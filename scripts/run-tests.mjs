// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Keep the broad suite parallel, but run the real PreCompact hook integration tests after it.
// Those tests intentionally execute a production 8s fail-open watchdog. Running that watchdog
// while every CPU is saturated by unrelated test workers tests scheduler contention rather than the
// checkpoint invariants: the correct production outcome under that contention is to exit 0 without
// an artifact, while the success-path assertions require a normal host budget.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testsRoot = path.join(repo, 'tests');
const deadlineSensitive = new Set(['tests/native-precompact.test.mjs']);
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

function runPhase(label, files) {
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
  const parallelTests = allTests.filter((file) => !deadlineSensitive.has(file));
  const deadlineTests = allTests.filter((file) => deadlineSensitive.has(file));

  const parallelExit = await runPhase('parallel core suite', parallelTests);
  if (parallelExit !== 0) return parallelExit;
  return runPhase('isolated deadline-sensitive PreCompact integration', deadlineTests);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
