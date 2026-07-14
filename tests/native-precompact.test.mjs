// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalCheckpointJson } from '../src/checkpoint-schema.ts';
import { locateCheckpointDrafts, resolveCheckpointProjectIdentity } from '../src/checkpoints.ts';
import { normalizeNativePreCompactTrigger } from '../src/native-precompact.ts';
import { openCore } from '../src/core.ts';
import { readActivationEvidence } from '../src/activation-ledger.ts';
import {
  CHECKPOINT_OPEN_DRAFT_MAX,
  checkpointPrivateIndexPaths,
  checkpointStorePaths,
  listCheckpointDraftFiles,
} from '../src/store/checkpoints.ts';
import { resolveWorkspace } from '../src/workspace.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'src', 'cli.ts');

async function fixture(t, label) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `ihow-precompact-${label}-`)));
  const root = path.join(base, 'store');
  const project = path.join(base, 'project');
  const home = path.join(base, 'home');
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  t.after(async () => { await fs.rm(base, { recursive: true, force: true }); });
  return { base, root, project, home, space: 't' };
}

function claudePayload(project, overrides = {}) {
  return {
    session_id: 'claude-session-1',
    transcript_path: path.join(project, 'missing-transcript.jsonl'),
    cwd: project,
    hook_event_name: 'PreCompact',
    trigger: 'auto',
    custom_instructions: '',
    ...overrides,
  };
}

function codexPayload(project, overrides = {}) {
  return {
    session_id: 'codex-session-1',
    turn_id: 'turn-9',
    transcript_path: null,
    cwd: project,
    hook_event_name: 'PreCompact',
    model: 'gpt-5.6-codex',
    trigger: 'manual',
    ...overrides,
  };
}

function runHook({ root, project, home, space = 't', runtime = 'claude-code', payload, env = {}, cli = CLI }) {
  return spawnSync(process.execPath, [
    cli, 'hook-pre-compact', '--runtime', runtime,
    '--root', root, '--space', space, '--cwd', project,
  ], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, HOME: home, ...env },
    timeout: 8_000,
  });
}

async function artifactFiles(root, space = 't') {
  const dir = path.join(root, space, 'checkpoints', 'artifacts');
  return (await fs.readdir(dir).catch(() => [])).filter((name) => /^cp_[a-f0-9]{64}\.json$/.test(name));
}

async function allFiles(dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await allFiles(file));
    else if (entry.isFile()) out.push(file);
  }
  return out;
}

async function writeFinalizedDraftNoise(core, template, count, label) {
  const paths = checkpointStorePaths(core.workspace);
  for (let index = 0; index < count; index += 1) {
    const draftId = `draft_${crypto.randomUUID()}`;
    const finalized = {
      ...template,
      draftId,
      session: {
        runtime: template.session.runtime,
        sessionIdHash: crypto.createHash('sha256').update(`${label}-${index}`).digest('hex'),
      },
      claims: { ...template.claims, completed: [`${label}-${index}`] },
      finalization: {
        artifactId: `cp_${crypto.createHash('sha256').update(`${label}-artifact-${index}`).digest('hex')}`,
      },
    };
    await fs.writeFile(path.join(paths.drafts, `${draftId}.json`), canonicalCheckpointJson(finalized), 'utf8');
  }
}

test('Claude and Codex normalize to distinct exact contracts without pseudo-symmetric fields', async (t) => {
  const { project } = await fixture(t, 'contract');
  const secret = 'sk-live-native-adapter-secret-123456';
  const claude = normalizeNativePreCompactTrigger('claude-code', claudePayload(project, {
    custom_instructions: `keep this private ${secret}`,
    unknown_future_field: { prompt: secret },
  }), '2026-07-12T15:00:00.000Z');
  const codex = normalizeNativePreCompactTrigger('codex', codexPayload(project, {
    unknown_future_field: secret,
  }), '2026-07-12T15:00:00.000Z');

  assert.equal(claude.runtime, 'claude-code');
  assert.equal(claude.customInstructionsRef.kind, 'untrusted-ref');
  assert.equal('model' in claude, false);
  assert.equal('turn' in claude, false);
  assert.equal(codex.runtime, 'codex');
  assert.equal(codex.model, 'gpt-5.6-codex');
  assert.equal(codex.turn.id, 'turn-9');
  assert.equal('customInstructionsRef' in codex, false);
  assert.equal('compact_summary' in codex, false);
  assert.equal('SessionEnd' in codex, false);
  assert.equal(claude.usage.status, 'unknown');
  assert.equal(codex.usage.status, 'unknown');
  assert.equal(claude.delivery.mode, 'best_effort');
  assert.equal(JSON.stringify(claude).includes(secret), false);
  assert.equal(JSON.stringify(codex).includes(secret), false);
  assert.equal('unknown_future_field' in claude, false);
  assert.equal('unknown_future_field' in codex, false);
});

test('normalization tolerates missing/null transcript refs but rejects wrong host fields and oversized codes', async (t) => {
  const { project } = await fixture(t, 'bounds');
  const claude = normalizeNativePreCompactTrigger('claude-code', claudePayload(project, {
    transcript_path: undefined,
    custom_instructions: null,
  }));
  const codex = normalizeNativePreCompactTrigger('codex', codexPayload(project, { transcript_path: null }));
  assert.equal(claude.transcriptRef, undefined);
  assert.equal(claude.customInstructionsRef, undefined);
  assert.equal(codex.transcriptRef, undefined);
  assert.throws(() => normalizeNativePreCompactTrigger('codex', codexPayload(project, { turn_id: null })), /native_precompact_turn_invalid/);
  assert.throws(() => normalizeNativePreCompactTrigger('codex', codexPayload(project, { model: 'x'.repeat(257) })), /native_precompact_model_invalid/);
  assert.throws(() => normalizeNativePreCompactTrigger('codex', codexPayload(project, { transcript_path: 'x'.repeat(4097) })), /native_precompact_transcript_ref_invalid/);
  assert.throws(() => normalizeNativePreCompactTrigger('claude-code', claudePayload(project, { custom_instructions: 'x'.repeat(32 * 1024 + 1) })), /native_precompact_custom_instructions_ref_invalid/);
  assert.throws(() => normalizeNativePreCompactTrigger('claude-code', claudePayload(project, { hook_event_name: 'SessionEnd' })), /native_precompact_event_invalid/);
});

test('no-draft Claude PreCompact writes one minimal partial shadow without reading transcript or retaining secrets', async (t) => {
  const f = await fixture(t, 'minimal');
  const secret = 'AKIAIOSFODNN7EXAMPLE';
  const result = runHook({ ...f, payload: claudePayload(f.project, {
    transcript_path: path.join(f.project, `missing-${secret}.jsonl`),
    custom_instructions: `password is ${secret}`,
    prompt: secret,
  }) });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');

  const core = await openCore({ root: f.root, space: f.space, cwd: f.project });
  const listed = await core.checkpoints.list();
  assert.equal(listed.length, 1);
  const artifact = await core.checkpoints.read(listed[0].id);
  assert.equal(artifact.trigger.kind, 'pre_compact');
  assert.equal(artifact.trigger.signal, 'shadow');
  assert.equal(artifact.trigger.sourceEvent, 'ClaudeCode.PreCompact');
  assert.equal(artifact.coverage.complete, false);
  assert.deepEqual(artifact.state, { completed: [], pending: [], decisions: [], blockers: [], nextActions: [] });
  assert.deepEqual(artifact.anchors, { files: [], commands: [] });

  for (const file of await allFiles(path.join(f.root, f.space))) {
    const bytes = await fs.readFile(file);
    assert.equal(bytes.includes(Buffer.from(secret)), false, `${path.relative(f.root, file)} retains no secret input`);
    assert.equal(bytes.includes(Buffer.from('custom_instructions')), false);
    assert.equal(bytes.includes(Buffer.from('prompt')), false);
    assert.equal(bytes.includes(Buffer.from('transcript_path')), false);
  }
});

test('interrupted adapter minimal draft remains shadow while evidence-bearing cooperative draft remains native', async (t) => {
  const residue = await fixture(t, 'residue');
  const residueCore = await openCore({ root: residue.root, space: residue.space, cwd: residue.project });
  await residueCore.checkpoints.createDraft({
    runtime: 'claude-code',
    sessionId: 'claude-session-1',
    claims: { coverage: { complete: false, eventCount: 0 } },
  });
  const resumed = runHook({ ...residue, payload: claudePayload(residue.project) });
  assert.equal(resumed.status, 0);
  const residueArtifacts = await residueCore.checkpoints.list();
  assert.equal(residueArtifacts.length, 1);
  const shadow = await residueCore.checkpoints.read(residueArtifacts[0].id);
  assert.equal(shadow.trigger.signal, 'shadow');
  assert.equal(shadow.trigger.reasonCode, 'native_precompact_minimal_partial');
  assert.equal(shadow.coverage.eventCount, 0);

  const cooperative = await fixture(t, 'evidence-only');
  const cooperativeCore = await openCore({ root: cooperative.root, space: cooperative.space, cwd: cooperative.project });
  await cooperativeCore.checkpoints.createDraft({
    runtime: 'claude-code',
    sessionId: 'claude-session-1',
    claims: {
      evidence: [{ kind: 'test', ref: 'focused-native-precompact' }],
      coverage: { complete: false, eventCount: 0 },
    },
  });
  const finalized = runHook({ ...cooperative, payload: claudePayload(cooperative.project) });
  assert.equal(finalized.status, 0);
  const cooperativeArtifacts = await cooperativeCore.checkpoints.list();
  assert.equal(cooperativeArtifacts.length, 1);
  const native = await cooperativeCore.checkpoints.read(cooperativeArtifacts[0].id);
  assert.equal(native.trigger.signal, 'native');
  assert.equal(native.trigger.reasonCode, 'native_precompact_existing_draft');
  assert.deepEqual(native.evidence, [{ kind: 'test', ref: 'focused-native-precompact' }]);
});

test('draft discovery bounds directory iteration and accepts only schema-canonical basenames', async (t) => {
  const f = await fixture(t, 'draft-scan');
  const core = await openCore({ root: f.root, space: f.space, cwd: f.project });
  const valid = await core.checkpoints.createDraft({
    runtime: 'claude-code',
    sessionId: 'claude-session-1',
    claims: { completed: ['kept'] },
  });
  const paths = checkpointStorePaths(core.workspace);
  await fs.writeFile(path.join(paths.drafts, '.interrupted.tmp'), 'ignored', 'utf8');
  await fs.writeFile(path.join(paths.drafts, 'not-a-draft'), 'ignored', 'utf8');
  await assert.rejects(listCheckpointDraftFiles(core.workspace, 2), /checkpoint_draft_scan_limit_exceeded/);

  await fs.rm(path.join(paths.drafts, '.interrupted.tmp'));
  await fs.rm(path.join(paths.drafts, 'not-a-draft'));
  await fs.writeFile(path.join(paths.drafts, 'draft_00000000-0000-6000-8000-000000000000.json'), '{}', 'utf8');
  assert.deepEqual(await listCheckpointDraftFiles(core.workspace, 2), [valid.draftId]);
});

test('private locator keeps PreCompact live after 257+ finalized drafts without using the global scan', async (t) => {
  const f = await fixture(t, 'locator-257');
  const core = await openCore({ root: f.root, space: f.space, cwd: f.project });
  const target = await core.checkpoints.createDraft({
    runtime: 'claude-code',
    sessionId: 'claude-session-1',
    claims: { completed: ['the indexed cooperative state'], coverage: { complete: false, eventCount: 1 } },
  });
  const paths = checkpointStorePaths(core.workspace);
  for (let index = 0; index < 257; index += 1) {
    const draftId = `draft_${crypto.randomUUID()}`;
    const unrelated = {
      ...target,
      draftId,
      session: { runtime: 'claude-code', sessionIdHash: crypto.createHash('sha256').update(`other-${index}`).digest('hex') },
      claims: { ...target.claims, completed: [`unrelated-${index}`] },
      finalization: { artifactId: `cp_${crypto.createHash('sha256').update(`artifact-${index}`).digest('hex')}` },
    };
    await fs.writeFile(path.join(paths.drafts, `${draftId}.json`), canonicalCheckpointJson(unrelated), 'utf8');
  }

  const result = runHook({ ...f, payload: claudePayload(f.project) });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  const storedTarget = JSON.parse(await fs.readFile(path.join(paths.drafts, `${target.draftId}.json`), 'utf8'));
  assert.ok(storedTarget.finalization?.artifactId, 'the exact indexed cooperative draft was finalized');
  const artifact = await core.checkpoints.read(storedTarget.finalization.artifactId);
  assert.deepEqual(artifact.state.completed, ['the indexed cooperative state']);
  assert.equal(artifact.trigger.signal, 'native');
});

test('a canonical locator that omits a real open draft fails closed instead of creating a shadow', async (t) => {
  const f = await fixture(t, 'locator-omission');
  const core = await openCore({ root: f.root, space: f.space, cwd: f.project });
  const draft = await core.checkpoints.createDraft({
    runtime: 'claude-code',
    sessionId: 'claude-session-1',
    claims: { completed: ['must remain visible'], coverage: { complete: false, eventCount: 1 } },
  });
  const indexes = checkpointPrivateIndexPaths(core.workspace);
  const [locatorName] = await fs.readdir(indexes.draftLocators);
  const locatorPath = path.join(indexes.draftLocators, locatorName);
  const locator = JSON.parse(await fs.readFile(locatorPath, 'utf8'));
  locator.open = [];
  locator.openSetComplete = true;
  await fs.writeFile(locatorPath, canonicalCheckpointJson(locator), 'utf8');

  const project = await resolveCheckpointProjectIdentity(
    { root: f.root, space: f.space, cwd: f.project },
    core.workspace,
  );
  assert.deepEqual(
    await locateCheckpointDrafts(core.workspace, project, 'claude-code', 'claude-session-1'),
    { completeness: 'unknown', reasonCode: 'checkpoint_draft_locator_incomplete' },
  );

  const result = runHook({ ...f, payload: claudePayload(f.project) });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.equal((await artifactFiles(f.root)).length, 0, 'locator disagreement publishes no shadow artifact');
  const stored = JSON.parse(await fs.readFile(
    path.join(checkpointStorePaths(core.workspace).drafts, `${draft.draftId}.json`),
    'utf8',
  ));
  assert.equal(stored.finalization, undefined, 'the cooperative draft remains open');
});

test('indexed draft component deletion and replacement stay unknown without shadow completion', async (t) => {
  for (const mode of ['deleted-open-set-member', 'deleted-canonical', 'canonical-symlink', 'canonical-directory']) {
    await t.test(mode, async (t) => {
      const f = await fixture(t, `indexed-attack-${mode}`);
      execFileSync(process.execPath, [CLI, 'install-hook', '--root', f.root, '--space', f.space, '--cwd', f.project], {
        encoding: 'utf8', env: { ...process.env, HOME: f.home },
      });
      const core = await openCore({ root: f.root, space: f.space, cwd: f.project });
      const draft = await core.checkpoints.createDraft({
        runtime: 'claude-code',
        sessionId: 'claude-session-1',
        claims: { completed: [`preserve-${mode}`], coverage: { complete: false, eventCount: 1 } },
      });
      const paths = checkpointStorePaths(core.workspace);
      const indexes = checkpointPrivateIndexPaths(core.workspace);
      const canonicalDraft = path.join(paths.drafts, `${draft.draftId}.json`);
      const [locatorName] = await fs.readdir(indexes.draftLocators);
      const locatorPath = path.join(indexes.draftLocators, locatorName);
      const locatorBefore = await fs.readFile(locatorPath, 'utf8');
      const memberPath = (await allFiles(indexes.draftOpenSets))
        .find((file) => path.basename(file) === `${draft.draftId}.json`);
      assert.ok(memberPath, 'the independently maintained open-set member exists before the attack');
      const memberBefore = await fs.readFile(memberPath, 'utf8');

      if (mode === 'deleted-open-set-member') {
        await fs.rm(memberPath);
      } else {
        const canonicalBefore = await fs.readFile(canonicalDraft, 'utf8');
        await fs.rm(canonicalDraft);
        if (mode === 'canonical-symlink') {
          const outside = path.join(f.base, 'outside-canonical-draft.json');
          await fs.writeFile(outside, canonicalBefore, 'utf8');
          await fs.symlink(outside, canonicalDraft);
        } else if (mode === 'canonical-directory') {
          await fs.mkdir(canonicalDraft);
        }
      }

      const project = await resolveCheckpointProjectIdentity(
        { root: f.root, space: f.space, cwd: f.project },
        core.workspace,
      );
      assert.deepEqual(
        await locateCheckpointDrafts(core.workspace, project, 'claude-code', 'claude-session-1'),
        { completeness: 'unknown', reasonCode: 'checkpoint_draft_locator_incomplete' },
      );
      assert.equal(await fs.readFile(locatorPath, 'utf8'), locatorBefore, 'lookup does not heal the locator');
      if (mode !== 'deleted-open-set-member') {
        assert.equal(await fs.readFile(memberPath, 'utf8'), memberBefore, 'lookup preserves the still-declared member');
      }

      const settings = JSON.parse(await fs.readFile(path.join(f.project, '.claude', 'settings.local.json'), 'utf8'));
      const command = settings.hooks.PreCompact.flatMap((group) => group.hooks ?? [])
        .find((entry) => entry.command.includes('hook-pre-compact')).command;
      const draftEntriesBefore = (await fs.readdir(paths.drafts)).sort();
      const result = spawnSync('/bin/sh', ['-c', command], {
        input: JSON.stringify(claudePayload(f.project)),
        encoding: 'utf8',
        env: { ...process.env, HOME: f.home },
        timeout: 8_000,
      });
      assert.equal(result.status, 0, mode);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
      assert.deepEqual((await fs.readdir(paths.drafts)).sort(), draftEntriesBefore, 'no minimal-shadow draft is created');
      assert.equal((await artifactFiles(f.root)).length, 0, 'no artifact is published');
      assert.deepEqual(
        await fs.readdir(path.join(paths.root, 'native-precompact-receipts')).catch((error) => {
          if (error.code === 'ENOENT') return [];
          throw error;
        }),
        [],
        'no completion receipt is published',
      );
      assert.equal(await fs.readFile(locatorPath, 'utf8'), locatorBefore, 'native lookup does not rewrite the locator');
      if (mode === 'deleted-open-set-member') {
        const stored = JSON.parse(await fs.readFile(canonicalDraft, 'utf8'));
        assert.equal(stored.finalization, undefined, 'the cooperative draft remains open');
      } else {
        assert.equal(await fs.readFile(memberPath, 'utf8'), memberBefore, 'native lookup does not reap the member');
      }

      const workspace = resolveWorkspace({ root: f.root, space: f.space, cwd: f.project });
      const rows = (await readActivationEvidence(workspace)).filter((row) => row.event === 'hook-pre-compact');
      assert.ok(rows.some((row) => row.status === 'observed-live-started'), mode);
      assert.ok(rows.some((row) => row.status === 'failed'), mode);
      assert.equal(rows.some((row) => row.status === 'observed-live-completed'), false, mode);
    });
  }
});

test('canonical draft symlinks and non-files make bounded fallback completeness unknown', async (t) => {
  for (const mode of ['symlink', 'directory']) {
    await t.test(mode, async (t) => {
      const f = await fixture(t, `fallback-${mode}`);
      const core = await openCore({ root: f.root, space: f.space, cwd: f.project });
      const paths = checkpointStorePaths(core.workspace);
      await fs.mkdir(paths.drafts, { recursive: true });
      const basename = 'draft_00000000-0000-4000-8000-000000000001.json';
      const planted = path.join(paths.drafts, basename);
      if (mode === 'symlink') {
        const outside = path.join(f.base, 'outside-draft.json');
        await fs.writeFile(outside, '{}', 'utf8');
        await fs.symlink(outside, planted);
      } else {
        await fs.mkdir(planted);
      }
      const project = await resolveCheckpointProjectIdentity(
        { root: f.root, space: f.space, cwd: f.project },
        core.workspace,
      );
      assert.deepEqual(
        await locateCheckpointDrafts(core.workspace, project, 'claude-code', 'claude-session-1'),
        { completeness: 'unknown', reasonCode: 'checkpoint_draft_locator_incomplete' },
      );
    });
  }
});

test('an existing over-limit/incomplete locator fails explicitly without shadowing or consuming cooperative state', async (t) => {
  const f = await fixture(t, 'locator-over-limit');
  const core = await openCore({ root: f.root, space: f.space, cwd: f.project });
  const target = await core.checkpoints.createDraft({
    runtime: 'claude-code',
    sessionId: 'claude-session-1',
    claims: { completed: ['must remain cooperative'], coverage: { complete: false, eventCount: 1 } },
  });
  const paths = checkpointStorePaths(core.workspace);
  for (let index = 0; index < CHECKPOINT_OPEN_DRAFT_MAX; index += 1) {
    const draftId = `draft_${crypto.randomUUID()}`;
    const extra = {
      ...target,
      draftId,
      claims: { ...target.claims, completed: [`extra-open-${index}`] },
    };
    await fs.writeFile(path.join(paths.drafts, `${draftId}.json`), canonicalCheckpointJson(extra), 'utf8');
  }
  const indexes = checkpointPrivateIndexPaths(core.workspace);
  const [locatorName] = await fs.readdir(indexes.draftLocators);
  const locatorPath = path.join(indexes.draftLocators, locatorName);
  const locator = JSON.parse(await fs.readFile(locatorPath, 'utf8'));
  locator.openSetComplete = false;
  await fs.writeFile(locatorPath, canonicalCheckpointJson(locator), 'utf8');
  await assert.rejects(
    core.checkpoints.createDraft({
      runtime: 'claude-code',
      sessionId: 'claude-session-1',
      claims: { completed: ['must fail explicitly'] },
    }),
    /checkpoint_draft_locator_incomplete/,
  );
  const before = (await fs.readdir(paths.drafts)).filter((name) => /^draft_[a-f0-9-]+\.json$/.test(name)).sort();

  const result = runHook({ ...f, payload: claudePayload(f.project) });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.deepEqual(
    (await fs.readdir(paths.drafts)).filter((name) => /^draft_[a-f0-9-]+\.json$/.test(name)).sort(),
    before,
    'unknown completeness creates no shadow draft',
  );
  assert.equal((await artifactFiles(f.root)).length, 0);
  const stored = JSON.parse(await fs.readFile(path.join(paths.drafts, `${target.draftId}.json`), 'utf8'));
  assert.equal(stored.finalization, undefined, 'cooperative state remains open rather than being silently consumed');
});

test('missing, stale, and tampered draft locators recover only when the bounded fallback is complete', async (t) => {
  for (const mode of ['missing', 'stale', 'tampered']) {
    await t.test(mode, async (t) => {
      const f = await fixture(t, `locator-${mode}`);
      const core = await openCore({ root: f.root, space: f.space, cwd: f.project });
      const draft = await core.checkpoints.createDraft({
        runtime: 'claude-code',
        sessionId: 'claude-session-1',
        claims: { completed: [`recover-${mode}`], coverage: { complete: false, eventCount: 1 } },
      });
      const indexes = checkpointPrivateIndexPaths(core.workspace);
      const [locatorName] = await fs.readdir(indexes.draftLocators);
      const locatorPath = path.join(indexes.draftLocators, locatorName);
      if (mode === 'missing') {
        await fs.rm(locatorPath);
      } else {
        const locator = JSON.parse(await fs.readFile(locatorPath, 'utf8'));
        if (mode === 'stale') {
          locator.open[0].contentSha256 = '0'.repeat(64);
        } else {
          const foreignProject = path.join(f.base, 'foreign-project');
          await fs.mkdir(foreignProject);
          const foreignCore = await openCore({ root: f.root, space: f.space, cwd: foreignProject });
          const foreign = await foreignCore.checkpoints.createDraft({
            runtime: 'codex',
            sessionId: 'foreign-session',
            claims: { completed: ['must never cross-bind'] },
          });
          locator.open[0] = {
            draftId: foreign.draftId,
            contentSha256: crypto.createHash('sha256').update(canonicalCheckpointJson(foreign)).digest('hex'),
          };
        }
        await fs.writeFile(locatorPath, canonicalCheckpointJson(locator), 'utf8');
      }

      const result = runHook({ ...f, payload: claudePayload(f.project) });
      assert.equal(result.status, 0, mode);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
      const stored = JSON.parse(await fs.readFile(path.join(checkpointStorePaths(core.workspace).drafts, `${draft.draftId}.json`), 'utf8'));
      assert.ok(stored.finalization?.artifactId, `${mode} locator did not hide the cooperative draft`);
      const artifact = await core.checkpoints.read(stored.finalization.artifactId);
      assert.deepEqual(artifact.state.completed, [`recover-${mode}`]);
      assert.equal(artifact.trigger.signal, 'native');
    });
  }
});

test('missing, stale, and tampered locators recover from the independent open-set even when global fallback is incomplete', async (t) => {
  for (const mode of ['missing', 'stale', 'tampered']) {
    await t.test(mode, async (t) => {
      const f = await fixture(t, `locator-incomplete-${mode}`);
      execFileSync(process.execPath, [CLI, 'install-hook', '--root', f.root, '--space', f.space, '--cwd', f.project], {
        encoding: 'utf8', env: { ...process.env, HOME: f.home },
      });
      const core = await openCore({ root: f.root, space: f.space, cwd: f.project });
      const target = await core.checkpoints.createDraft({
        runtime: 'claude-code',
        sessionId: 'claude-session-1',
        claims: { completed: [`preserve-${mode}`], coverage: { complete: false, eventCount: 1 } },
      });
      await writeFinalizedDraftNoise(core, target, 65, `fallback-${mode}`);

      const indexes = checkpointPrivateIndexPaths(core.workspace);
      const [locatorName] = await fs.readdir(indexes.draftLocators);
      const locatorPath = path.join(indexes.draftLocators, locatorName);
      if (mode === 'missing') {
        await fs.rm(locatorPath);
      } else {
        const locator = JSON.parse(await fs.readFile(locatorPath, 'utf8'));
        if (mode === 'stale') locator.open[0].contentSha256 = '0'.repeat(64);
        else locator.identityKey = 'f'.repeat(64);
        await fs.writeFile(locatorPath, canonicalCheckpointJson(locator), 'utf8');
      }

      const settings = JSON.parse(await fs.readFile(path.join(f.project, '.claude', 'settings.local.json'), 'utf8'));
      const command = settings.hooks.PreCompact.flatMap((group) => group.hooks ?? [])
        .find((entry) => entry.command.includes('hook-pre-compact')).command;
      const before = (await fs.readdir(checkpointStorePaths(core.workspace).drafts)).sort();
      const result = spawnSync('/bin/sh', ['-c', command], {
        input: JSON.stringify(claudePayload(f.project)),
        encoding: 'utf8',
        env: { ...process.env, HOME: f.home },
        timeout: 8_000,
      });
      assert.equal(result.status, 0, mode);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
      assert.deepEqual((await fs.readdir(checkpointStorePaths(core.workspace).drafts)).sort(), before, `${mode} created no shadow draft`);
      const stored = JSON.parse(await fs.readFile(path.join(checkpointStorePaths(core.workspace).drafts, `${target.draftId}.json`), 'utf8'));
      assert.ok(stored.finalization?.artifactId, `${mode} open-set did not recover the cooperative draft`);
      const artifact = await core.checkpoints.read(stored.finalization.artifactId);
      assert.deepEqual(artifact.state.completed, [`preserve-${mode}`]);
      assert.equal(artifact.trigger.signal, 'native');
      assert.equal((await artifactFiles(f.root)).length, 1, `${mode} persisted exactly one artifact`);

      const workspace = resolveWorkspace({ root: f.root, space: f.space, cwd: f.project });
      const rows = (await readActivationEvidence(workspace)).filter((row) => row.event === 'hook-pre-compact');
      assert.ok(rows.some((row) => row.status === 'observed-live-started'), mode);
      assert.ok(rows.some((row) => row.status === 'observed-live-completed'), mode);
      assert.equal(rows.some((row) => row.status === 'failed'), false, mode);
    });
  }
});

test('matching cooperative draft is finalized as-is and duplicate delivery produces no duplicate artifact', async (t) => {
  const f = await fixture(t, 'existing');
  const core = await openCore({ root: f.root, space: f.space, cwd: f.project });
  await core.checkpoints.createDraft({
    runtime: 'claude-code',
    sessionId: 'claude-session-1',
    claims: {
      objective: 'ship the adapter',
      completed: ['bounded normalization'],
      pending: ['run focused tests'],
      coverage: { complete: false, eventCount: 2 },
    },
  });
  const first = runHook({ ...f, payload: claudePayload(f.project) });
  const second = runHook({ ...f, payload: claudePayload(f.project) });
  assert.equal(first.status, 0);
  assert.equal(second.status, 0);
  assert.equal(first.stderr, '');
  assert.equal(second.stderr, '');

  const listed = await core.checkpoints.list();
  assert.equal(listed.length, 1, 'at-least-once duplicate delivery deduplicates to one immutable artifact');
  const artifact = await core.checkpoints.read(listed[0].id);
  assert.equal(artifact.trigger.signal, 'native');
  assert.equal(artifact.trigger.reasonCode, 'native_precompact_existing_draft');
  assert.equal(artifact.state.objective, 'ship the adapter');
  assert.deepEqual(artifact.state.completed, ['bounded normalization']);
});

test('same delivery key does not dedupe a newly opened cooperative state change', async (t) => {
  const f = await fixture(t, 'state-change');
  const core = await openCore({ root: f.root, space: f.space, cwd: f.project });
  await core.checkpoints.createDraft({
    runtime: 'claude-code',
    sessionId: 'claude-session-1',
    claims: { completed: ['first state'], coverage: { complete: false, eventCount: 1 } },
  });
  const first = runHook({ ...f, payload: claudePayload(f.project) });
  assert.equal(first.status, 0);

  await core.checkpoints.createDraft({
    runtime: 'claude-code',
    sessionId: 'claude-session-1',
    claims: { completed: ['second state'], coverage: { complete: false, eventCount: 2 } },
  });
  const second = runHook({ ...f, payload: claudePayload(f.project) });
  assert.equal(second.status, 0);

  const listed = await core.checkpoints.list();
  assert.equal(listed.length, 2, 'a newer open state is finalized instead of time-window deduplicated');
  const artifacts = await Promise.all(listed.map((item) => core.checkpoints.read(item.id)));
  assert.ok(artifacts.some((artifact) => artifact.state.completed.includes('first state')));
  assert.ok(artifacts.some((artifact) => artifact.state.completed.includes('second state')));
  assert.ok(artifacts.every((artifact) => artifact.trigger.signal === 'native'));
});

test('Codex PreCompact works with model/turn_id only and never creates a SessionEnd/summary/instructions fiction', async (t) => {
  const f = await fixture(t, 'codex');
  const result = runHook({ ...f, runtime: 'codex', payload: codexPayload(f.project, {
    compact_summary: 'must be ignored',
    custom_instructions: 'must be ignored',
    SessionEnd: true,
  }) });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  const files = await artifactFiles(f.root);
  assert.equal(files.length, 1);
  const raw = await fs.readFile(path.join(f.root, f.space, 'checkpoints', 'artifacts', files[0]), 'utf8');
  assert.match(raw, /Codex\.PreCompact/);
  assert.doesNotMatch(raw, /compact_summary|custom_instructions|SessionEnd|must be ignored|turn-9|gpt-5\.6-codex/);
});

test('oversized/malformed payload and persistence failure stay silent and exit 0', async (t) => {
  const f = await fixture(t, 'fail-open');
  const oversized = JSON.stringify({ ...claudePayload(f.project), unknown: 'x'.repeat(60 * 1024) });
  const tooLarge = runHook({ ...f, payload: oversized });
  assert.equal(tooLarge.status, 0);
  assert.equal(tooLarge.stdout, '');
  assert.equal(tooLarge.stderr, '');
  assert.equal((await artifactFiles(f.root)).length, 0);

  execFileSync(process.execPath, [CLI, 'init', '--root', f.root, '--space', f.space, '--cwd', f.project], {
    encoding: 'utf8', env: { ...process.env, HOME: f.home },
  });
  await fs.writeFile(path.join(f.root, f.space, 'checkpoints'), 'not-a-directory', 'utf8');
  const started = Date.now();
  const failed = runHook({ ...f, payload: claudePayload(f.project) });
  assert.equal(failed.status, 0);
  assert.equal(failed.stdout, '');
  assert.equal(failed.stderr, '');
  assert.ok(Date.now() - started < 3_500, 'failure is bounded below the host timeout envelope');
});

test('real installed Claude PreCompact path records started/completed evidence only after durable completion', async (t) => {
  const f = await fixture(t, 'activation');
  execFileSync(process.execPath, [CLI, 'install-hook', '--root', f.root, '--space', f.space, '--cwd', f.project], {
    encoding: 'utf8', env: { ...process.env, HOME: f.home },
  });
  const settings = JSON.parse(await fs.readFile(path.join(f.project, '.claude', 'settings.local.json'), 'utf8'));
  const command = settings.hooks.PreCompact.flatMap((group) => group.hooks ?? [])
    .find((entry) => entry.command.includes('hook-pre-compact')).command;
  const result = spawnSync('/bin/sh', ['-c', command], {
    input: JSON.stringify(claudePayload(f.project)),
    encoding: 'utf8',
    env: { ...process.env, HOME: f.home },
    timeout: 8_000,
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');

  const workspace = resolveWorkspace({ root: f.root, space: f.space, cwd: f.project });
  const rows = await readActivationEvidence(workspace);
  const precompact = rows.filter((row) => row.event === 'hook-pre-compact');
  assert.ok(precompact.some((row) => row.status === 'observed-live-started'));
  assert.ok(precompact.some((row) => row.status === 'observed-live-completed'));
  assert.equal(precompact.some((row) => row.status === 'failed'), false);
  const configured = rows.find((row) => row.status === 'configured');
  const completed = precompact.find((row) => row.status === 'observed-live-completed');
  assert.equal(completed.configuration.id, configured.configuration.id);
  assert.equal((await artifactFiles(f.root)).length, 1, 'completed evidence follows a durable artifact');
});

test('strict PreCompact deadline exits 0, records failed not completed, and persists no partial artifact', async (t) => {
  const f = await fixture(t, 'timeout');
  execFileSync(process.execPath, [CLI, 'install-hook', '--root', f.root, '--space', f.space, '--cwd', f.project], {
    encoding: 'utf8', env: { ...process.env, HOME: f.home },
  });
  const settings = JSON.parse(await fs.readFile(path.join(f.project, '.claude', 'settings.local.json'), 'utf8'));
  const command = settings.hooks.PreCompact.flatMap((group) => group.hooks ?? [])
    .find((entry) => entry.command.includes('hook-pre-compact')).command;
  const workspace = resolveWorkspace({ root: f.root, space: f.space, cwd: f.project });
  await fs.mkdir(path.dirname(workspace.lockPath), { recursive: true });
  await fs.writeFile(workspace.lockPath, `${process.pid}\n${new Date().toISOString()}\n`, 'utf8');
  const startedAt = Date.now();
  const result = spawnSync('/bin/sh', ['-c', command], {
    input: JSON.stringify(claudePayload(f.project, { session_id: 'timeout-session' })),
    encoding: 'utf8',
    env: { ...process.env, HOME: f.home, IHOW_PRECOMPACT_BUDGET_MS: '300' },
    timeout: 3_000,
  });
  await fs.rm(workspace.lockPath, { force: true });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.ok(Date.now() - startedAt < 1_500, 'watchdog returns well below the checkpoint lock timeout');
  assert.equal((await artifactFiles(f.root)).length, 0, 'interrupted persistence never exposes an artifact');
  const rows = (await readActivationEvidence(workspace)).filter((row) => row.event === 'hook-pre-compact');
  assert.ok(rows.some((row) => row.status === 'observed-live-started'));
  assert.ok(rows.some((row) => row.status === 'failed'));
  assert.equal(rows.some((row) => row.status === 'observed-live-completed'), false);
});

test('installed wiring is idempotent, preserves third-party PreCompact config, and Codex has no SessionEnd', async (t) => {
  const f = await fixture(t, 'wiring');
  const claudePath = path.join(f.project, '.claude', 'settings.local.json');
  await fs.mkdir(path.dirname(claudePath), { recursive: true });
  await fs.writeFile(claudePath, JSON.stringify({
    keep: true,
    hooks: { PreCompact: [{ matcher: 'manual', keepGroup: 7, hooks: [{ type: 'command', command: 'echo third-party-precompact', keepEntry: true }] }] },
  }, null, 2));
  const args = ['install-hook', '--root', f.root, '--space', f.space, '--cwd', f.project];
  execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, HOME: f.home } });
  const first = await fs.readFile(claudePath, 'utf8');
  execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, HOME: f.home } });
  assert.equal(await fs.readFile(claudePath, 'utf8'), first);
  const claude = JSON.parse(first);
  assert.equal(claude.keep, true);
  assert.ok(claude.hooks.PreCompact.flatMap((group) => group.hooks ?? []).some((entry) => entry.command === 'echo third-party-precompact'));
  assert.equal(claude.hooks.PreCompact.flatMap((group) => group.hooks ?? []).filter((entry) => entry.command.includes('hook-pre-compact')).length, 1);

  const codexHome = path.join(f.base, 'codex-home');
  await fs.mkdir(codexHome);
  execFileSync(process.execPath, [CLI, 'install-hook', '--runtime', 'codex', '--root', f.root, '--space', 'codex', '--cwd', f.project], {
    encoding: 'utf8', env: { ...process.env, HOME: f.home, CODEX_HOME: codexHome },
  });
  const codex = JSON.parse(await fs.readFile(path.join(codexHome, 'hooks.json'), 'utf8'));
  assert.ok(codex.hooks.PreCompact.flatMap((group) => group.hooks ?? []).some((entry) => entry.command.includes('hook-pre-compact')));
  assert.equal('SessionEnd' in codex.hooks, false);
  assert.equal(JSON.stringify(codex).includes('hook-session-end'), false);
});
