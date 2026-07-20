// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  awaitDeadlineReadiness,
  findCompetingTestProcesses,
  partitionTestPhases,
  sanitizeTestEnv,
} from '../scripts/run-tests.mjs';

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

test('partitionTestPhases separates deadline-sensitive tests from the parallel core', () => {
  const phases = partitionTestPhases([
    'tests/ordinary.test.mjs',
    'tests/activation-ledger.test.mjs',
    'tests/checkpoint-core.test.mjs',
    'tests/hermes-b3-shared-contract.test.mjs',
    'tests/hermes-host-plugin-e2e.test.mjs',
    'tests/hermes-native-lifecycle-e2e.test.mjs',
    'tests/hermes-ordinary-language-capture.test.mjs',
    'tests/ollama-index-concurrency.test.mjs',
    'tests/semantic-activation-gate.test.mjs',
    'tests/vector-index-timeout.test.mjs',
    'tests/native-precompact.test.mjs',
  ]);

  assert.deepEqual(phases, {
    parallelTests: ['tests/ordinary.test.mjs'],
    deadlineTests: [
      'tests/activation-ledger.test.mjs',
      'tests/checkpoint-core.test.mjs',
      'tests/hermes-b3-shared-contract.test.mjs',
      'tests/hermes-host-plugin-e2e.test.mjs',
      'tests/hermes-native-lifecycle-e2e.test.mjs',
      'tests/hermes-ordinary-language-capture.test.mjs',
      'tests/ollama-index-concurrency.test.mjs',
      'tests/semantic-activation-gate.test.mjs',
      'tests/vector-index-timeout.test.mjs',
      'tests/native-precompact.test.mjs',
    ],
  });
});

test('awaitDeadlineReadiness requires three quiet competitor-free samples and resets on contention', async () => {
  const samples = [
    { load1: 7, competitors: [] },
    { load1: 6, competitors: ['other-test'] },
    { load1: 5, competitors: [] },
    { load1: 4, competitors: [] },
    { load1: 3, competitors: [] },
  ];
  const observed = [];
  const result = await awaitDeadlineReadiness({
    maxLoad1: 8,
    requiredConsecutiveSamples: 3,
    maxSamples: samples.length,
    sample: async () => samples.shift(),
    sleep: async () => {},
    onSample: (entry) => observed.push(entry),
  });

  assert.equal(result.ready, true);
  assert.equal(result.consecutiveSamples, 3);
  assert.equal(observed.length, 5);
});

test('findCompetingTestProcesses parses executable argv without matching prompt text', () => {
  const processTable = [
    { pid: 100, ppid: 1, command: 'npm test' },
    { pid: 101, ppid: 100, command: 'node scripts/run-tests.mjs' },
    { pid: 102, ppid: 101, command: 'node --test tests/a.test.mjs' },
    { pid: 200, ppid: 1, command: 'node --test tests/external.test.mjs' },
    { pid: 201, ppid: 1, command: '/opt/homebrew/bin/nodejs --test tests/nodejs.test.mjs' },
    { pid: 202, ppid: 1, command: '/opt/node/bin/node --experimental-strip-types --test tests/absolute.test.mjs' },
    { pid: 203, ppid: 1, command: 'npm test -- --test-name-pattern focused' },
    { pid: 204, ppid: 1, command: 'node scripts/run-tests.mjs' },
    { pid: 300, ppid: 1, command: 'node /opt/agent/cli.js --prompt "Do not run full npm test or node --test"' },
    { pid: 301, ppid: 1, command: 'node /opt/agent/cli.js --message scripts/run-tests.mjs' },
    { pid: 302, ppid: 1, command: 'node harmless.js' },
  ];

  assert.deepEqual(findCompetingTestProcesses(processTable, 102), [
    processTable[3],
    processTable[4],
    processTable[5],
    processTable[6],
    processTable[7],
  ]);
});

test('awaitDeadlineReadiness reports bounded exhaustion without launching the deadline phase', async () => {
  const samples = [
    { load1: 9, competitors: [] },
    { load1: 7, competitors: ['reviewer'] },
    { load1: 6, competitors: [] },
  ];
  const result = await awaitDeadlineReadiness({
    maxLoad1: 8,
    requiredConsecutiveSamples: 3,
    maxSamples: samples.length,
    sample: async () => samples.shift(),
    sleep: async () => {},
  });

  assert.deepEqual(result, {
    ready: false,
    classification: 'DEADLINE_READINESS_EXHAUSTED',
    consecutiveSamples: 1,
    samplesTaken: 3,
  });
});

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

test('runPhase serializes deadline-sensitive test files when concurrency is one', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-run-tests-serial-'));
  const lockDir = path.join(tempDir, 'exclusive-lock');
  const driver = path.join(tempDir, 'run-phase.mjs');
  const childFiles = [1, 2, 3].map((index) => path.join(tempDir, `serial-${index}.test.mjs`));

  try {
    const childSource = `
      import assert from 'node:assert/strict';
      import fs from 'node:fs/promises';
      import test from 'node:test';

      test('holds one exclusive file-level slot', async () => {
        let ownsLock = false;
        try {
          await fs.mkdir(${JSON.stringify(lockDir)});
          ownsLock = true;
          await new Promise(resolve => setTimeout(resolve, 750));
        } catch (error) {
          assert.fail(\`deadline test files overlapped: \${error?.code ?? 'unknown'}\`);
        } finally {
          if (ownsLock) await fs.rm(${JSON.stringify(lockDir)}, { recursive: true, force: true });
        }
      });
    `;
    await Promise.all(childFiles.map(file => fs.writeFile(file, childSource, 'utf8')));
    await fs.writeFile(driver, `
      import { runPhase } from ${JSON.stringify(runTestsModule)};

      process.exitCode = await runPhase(
        'serial deadline integration',
        ${JSON.stringify(childFiles)},
        { concurrency: 1 },
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
    await fs.rm(tempDir, { recursive: true, force: true });
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
