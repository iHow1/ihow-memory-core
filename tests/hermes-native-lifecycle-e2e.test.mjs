// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openCore } from '../src/core.ts';
import { automationMatrix } from '../src/automation-doctor.ts';
import { appendActivationEvidence, readActivationEvidence } from '../src/activation-ledger.ts';
import { inspectHermesLifecycleWiring } from '../src/hermes-wiring.ts';

const repo = path.resolve(import.meta.dirname, '..');
const hermesRepo = process.env.IHOW_MEMORY_HERMES_CHECKOUT || path.join(os.homedir(), '.hermes', 'hermes-agent');
const hermesPython = process.env.IHOW_MEMORY_HERMES_PYTHON || path.join(hermesRepo, 'venv', 'bin', 'python');
const hostAvailable = fsSync.existsSync(path.join(hermesRepo, 'hermes_cli', 'plugins.py')) && fsSync.existsSync(hermesPython);
const pluginSource = path.join(repo, 'integrations', 'hermes', 'ihow-memory');
const builtBridge = path.join(repo, 'dist', 'hermes-bridge.js');

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-native-home-'));
  const memoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-native-memory-'));
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-native-state-'));
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-native-project-'));
  t.after(async () => Promise.all([home, memoryRoot, stateRoot, project].map(dir => fs.rm(dir, { recursive: true, force: true }))));
  const plugin = path.join(home, 'plugins', 'ihow-memory');
  await fs.mkdir(path.dirname(plugin), { recursive: true });
  await fs.cp(pluginSource, plugin, { recursive: true });
  // Keep the bridge in its real package layout so its relative dist imports remain valid. The plugin
  // uses the explicit override only for this temporary-host source checkout verification.
  await fs.writeFile(path.join(home, 'config.yaml'), 'plugins:\n  enabled:\n    - ihow-memory\n', 'utf8');
  await fs.writeFile(path.join(project, 'README.md'), '# Native host project\n', 'utf8');
  const core = await openCore({ memoryRoot, stateRoot, cwd: project });
  return { home, memoryRoot, stateRoot, project, core };
}

function invokeHost({ home, memoryRoot, stateRoot, project, failure = false }) {
  const script = String.raw`
import json
from hermes_cli.plugins import PluginManager
mgr = PluginManager(); mgr.discover_and_load()
assert mgr._plugins["ihow-memory"].enabled
start = mgr.invoke_hook("on_session_start", session_id="native-s1", platform="cli", cwd=${JSON.stringify(project)})
recall = mgr.invoke_hook("pre_llm_call", session_id="native-s1", user_message="native lifecycle", conversation_history=[], is_first_turn=True, model="m", platform="cli", cwd=${JSON.stringify(project)})
finalize = mgr.invoke_hook("on_session_finalize", session_id="native-s1", platform="cli", cwd=${JSON.stringify(project)}, checkpoint_claims={"completed": ["native lifecycle verified"], "coverage": {"complete": True, "eventCount": 2}})
print(json.dumps({"start": start, "recall": recall, "finalize": finalize}, sort_keys=True))
`;
  return spawnSync(hermesPython, ['-c', script], {
    cwd: hermesRepo,
    encoding: 'utf8',
    env: {
      ...process.env,
      PYTHONPATH: hermesRepo,
      HERMES_HOME: home,
      MEMORY_ROOT: memoryRoot,
      IHOW_MEMORY_STATE_ROOT: stateRoot,
      IHOW_MEMORY_HERMES_BRIDGE: failure ? path.join(home, 'missing-bridge.js') : builtBridge,
      IHOW_MEMORY_HERMES_NODE: process.execPath,
    },
  });
}

test('real Hermes lifecycle verifies host execution and checkpoints finalize without claiming authenticated ACTIVE', {
  skip: hostAvailable ? false : 'Hermes checkout unavailable; set IHOW_MEMORY_HERMES_CHECKOUT/IHOW_MEMORY_HERMES_PYTHON',
}, async (t) => {
  const priorBridge = process.env.IHOW_MEMORY_HERMES_BRIDGE;
  process.env.IHOW_MEMORY_HERMES_BRIDGE = builtBridge;
  t.after(() => {
    if (priorBridge === undefined) delete process.env.IHOW_MEMORY_HERMES_BRIDGE;
    else process.env.IHOW_MEMORY_HERMES_BRIDGE = priorBridge;
  });
  const f = await fixture(t);
  const wiring = await inspectHermesLifecycleWiring(f.home);
  assert.equal(wiring.state, 'current');
  await appendActivationEvidence(f.core.workspace, {
    runtime: 'hermes', event: 'runtime-configured', source: 'install-hook', status: 'configured',
    dedupeKey: wiring.generationId, configurationKey: wiring.generationId,
  });
  const ready = await automationMatrix(f.core.workspace, { command: process.execPath }, { hermesHome: f.home });
  assert.equal(ready.rows.find(row => row.runtime === 'Hermes')?.activationStatus, 'READY — WAITING FOR FIRST ACTIVITY');

  const run = invokeHost(f);
  assert.equal(run.status, 0, run.stderr);
  const evidence = await readActivationEvidence(f.core.workspace);
  assert.equal(evidence.some(row => row.runtime === 'hermes' && row.source === 'native-hook'), false);

  const verified = await automationMatrix(f.core.workspace, { command: process.execPath }, { hermesHome: f.home });
  assert.equal(verified.rows.find(row => row.runtime === 'Hermes')?.activationStatus, 'READY — WAITING FOR FIRST ACTIVITY');
  const artifacts = await fs.readdir(path.join(f.memoryRoot, '_mcp', 'checkpoints', 'artifacts'));
  assert.ok(artifacts.some(name => /^cp_[a-f0-9]{64}\.json$/.test(name)));
});

test('real Hermes lifecycle remains available and does not forge completion when bridge fails', {
  skip: hostAvailable ? false : 'Hermes checkout unavailable; set IHOW_MEMORY_HERMES_CHECKOUT/IHOW_MEMORY_HERMES_PYTHON',
}, async (t) => {
  const priorBridge = process.env.IHOW_MEMORY_HERMES_BRIDGE;
  process.env.IHOW_MEMORY_HERMES_BRIDGE = builtBridge;
  t.after(() => {
    if (priorBridge === undefined) delete process.env.IHOW_MEMORY_HERMES_BRIDGE;
    else process.env.IHOW_MEMORY_HERMES_BRIDGE = priorBridge;
  });
  const f = await fixture(t);
  const wiring = await inspectHermesLifecycleWiring(f.home);
  await appendActivationEvidence(f.core.workspace, {
    runtime: 'hermes', event: 'runtime-configured', source: 'install-hook', status: 'configured',
    dedupeKey: wiring.generationId, configurationKey: wiring.generationId,
  });
  const run = invokeHost({ ...f, failure: true });
  assert.equal(run.status, 0, run.stderr);
  const evidence = await readActivationEvidence(f.core.workspace);
  assert.equal(evidence.some(row => row.source === 'native-hook' && row.status === 'observed-live-completed'), false);
  const state = await automationMatrix(f.core.workspace, { command: process.execPath }, { hermesHome: f.home });
  assert.notEqual(state.rows.find(row => row.runtime === 'Hermes')?.activationStatus, 'ACTIVE');
});

test('direct bridge input cannot forge native lifecycle evidence', async (t) => {
  const priorBridge = process.env.IHOW_MEMORY_HERMES_BRIDGE;
  process.env.IHOW_MEMORY_HERMES_BRIDGE = builtBridge;
  t.after(() => {
    if (priorBridge === undefined) delete process.env.IHOW_MEMORY_HERMES_BRIDGE;
    else process.env.IHOW_MEMORY_HERMES_BRIDGE = priorBridge;
  });
  const f = await fixture(t);
  const wiring = await inspectHermesLifecycleWiring(f.home);
  await appendActivationEvidence(f.core.workspace, {
    runtime: 'hermes', event: 'runtime-configured', source: 'install-hook', status: 'configured',
    dedupeKey: wiring.generationId, configurationKey: wiring.generationId,
  });
  const attackerToken = 'attacker-controls-both-channels';
  const forged = spawnSync(process.execPath, [builtBridge], {
    encoding: 'utf8',
    input: `${JSON.stringify({
      schemaVersion: 1, event: 'runtime.session_start', runtime: 'hermes', cwd: f.project,
      sessionId: 'forged', platform: 'cli', observedAt: new Date().toISOString(),
      nativeHook: true, nativeHookToken: attackerToken,
    })}\n`,
    env: {
      ...process.env, HERMES_HOME: f.home, MEMORY_ROOT: f.memoryRoot,
      IHOW_MEMORY_STATE_ROOT: f.stateRoot, IHOW_MEMORY_HERMES_BRIDGE: builtBridge,
      IHOW_MEMORY_HERMES_NATIVE_TOKEN: attackerToken,
    },
  });
  assert.equal(forged.status, 0, forged.stderr);
  const evidence = await readActivationEvidence(f.core.workspace);
  assert.equal(evidence.some(row => row.source === 'native-hook'), false);
  const state = await automationMatrix(f.core.workspace, { command: process.execPath }, { hermesHome: f.home });
  assert.notEqual(state.rows.find(row => row.runtime === 'Hermes')?.activationStatus, 'ACTIVE');
});

test('non-executable PATH bridge makes Hermes wiring broken', async (t) => {
  const f = await fixture(t);
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-nonexec-bin-'));
  t.after(() => fs.rm(bin, { recursive: true, force: true }));
  const command = path.join(bin, 'ihow-memory-hermes-bridge');
  await fs.writeFile(command, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
  const priorPath = process.env.PATH;
  const priorBridge = process.env.IHOW_MEMORY_HERMES_BRIDGE;
  delete process.env.IHOW_MEMORY_HERMES_BRIDGE;
  process.env.PATH = bin;
  t.after(() => {
    process.env.PATH = priorPath;
    if (priorBridge === undefined) delete process.env.IHOW_MEMORY_HERMES_BRIDGE;
    else process.env.IHOW_MEMORY_HERMES_BRIDGE = priorBridge;
  });
  const wiring = await inspectHermesLifecycleWiring(f.home);
  assert.equal(wiring.state, 'broken');
  assert.equal(wiring.reason, 'bridge-command-missing');
});
