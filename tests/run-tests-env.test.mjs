// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { sanitizeTestEnv } from '../scripts/run-tests.mjs';

const runTestsModule = new URL('../scripts/run-tests.mjs', import.meta.url).href;

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

test('runPhase sanitizes the spawned test environment', async () => {
  const originalValues = new Map(
    dangerousRoutingKeys.map((key) => [key, process.env[key]]),
  );
  const safeKey = 'IHOW_RUN_TESTS_ENV_SENTINEL';
  const originalSafeValue = process.env[safeKey];
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-run-tests-env-'));
  const childTest = path.join(tempDir, 'child-env.test.mjs');
  const driver = path.join(tempDir, 'run-phase.mjs');

  try {
    for (const key of dangerousRoutingKeys) process.env[key] = `ambient-${key}`;
    process.env[safeKey] = 'preserved';
    await fs.writeFile(childTest, `
      import assert from 'node:assert/strict';
      import test from 'node:test';

      const dangerousRoutingKeys = ${JSON.stringify(dangerousRoutingKeys)};

      test('receives only the sanitized runner environment', () => {
        assert.equal(process.env.${safeKey}, 'preserved');
        for (const key of dangerousRoutingKeys) {
          assert.equal(process.env[key], undefined, \`${'${key}'} leaked into child\`);
        }
      });
    `);
    await fs.writeFile(driver, `
      import { runPhase } from ${JSON.stringify(runTestsModule)};

      process.exitCode = await runPhase(
        'environment sanitization integration',
        [${JSON.stringify(childTest)}],
      );
    `);

    const driverEnv = { ...process.env };
    delete driverEnv.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [driver], {
      encoding: 'utf8',
      env: driverEnv,
    });

    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  } finally {
    for (const [key, value] of originalValues) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (originalSafeValue === undefined) delete process.env[safeKey];
    else process.env[safeKey] = originalSafeValue;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
