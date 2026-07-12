// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveRuntimeActivation,
} from '../src/automation-doctor.ts';
import { activationConfigurationId } from '../src/activation-ledger.ts';

function evidence({
  status,
  source = 'native-hook',
  event = 'hook-user-prompt-submit',
  observedAt,
  configurationId,
}) {
  return {
    schemaVersion: 1,
    id: `${status}-${observedAt}`,
    runtime: 'hermes',
    event,
    source,
    status,
    observedAt,
    workspaceBinding: { algorithm: 'sha256', id: 'workspace' },
    dedupe: { algorithm: 'sha256', id: `${status}-dedupe` },
    ...(configurationId
      ? { configuration: { algorithm: 'sha256', id: activationConfigurationId(configurationId) } }
      : {}),
  };
}

test('Hermes remains tools-only without verified installed plugin wiring', () => {
  const activation = deriveRuntimeActivation('hermes', [evidence({
    status: 'observed-live-completed',
    observedAt: '2026-07-12T10:01:00.000Z',
    configurationId: 'generation-1',
  })]);
  assert.equal(activation.status, 'TOOLS ONLY');
  assert.equal(activation.reasonCode, 'ACTIVATION_NO_VERIFIED_LIFECYCLE_TOOLS_ONLY');
});

test('Hermes is ready after verified plugin installation but before live activity', () => {
  const activation = deriveRuntimeActivation('hermes', [evidence({
    status: 'configured',
    source: 'install-hook',
    event: 'runtime-configured',
    observedAt: '2026-07-12T10:00:00.000Z',
    configurationId: 'generation-1',
  })], {
    lifecycleWiring: { state: 'current', generationId: 'generation-1' },
  });
  assert.equal(activation.status, 'READY — WAITING FOR FIRST ACTIVITY');
  assert.equal(activation.reasonCode, 'ACTIVATION_CONFIGURED_AWAITING_LIVE_ACTIVITY');
});

test('Hermes becomes active only after completed native-hook evidence from the same installed generation', () => {
  const rows = [
    evidence({
      status: 'configured', source: 'install-hook', event: 'runtime-configured',
      observedAt: '2026-07-12T10:00:00.000Z', configurationId: 'generation-1',
    }),
    evidence({
      status: 'observed-live-completed', observedAt: '2026-07-12T10:01:00.000Z',
      configurationId: 'generation-1',
    }),
  ];
  const activation = deriveRuntimeActivation('hermes', rows, {
    lifecycleWiring: { state: 'current', generationId: 'generation-1' },
  });
  assert.equal(activation.status, 'ACTIVE');
  assert.equal(activation.reasonCode, 'ACTIVATION_LIVE_COMPLETED_AFTER_INSTALL');
});

test('Hermes rejects synthetic/context-probe evidence and stale plugin generations as activation proof', () => {
  const rows = [
    evidence({
      status: 'configured', source: 'install-hook', event: 'runtime-configured',
      observedAt: '2026-07-12T10:00:00.000Z', configurationId: 'generation-2',
    }),
    evidence({
      status: 'synthetic', source: 'context-probe', event: 'context-probe-prompt',
      observedAt: '2026-07-12T10:01:00.000Z', configurationId: 'generation-2',
    }),
    evidence({
      status: 'observed-live-completed', source: 'context-probe', event: 'context-probe-prompt',
      observedAt: '2026-07-12T10:01:30.000Z', configurationId: 'generation-2',
    }),
    evidence({
      status: 'observed-live-completed', observedAt: '2026-07-12T10:02:00.000Z',
      configurationId: 'generation-1',
    }),
  ];
  const activation = deriveRuntimeActivation('hermes', rows, {
    lifecycleWiring: { state: 'current', generationId: 'generation-2' },
  });
  assert.equal(activation.status, 'READY — WAITING FOR FIRST ACTIVITY');
  assert.equal(activation.reasonCode, 'ACTIVATION_SYNTHETIC_ONLY');
});
