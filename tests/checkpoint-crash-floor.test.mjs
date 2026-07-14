// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { canonicalCheckpointJson } from '../src/checkpoint-schema.ts';
import { openCore } from '../src/core.ts';
import { runCaptureFloorSweep } from '../src/floor.ts';
import {
  checkpointPrivateIndexPaths,
  checkpointStorePaths,
} from '../src/store/checkpoints.ts';

const STALE_MS = 30 * 60 * 1000;

const codexMeta = (id, cwd) => JSON.stringify({
  timestamp: '2026-07-14T00:00:00Z',
  type: 'session_meta',
  payload: { id, cwd, git: {} },
});
const codexMessage = (role, text) => JSON.stringify({
  timestamp: '2026-07-14T00:00:01Z',
  type: 'response_item',
  payload: {
    type: 'message',
    role,
    content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
  },
});

async function makeRepo(project) {
  await fs.mkdir(project, { recursive: true });
  const git = (args) => execFileSync('git', args, { cwd: project, encoding: 'utf8' }).trim();
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 't@example.com']);
  git(['config', 'user.name', 'T']);
  await fs.writeFile(path.join(project, 'seed.txt'), 'seed\n', 'utf8');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'seed']);
  return git(['rev-parse', '--short', 'HEAD']);
}

async function plantCodexSession(home, { id, cwd, mtimeMs }) {
  const dir = path.join(home, '.codex', 'sessions', '2026', '07', '14');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `rollout-${id}.jsonl`);
  const raw = [
    codexMeta(id, cwd),
    codexMessage('user', '继续完成 crash floor 集成。'.repeat(3)),
    codexMessage('assistant', 'CHECKPOINT-FLOOR-TRANSCRIPT 继续验证并收口。'.repeat(5)),
  ].join('\n') + '\n';
  await fs.writeFile(file, raw, 'utf8');
  await fs.utimes(file, new Date(mtimeMs), new Date(mtimeMs));
}

async function plantHermesSession(home, { id, cwd, mtimeMs }) {
  const dir = path.join(home, '.hermes', 'sessions');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `session_${id}.json`);
  await fs.writeFile(file, JSON.stringify({
    session_id: id,
    messages: [
      { role: 'user', content: '继续完成 Hermes crash floor 集成。'.repeat(3) },
      {
        role: 'assistant',
        content: 'HERMES-CHECKPOINT-FLOOR 继续验证并收口。'.repeat(5),
        tool_calls: [{
          function: {
            name: 'terminal',
            arguments: JSON.stringify({ workdir: cwd, command: 'git status --short' }),
          },
        }],
      },
    ],
  }), 'utf8');
  await fs.utimes(file, new Date(mtimeMs), new Date(mtimeMs));
}

async function fixture(t, label) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `ihow-stage4-floor-${label}-`)));
  const home = path.join(base, 'home');
  const project = path.join(base, 'project');
  const root = path.join(base, 'store');
  await fs.mkdir(home, { recursive: true });
  const head = await makeRepo(project);
  const priorHome = process.env.HOME;
  process.env.HOME = home;
  const core = await openCore({ root, space: 't', cwd: project });
  t.after(async () => {
    process.env.HOME = priorHome;
    await fs.rm(base, { recursive: true, force: true });
  });
  return { base, home, project, root, head, core };
}

async function staleDraftFixture(t, label, claims = {}) {
  const f = await fixture(t, label);
  const sessionId = `codex-${label}`;
  const draft = await f.core.checkpoints.createDraft({
    runtime: 'codex',
    sessionId,
    claims: {
      objective: 'finish Stage 4 crash floor',
      completed: ['CHECKPOINT-DRAFT-CLAIM'],
      pending: ['run focused verification'],
      evidence: [{ kind: 'test', ref: 'tests/checkpoint-crash-floor.test.mjs' }],
      coverage: { complete: true, eventCount: 2 },
      ...claims,
    },
  });
  const sweepNow = Date.parse(draft.updatedAt) + STALE_MS + 1;
  await plantCodexSession(f.home, {
    id: sessionId,
    cwd: f.project,
    mtimeMs: sweepNow - STALE_MS - 1,
  });
  return { ...f, sessionId, draft, sweepNow };
}

async function artifacts(core) {
  const listed = await core.checkpoints.list({ limit: 100 });
  return await Promise.all(listed.filter((item) => item.integrity === 'valid').map((item) => core.checkpoints.read(item.id)));
}

test('stale valid draft becomes one bounded partial shadow checkpoint with live anchors', async (t) => {
  const f = await staleDraftFixture(t, 'stale-valid');
  const result = await runCaptureFloorSweep(f.core.workspace, { now: f.sweepNow });

  assert.equal(result.checkpointed, 1, 'the checkpoint floor finalizes one stale draft');
  assert.ok(result.checkpointOutcomes.some((row) => row.outcome === 'checkpointed-partial'));
  const [artifact] = await artifacts(f.core);
  assert.ok(artifact, 'immutable checkpoint artifact exists');
  assert.equal(artifact.trigger.kind, 'crash_floor');
  assert.equal(artifact.trigger.signal, 'shadow');
  assert.equal(artifact.trigger.reasonCode, 'stale_checkpoint_draft');
  assert.equal(artifact.coverage.complete, false, 'crash floor can never claim complete coverage');
  assert.deepEqual(artifact.state.completed, ['CHECKPOINT-DRAFT-CLAIM']);
  assert.deepEqual(artifact.evidence, [{ kind: 'test', ref: 'tests/checkpoint-crash-floor.test.mjs' }]);
  assert.equal(artifact.anchors.git?.head, f.head, 'git HEAD is recomputed live at floor time');
  assert.equal(artifact.anchors.git?.branch, 'main');
});

test('fresh draft is not finalized by the checkpoint crash floor', async (t) => {
  const f = await staleDraftFixture(t, 'fresh');
  const now = Date.parse(f.draft.updatedAt) + 60_000;
  await plantCodexSession(f.home, {
    id: f.sessionId,
    cwd: f.project,
    mtimeMs: now - STALE_MS - 1,
  });
  const result = await runCaptureFloorSweep(f.core.workspace, {
    now,
  });

  assert.equal(result.checkpointed, 0);
  assert.ok(result.checkpointOutcomes.some((row) => row.outcome === 'skipped-checkpoint-fresh'));
  assert.equal((await artifacts(f.core)).length, 0);
});

test('Hermes stale draft resolves its tool-call project without constructing handoff anchors', async (t) => {
  const f = await fixture(t, 'hermes-stale');
  const sessionId = 'hermes-stage4-session';
  const draft = await f.core.checkpoints.createDraft({
    runtime: 'hermes',
    sessionId,
    claims: {
      completed: ['HERMES-DRAFT-CLAIM'],
      coverage: { complete: false, eventCount: 1 },
    },
  });
  const now = Date.parse(draft.updatedAt) + STALE_MS + 1;
  await plantHermesSession(f.home, {
    id: sessionId,
    cwd: f.project,
    mtimeMs: now - STALE_MS - 1,
  });

  const result = await runCaptureFloorSweep(f.core.workspace, { now });
  assert.equal(result.checkpointed, 1);
  const [artifact] = await artifacts(f.core);
  assert.equal(artifact.session.runtime, 'hermes');
  assert.deepEqual(artifact.state.completed, ['HERMES-DRAFT-CLAIM']);
  assert.equal(artifact.anchors.git?.head, f.head);
});

for (const mode of ['corrupt', 'secret', 'symlink', 'directory', 'over-limit', 'ambiguous']) {
  test(`unsafe ${mode} draft state produces no artifact and only a stable non-sensitive signal`, async (t) => {
    const f = await staleDraftFixture(t, `reject-${mode}`);
    const paths = checkpointStorePaths(f.core.workspace);
    const draftPath = path.join(paths.drafts, `${f.draft.draftId}.json`);
    const secret = 'sk-stage4-floor-secret-value-123456789';

    if (mode === 'corrupt') {
      await fs.writeFile(draftPath, '{not-json', 'utf8');
    } else if (mode === 'secret') {
      const unsafe = structuredClone(f.draft);
      unsafe.claims.completed = [`password is ${secret}`];
      await fs.writeFile(draftPath, canonicalCheckpointJson(unsafe), 'utf8');
    } else if (mode === 'symlink') {
      const target = path.join(f.base, 'outside-draft.json');
      await fs.writeFile(target, canonicalCheckpointJson(f.draft), 'utf8');
      await fs.rm(draftPath);
      await fs.symlink(target, draftPath);
    } else if (mode === 'directory') {
      await fs.rm(draftPath);
      await fs.mkdir(draftPath);
    } else if (mode === 'over-limit') {
      await fs.writeFile(draftPath, 'x'.repeat(40 * 1024), 'utf8');
    } else {
      const indexes = checkpointPrivateIndexPaths(f.core.workspace);
      const [locatorName] = await fs.readdir(indexes.draftLocators);
      const locatorPath = path.join(indexes.draftLocators, locatorName);
      const locator = JSON.parse(await fs.readFile(locatorPath, 'utf8'));
      locator.open = [];
      locator.openSetComplete = true;
      await fs.writeFile(locatorPath, canonicalCheckpointJson(locator), 'utf8');
    }

    const result = await runCaptureFloorSweep(f.core.workspace, { now: f.sweepNow });
    assert.equal(result.checkpointed, 0, mode);
    assert.equal((await artifacts(f.core)).length, 0, mode);
    const failure = result.checkpointOutcomes.find((row) => row.outcome === 'checkpoint-error');
    assert.ok(failure, `${mode}: stable failure signal returned`);
    assert.match(failure.reasonCode, /^checkpoint_[a-z0-9_]+$/);
    assert.ok(!JSON.stringify(failure).includes(secret), 'failure signal carries no rejected bytes');
  });
}

test('unchanged sweep is idempotent, while newer material state supersedes the prior partial', async (t) => {
  const f = await staleDraftFixture(t, 'supersede');
  const first = await runCaptureFloorSweep(f.core.workspace, { now: f.sweepNow });
  assert.equal(first.checkpointed, 1);
  const [firstArtifact] = await artifacts(f.core);

  const repeated = await runCaptureFloorSweep(f.core.workspace, { now: f.sweepNow + 1 });
  assert.equal(repeated.checkpointed, 0, 'same open-state snapshot cannot publish twice');
  assert.equal((await artifacts(f.core)).length, 1);

  const nextDraft = await f.core.checkpoints.createDraft({
    runtime: 'codex',
    sessionId: f.sessionId,
    claims: {
      completed: ['NEW-MATERIAL-AFTER-PARTIAL'],
      coverage: { complete: false, eventCount: 5, fromCheckpointId: firstArtifact.id },
    },
  });
  const nextNow = Date.parse(nextDraft.updatedAt) + STALE_MS + 1;
  const next = await runCaptureFloorSweep(f.core.workspace, { now: nextNow });
  assert.equal(next.checkpointed, 1, 'new material can create a new partial');
  const all = await artifacts(f.core);
  assert.equal(all.length, 2);
  const superseding = all.find((artifact) => artifact.id !== firstArtifact.id);
  assert.equal(superseding.supersedes, firstArtifact.id);
  assert.deepEqual(superseding.state.completed, ['NEW-MATERIAL-AFTER-PARTIAL']);
});

test('checkpoint floor stays fail-open to the host while artifact persistence remains fail-closed', async (t) => {
  const f = await staleDraftFixture(t, 'fail-open');
  const paths = checkpointStorePaths(f.core.workspace);
  await fs.rm(paths.artifacts, { recursive: true, force: true });
  await fs.writeFile(paths.artifacts, 'not-a-directory', 'utf8');

  let result;
  await assert.doesNotReject(async () => {
    result = await runCaptureFloorSweep(f.core.workspace, { now: f.sweepNow });
  }, 'floor errors never escape into the host process');
  assert.equal(result.checkpointed, 0);
  assert.ok(result.checkpointOutcomes.some((row) => row.outcome === 'checkpoint-error'));
  const storedDraft = JSON.parse(await fs.readFile(
    path.join(paths.drafts, `${f.draft.draftId}.json`),
    'utf8',
  ));
  assert.equal(storedDraft.finalization, undefined, 'failed persistence did not publish a false completion marker');
});
