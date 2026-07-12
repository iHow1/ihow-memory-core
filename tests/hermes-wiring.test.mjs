// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openCore } from '../src/core.ts';
import {
  inspectHermesLifecycleWiring,
  hermesLifecycleConfigurationKey,
} from '../src/hermes-wiring.ts';
import { automationMatrix } from '../src/automation-doctor.ts';
import { appendActivationEvidence } from '../src/activation-ledger.ts';

const repo = path.resolve(import.meta.dirname, '..');
const pluginSource = path.join(repo, 'integrations', 'hermes', 'ihow-memory');
const bridgeSource = path.join(repo, 'dist', 'hermes-bridge.js');

async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-home-'));
  const memoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-memory-root-'));
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-state-root-'));
  const core = await openCore({ memoryRoot, stateRoot, cwd: repo });
  return { home, core };
}

async function installFixture(home, enabled = true) {
  const plugin = path.join(home, 'plugins', 'ihow-memory');
  await fs.mkdir(path.dirname(plugin), { recursive: true });
  await fs.cp(pluginSource, plugin, { recursive: true });
  await fs.copyFile(bridgeSource, path.join(plugin, 'hermes-bridge.js'));
  await fs.writeFile(path.join(home, 'config.yaml'), enabled
    ? 'plugins:\n  enabled:\n    - ihow-memory\n'
    : 'plugins:\n  enabled: []\n', 'utf8');
}

test('Hermes wiring is missing until the packaged plugin is installed and enabled', async () => {
  const { home } = await fixture();
  assert.deepEqual(await inspectHermesLifecycleWiring(home), { state: 'missing' });
  await installFixture(home, false);
  const disabled = await inspectHermesLifecycleWiring(home);
  assert.equal(disabled.state, 'broken');
  assert.match(disabled.reason ?? '', /not-enabled/);
});

test('Hermes wiring generation is content-bound and detects plugin tampering', async () => {
  const { home } = await fixture();
  await installFixture(home);
  const current = await inspectHermesLifecycleWiring(home);
  assert.equal(current.state, 'current');
  assert.match(current.generationId ?? '', /^[a-f0-9]{64}$/);
  assert.equal(current.generationId, await hermesLifecycleConfigurationKey(home));

  await fs.appendFile(path.join(home, 'plugins', 'ihow-memory', '__init__.py'), '\n# tampered\n');
  const changed = await inspectHermesLifecycleWiring(home);
  assert.equal(changed.state, 'current');
  assert.notEqual(changed.generationId, current.generationId);
});

test('automationMatrix receives real Hermes wiring and refuses READY without matching configured evidence', async () => {
  const { home, core } = await fixture();
  await installFixture(home);
  const wiring = await inspectHermesLifecycleWiring(home);
  assert.equal(wiring.state, 'current');

  const unconfigured = await automationMatrix(core.workspace, { command: process.execPath }, {
    hermesHome: home,
  });
  const first = unconfigured.rows.find(row => row.runtime === 'Hermes');
  assert.equal(first?.activationStatus, 'NEEDS REPAIR');
  assert.equal(first?.activationReasonCode, 'ACTIVATION_WIRING_GENERATION_UNCONFIRMED');

  await appendActivationEvidence(core.workspace, {
    runtime: 'hermes', event: 'runtime-configured', source: 'install-hook', status: 'configured',
    configurationKey: wiring.generationId,
  });
  const configured = await automationMatrix(core.workspace, { command: process.execPath }, {
    hermesHome: home,
  });
  const second = configured.rows.find(row => row.runtime === 'Hermes');
  assert.equal(second?.activationStatus, 'READY — WAITING FOR FIRST ACTIVITY');
});

test('broken and missing Hermes wiring are reported honestly through automationMatrix', async () => {
  const { home, core } = await fixture();
  const missing = await automationMatrix(core.workspace, { command: process.execPath }, { hermesHome: home });
  assert.equal(missing.rows.find(row => row.runtime === 'Hermes')?.activationStatus, 'TOOLS ONLY');

  await installFixture(home, false);
  const broken = await automationMatrix(core.workspace, { command: process.execPath }, { hermesHome: home });
  assert.equal(broken.rows.find(row => row.runtime === 'Hermes')?.activationStatus, 'NEEDS REPAIR');
});

test('Hermes current wiring without a generation or matching configured row is never READY', async () => {
  const none = await import('../src/automation-doctor.ts');
  const missingGeneration = none.deriveRuntimeActivation('hermes', [], {
    lifecycleWiring: { state: 'current' },
  });
  assert.equal(missingGeneration.status, 'NEEDS REPAIR');
  const unmatched = none.deriveRuntimeActivation('hermes', [], {
    lifecycleWiring: { state: 'current', generationId: 'unmatched-generation' },
  });
  assert.equal(unmatched.status, 'NEEDS REPAIR');
  assert.equal(unmatched.reasonCode, 'ACTIVATION_WIRING_GENERATION_UNCONFIRMED');
});
