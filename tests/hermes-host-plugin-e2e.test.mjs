// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { openCore } from '../src/core.ts';

const repo = path.resolve(import.meta.dirname, '..');
const hermesRepo = process.env.IHOW_MEMORY_HERMES_CHECKOUT || path.join(os.homedir(), '.hermes', 'hermes-agent');
const hermesPython = process.env.IHOW_MEMORY_HERMES_PYTHON || path.join(hermesRepo, 'venv', 'bin', 'python');
const lifecyclePluginSource = path.join(repo, 'integrations', 'hermes', 'ihow-memory');
const compactionProviderSource = path.join(repo, 'integrations', 'hermes', 'ihow-memory-compaction');
const bridge = path.join(repo, 'src', 'hermes-bridge.ts');
const hostAvailable = fsSync.existsSync(path.join(hermesRepo, 'hermes_cli', 'plugins.py')) && fsSync.existsSync(hermesPython);

test('real Hermes keeps the lifecycle plugin while loading the explicit compaction provider', {
  skip: hostAvailable ? false : 'Hermes checkout unavailable; set IHOW_MEMORY_HERMES_CHECKOUT/IHOW_MEMORY_HERMES_PYTHON',
}, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-host-'));
  const memoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-memory-'));
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-state-'));
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-project-'));
  t.after(() => Promise.all([home, memoryRoot, stateRoot, project]
    .map(target => fs.rm(target, { recursive: true, force: true }))));
  const lifecyclePluginTarget = path.join(home, 'plugins', 'ihow-memory');
  const compactionProviderTarget = path.join(home, 'plugins', 'ihow-memory-compaction');
  await fs.mkdir(path.dirname(lifecyclePluginTarget), { recursive: true });
  await Promise.all([
    fs.cp(lifecyclePluginSource, lifecyclePluginTarget, { recursive: true }),
    fs.cp(compactionProviderSource, compactionProviderTarget, { recursive: true }),
  ]);
  await fs.writeFile(
    path.join(home, 'config.yaml'),
    'plugins:\n  enabled:\n    - ihow-memory\nmemory:\n  provider: ihow-memory-compaction\n',
    'utf8',
  );
  await fs.mkdir(path.join(memoryRoot, 'scopes'), { recursive: true });
  await fs.writeFile(
    path.join(memoryRoot, 'scopes', 'project.md'),
    '# Host loaded recall\n\nThe real Hermes PluginManager loaded this verified memory.\n',
    'utf8',
  );
  const git = (args) => execFileSync('git', args, { cwd: project, encoding: 'utf8' }).trim();
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 't@example.com']);
  git(['config', 'user.name', 'T']);
  await fs.writeFile(path.join(project, 'seed.txt'), 'seed\n', 'utf8');
  git(['add', 'seed.txt']);
  git(['commit', '-q', '-m', 'seed']);
  const core = await openCore({ memoryRoot, stateRoot, cwd: project });
  await core.rebuild();

  const script = String.raw`
import json
from plugins.memory import discover_memory_providers, load_memory_provider
from hermes_cli.plugins import PluginManager
mgr = PluginManager(); mgr.discover_and_load()
assert "ihow-memory" in mgr._plugins
assert mgr._plugins["ihow-memory"].enabled
provider = load_memory_provider("ihow-memory-compaction")
assert provider is not None
assert provider.name == "ihow-memory-compaction"
provider.initialize("host-s1", hermes_home=${JSON.stringify(home)}, platform="cli")
handoff = provider.on_pre_compress([{"role": "user", "content": "host compression body"}])
results = mgr.invoke_hook(
  "pre_llm_call", session_id="host-s1", user_message="Host loaded recall",
  conversation_history=[], is_first_turn=True, model="m", platform="cli", cwd=${JSON.stringify(project)},
)
print(json.dumps({
 "hooks": sorted(mgr._hooks),
 "results": results,
 "providers": discover_memory_providers(),
 "providerName": provider.name,
 "handoff": handoff,
}, sort_keys=True))
`;
  const run = spawnSync(hermesPython, ['-c', script], {
    cwd: project,
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
  assert.ok(output.providers.some(([name]) => name === 'ihow-memory-compaction'));
  assert.equal(output.providerName, 'ihow-memory-compaction');
  assert.match(output.handoff, /iHow checkpoint handoff:/);
  const receiptPath = path.join(memoryRoot, '_mcp', 'turn-receipts', 'v1.json');
  assert.equal(await fs.stat(receiptPath).then(() => true).catch(() => false), false,
    'missing B3 evidence must preserve recall without creating an OPEN receipt');
  const checkpoints = await core.checkpoints.list();
  assert.equal(checkpoints.length, 1, 'the loaded Provider persists one pre-compression checkpoint');
  const checkpoint = await core.checkpoints.read(checkpoints[0].id);
  assert.equal(checkpoint.trigger.sourceEvent, 'Hermes.MemoryProvider.on_pre_compress');
  assert.equal(checkpoint.coverage.complete, false);
});
