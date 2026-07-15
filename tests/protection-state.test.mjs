// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { appendActivationEvidence } from '../src/activation-ledger.ts';
import { gitAnchors } from '../src/anchors.ts';
import { openCore } from '../src/core.ts';
import { appendFloorJournalOnce } from '../src/governance.ts';
import { checkpointStorePaths } from '../src/store/checkpoints.ts';

const ZERO_HASH = '0'.repeat(64);

async function fixture(t, label) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `ihow-stage4-protection-${label}-`)));
  const project = path.join(base, 'project');
  const root = path.join(base, 'store');
  await fs.mkdir(project, { recursive: true });
  const git = (args) => execFileSync('git', args, { cwd: project, encoding: 'utf8' }).trim();
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 't@example.com']);
  git(['config', 'user.name', 'T']);
  await fs.writeFile(path.join(project, 'seed.txt'), 'seed\n', 'utf8');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'seed']);
  const core = await openCore({ root, space: 't', cwd: project });
  t.after(async () => { await fs.rm(base, { recursive: true, force: true }); });
  return { base, project, root, core };
}

function anchors(project) {
  const live = gitAnchors(project);
  return async () => ({
    git: {
      repo: live.repo,
      branch: live.branch,
      head: live.head,
      dirty: false,
      statusHash: ZERO_HASH,
    },
    files: [],
    commands: [],
  });
}

async function completeThenPartial(f) {
  const completeDraft = await f.core.checkpoints.createDraft({
    runtime: 'codex',
    sessionId: 'protection-session',
    claims: {
      completed: ['complete protection state'],
      coverage: { complete: true, eventCount: 4 },
    },
  });
  const complete = await f.core.checkpoints.finalizeDraft(completeDraft.draftId, {
    trigger: { kind: 'explicit', signal: 'native', sourceEvent: 'unit-test', reasonCode: 'complete_checkpoint' },
  }, anchors(f.project));

  const partialDraft = await f.core.checkpoints.createDraft({
    runtime: 'codex',
    sessionId: 'protection-session',
    claims: {
      completed: ['partial protection state'],
      coverage: { complete: false, eventCount: 6, fromCheckpointId: complete.artifact.id },
    },
  });
  const partial = await f.core.checkpoints.finalizeDraft(partialDraft.draftId, {
    trigger: { kind: 'crash_floor', signal: 'shadow', sourceEvent: 'unit-test', reasonCode: 'stale_checkpoint_draft' },
    supersedes: complete.artifact.id,
  }, anchors(f.project));
  return { complete: complete.artifact, partial: partial.artifact };
}

test('status reports latest complete/partial/floor, stale material, bounded loss, and separate activation degradation', async (t) => {
  const f = await fixture(t, 'bounded');
  const { complete, partial } = await completeThenPartial(f);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const open = await f.core.checkpoints.createDraft({
    runtime: 'codex',
    sessionId: 'protection-session',
    claims: {
      pending: ['three persisted events newer than the partial'],
      coverage: { complete: false, eventCount: 9, fromCheckpointId: partial.id },
    },
  });
  await appendActivationEvidence(f.core.workspace, {
    runtime: 'codex',
    event: 'hook-pre-compact',
    source: 'native-hook',
    status: 'failed',
    dedupeKey: 'protection-state-failed-wiring',
  });

  const status = await f.core.status();
  const protection = status.protectionState;
  assert.equal(protection.lookup.status, 'ok');
  assert.equal(protection.latestComplete.artifactId, complete.id);
  assert.equal(protection.latestComplete.coverageComplete, true);
  assert.equal(protection.latestPartial.artifactId, partial.id);
  assert.equal(protection.latestPartial.triggerSignal, 'shadow');
  assert.equal(protection.latestFloor.kind, 'checkpoint');
  assert.equal(protection.latestFloor.artifactId, partial.id);
  assert.equal(protection.stale, true);
  assert.equal(protection.newerMaterial.draftId, open.draftId);
  assert.equal(protection.worstLossEvents, 3, '9 known events - 6 checkpointed events');
  assert.deepEqual(protection.activationDegradation, [{
    runtime: 'codex',
    observedAt: protection.activationDegradation[0].observedAt,
    reasonCode: 'activation_latest_event_failed',
  }]);
  assert.equal(protection.latestComplete.artifactId, complete.id, 'degradation does not erase safe checkpoint evidence');
  assert.equal(protection.latestPartial.artifactId, partial.id);
});

test('worst-loss is unknown when event lineage cannot prove a bounded count', async (t) => {
  const f = await fixture(t, 'unknown');
  const { complete } = await completeThenPartial(f);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await f.core.checkpoints.createDraft({
    runtime: 'codex',
    sessionId: 'unrelated-open-session',
    claims: {
      pending: ['newer material without fromCheckpointId or eventCount'],
      coverage: { complete: false },
    },
  });

  const protection = (await f.core.status()).protectionState;
  assert.equal(protection.latestComplete.artifactId, complete.id);
  assert.equal(protection.stale, true);
  assert.equal(protection.worstLossEvents, 'unknown');
});

test('degraded artifact snapshot cannot claim an exact safe protection state from remaining valid artifacts', async (t) => {
  const f = await fixture(t, 'artifact-degraded');
  const { complete, partial } = await completeThenPartial(f);
  const artifactPath = path.join(checkpointStorePaths(f.core.workspace).artifacts, `${partial.id}.json`);
  await fs.writeFile(artifactPath, '{corrupt-checkpoint', 'utf8');

  const protection = (await f.core.status()).protectionState;
  assert.equal(protection.lookup.status, 'degraded');
  assert.match(protection.lookup.reasonCode, /^checkpoint_[a-z0-9_]+$/);
  assert.equal(protection.latestComplete.artifactId, complete.id, 'validated evidence remains visible under degraded lookup');
  assert.equal(protection.latestPartial, null, 'the corrupt canonical artifact is never reported as valid evidence');
  assert.equal(protection.stale, 'unknown', 'incomplete artifact lookup cannot prove freshness');
  assert.equal(protection.worstLossEvents, 'unknown', 'incomplete artifact lookup cannot prove exact zero loss');
});

test('floor journal is exposed as a bounded metadata-only fallback when no crash checkpoint exists', async (t) => {
  const f = await fixture(t, 'journal-floor');
  await appendFloorJournalOnce(f.core.workspace, {
    text: 'status floor journal body must not be copied into protection evidence',
    runtime: 'codex',
    sessionId: 'floor-status-session',
  });

  const protection = (await f.core.status()).protectionState;
  assert.equal(protection.latestComplete, null);
  assert.equal(protection.latestPartial, null);
  assert.equal(protection.latestFloor.kind, 'journal');
  assert.equal(protection.latestFloor.runtime, 'codex');
  assert.equal(typeof protection.latestFloor.at, 'string');
  assert.ok(!JSON.stringify(protection.latestFloor).includes('status floor journal body'));
  assert.equal(protection.worstLossEvents, 'unknown');
});
