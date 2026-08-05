// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { canonicalCheckpointJson } from '../src/checkpoint-schema.ts';
import { openCore } from '../src/core.ts';
import {
  appendCheckpointAuditUnlocked,
  CHECKPOINT_AUDIT_COMPAT_MAX_EVENTS,
  CHECKPOINT_AUDIT_PAGE_MAX_LIMIT,
  CHECKPOINT_AUDIT_V2_MIGRATION_MAX_BYTES,
  CHECKPOINT_AUDIT_V2_SEGMENT_MAX_BYTES,
  CHECKPOINT_AUDIT_V2_SEGMENT_RECORDS,
  checkpointAuditV2Paths,
  checkpointStorePaths,
  readCheckpointAudit,
  readCheckpointAuditPageUnlocked,
  readCheckpointDraftUnlocked,
  readCheckpointFinalizationIntentUnlocked,
} from '../src/store/checkpoints.ts';

const explicit = {
  trigger: {
    kind: 'explicit',
    signal: 'native',
    sourceEvent: 'audit-v2-test',
    reasonCode: 'test_checkpoint',
  },
};

async function tempCore(t, label) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `ihow-${label}-`)));
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return await openCore({ root: path.join(root, 'store'), space: 'checkpoint-audit-v2', cwd: project });
}

function artifactId(label) {
  return `cp_${crypto.createHash('sha256').update(label).digest('hex')}`;
}

function auditFinalizationLocation(workspace, draftId) {
  const bucket = crypto.createHash('sha256').update(draftId).digest('hex');
  const root = checkpointAuditV2Paths(workspace).finalizations;
  const directory = path.join(root, bucket.slice(0, 2), bucket.slice(2, 4), bucket.slice(4, 6), draftId);
  return {
    directory,
    outcome: path.join(directory, 'outcome.json'),
    catalog: path.join(directory, 'catalog.json'),
    publication: path.join(directory, 'publication.json'),
    conflict: path.join(directory, 'conflict.json'),
  };
}

async function walkFiles(directory) {
  const out = [];
  async function visit(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) out.push(file);
    }
  }
  try {
    await visit(directory);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return out.sort();
}

async function readCatalogRecords(workspace) {
  const segmentFiles = (await walkFiles(checkpointAuditV2Paths(workspace).segments))
    .filter((file) => file.endsWith('.ndjson'));
  const records = [];
  for (const file of segmentFiles) {
    const raw = await fs.readFile(file, 'utf8');
    for (const line of raw.trimEnd().split('\n')) {
      if (line) records.push(JSON.parse(line));
    }
  }
  return records.sort((a, b) => a.sequence - b.sequence);
}

function finalizationRequest(draftId, label, overrides = {}) {
  return {
    type: 'checkpoint.artifact.created',
    operation: 'artifact.finalize',
    draftId,
    artifactId: artifactId(label),
    ...overrides,
  };
}

function restoreEnv(name, prior) {
  if (prior === undefined) delete process.env[name];
  else process.env[name] = prior;
}

async function stageBeforeMarkerCrash(core, label) {
  const draft = await core.checkpoints.createDraft({
    runtime: 'audit-v2-test',
    sessionId: label,
    claims: { completed: [`durable ${label}`] },
  });
  let anchorCalls = 0;
  const prior = process.env.IHOW_CHECKPOINT_AUDIT_TEST_FAIL_PHASE;
  process.env.IHOW_CHECKPOINT_AUDIT_TEST_FAIL_PHASE = 'before-marker';
  try {
    await assert.rejects(
      core.checkpoints.finalizeDraft(draft.draftId, explicit, async () => {
        anchorCalls += 1;
        return { files: [], commands: [] };
      }),
      /checkpoint_internal_failure/,
    );
  } finally {
    restoreEnv('IHOW_CHECKPOINT_AUDIT_TEST_FAIL_PHASE', prior);
  }
  const intent = await readCheckpointFinalizationIntentUnlocked(core.workspace, draft.draftId);
  assert.ok(intent, 'the marker crash must retain its deterministic intent');
  return { draft, intent, anchorCalls };
}

function deterministicUuid(index) {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function legacyEvent(index) {
  return {
    schemaVersion: 1,
    id: deterministicUuid(index + 1),
    at: '2026-07-12T08:00:00.000Z',
    type: 'checkpoint.rejected',
    operation: 'artifact.read',
    reasonCode: 'checkpoint_legacy_seed',
  };
}

async function writeLegacyAudit(workspace, count) {
  const paths = checkpointStorePaths(workspace);
  await fs.mkdir(paths.root, { recursive: true });
  const events = Array.from({ length: count }, (_, index) => legacyEvent(index));
  const raw = `${events.map((event) => canonicalCheckpointJson(event)).join('\n')}\n`;
  assert.ok(Buffer.byteLength(raw, 'utf8') <= CHECKPOINT_AUDIT_V2_MIGRATION_MAX_BYTES);
  await fs.writeFile(paths.audit, raw, 'utf8');
  return { events, raw };
}

test('finalization append faults recover the same outcome exactly once in every durable phase', async (t) => {
  const core = await tempCore(t, 'audit-v2-finalization-faults');
  const phases = [
    'before-outcome',
    'after-outcome',
    'after-pending',
    'after-segment',
    'after-state',
    'after-publication',
  ];
  const expected = [];

  for (const [index, phase] of phases.entries()) {
    const draftId = `draft_${deterministicUuid(100 + index)}`;
    const requested = finalizationRequest(draftId, `fault-${phase}`);
    await assert.rejects(
      appendCheckpointAuditUnlocked(core.workspace, requested, { testAuditFailPhase: phase }),
      /checkpoint_internal_failure/,
      phase,
    );
    const retried = await appendCheckpointAuditUnlocked(core.workspace, requested);
    assert.equal(retried.draftId, draftId);
    assert.equal(retried.type, requested.type);
    assert.equal(retried.artifactId, requested.artifactId);
    expected.push(retried);

    const location = auditFinalizationLocation(core.workspace, draftId);
    assert.deepEqual((await fs.readdir(location.directory)).sort(), ['catalog.json', 'outcome.json', 'publication.json']);
    const outcome = JSON.parse(await fs.readFile(location.outcome, 'utf8'));
    const publication = JSON.parse(await fs.readFile(location.publication, 'utf8'));
    assert.deepEqual(outcome.event, retried);
    assert.equal(publication.draftId, draftId);
    assert.equal(publication.eventId, retried.id);
  }

  assert.equal(
    await fs.readFile(checkpointAuditV2Paths(core.workspace).pending, 'utf8'),
    canonicalCheckpointJson({ schemaVersion: 2, status: 'empty' }),
  );
  const records = await readCatalogRecords(core.workspace);
  for (const event of expected) {
    const matching = records.filter((record) => record.kind === 'finalization-ref' && record.draftId === event.draftId);
    assert.equal(matching.length, 1, `${event.draftId} was cataloged more than once`);
    assert.equal(matching[0].eventId, event.id);
  }
  const audit = await readCheckpointAudit(core.workspace);
  for (const event of expected) {
    assert.equal(audit.filter((item) => item.draftId === event.draftId).length, 1);
  }
});

test('service before-marker retry reuses landed anchors and only writes the missing marker', async (t) => {
  const core = await tempCore(t, 'audit-v2-before-marker');
  const staged = await stageBeforeMarkerCrash(core, 'before-marker');
  assert.equal(staged.anchorCalls, 1);

  const paths = checkpointStorePaths(core.workspace);
  const location = auditFinalizationLocation(core.workspace, staged.draft.draftId);
  await fs.access(path.join(paths.artifacts, `${staged.intent.artifactId}.json`));
  await fs.access(location.outcome);
  await fs.access(location.catalog);
  await fs.access(location.publication);
  assert.equal((await readCheckpointDraftUnlocked(core.workspace, staged.draft.draftId)).finalization, undefined);

  let retryAnchorCalls = 0;
  const retried = await core.checkpoints.finalizeDraft(staged.draft.draftId, explicit, async () => {
    retryAnchorCalls += 1;
    throw new Error('replacement anchors must not be collected');
  });
  assert.equal(retryAnchorCalls, 0);
  assert.equal(retried.artifact.id, staged.intent.artifactId);
  assert.deepEqual(
    (await readCheckpointDraftUnlocked(core.workspace, staged.draft.draftId)).finalization,
    { artifactId: staged.intent.artifactId },
  );
  assert.equal(await readCheckpointFinalizationIntentUnlocked(core.workspace, staged.draft.draftId), undefined);
  assert.equal(
    (await readCatalogRecords(core.workspace)).filter(
      (record) => record.kind === 'finalization-ref' && record.draftId === staged.draft.draftId,
    ).length,
    1,
  );
  assert.deepEqual((await fs.readdir(location.directory)).sort(), ['catalog.json', 'outcome.json', 'publication.json']);
});

test('legacy bootstrap rolls segments at 512 records, pages across boundaries, and keeps critical finalization off compat aggregation', async (t) => {
  const core = await tempCore(t, 'audit-v2-rollover');
  const legacyCount = CHECKPOINT_AUDIT_COMPAT_MAX_EVENTS + 1;
  const { events } = await writeLegacyAudit(core.workspace, legacyCount);

  const appended = await appendCheckpointAuditUnlocked(core.workspace, {
    type: 'checkpoint.rejected',
    operation: 'artifact.inspect',
    reasonCode: 'checkpoint_rollover_append',
  });
  const finalDraftId = `draft_${deterministicUuid(9000)}`;
  const finalized = await appendCheckpointAuditUnlocked(
    core.workspace,
    finalizationRequest(finalDraftId, 'rollover-finalization'),
  );

  const segmentFiles = (await walkFiles(checkpointAuditV2Paths(core.workspace).segments))
    .filter((file) => file.endsWith('.ndjson'));
  assert.ok(segmentFiles.length >= 2);
  let totalRecords = 0;
  for (const file of segmentFiles) {
    const raw = await fs.readFile(file, 'utf8');
    const records = raw.trimEnd().split('\n');
    totalRecords += records.length;
    assert.ok(records.length <= CHECKPOINT_AUDIT_V2_SEGMENT_RECORDS, path.basename(file));
    assert.ok(Buffer.byteLength(raw, 'utf8') <= CHECKPOINT_AUDIT_V2_SEGMENT_MAX_BYTES, path.basename(file));
  }
  assert.equal(totalRecords, legacyCount + 2);

  const boundary = await readCheckpointAuditPageUnlocked(core.workspace, { cursor: 'v2:511', limit: 3 });
  assert.deepEqual(boundary.events.map((event) => event.id), events.slice(511, 514).map((event) => event.id));
  assert.equal(boundary.nextCursor, 'v2:514');

  const tail = await readCheckpointAuditPageUnlocked(core.workspace, { cursor: `v2:${legacyCount - 1}`, limit: 3 });
  assert.deepEqual(tail.events.map((event) => event.id), [events.at(-1).id, appended.id, finalized.id]);
  assert.equal(tail.nextCursor, undefined);
  assert.deepEqual(
    await readCheckpointAuditPageUnlocked(core.workspace, { cursor: `v2:${legacyCount + 2}`, limit: 1 }),
    { events: [] },
  );
  await assert.rejects(readCheckpointAudit(core.workspace), /checkpoint_audit_read_limit_exceeded/);
  await assert.rejects(
    readCheckpointAuditPageUnlocked(core.workspace, { limit: CHECKPOINT_AUDIT_PAGE_MAX_LIMIT + 1 }),
    /checkpoint_audit_limit_invalid/,
  );
  await assert.rejects(
    readCheckpointAuditPageUnlocked(core.workspace, { cursor: 'v2:not-a-number', limit: 1 }),
    /checkpoint_audit_cursor_invalid/,
  );
  await assert.rejects(
    readCheckpointAuditPageUnlocked(core.workspace, { cursor: `v2:${legacyCount + 3}`, limit: 1 }),
    /checkpoint_audit_cursor_invalid/,
  );
});

test('paged reads reject an old segment whose tail no longer binds the next segment', async (t) => {
  const core = await tempCore(t, 'audit-v2-forward-boundary');
  await writeLegacyAudit(core.workspace, CHECKPOINT_AUDIT_V2_SEGMENT_RECORDS * 2 + 1);
  await appendCheckpointAuditUnlocked(core.workspace, {
    type: 'checkpoint.rejected',
    operation: 'artifact.inspect',
    reasonCode: 'checkpoint_forward_boundary_seed',
  });

  const segmentFiles = (await walkFiles(checkpointAuditV2Paths(core.workspace).segments))
    .filter((file) => file.endsWith('.ndjson'))
    .sort();
  assert.ok(segmentFiles.length >= 3);
  const firstLines = (await fs.readFile(segmentFiles[0], 'utf8')).trimEnd().split('\n');
  assert.equal(firstLines.length, CHECKPOINT_AUDIT_V2_SEGMENT_RECORDS);
  const tail = JSON.parse(firstLines.at(-1));
  assert.equal(tail.sequence, CHECKPOINT_AUDIT_V2_SEGMENT_RECORDS - 1);
  tail.event.reasonCode = 'checkpoint_tampered_old_segment_tail';
  firstLines[firstLines.length - 1] = canonicalCheckpointJson(tail);
  await fs.writeFile(segmentFiles[0], `${firstLines.join('\n')}\n`, 'utf8');

  await assert.rejects(
    readCheckpointAuditPageUnlocked(core.workspace, {
      cursor: `v2:${CHECKPOINT_AUDIT_V2_SEGMENT_RECORDS - 1}`,
      limit: 1,
    }),
    /checkpoint_audit_segment_invalid/,
  );
});

test('oversized legacy audit requires offline migration without publishing or moving any audit-v2 state', async (t) => {
  const core = await tempCore(t, 'audit-v2-oversized-legacy');
  const paths = checkpointStorePaths(core.workspace);
  const v2 = checkpointAuditV2Paths(core.workspace);
  await fs.mkdir(paths.root, { recursive: true });
  const oversized = Buffer.alloc(CHECKPOINT_AUDIT_V2_MIGRATION_MAX_BYTES + 1, 0x78);
  await fs.writeFile(paths.audit, oversized);
  const before = await fs.lstat(paths.audit, { bigint: true });

  await assert.rejects(
    appendCheckpointAuditUnlocked(
      core.workspace,
      finalizationRequest(`draft_${deterministicUuid(9100)}`, 'oversized-migration'),
    ),
    /checkpoint_audit_migration_required/,
  );

  const after = await fs.lstat(paths.audit, { bigint: true });
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.equal(after.size, before.size);
  assert.deepEqual(await fs.readFile(paths.audit), oversized);
  await assert.rejects(fs.access(v2.current), /ENOENT/);
  await assert.rejects(fs.access(v2.state), /ENOENT/);
  await assert.rejects(fs.access(v2.pending), /ENOENT/);
  assert.deepEqual(await walkFiles(v2.segments), []);
  assert.deepEqual(await walkFiles(v2.finalizations), []);
  assert.equal((await fs.readdir(paths.root)).filter((name) => name.startsWith('audit.ndjson')).length, 1);
});

test('tampered or missing canonical audit-v2 components fail closed before marker recovery', async (t) => {
  const cases = [
    {
      name: 'state-noncanonical',
      expected: /checkpoint_audit_state_invalid/,
      corrupt: async (core) => {
        const file = checkpointAuditV2Paths(core.workspace).state;
        await fs.writeFile(file, `${await fs.readFile(file, 'utf8')}\n`, 'utf8');
      },
    },
    {
      name: 'pending-missing',
      expected: /checkpoint_audit_pending_invalid/,
      corrupt: async (core) => {
        await fs.unlink(checkpointAuditV2Paths(core.workspace).pending);
      },
    },
    {
      name: 'segment-chain-hash',
      expected: /checkpoint_audit_segment_invalid|checkpoint_audit_state_invalid/,
      corrupt: async (core) => {
        const [file] = (await walkFiles(checkpointAuditV2Paths(core.workspace).segments))
          .filter((candidate) => candidate.endsWith('.ndjson'));
        const records = (await fs.readFile(file, 'utf8')).trimEnd().split('\n').map(JSON.parse);
        assert.ok(records.length >= 2);
        records[1].previousRecordSha256 = '0'.repeat(64);
        await fs.writeFile(file, `${records.map((record) => canonicalCheckpointJson(record)).join('\n')}\n`, 'utf8');
      },
    },
    {
      name: 'outcome-schema',
      expected: /checkpoint_finalization_audit_outcome_mismatch/,
      corrupt: async (core, staged) => {
        const file = auditFinalizationLocation(core.workspace, staged.draft.draftId).outcome;
        const value = JSON.parse(await fs.readFile(file, 'utf8'));
        value.unexpected = true;
        await fs.writeFile(file, canonicalCheckpointJson(value), 'utf8');
      },
    },
    {
      name: 'publication-hash',
      expected: /checkpoint_audit_publication_invalid/,
      corrupt: async (core, staged) => {
        const file = auditFinalizationLocation(core.workspace, staged.draft.draftId).publication;
        const value = JSON.parse(await fs.readFile(file, 'utf8'));
        value.recordSha256 = '0'.repeat(64);
        await fs.writeFile(file, canonicalCheckpointJson(value), 'utf8');
      },
    },
    {
      name: 'publication-missing-after-commit',
      expected: /checkpoint_audit_publication_invalid/,
      corrupt: async (core, staged) => {
        await fs.unlink(auditFinalizationLocation(core.workspace, staged.draft.draftId).publication);
      },
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async (st) => {
      const core = await tempCore(st, `audit-v2-tamper-${item.name}`);
      const staged = await stageBeforeMarkerCrash(core, item.name);
      await item.corrupt(core, staged);
      let providerCalls = 0;
      await assert.rejects(
        core.checkpoints.finalizeDraft(staged.draft.draftId, explicit, async () => {
          providerCalls += 1;
          return { files: [], commands: [] };
        }),
        item.expected,
      );
      assert.equal(providerCalls, 0);
      assert.equal((await readCheckpointDraftUnlocked(core.workspace, staged.draft.draftId)).finalization, undefined);
      assert.ok(await readCheckpointFinalizationIntentUnlocked(core.workspace, staged.draft.draftId));
      assert.equal(
        (await readCatalogRecords(core.workspace)).filter(
          (record) => record.kind === 'finalization-ref' && record.draftId === staged.draft.draftId,
        ).length,
        1,
      );
    });
  }
});

test('competing finalization type, artifact, or supersedes writes a durable conflict and poisons later finalize and audit', async (t) => {
  const cases = [
    {
      name: 'type',
      competing: ({ artifact }) => ({ type: 'checkpoint.artifact.deduplicated', artifactId: artifact.id }),
    },
    {
      name: 'artifact',
      competing: () => ({ type: 'checkpoint.artifact.created', artifactId: artifactId('competing-artifact') }),
    },
    {
      name: 'supersedes',
      competing: ({ artifact }) => ({
        type: 'checkpoint.artifact.created',
        artifactId: artifact.id,
        supersedes: artifactId('competing-parent'),
      }),
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async (st) => {
      const core = await tempCore(st, `audit-v2-conflict-${item.name}`);
      const draft = await core.checkpoints.createDraft({
        runtime: 'audit-v2-test',
        sessionId: `conflict-${item.name}`,
        claims: { completed: [`conflict ${item.name}`] },
      });
      const original = await core.checkpoints.finalizeDraft(draft.draftId, explicit, async () => ({ files: [], commands: [] }));
      const competing = item.competing(original);
      await assert.rejects(
        appendCheckpointAuditUnlocked(core.workspace, {
          operation: 'artifact.finalize',
          draftId: draft.draftId,
          ...competing,
        }),
        /checkpoint_finalization_audit_outcome_mismatch/,
      );

      const conflictFile = auditFinalizationLocation(core.workspace, draft.draftId).conflict;
      const conflictRaw = await fs.readFile(conflictFile, 'utf8');
      const conflict = JSON.parse(conflictRaw);
      assert.equal(conflictRaw, canonicalCheckpointJson(conflict));
      assert.equal(conflict.draftId, draft.draftId);
      assert.match(conflict.expectedOutcomeSha256, /^[a-f0-9]{64}$/);
      assert.match(conflict.observedOutcomeSha256, /^[a-f0-9]{64}$/);

      let providerCalls = 0;
      await assert.rejects(
        core.checkpoints.finalizeDraft(draft.draftId, explicit, async () => {
          providerCalls += 1;
          return { files: [], commands: [] };
        }),
        /checkpoint_finalization_audit_outcome_mismatch/,
      );
      assert.equal(providerCalls, 0);
      await assert.rejects(core.checkpoints.audit(), /checkpoint_finalization_audit_outcome_mismatch/);
      await assert.rejects(
        appendCheckpointAuditUnlocked(core.workspace, {
          type: 'checkpoint.artifact.created',
          operation: 'artifact.finalize',
          draftId: draft.draftId,
          artifactId: original.artifact.id,
        }),
        /checkpoint_finalization_audit_outcome_mismatch/,
      );
      assert.equal(await fs.readFile(conflictFile, 'utf8'), conflictRaw);
    });
  }
});

test('audit-v2 control, segment, and finalization symlink replacements stay contained and preserve sentinels', async (t) => {
  for (const targetName of ['control', 'segments', 'finalizations']) {
    await t.test(targetName, async (st) => {
      const core = await tempCore(st, `audit-v2-containment-${targetName}`);
      await appendCheckpointAuditUnlocked(core.workspace, {
        type: 'checkpoint.rejected',
        operation: 'artifact.read',
        reasonCode: 'checkpoint_containment_seed',
      });
      const paths = checkpointAuditV2Paths(core.workspace);
      const target = paths[targetName];
      const backup = `${target}.backup`;
      const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `ihow-audit-v2-${targetName}-outside-`)));
      const sentinel = path.join(outside, 'replacement-sentinel.txt');
      await fs.writeFile(sentinel, `preserve-${targetName}`, 'utf8');
      st.after(async () => { await fs.rm(outside, { recursive: true, force: true }); });
      await fs.rename(target, backup);
      await fs.symlink(outside, target, 'dir');
      try {
        await assert.rejects(
          appendCheckpointAuditUnlocked(
            core.workspace,
            targetName === 'finalizations'
              ? finalizationRequest(`draft_${deterministicUuid(9200)}`, `containment-${targetName}`)
              : {
                  type: 'checkpoint.rejected',
                  operation: 'artifact.read',
                  reasonCode: `checkpoint_containment_${targetName}`,
                },
          ),
          /checkpoint_path_outside_store/,
        );
        assert.equal(await fs.readFile(sentinel, 'utf8'), `preserve-${targetName}`);
        assert.deepEqual(await fs.readdir(outside), ['replacement-sentinel.txt']);
      } finally {
        await fs.unlink(target);
        await fs.rename(backup, target);
      }
    });
  }
});
