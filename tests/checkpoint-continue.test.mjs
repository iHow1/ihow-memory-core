// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendActivationEvidence } from '../src/activation-ledger.ts';
import { gitAnchors } from '../src/anchors.ts';
import { openCore } from '../src/core.ts';
import { appendFloorJournalOnce } from '../src/governance.ts';
import { buildHandoffPacket } from '../src/handoff.ts';
import { checkpointStorePaths } from '../src/store/checkpoints.ts';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'mcp', 'server.ts');
async function makeRepo(project, marker = 'seed') {
  await fs.mkdir(project, { recursive: true });
  const git = (args) => execFileSync('git', args, { cwd: project, encoding: 'utf8' }).trim();
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 't@example.com']);
  git(['config', 'user.name', 'T']);
  await fs.writeFile(path.join(project, 'seed.txt'), `${marker}\n`, 'utf8');
  git(['add', '-A']);
  git(['commit', '-q', '-m', marker]);
  return git;
}

async function plantCodexSession(home, { id, cwd, marker, mtimeMs = Date.now() }) {
  const dir = path.join(home, '.codex', 'sessions', '2026', '07', '14');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `rollout-${id}.jsonl`);
  const meta = JSON.stringify({
    timestamp: '2026-07-14T00:00:00Z',
    type: 'session_meta',
    payload: { id, cwd, git: {} },
  });
  const msg = (role, text) => JSON.stringify({
    timestamp: '2026-07-14T00:00:01Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role,
      content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
    },
  });
  await fs.writeFile(file, [
    meta,
    msg('user', '继续这个项目并核对现场状态。'.repeat(3)),
    msg('assistant', `${marker} transcript claim; verify it live before continuing. `.repeat(5)),
  ].join('\n') + '\n', 'utf8');
  await fs.utimes(file, new Date(mtimeMs), new Date(mtimeMs));
}

function checkpointAnchors(project) {
  const raw = (args) => execFileSync('git', args, { cwd: project, encoding: 'utf8' });
  const porcelain = raw(['status', '--porcelain=v1', '--untracked-files=all']);
  const cachedDiff = raw(['diff', '--no-ext-diff', '--binary', '--cached', 'HEAD', '--']);
  const unstagedDiff = raw(['diff', '--no-ext-diff', '--binary', '--']);
  const untracked = raw(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean).sort();
  const hash = crypto.createHash('sha256')
    .update(porcelain).update('\0')
    .update(cachedDiff).update('\0')
    .update(unstagedDiff).update('\0');
  for (const file of untracked) {
    const blob = raw(['hash-object', '--no-filters', '--', file]).trim();
    hash.update(file).update('\0').update(blob).update('\0');
  }
  const live = gitAnchors(project);
  return async () => ({
    git: {
      repo: live.repo,
      branch: live.branch,
      head: live.head,
      dirty: (live.dirtyCount ?? 0) > 0,
      statusHash: hash.digest('hex'),
    },
    files: [],
    commands: [],
  });
}

async function fixture(t, label) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `ihow-stage4-continue-${label}-`)));
  const home = path.join(base, 'home');
  const project = path.join(base, 'project');
  const root = path.join(base, 'store');
  await fs.mkdir(home, { recursive: true });
  const git = await makeRepo(project);
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const core = await openCore({ root, space: 't', cwd: project });
  t.after(async () => {
    process.env.HOME = previousHome;
    await fs.rm(base, { recursive: true, force: true });
  });
  return { base, home, project, root, git, core };
}

async function seedCheckpointStack(f) {
  const completeDraft = await f.core.checkpoints.createDraft({
    runtime: 'codex',
    sessionId: 'checkpoint-complete-session',
    claims: {
      objective: 'CHECKPOINT-COMPLETE-MARKER',
      completed: ['complete checkpoint claim'],
      evidence: [{ kind: 'test', ref: 'complete-evidence-ref' }],
      coverage: { complete: true, eventCount: 4 },
    },
  });
  const complete = await f.core.checkpoints.finalizeDraft(completeDraft.draftId, {
    trigger: { kind: 'explicit', signal: 'native', sourceEvent: 'unit-test', reasonCode: 'complete_checkpoint' },
  }, checkpointAnchors(f.project));

  const partialDraft = await f.core.checkpoints.createDraft({
    runtime: 'codex',
    sessionId: 'checkpoint-partial-session',
    claims: {
      objective: 'CHECKPOINT-PARTIAL-MARKER',
      pending: ['partial checkpoint claim'],
      evidence: [{ kind: 'test', ref: 'partial-evidence-ref' }],
      coverage: { complete: false, eventCount: 6, fromCheckpointId: complete.artifact.id },
    },
  });
  const partial = await f.core.checkpoints.finalizeDraft(partialDraft.draftId, {
    trigger: { kind: 'crash_floor', signal: 'shadow', sourceEvent: 'unit-test', reasonCode: 'stale_checkpoint_draft' },
    supersedes: complete.artifact.id,
  }, checkpointAnchors(f.project));
  return { complete: complete.artifact, partial: partial.artifact };
}

test('checkpoint-first ordering and metadata: complete > partial/shadow > transcript > floor journal', async (t) => {
  const f = await fixture(t, 'priority');
  const seeded = await seedCheckpointStack(f);
  await plantCodexSession(f.home, {
    id: 'transcript-session',
    cwd: f.project,
    marker: 'TRANSCRIPT-FALLBACK-MARKER',
  });
  await appendFloorJournalOnce(f.core.workspace, {
    text: 'FLOOR-JOURNAL-FALLBACK-MARKER low weight recovery claim.',
    runtime: 'codex',
    sessionId: 'floor-only-session',
    title: 'stage4 floor fallback',
  });
  await appendActivationEvidence(f.core.workspace, {
    runtime: 'codex',
    event: 'hook-pre-compact',
    source: 'native-hook',
    status: 'failed',
    dedupeKey: 'stage4-checkpoint-continue-degradation',
  });

  const packet = await buildHandoffPacket({
    cwd: f.project,
    workspace: f.core.workspace,
    limit: 10,
  });
  const sources = packet.candidates.map((candidate) => candidate.narrative.source);
  assert.deepEqual(sources.slice(0, 4), [
    'checkpoint-complete',
    'checkpoint-partial',
    'codex-transcript',
    'codex-floor-journal',
  ]);

  const complete = packet.candidates[0];
  assert.equal(complete.checkpoint.artifactId, seeded.complete.id);
  assert.equal(complete.checkpoint.classification, 'complete');
  assert.equal(complete.checkpoint.triggerSignal, 'native');
  assert.equal(complete.checkpoint.triggerKind, 'explicit');
  assert.equal(complete.checkpoint.coverage.complete, true);
  assert.deepEqual(complete.checkpoint.evidenceRefs, [{ kind: 'test', ref: 'complete-evidence-ref' }]);
  assert.equal(typeof complete.freshness.ageMs, 'number');
  assert.equal(complete.narrative.unverified, true, 'checkpoint claims stay UNVERIFIED');
  assert.match(complete.narrative.text, /CHECKPOINT-COMPLETE-MARKER/);
  assert.equal(complete.verdict.state, 'GREEN', complete.verdict.reason);
  assert.equal(complete.anchors.head, gitAnchors(f.project).head, 'exposed machine anchors are live');
  assert.equal(complete.activationDegradation.reasonCode, 'activation_latest_event_failed');

  const partial = packet.candidates[1];
  assert.equal(partial.checkpoint.artifactId, seeded.partial.id);
  assert.equal(partial.checkpoint.classification, 'partial');
  assert.equal(partial.checkpoint.triggerSignal, 'shadow');
  assert.equal(partial.checkpoint.coverage.complete, false);
  assert.equal(partial.narrative.unverified, true);
});

test('checkpoint verdict recomputes live anchors: HEAD drift, wrong checkout, and blank cwd never GREEN', async (t) => {
  const f = await fixture(t, 'verdict');
  await seedCheckpointStack(f);
  await plantCodexSession(f.home, {
    id: 'checkpoint-project-map',
    cwd: f.project,
    marker: 'PROJECT-MAP-TRANSCRIPT',
  });

  await fs.writeFile(path.join(f.project, 'drift.txt'), 'drift\n', 'utf8');
  f.git(['add', '-A']);
  f.git(['commit', '-q', '-m', 'drift']);
  const drifted = await buildHandoffPacket({ cwd: f.project, workspace: f.core.workspace, limit: 5 });
  assert.notEqual(drifted.candidates[0].verdict.state, 'GREEN');
  assert.match(drifted.candidates[0].verdict.reason, /drift/i);
  assert.notEqual(drifted.candidates[0].verdict.recordedHead, drifted.candidates[0].verdict.liveHead);

  const wrong = path.join(f.base, 'wrong-checkout');
  await makeRepo(wrong, 'wrong');
  const wrongPacket = await buildHandoffPacket({ cwd: wrong, workspace: f.core.workspace, limit: 5 });
  const wrongCheckpoint = wrongPacket.candidates.find((candidate) => candidate.checkpoint);
  assert.ok(wrongCheckpoint, 'transcript project mapping still finds the checkpoint');
  assert.notEqual(wrongCheckpoint.verdict.state, 'GREEN');

  const blank = await buildHandoffPacket({ cwd: '', workspace: f.core.workspace, limit: 5 });
  const blankCheckpoint = blank.candidates.find((candidate) => candidate.checkpoint);
  assert.ok(blankCheckpoint);
  assert.notEqual(blankCheckpoint.verdict.state, 'GREEN');
});

test('checkpoint verdict rejects same-HEAD worktree drift captured by statusHash', async (t) => {
  const f = await fixture(t, 'worktree-drift');
  await seedCheckpointStack(f);
  await fs.writeFile(path.join(f.project, 'seed.txt'), 'same HEAD, changed worktree\n', 'utf8');

  const packet = await buildHandoffPacket({ cwd: f.project, workspace: f.core.workspace, limit: 5 });
  const checkpoint = packet.candidates.find((candidate) => candidate.checkpoint);
  assert.ok(checkpoint);
  assert.equal(checkpoint.verdict.state, 'RED', checkpoint.verdict.reason);
  assert.match(checkpoint.verdict.reason, /worktree drift/i);
});

test('missing or corrupt checkpoint falls back honestly to transcript without fabricated checkpoint summary', async (t) => {
  await t.test('missing', async (t) => {
    const f = await fixture(t, 'missing');
    await plantCodexSession(f.home, {
      id: 'missing-checkpoint-transcript',
      cwd: f.project,
      marker: 'HONEST-TRANSCRIPT-ONLY',
    });
    const packet = await buildHandoffPacket({ cwd: f.project, workspace: f.core.workspace, limit: 5 });
    assert.equal(packet.checkpointLookup.status, 'missing');
    assert.equal(packet.candidates[0].narrative.source, 'codex-transcript');
    assert.match(packet.candidates[0].narrative.text, /HONEST-TRANSCRIPT-ONLY/);
    assert.ok(!packet.candidates.some((candidate) => candidate.checkpoint));
  });

  await t.test('corrupt', async (t) => {
    const f = await fixture(t, 'corrupt');
    const { complete } = await seedCheckpointStack(f);
    await plantCodexSession(f.home, {
      id: 'corrupt-checkpoint-transcript',
      cwd: f.project,
      marker: 'CORRUPT-CHECKPOINT-HONEST-FALLBACK',
    });
    const artifactPath = path.join(checkpointStorePaths(f.core.workspace).artifacts, `${complete.id}.json`);
    await fs.writeFile(artifactPath, '{corrupt-checkpoint', 'utf8');

    const packet = await buildHandoffPacket({ cwd: f.project, workspace: f.core.workspace, limit: 5 });
    assert.equal(packet.checkpointLookup.status, 'degraded');
    assert.match(packet.checkpointLookup.reasonCode, /^checkpoint_[a-z0-9_]+$/);
    assert.equal(packet.candidates[0].narrative.source, 'codex-transcript');
    assert.match(packet.candidates[0].narrative.text, /CORRUPT-CHECKPOINT-HONEST-FALLBACK/);
    assert.ok(!packet.candidates.some((candidate) => candidate.narrative.text.includes('CHECKPOINT-COMPLETE-MARKER')));
  });
});

test('memory.continue MCP consumes checkpoints and preserves the blank-cwd non-GREEN gate', async (t) => {
  const f = await fixture(t, 'mcp');
  await seedCheckpointStack(f);
  await plantCodexSession(f.home, {
    id: 'mcp-checkpoint-map',
    cwd: f.project,
    marker: 'MCP-TRANSCRIPT-LOWER-PRIORITY',
  });
  const lines = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory.continue', arguments: { cwd: f.project, limit: 5 } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'memory.continue', arguments: { cwd: '', limit: 5 } } }),
  ].join('\n') + '\n';
  const stdout = execFileSync(process.execPath, [SERVER, '--root', f.root, '--space', 't'], {
    cwd: f.project,
    encoding: 'utf8',
    input: lines,
    env: { ...process.env, HOME: f.home, IHOW_CAPTURE_FLOOR: '0' },
    timeout: 30_000,
  });
  const messages = stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const checkpointPacket = messages.find((message) => message.id === 2).result.structuredContent;
  assert.equal(checkpointPacket.candidates[0].narrative.source, 'checkpoint-complete');
  assert.equal(checkpointPacket.candidates[0].narrative.unverified, true);

  const blankPacket = messages.find((message) => message.id === 3).result.structuredContent;
  assert.notEqual(blankPacket.candidates[0].verdict.state, 'GREEN');
});
