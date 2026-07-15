// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runtimeAutomationCeiling,
  runtimeCapabilityManifest,
} from '../src/runtime-capabilities.ts';

test('Hermes manifest exposes lifecycle surfaces without claiming native pre-compact', () => {
  const manifest = runtimeCapabilityManifest('hermes');

  assert.equal(manifest.runtime, 'hermes');
  assert.equal(manifest.mcpTools, true);
  assert.equal(manifest.readableTranscript, true);
  assert.deepEqual(manifest.lifecycle, {
    sessionStart: true,
    sessionReset: true,
    beforePrompt: true,
    afterTurn: true,
    sessionFinalize: true,
    sessionEnd: true,
    preCompact: 'none',
  });
  assert.equal(runtimeAutomationCeiling(manifest), 'lifecycle-capable');
});

test('capability ceilings describe host potential, never live activation', () => {
  assert.equal(runtimeAutomationCeiling(runtimeCapabilityManifest('hermes')), 'lifecycle-capable');
  assert.equal(runtimeAutomationCeiling(runtimeCapabilityManifest('workbuddy')), 'tools-only');
  assert.equal(runtimeAutomationCeiling(runtimeCapabilityManifest('unknown')), 'explicit-only');
});

test('runtime capability manifests are immutable across callers', () => {
  const first = runtimeCapabilityManifest('hermes');
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.lifecycle), true);
  assert.throws(() => {
    first.lifecycle.beforePrompt = false;
  }, TypeError);

  const second = runtimeCapabilityManifest('hermes');
  assert.equal(second.lifecycle.beforePrompt, true);
});

test('unknown runtime fails closed without inferred hooks or tools', () => {
  const manifest = runtimeCapabilityManifest('something-new');
  assert.equal(manifest.runtime, 'something-new');
  assert.equal(manifest.mcpTools, false);
  assert.equal(manifest.readableTranscript, false);
  assert.deepEqual(manifest.lifecycle, {
    sessionStart: false,
    sessionReset: false,
    beforePrompt: false,
    afterTurn: false,
    sessionFinalize: false,
    sessionEnd: false,
    preCompact: 'none',
  });
});
