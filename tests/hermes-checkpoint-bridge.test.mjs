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
