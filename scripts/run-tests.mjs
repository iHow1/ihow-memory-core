// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Keep the broad suite parallel, but run deadline-sensitive integration tests after it. The real
// PreCompact hook tests execute a production 8s fail-open watchdog, while the vector timeout test
// deliberately contrasts a 200ms status preflight with the index phase's 4000ms ceiling. Running
// either family while every CPU is saturated by unrelated workers tests scheduler contention rather
// than the production checkpoint or index-timeout contract that its assertions are meant to cover.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testsRoot = path.join(repo, 'tests');
const deadlineSensitive = new Set([
  'tests/native-precompact.test.mjs',
  'tests/vector-index-timeout.test.mjs',
]);
const dangerousAmbientRoutingKeys = [
  'MEMORY_ROOT',
  'IHOW_MEMORY_ROOT',
  'IHOW_MEMORY_HOME',
  'IHOW_MEMORY_STATE_ROOT',
  'HERMES_HOME',
  'IHOW_MEMORY_HERMES_BRIDGE',
  'IHOW_MEMORY_HERMES_NODE',
  'CODEX_HOME',
];

export function sanitizeTestEnv(env = process.env) {
  const sanitized = { ...env };
  for (const key of dangerousAmbientRoutingKeys) delete sanitized[key];
  return sanitized;
}

export function partitionTestPhases(files) {
  return {
    parallelTests: files.filter((file) => !deadlineSensitive.has(file)),
    deadlineTests: files.filter((file) => deadlineSensitive.has(file)),
  };
}

async function collectTests(dir) {
  const files = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await collectTests(target));
    else if (entry.isFile() && entry.name.endsWith('.test.mjs')) {
      files.push(path.relative(repo, target).split(path.sep).join('/'));
    }
  }
  return files.sort();
}

export function runPhase(label, files) {
  if (files.length === 0) throw new Error(`test_phase_empty:${label}`);
  console.log(`# test phase: ${label} (${files.length} file${files.length === 1 ? '' : 's'})`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', ...files], {
      cwd: repo,
      env: sanitizeTestEnv(process.env),
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`test_phase_signal:${label}:${signal}`));
      else resolve(code ?? 1);
    });
  });
}

async function main() {
  const allTests = await collectTests(testsRoot);
  const { parallelTests, deadlineTests } = partitionTestPhases(allTests);

  const parallelExit = await runPhase('parallel core suite', parallelTests);
  if (parallelExit !== 0) return parallelExit;
  return runPhase('isolated deadline-sensitive integrations', deadlineTests);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
