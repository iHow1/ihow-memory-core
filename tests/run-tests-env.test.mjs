// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import assert from 'node:assert/strict';
import test from 'node:test';

import { sanitizeTestEnv } from '../scripts/run-tests.mjs';

const dangerousRoutingKeys = [
  'MEMORY_ROOT',
  'IHOW_MEMORY_ROOT',
  'IHOW_MEMORY_HOME',
  'IHOW_MEMORY_STATE_ROOT',
  'HERMES_HOME',
  'IHOW_MEMORY_HERMES_BRIDGE',
  'IHOW_MEMORY_HERMES_NODE',
  'CODEX_HOME',
];

test('sanitizeTestEnv copies process.env without ambient memory routing', () => {
  const originalValues = new Map(
    dangerousRoutingKeys.map((key) => [key, process.env[key]]),
  );
  const safeKey = 'IHOW_RUN_TESTS_ENV_SENTINEL';
  const originalSafeValue = process.env[safeKey];

  try {
    for (const key of dangerousRoutingKeys) process.env[key] = `ambient-${key}`;
    process.env[safeKey] = 'preserved';

    const sanitized = sanitizeTestEnv();

    assert.notStrictEqual(sanitized, process.env);
    assert.equal(sanitized[safeKey], 'preserved');
    for (const key of dangerousRoutingKeys) {
      assert.equal(sanitized[key], undefined);
      assert.equal(process.env[key], `ambient-${key}`);
    }
  } finally {
    for (const [key, value] of originalValues) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (originalSafeValue === undefined) delete process.env[safeKey];
    else process.env[safeKey] = originalSafeValue;
  }
});
