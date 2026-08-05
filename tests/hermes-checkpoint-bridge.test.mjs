// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '..');
const bridge = path.join(repo, 'src', 'hermes-bridge.ts');

function invokeBridge(event, env) {
  return spawnSync(process.execPath, ['--experimental-strip-types', bridge], {
    cwd: repo,
    encoding: 'utf8',
    input: `${JSON.stringify(event)}\n`,
    env: { ...process.env, ...env },
  });
}

async function roots(t) {
  const memoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-memory-'));
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-state-'));
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-project-'));
  t.after(async () => {
    await Promise.all([memoryRoot, stateRoot, project].map(dir => fs.rm(dir, { recursive: true, force: true })));
  });
  return { memoryRoot, stateRoot, project };
}

function event(overrides = {}) {
  return {
    schemaVersion: 1,
    runtime: 'hermes',
    cwd: '/repo',
    sessionId: 'session-1',
    platform: 'cli',
    observedAt: '2026-07-12T00:00:00.000Z',
    ...overrides,
  };
}

test('Hermes finalize creates a bounded session-end checkpoint and returns only its id', async (t) => {
  const { memoryRoot, stateRoot, project } = await roots(t);
  const run = invokeBridge(event({
    cwd: project,
    event: 'runtime.session_finalize',
    checkpointClaims: {
      objective: 'Finish Hermes runtime adapter',
      completed: ['Node bridge connected'],
      pending: ['Install in a real Hermes home'],
      decisions: ['Keep activation fail closed'],
      blockers: [],
      nextActions: ['Verify installed plugin lifecycle'],
      coverage: { complete: true, eventCount: 3 },
    },
  }), { MEMORY_ROOT: memoryRoot, IHOW_MEMORY_STATE_ROOT: stateRoot });

  assert.equal(run.status, 0, run.stderr);
  const output = JSON.parse(run.stdout.trim());
  assert.equal(output.ok, true);
  assert.match(output.checkpointId, /^cp_[a-f0-9]{64}$/);
  assert.equal(Object.keys(output).sort().join(','), 'checkpointId,ok');

  const artifactDir = path.join(memoryRoot, '_mcp', 'checkpoints', 'artifacts');
  const files = (await fs.readdir(artifactDir)).filter(name => /^cp_[a-f0-9]{64}\.json$/.test(name));
  assert.equal(files.length, 1);
  const artifact = JSON.parse(await fs.readFile(path.join(artifactDir, files[0]), 'utf8'));
  assert.equal(artifact.trigger.kind, 'session_end');
  assert.equal(artifact.trigger.signal, 'native');
  assert.equal(artifact.trigger.sourceEvent, 'hermes.on_session_finalize');
  assert.equal(artifact.session.runtime, 'hermes');
  assert.notEqual(artifact.session.sessionIdHash, 'session-1');
  assert.equal(artifact.state.objective, 'Finish Hermes runtime adapter');
});

test('Hermes finalize without exact receipt binding downgrades claimed complete coverage', async (t) => {
  const { memoryRoot, stateRoot, project } = await roots(t);
  const run = invokeBridge(event({
    cwd: project,
    event: 'runtime.session_finalize',
    checkpointClaims: {
      completed: ['cooperative draft claimed complete before receipt closure'],
      coverage: { complete: true, eventCount: 7 },
    },
  }), { MEMORY_ROOT: memoryRoot, IHOW_MEMORY_STATE_ROOT: stateRoot });

  assert.equal(run.status, 0, run.stderr || run.stdout);
  const artifact = await finalizedArtifact(memoryRoot);
  assert.equal(artifact.coverage.complete, false);
  assert.equal(artifact.coverage.eventCount, 7);
  assert.equal(artifact.trigger.reasonCode, 'hermes_lifecycle_checkpoint_receipt_binding_unavailable');
});

function receiptIdentity() {
  return {
    runtime: 'hermes',
    projectId: '1'.repeat(64),
    sessionHash: '2'.repeat(64),
    turnId: '3'.repeat(64),
    revision: 1,
  };
}

function openReceipt(identity = receiptIdentity()) {
  return {
    schemaVersion: 1,
    ...identity,
    inputSourceHash: `sha256:${'4'.repeat(64)}`,
    inputContentSha256: '5'.repeat(64),
    openedAt: '2026-07-18T12:00:00.000Z',
  };
}

function commitReceipt(identity = receiptIdentity(), deltaState = 'not_emitted') {
  const opened = openReceipt(identity);
  const { openedAt: _openedAt, ...inputEvidence } = opened;
  return {
    ...inputEvidence,
    finalSourceHash: `sha256:${'6'.repeat(64)}`,
    finalContentSha256: '7'.repeat(64),
    committedAt: '2026-07-18T12:00:01.000Z',
    deltaState,
  };
}

async function openTurnReceipt(env, cwd, identity = receiptIdentity()) {
  const run = invokeBridge(event({
    cwd,
    event: 'runtime.before_prompt',
    turnReceipt: { action: 'open', receipt: openReceipt(identity) },
  }), env);
  assert.equal(run.status, 0, run.stderr || run.stdout);
}

test('Hermes session_end with a not_emitted receipt downgrades claimed complete coverage', async (t) => {
  const { memoryRoot, stateRoot, project } = await roots(t);
  const env = { MEMORY_ROOT: memoryRoot, IHOW_MEMORY_STATE_ROOT: stateRoot };
  const identity = receiptIdentity();
  await openTurnReceipt(env, project, identity);

  const run = invokeBridge(event({
    cwd: project,
    event: 'runtime.session_end',
    turnReceipt: { action: 'commit', receipt: commitReceipt(identity, 'not_emitted') },
    checkpointClaims: {
      completed: ['host claimed complete while memory extraction remains open'],
      coverage: { complete: true, eventCount: 8 },
    },
  }), env);

  assert.equal(run.status, 0, run.stderr || run.stdout);
  const artifact = await finalizedArtifact(memoryRoot);
  assert.equal(artifact.coverage.complete, false);
  assert.equal(artifact.coverage.eventCount, 8);
  assert.equal(artifact.trigger.reasonCode, 'hermes_lifecycle_checkpoint_receipt_gaps');
});

test('Hermes session_end preserves claimed complete only when every known receipt is closed', async (t) => {
  const { memoryRoot, stateRoot, project } = await roots(t);
  const env = { MEMORY_ROOT: memoryRoot, IHOW_MEMORY_STATE_ROOT: stateRoot };
  const identity = receiptIdentity();
  await openTurnReceipt(env, project, identity);

  const run = invokeBridge(event({
    cwd: project,
    event: 'runtime.session_end',
    turnReceipt: { action: 'commit', receipt: commitReceipt(identity, 'explicit_none') },
    checkpointClaims: {
      completed: ['host complete and every known receipt is closed'],
      coverage: { complete: true, eventCount: 9 },
    },
  }), env);

  assert.equal(run.status, 0, run.stderr || run.stdout);
  const artifact = await finalizedArtifact(memoryRoot);
  assert.equal(artifact.coverage.complete, true);
  assert.equal(artifact.coverage.eventCount, 9);
  assert.equal(artifact.trigger.reasonCode, 'hermes_lifecycle_checkpoint');
});

test('known closed receipts never upgrade an originally partial checkpoint claim', async (t) => {
  const { memoryRoot, stateRoot, project } = await roots(t);
  const env = { MEMORY_ROOT: memoryRoot, IHOW_MEMORY_STATE_ROOT: stateRoot };
  const identity = receiptIdentity();
  await openTurnReceipt(env, project, identity);

  const run = invokeBridge(event({
    cwd: project,
    event: 'runtime.session_end',
    turnReceipt: { action: 'commit', receipt: commitReceipt(identity, 'explicit_none') },
    checkpointClaims: {
      pending: ['cooperative draft remains partial'],
      coverage: { complete: false, eventCount: 10 },
    },
  }), env);

  assert.equal(run.status, 0, run.stderr || run.stdout);
  const artifact = await finalizedArtifact(memoryRoot);
  assert.equal(artifact.coverage.complete, false);
  assert.equal(artifact.coverage.eventCount, 10);
  assert.equal(artifact.trigger.reasonCode, 'hermes_lifecycle_checkpoint');
});

test('Hermes session_end does not create a checkpoint without bounded claims', async (t) => {
  const { memoryRoot, stateRoot, project } = await roots(t);
  const run = invokeBridge(event({ cwd: project, event: 'runtime.session_end' }), {
    MEMORY_ROOT: memoryRoot,
    IHOW_MEMORY_STATE_ROOT: stateRoot,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout.trim()), { ok: true, checkpointSkipped: 'claims-unavailable' });
  const artifactDir = path.join(memoryRoot, '_mcp', 'checkpoints', 'artifacts');
  assert.deepEqual(await fs.readdir(artifactDir).catch(() => []), []);
});

test('Hermes checkpoint secret rejection fails open without persisting raw claims', async (t) => {
  const { memoryRoot, stateRoot, project } = await roots(t);
  const secret = 'password is hunter2';
  const run = invokeBridge(event({
    cwd: project,
    event: 'runtime.session_finalize',
    checkpointClaims: { completed: [secret] },
  }), { MEMORY_ROOT: memoryRoot, IHOW_MEMORY_STATE_ROOT: stateRoot });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout.trim()), { ok: true, checkpointSkipped: 'checkpoint-secret-rejected' });
  const allFiles = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(target);
      else allFiles.push(await fs.readFile(target, 'utf8').catch(() => ''));
    }
  }
  await walk(memoryRoot);
  assert.doesNotMatch(allFiles.join('\n'), /hunter2/);
});


test('observational after-turn events cannot create checkpoints', async (t) => {
  const { memoryRoot, stateRoot, project } = await roots(t);
  const run = invokeBridge(event({
    cwd: project,
    event: 'runtime.after_turn',
    checkpointClaims: { completed: ['must not persist'] },
  }), { MEMORY_ROOT: memoryRoot, IHOW_MEMORY_STATE_ROOT: stateRoot });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout.trim()), { ok: true });
  assert.deepEqual(await fs.readdir(path.join(memoryRoot, '_mcp', 'checkpoints', 'artifacts')).catch(() => []), []);
});

async function finalizedArtifact(memoryRoot) {
  const dir = path.join(memoryRoot, '_mcp', 'checkpoints', 'artifacts');
  const file = (await fs.readdir(dir)).find(name => /^cp_[a-f0-9]{64}\.json$/.test(name));
  assert.ok(file);
  return JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'));
}

test('file anchors hash the exact raw bytes for non-ASCII project files', async (t) => {
  const { memoryRoot, stateRoot, project } = await roots(t);
  const raw = Buffer.from([0x23, 0x20, 0xe4, 0xb8, 0xad, 0xe6, 0x96, 0x87, 0x0a, 0xff]);
  await fs.writeFile(path.join(project, 'README.md'), raw);
  const run = invokeBridge(event({
    cwd: project, event: 'runtime.session_finalize', checkpointClaims: { completed: ['raw byte anchor'] },
  }), { MEMORY_ROOT: memoryRoot, IHOW_MEMORY_STATE_ROOT: stateRoot });
  assert.equal(run.status, 0, run.stderr);
  const artifact = await finalizedArtifact(memoryRoot);
  const anchor = artifact.anchors.files.find(item => item.path === 'README.md');
  assert.equal(anchor.sha256, crypto.createHash('sha256').update(raw).digest('hex'));
});

test('file anchors skip symlinks and files beyond the bounded read ceiling', async (t) => {
  const { memoryRoot, stateRoot, project } = await roots(t);
  const outside = path.join(os.tmpdir(), `ihow-outside-${crypto.randomUUID()}.md`);
  t.after(() => fs.rm(outside, { force: true }));
  await fs.writeFile(outside, 'outside target', 'utf8');
  await fs.symlink(outside, path.join(project, 'README.md'));
  await fs.writeFile(path.join(project, 'package.json'), Buffer.alloc(1024 * 1024 + 1, 0x61));
  const run = invokeBridge(event({
    cwd: project, event: 'runtime.session_finalize', checkpointClaims: { completed: ['bounded anchor'] },
  }), { MEMORY_ROOT: memoryRoot, IHOW_MEMORY_STATE_ROOT: stateRoot });
  assert.equal(run.status, 0, run.stderr);
  const artifact = await finalizedArtifact(memoryRoot);
  assert.deepEqual(artifact.anchors.files, []);
});
