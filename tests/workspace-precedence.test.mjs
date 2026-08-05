// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureWorkspace, resolveWorkspace } from '../src/workspace.ts';

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

test('workspace options take precedence over ambient memory roots', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-workspace-precedence-'));
  const priorEnv = {
    MEMORY_ROOT: process.env.MEMORY_ROOT,
    IHOW_MEMORY_ROOT: process.env.IHOW_MEMORY_ROOT,
  };
  t.after(async () => {
    for (const [name, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await fs.rm(base, { recursive: true, force: true });
  });

  for (const ambientName of ['MEMORY_ROOT', 'IHOW_MEMORY_ROOT']) {
    delete process.env.MEMORY_ROOT;
    delete process.env.IHOW_MEMORY_ROOT;
    const suffix = ambientName.toLowerCase().replaceAll('_', '-');
    const decoyAmbientRoot = path.join(base, `decoy-${suffix}`);
    const explicitRoot = path.join(base, `explicit-${suffix}`);
    const space = `lane-a-${suffix}`;
    process.env[ambientName] = decoyAmbientRoot;

    const workspace = resolveWorkspace({ root: explicitRoot, space, cwd: base });
    await ensureWorkspace(workspace);

    assert.equal(workspace.mode, 'managed-space');
    assert.equal(workspace.root, path.resolve(explicitRoot));
    assert.equal(workspace.memoryDir, path.join(path.resolve(explicitRoot), space, 'memory'));
    assert.equal(await exists(workspace.indexManifestPath), true, 'explicit root receives workspace writes');
    assert.equal(await exists(decoyAmbientRoot), false, `${ambientName} decoy receives no writes`);
  }

  delete process.env.IHOW_MEMORY_ROOT;
  const ambientMemoryRoot = path.join(base, 'ambient-memory-root');
  process.env.MEMORY_ROOT = ambientMemoryRoot;
  const ambientWorkspace = resolveWorkspace({ cwd: base, stateRoot: path.join(base, 'ambient-state') });
  assert.equal(ambientWorkspace.mode, 'existing-memory-root');
  assert.equal(ambientWorkspace.memoryDir, path.resolve(ambientMemoryRoot));

  const explicitMemoryRoot = path.join(base, 'explicit-memory-root');
  const ignoredExplicitRoot = path.join(base, 'ignored-explicit-root');
  const decoyAmbientRoot = path.join(base, 'decoy-both-explicit');
  const stateRoot = path.join(base, 'explicit-memory-state');
  process.env.MEMORY_ROOT = decoyAmbientRoot;
  const memoryWorkspace = resolveWorkspace({
    memoryRoot: explicitMemoryRoot,
    root: ignoredExplicitRoot,
    stateRoot,
    space: 'both-explicit',
    cwd: base,
  });
  await ensureWorkspace(memoryWorkspace);

  assert.equal(memoryWorkspace.mode, 'existing-memory-root');
  assert.equal(memoryWorkspace.memoryDir, path.resolve(explicitMemoryRoot));
  assert.equal(memoryWorkspace.root, path.resolve(stateRoot));
  assert.equal(await exists(memoryWorkspace.indexManifestPath), true, 'explicit memoryRoot receives workspace writes');
  assert.equal(await exists(ignoredExplicitRoot), false, 'explicit root stays secondary to explicit memoryRoot');
  assert.equal(await exists(decoyAmbientRoot), false, 'ambient decoy receives no writes when memoryRoot is explicit');
});
