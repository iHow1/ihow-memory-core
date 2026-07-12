// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openCore } from '../src/core.ts';

const repo = path.resolve(import.meta.dirname, '..');
const hermesRepo = path.join(os.homedir(), '.hermes', 'hermes-agent');
const pluginSource = path.join(repo, 'integrations', 'hermes', 'ihow-memory');
const bridge = path.join(repo, 'src', 'hermes-bridge.ts');

test('real Hermes PluginManager discovers the isolated plugin and invokes bounded recall', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-host-'));
  const memoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-memory-'));
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-state-'));
  const pluginTarget = path.join(home, 'plugins', 'ihow-memory');
  await fs.mkdir(path.dirname(pluginTarget), { recursive: true });
  await fs.cp(pluginSource, pluginTarget, { recursive: true });
  await fs.writeFile(path.join(home, 'config.yaml'), 'plugins:\n  enabled:\n    - ihow-memory\n', 'utf8');
  await fs.mkdir(path.join(memoryRoot, 'scopes'), { recursive: true });
  await fs.writeFile(
    path.join(memoryRoot, 'scopes', 'project.md'),
    '# Host loaded recall\n\nThe real Hermes PluginManager loaded this verified memory.\n',
    'utf8',
  );
  const core = await openCore({ memoryRoot, stateRoot, cwd: '/repo' });
  await core.rebuild();

  const script = String.raw`
import json
from hermes_cli.plugins import PluginManager
mgr = PluginManager(); mgr.discover_and_load()
assert "ihow-memory" in mgr._plugins
assert mgr._plugins["ihow-memory"].enabled
results = mgr.invoke_hook(
  "pre_llm_call", session_id="host-s1", user_message="Host loaded recall",
  conversation_history=[], is_first_turn=True, model="m", platform="cli", cwd="/repo",
)
print(json.dumps({"hooks": sorted(mgr._hooks), "results": results}, sort_keys=True))
`;
  const run = spawnSync(path.join(hermesRepo, 'venv', 'bin', 'python'), ['-c', script], {
    cwd: hermesRepo,
    encoding: 'utf8',
    env: {
      ...process.env,
      PYTHONPATH: hermesRepo,
      HERMES_HOME: home,
      MEMORY_ROOT: memoryRoot,
      IHOW_MEMORY_STATE_ROOT: stateRoot,
      IHOW_MEMORY_HERMES_BRIDGE: bridge,
      IHOW_MEMORY_HERMES_NODE: process.execPath,
    },
  });

  assert.equal(run.status, 0, run.stderr);
  const output = JSON.parse(run.stdout.trim());
  assert.ok(output.hooks.includes('pre_llm_call'));
  assert.equal(output.results.length, 1);
  assert.equal(typeof output.results[0].context, 'string');
  assert.match(output.results[0].context, /Host loaded recall|real Hermes PluginManager/i);
});
