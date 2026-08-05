// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  inspectHermesCompactionWiring,
  inspectHermesInstallationWiring,
  inspectHermesLifecycleWiring,
} from '../src/hermes-wiring.ts';
import { automationMatrix } from '../src/automation-doctor.ts';
import { resolveWorkspace } from '../src/workspace.ts';
import {
  activationLedgerPath,
  appendActivationEvidence,
} from '../src/activation-ledger.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'src', 'cli.ts');

async function exists(target) {
  try { await fs.access(target); return true; } catch { return false; }
}

async function makeHermesShim(t, hermesHome) {
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-bin-'));
  t.after(() => fs.rm(bin, { recursive: true, force: true }));
  const shim = path.join(bin, 'hermes');
  const source = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const home = process.env.HERMES_HOME;
const args = process.argv.slice(2);
fs.mkdirSync(home, { recursive: true });
fs.appendFileSync(path.join(home, 'hermes-calls.jsonl'), JSON.stringify(args) + '\\n');
const state = path.join(home, '.ihow-test-mcp-added');
const config = path.join(home, 'config.yaml');
const readConfig = () => { try { return fs.readFileSync(config, 'utf8'); } catch { return ''; } };
if (args[0] === 'mcp' && args[1] === 'list') {
  if (fs.existsSync(state)) process.stdout.write('ihow-memory: connected\\n');
  process.exit(0);
}
if (args[0] === 'mcp' && args[1] === 'add') {
  fs.writeFileSync(state, 'added\\n');
  process.exit(0);
}
if (args[0] === 'mcp' && args[1] === 'remove') {
  fs.rmSync(state, { force: true });
  process.exit(0);
}
if (args[0] === 'mcp' && args[1] === 'test') {
  process.stdout.write(fs.existsSync(state) ? 'connected; tools discovered; ok\\n' : 'not found\\n');
  process.exit(0);
}
if (args[0] === 'gateway') process.exit(0);
if (args[0] === 'plugins' && args[1] === 'enable' && args[2] === 'ihow-memory') {
  const raw = readConfig();
  if (!raw.includes('plugins:')) {
    fs.writeFileSync(config, raw + 'plugins:\\n  enabled:\\n    - ihow-memory\\n  disabled: []\\n');
  }
  process.exit(0);
}
if (args[0] === 'config' && args[1] === 'set' && args[2] === 'memory.provider') {
  if (process.env.IHOW_TEST_HERMES_FAIL_PROVIDER === '1') {
    process.stderr.write('simulated provider selection failure\\n');
    process.exit(75);
  }
  const raw = readConfig();
  const next = /(^|\\n)memory:\\s*\\n(?:[ \\t].*(?:\\n|$))*/.test(raw)
    ? raw.replace(/((?:^|\\n)memory:\\s*\\n(?:[ \\t].*(?:\\n|$))*)/, (block) =>
        /(^|\\n)[ \\t]+provider:/.test(block)
          ? block.replace(/(^|\\n)([ \\t]+provider:)\\s*[^\\n]*/, '$1$2 ihow-memory-compaction')
          : block + '  provider: ihow-memory-compaction\\n')
    : raw + 'memory:\\n  provider: ihow-memory-compaction\\n';
  fs.writeFileSync(config, next);
  process.exit(0);
}
process.stderr.write('unexpected hermes shim call: ' + JSON.stringify(args) + '\\n');
process.exit(64);
`;
  await fs.writeFile(shim, source, { mode: 0o755 });
  await fs.chmod(shim, 0o755);
  return bin;
}

test('connect --runtime hermes installs and activates the packaged lifecycle and compaction adapters', async (t) => {
  const priorBridge = process.env.IHOW_MEMORY_HERMES_BRIDGE;
  const priorNode = process.env.IHOW_MEMORY_HERMES_NODE;
  delete process.env.IHOW_MEMORY_HERMES_BRIDGE;
  delete process.env.IHOW_MEMORY_HERMES_NODE;
  t.after(() => {
    if (priorBridge === undefined) delete process.env.IHOW_MEMORY_HERMES_BRIDGE;
    else process.env.IHOW_MEMORY_HERMES_BRIDGE = priorBridge;
    if (priorNode === undefined) delete process.env.IHOW_MEMORY_HERMES_NODE;
    else process.env.IHOW_MEMORY_HERMES_NODE = priorNode;
  });
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-user-home-'));
  const hermesHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-active-home-'));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-memory-root-'));
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-project-'));
  t.after(() => Promise.all([home, hermesHome, root, project].map(target => fs.rm(target, { recursive: true, force: true }))));
  await fs.writeFile(path.join(hermesHome, 'config.yaml'), 'sentinel: KEEP-ME\n', 'utf8');
  const bin = await makeHermesShim(t, hermesHome);
  const env = {
    ...process.env,
    HOME: home,
    HERMES_HOME: hermesHome,
    PATH: `${bin}:/usr/bin:/bin`,
    IHOW_HANDOFF_METRICS: '0',
    IHOW_MEMORY_HERMES_BRIDGE: '',
    IHOW_MEMORY_HERMES_NODE: '',
  };

  const output = JSON.parse(execFileSync(process.execPath, [
    cli, 'connect', '--runtime', 'hermes', '--root', root, '--space', 't', '--cwd', project, '--json',
  ], { cwd: project, encoding: 'utf8', env }));
  assert.equal(output.verified, true);

  const runtimeDir = path.join(root, 't', '.runtime');
  const expectedBridge = path.join(runtimeDir, 'hermes-bridge.js');
  assert.equal(await exists(expectedBridge), true, 'the atomically frozen runtime owns the durable bridge');

  const pluginRoot = path.join(hermesHome, 'plugins');
  const lifecycle = path.join(pluginRoot, 'ihow-memory');
  const compaction = path.join(pluginRoot, 'ihow-memory-compaction');
  for (const target of [
    path.join(lifecycle, '__init__.py'),
    path.join(lifecycle, 'plugin.yaml'),
    path.join(lifecycle, 'bridge.json'),
    path.join(compaction, '__init__.py'),
    path.join(compaction, 'plugin.yaml'),
    path.join(compaction, 'provider.py'),
    path.join(compaction, 'bridge.json'),
  ]) assert.equal(await exists(target), true, `installed regular file: ${target}`);

  for (const plugin of [lifecycle, compaction]) {
    const bridge = JSON.parse(await fs.readFile(path.join(plugin, 'bridge.json'), 'utf8'));
    assert.deepEqual(bridge, {
      schemaVersion: 1,
      node: process.execPath,
      bridge: expectedBridge,
      memoryRoot: path.join(root, 't', 'memory'),
      stateRoot: root,
    });
  }

  const config = await fs.readFile(path.join(hermesHome, 'config.yaml'), 'utf8');
  assert.match(config, /sentinel:\s*KEEP-ME/, 'unrelated Hermes config survives');
  assert.match(config, /plugins:[\s\S]*enabled:[\s\S]*-\s*ihow-memory(?:\s|$)/, 'lifecycle plugin is explicitly enabled');
  assert.match(config, /memory:[\s\S]*provider:\s*ihow-memory-compaction(?:\s|$)/, 'compaction provider is selected');

  const calls = (await fs.readFile(path.join(hermesHome, 'hermes-calls.jsonl'), 'utf8'))
    .trim().split('\n').map(line => JSON.parse(line));
  assert.ok(calls.some(args => args.join(' ') === 'plugins enable ihow-memory --no-allow-tool-override'));
  assert.ok(calls.some(args => args.join(' ') === 'config set memory.provider ihow-memory-compaction --force'));

  const wiring = await inspectHermesLifecycleWiring(hermesHome);
  assert.equal(wiring.state, 'current', JSON.stringify(wiring));
  assert.match(wiring.generationId ?? '', /^[a-f0-9]{64}$/);
  const compactionWiring = await inspectHermesCompactionWiring(hermesHome);
  assert.equal(compactionWiring.state, 'current', JSON.stringify(compactionWiring));
  assert.match(compactionWiring.generationId ?? '', /^[a-f0-9]{64}$/);
});

test('connect --runtime hermes refuses to replace an existing external memory provider before writing', async (t) => {
  const priorBridge = process.env.IHOW_MEMORY_HERMES_BRIDGE;
  delete process.env.IHOW_MEMORY_HERMES_BRIDGE;
  t.after(() => {
    if (priorBridge === undefined) delete process.env.IHOW_MEMORY_HERMES_BRIDGE;
    else process.env.IHOW_MEMORY_HERMES_BRIDGE = priorBridge;
  });
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-conflict-user-'));
  const hermesHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-conflict-active-'));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-conflict-root-'));
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-conflict-project-'));
  t.after(() => Promise.all([home, hermesHome, root, project].map(target => fs.rm(target, { recursive: true, force: true }))));
  const original = 'sentinel: KEEP-CONFLICT\nmemory:\n  provider: honcho\n';
  await fs.writeFile(path.join(hermesHome, 'config.yaml'), original, 'utf8');
  const bin = await makeHermesShim(t, hermesHome);
  const run = await import('node:child_process').then(({ spawnSync }) => spawnSync(process.execPath, [
    cli, 'connect', '--runtime', 'hermes', '--root', root, '--space', 't', '--cwd', project, '--json',
  ], {
    cwd: project,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      HERMES_HOME: hermesHome,
      PATH: `${bin}:/usr/bin:/bin`,
      IHOW_HANDOFF_METRICS: '0',
      IHOW_MEMORY_HERMES_BRIDGE: '',
    },
  }));
  assert.notEqual(run.status, 0, run.stdout || run.stderr);
  assert.match(run.stderr, /hermes_memory_provider_conflict:honcho/);
  assert.equal(await fs.readFile(path.join(hermesHome, 'config.yaml'), 'utf8'), original);
  assert.equal(await exists(path.join(hermesHome, 'plugins', 'ihow-memory')), false);
  assert.equal(await exists(path.join(hermesHome, 'plugins', 'ihow-memory-compaction')), false);
  const callsPath = path.join(hermesHome, 'hermes-calls.jsonl');
  const calls = await exists(callsPath)
    ? (await fs.readFile(callsPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    : [];
  assert.equal(calls.some(args => args[0] === 'plugins' || args[0] === 'config'), false);
  assert.equal(calls.some(args => args[0] === 'mcp' && args[1] !== 'list'), false);
});

test('connect --runtime hermes rejects an inline-flow external memory provider before writing', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-inline-user-'));
  const hermesHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-inline-active-'));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-inline-root-'));
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-inline-project-'));
  t.after(() => Promise.all([home, hermesHome, root, project].map(target => fs.rm(target, { recursive: true, force: true }))));
  const original = 'sentinel: KEEP-INLINE\nmemory: { provider: honcho, enabled: true }\n';
  await fs.writeFile(path.join(hermesHome, 'config.yaml'), original, 'utf8');
  const bin = await makeHermesShim(t, hermesHome);
  const run = await import('node:child_process').then(({ spawnSync }) => spawnSync(process.execPath, [
    cli, 'connect', '--runtime', 'hermes', '--root', root, '--space', 't', '--cwd', project, '--json',
  ], {
    cwd: project,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      HERMES_HOME: hermesHome,
      PATH: `${bin}:/usr/bin:/bin`,
      IHOW_HANDOFF_METRICS: '0',
      IHOW_MEMORY_HERMES_BRIDGE: '',
    },
  }));
  assert.notEqual(run.status, 0, run.stdout || run.stderr);
  assert.match(run.stderr, /hermes_memory_provider_conflict:honcho/);
  assert.equal(await fs.readFile(path.join(hermesHome, 'config.yaml'), 'utf8'), original);
  assert.equal(await exists(path.join(hermesHome, 'plugins', 'ihow-memory')), false);
  assert.equal(await exists(path.join(hermesHome, 'plugins', 'ihow-memory-compaction')), false);
  assert.equal(await exists(path.join(hermesHome, 'hermes-calls.jsonl')), false);
});

test('connect --runtime hermes rolls back config, MCP registration, and prior plugins when activation fails', async (t) => {
  const priorBridge = process.env.IHOW_MEMORY_HERMES_BRIDGE;
  delete process.env.IHOW_MEMORY_HERMES_BRIDGE;
  t.after(() => {
    if (priorBridge === undefined) delete process.env.IHOW_MEMORY_HERMES_BRIDGE;
    else process.env.IHOW_MEMORY_HERMES_BRIDGE = priorBridge;
  });
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-rollback-user-'));
  const hermesHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-rollback-active-'));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-rollback-root-'));
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-rollback-project-'));
  t.after(() => Promise.all([home, hermesHome, root, project].map(target => fs.rm(target, { recursive: true, force: true }))));
  const originalConfig = 'sentinel: KEEP-ROLLBACK\n';
  await fs.writeFile(path.join(hermesHome, 'config.yaml'), originalConfig, 'utf8');
  for (const [name, marker] of [['ihow-memory', 'OLD-LIFECYCLE'], ['ihow-memory-compaction', 'OLD-COMPACTION']]) {
    const target = path.join(hermesHome, 'plugins', name);
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'old-marker.txt'), `${marker}\n`, 'utf8');
  }
  const bin = await makeHermesShim(t, hermesHome);
  const run = await import('node:child_process').then(({ spawnSync }) => spawnSync(process.execPath, [
    cli, 'connect', '--runtime', 'hermes', '--root', root, '--space', 't', '--cwd', project, '--json',
  ], {
    cwd: project,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      HERMES_HOME: hermesHome,
      PATH: `${bin}:/usr/bin:/bin`,
      IHOW_HANDOFF_METRICS: '0',
      IHOW_MEMORY_HERMES_BRIDGE: '',
      IHOW_TEST_HERMES_FAIL_PROVIDER: '1',
    },
  }));
  assert.notEqual(run.status, 0, run.stdout || run.stderr);
  assert.match(run.stderr, /hermes_compaction_select_failed/);
  assert.equal(await fs.readFile(path.join(hermesHome, 'config.yaml'), 'utf8'), originalConfig);
  assert.equal(await fs.readFile(path.join(hermesHome, 'plugins', 'ihow-memory', 'old-marker.txt'), 'utf8'), 'OLD-LIFECYCLE\n');
  assert.equal(await fs.readFile(path.join(hermesHome, 'plugins', 'ihow-memory-compaction', 'old-marker.txt'), 'utf8'), 'OLD-COMPACTION\n');
  assert.equal(await exists(path.join(hermesHome, 'plugins', 'ihow-memory', 'bridge.json')), false);
  assert.equal(await exists(path.join(hermesHome, 'plugins', 'ihow-memory-compaction', 'bridge.json')), false);
  assert.equal(await exists(path.join(hermesHome, '.ihow-test-mcp-added')), false);
  const calls = (await fs.readFile(path.join(hermesHome, 'hermes-calls.jsonl'), 'utf8'))
    .trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.ok(calls.some(args => args[0] === 'mcp' && args[1] === 'add'));
  assert.ok(calls.some(args => args[0] === 'plugins' && args[1] === 'enable'));
  assert.ok(calls.some(args => args[0] === 'config' && args[1] === 'set'));
  assert.ok(calls.some(args => args[0] === 'mcp' && args[1] === 'remove'));
});

test('Doctor binds Hermes readiness to the composite lifecycle and compaction generation', async (t) => {
  const priorBridge = process.env.IHOW_MEMORY_HERMES_BRIDGE;
  const priorNode = process.env.IHOW_MEMORY_HERMES_NODE;
  delete process.env.IHOW_MEMORY_HERMES_BRIDGE;
  delete process.env.IHOW_MEMORY_HERMES_NODE;
  t.after(() => {
    if (priorBridge === undefined) delete process.env.IHOW_MEMORY_HERMES_BRIDGE;
    else process.env.IHOW_MEMORY_HERMES_BRIDGE = priorBridge;
    if (priorNode === undefined) delete process.env.IHOW_MEMORY_HERMES_NODE;
    else process.env.IHOW_MEMORY_HERMES_NODE = priorNode;
  });
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-doctor-user-'));
  const hermesHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-doctor-active-'));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-doctor-root-'));
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-doctor-project-'));
  t.after(() => Promise.all([home, hermesHome, root, project].map(target => fs.rm(target, { recursive: true, force: true }))));
  await fs.writeFile(path.join(hermesHome, 'config.yaml'), 'sentinel: KEEP-DOCTOR\n', 'utf8');
  const bin = await makeHermesShim(t, hermesHome);
  execFileSync(process.execPath, [
    cli, 'connect', '--runtime', 'hermes', '--root', root, '--space', 't', '--cwd', project, '--json',
  ], {
    cwd: project,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      HERMES_HOME: hermesHome,
      PATH: `${bin}:/usr/bin:/bin`,
      IHOW_HANDOFF_METRICS: '0',
      IHOW_MEMORY_HERMES_BRIDGE: '',
      IHOW_MEMORY_HERMES_NODE: '',
    },
  });

  const composite = await inspectHermesInstallationWiring(hermesHome);
  assert.equal(composite.state, 'current', JSON.stringify(composite));
  assert.match(composite.generationId ?? '', /^[a-f0-9]{64}$/);
  const workspace = resolveWorkspace({ root, space: 't', cwd: project });
  const ready = await automationMatrix(workspace, { command: process.execPath }, { hermesHome });
  const readyRow = ready.rows.find(row => row.runtime === 'Hermes');
  assert.equal(readyRow?.activationStatus, 'READY — WAITING FOR FIRST ACTIVITY');
  assert.equal(readyRow?.activationReasonCode, 'ACTIVATION_CONFIGURED_AWAITING_LIVE_ACTIVITY');

  await fs.appendFile(path.join(hermesHome, 'plugins', 'ihow-memory-compaction', 'provider.py'), '\n# drift\n');
  const drifted = await automationMatrix(workspace, { command: process.execPath }, { hermesHome });
  const driftedRow = drifted.rows.find(row => row.runtime === 'Hermes');
  assert.equal(driftedRow?.activationStatus, 'NEEDS REPAIR');
  assert.equal(driftedRow?.activationReasonCode, 'ACTIVATION_WIRING_GENERATION_UNCONFIRMED');
});

test('idempotent Hermes connect repairs stale composite activation evidence', async (t) => {
  const priorBridge = process.env.IHOW_MEMORY_HERMES_BRIDGE;
  const priorNode = process.env.IHOW_MEMORY_HERMES_NODE;
  delete process.env.IHOW_MEMORY_HERMES_BRIDGE;
  delete process.env.IHOW_MEMORY_HERMES_NODE;
  t.after(() => {
    if (priorBridge === undefined) delete process.env.IHOW_MEMORY_HERMES_BRIDGE;
    else process.env.IHOW_MEMORY_HERMES_BRIDGE = priorBridge;
    if (priorNode === undefined) delete process.env.IHOW_MEMORY_HERMES_NODE;
    else process.env.IHOW_MEMORY_HERMES_NODE = priorNode;
  });
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-evidence-user-'));
  const hermesHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-evidence-active-'));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-evidence-root-'));
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-evidence-project-'));
  t.after(() => Promise.all([home, hermesHome, root, project].map(target => fs.rm(target, { recursive: true, force: true }))));
  await fs.writeFile(path.join(hermesHome, 'config.yaml'), 'sentinel: KEEP-EVIDENCE\n', 'utf8');
  const bin = await makeHermesShim(t, hermesHome);
  const env = {
    ...process.env,
    HOME: home,
    HERMES_HOME: hermesHome,
    PATH: `${bin}:/usr/bin:/bin`,
    IHOW_HANDOFF_METRICS: '0',
    IHOW_MEMORY_HERMES_BRIDGE: '',
    IHOW_MEMORY_HERMES_NODE: '',
  };
  const args = [cli, 'connect', '--runtime', 'hermes', '--root', root, '--space', 't', '--cwd', project, '--json'];
  execFileSync(process.execPath, args, { cwd: project, encoding: 'utf8', env });

  const workspace = resolveWorkspace({ root, space: 't', cwd: project });
  await fs.rm(activationLedgerPath(workspace), { force: true });
  await appendActivationEvidence(workspace, {
    runtime: 'hermes',
    event: 'runtime-configured',
    source: 'connect',
    status: 'configured',
    dedupeKey: 'stale-composite-generation',
    configurationKey: 'stale-composite-generation',
  });
  await fs.appendFile(path.join(hermesHome, 'config.yaml'), [
    'mcp_servers:',
    '  ihow-memory:',
    `    command: ${process.execPath}`,
    '    args:',
    `      - ${path.join(root, 't', '.runtime', 'mcp', 'server.js')}`,
    '    env:',
    `      MEMORY_ROOT: ${path.join(root, 't', 'memory')}`,
    `      IHOW_MEMORY_STATE_ROOT: ${root}`,
    '',
  ].join('\n'), 'utf8');

  const second = JSON.parse(execFileSync(process.execPath, args, { cwd: project, encoding: 'utf8', env }));
  assert.equal(second.unchanged, true);
  const matrix = await automationMatrix(workspace, { command: process.execPath }, { hermesHome });
  const row = matrix.rows.find(candidate => candidate.runtime === 'Hermes');
  assert.equal(row?.activationStatus, 'READY — WAITING FOR FIRST ACTIVITY');
  assert.equal(row?.activationReasonCode, 'ACTIVATION_CONFIGURED_AWAITING_LIVE_ACTIVITY');
});
