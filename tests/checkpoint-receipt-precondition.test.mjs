// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openCore } from '../src/core.ts';
import { checkpointDraftFinalizationPrecondition } from '../src/checkpoints.ts';

const binding = Object.freeze({
  runtime: 'hermes',
  projectId: '1'.repeat(64),
  sessionHash: '2'.repeat(64),
});

function identity(turnId) {
  return { ...binding, turnId, revision: 1 };
}

function openInput(turnId) {
  return {
    schemaVersion: 1,
    ...identity(turnId),
    inputSourceHash: `sha256:${'3'.repeat(64)}`,
    inputContentSha256: '4'.repeat(64),
    openedAt: '2026-07-18T12:00:00.000Z',
  };
}

function commitInput(turnId) {
  return {
    schemaVersion: 1,
    ...identity(turnId),
    inputSourceHash: `sha256:${'3'.repeat(64)}`,
    inputContentSha256: '4'.repeat(64),
    finalSourceHash: `sha256:${'5'.repeat(64)}`,
    finalContentSha256: '6'.repeat(64),
    committedAt: '2026-07-18T12:00:01.000Z',
    deltaState: 'explicit_none',
  };
}

async function fixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-b5-receipt-race-')));
  const root = path.join(base, 'store');
  const project = path.join(base, 'project');
  await fs.mkdir(project, { recursive: true });
  const core = await openCore({ root, space: 't', cwd: project });
  t.after(async () => fs.rm(base, { recursive: true, force: true }));
  return core;
}

const finalizeRequest = {
  trigger: {
    kind: 'session_end',
    signal: 'native',
    sourceEvent: 'hermes.on_session_end',
    reasonCode: 'hermes_lifecycle_checkpoint',
  },
};

const anchors = async () => ({ files: [], commands: [] });

function restoreEnv(name, prior) {
  if (prior === undefined) delete process.env[name];
  else process.env[name] = prior;
}

test('malformed receipt coverage preconditions fail before anchor collection', async (t) => {
  const core = await fixture(t);
  const draft = await core.checkpoints.createDraft({
    runtime: 'hermes',
    sessionId: 'raw-session-id',
    claims: { completed: ['bounded'], coverage: { complete: true, eventCount: 1 } },
  });
  const draftOnly = checkpointDraftFinalizationPrecondition(draft);
  let anchorCalls = 0;
  await assert.rejects(
    core.checkpoints.finalizeDraft(draft.draftId, finalizeRequest, async () => {
      anchorCalls += 1;
      return { files: [], commands: [] };
    }, {
      ...draftOnly,
      receiptCoverage: {
        schemaVersion: 1,
        binding,
        requiredStatus: 'known_closed',
        expectedSnapshotSha256: 'a'.repeat(64),
        attackerField: 'raw-content-canary',
      },
    }),
    /checkpoint_receipt_coverage_precondition_invalid/,
  );
  assert.equal(anchorCalls, 0);
  assert.deepEqual(await core.checkpoints.list(), []);
});

test('a durable finalization intent recovers before a later receipt can invalidate its snapshot', async (t) => {
  const core = await fixture(t);
  await core.turnReceipts.open(openInput('closed-before-crash'));
  await core.turnReceipts.commit(commitInput('closed-before-crash'));
  const coverage = await core.turnReceipts.knownCoverage(binding);
  assert.equal(coverage.status, 'known_closed');

  const draft = await core.checkpoints.createDraft({
    runtime: 'hermes',
    sessionId: 'raw-session-id',
    claims: { completed: ['claimed complete'], coverage: { complete: true, eventCount: 1 } },
  });
  const precondition = checkpointDraftFinalizationPrecondition(draft, {
    schemaVersion: 1,
    binding,
    requiredStatus: 'known_closed',
    expectedSnapshotSha256: coverage.snapshotSha256,
  });

  const prior = process.env.IHOW_CHECKPOINT_AUDIT_TEST_FAIL_PHASE;
  process.env.IHOW_CHECKPOINT_AUDIT_TEST_FAIL_PHASE = 'before-marker';
  try {
    await assert.rejects(
      core.checkpoints.finalizeDraft(draft.draftId, finalizeRequest, anchors, precondition),
      /checkpoint_internal_failure/,
    );
  } finally {
    restoreEnv('IHOW_CHECKPOINT_AUDIT_TEST_FAIL_PHASE', prior);
  }
  const staged = await core.checkpoints.list();
  assert.equal(staged.length, 1);
  const artifactId = staged[0].id;

  await core.turnReceipts.open(openInput('opened-after-artifact'));
  let anchorCalls = 0;
  const recovered = await core.checkpoints.finalizeDraft(
    draft.draftId,
    finalizeRequest,
    async () => {
      anchorCalls += 1;
      return { files: [], commands: [] };
    },
    precondition,
  );
  assert.equal(recovered.artifact.id, artifactId);
  assert.equal(recovered.deduplicated, true);
  assert.equal(anchorCalls, 0);
});

test('a newly opened receipt invalidates a known-closed checkpoint finalization precondition', async (t) => {
  const core = await fixture(t);
  await core.turnReceipts.open(openInput('closed-before-snapshot'));
  await core.turnReceipts.commit(commitInput('closed-before-snapshot'));
  const coverage = await core.turnReceipts.knownCoverage(binding);
  assert.equal(coverage.status, 'known_closed');
  assert.match(coverage.snapshotSha256, /^[a-f0-9]{64}$/);

  const draft = await core.checkpoints.createDraft({
    runtime: 'hermes',
    sessionId: 'raw-session-id',
    claims: { completed: ['claimed complete'], coverage: { complete: true, eventCount: 1 } },
  });
  const precondition = checkpointDraftFinalizationPrecondition(draft, {
    schemaVersion: 1,
    binding,
    requiredStatus: 'known_closed',
    expectedSnapshotSha256: coverage.snapshotSha256,
  });

  await core.turnReceipts.open(openInput('opened-after-snapshot'));
  await assert.rejects(
    core.checkpoints.finalizeDraft(draft.draftId, finalizeRequest, anchors, precondition),
    /checkpoint_receipt_coverage_precondition_failed/,
  );
  assert.deepEqual(await core.checkpoints.list(), []);
});
