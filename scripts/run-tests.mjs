// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Keep the broad suite parallel, but run deadline-sensitive integration tests after it. The real
// PreCompact hook tests execute a production 8s fail-open watchdog, the Hermes native lifecycle test
// crosses a production 5s Python-to-Node bridge budget, and the vector timeout test deliberately
// contrasts a 200ms status preflight with the index phase's 4000ms ceiling. Running any of these
// families while every CPU is saturated by unrelated workers tests scheduler contention rather than
// the production checkpoint, bridge, or index-timeout contract that its assertions are meant to cover.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testsRoot = path.join(repo, 'tests');
const deadlineSensitive = new Set([
  'tests/activation-ledger.test.mjs',
  'tests/checkpoint-core.test.mjs',
  'tests/hermes-b3-shared-contract.test.mjs',
  'tests/hermes-host-plugin-e2e.test.mjs',
  'tests/hermes-native-lifecycle-e2e.test.mjs',
  'tests/hermes-ordinary-language-capture.test.mjs',
  'tests/native-precompact.test.mjs',
  'tests/ollama-index-concurrency.test.mjs',
  'tests/semantic-activation-gate.test.mjs',
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

export function runPhase(label, files, { concurrency } = {}) {
  if (files.length === 0) throw new Error(`test_phase_empty:${label}`);
  console.log(`# test phase: ${label} (${files.length} file${files.length === 1 ? '' : 's'})`);
  const concurrencyArgs = concurrency === undefined ? [] : [`--test-concurrency=${concurrency}`];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', ...concurrencyArgs, ...files], {
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

function isCompetingTestCommand(command) {
  const argv = command.trim().split(/\s+/);
  if (argv.length < 2) return false;
  const executable = path.basename(argv[0]);
  if (executable === 'npm') return argv[1] === 'test';
  if (!/^node(?:js)?$/.test(executable)) return false;

  const testFlag = argv.indexOf('--test', 1);
  if (testFlag !== -1) {
    const scriptBeforeTestFlag = argv.slice(1, testFlag).some((arg) => !arg.startsWith('-'));
    if (!scriptBeforeTestFlag) return true;
  }

  const script = argv.slice(1).find((arg) => !arg.startsWith('-'));
  return script?.replace(/\\/g, '/').endsWith('/scripts/run-tests.mjs')
    || script === 'scripts/run-tests.mjs';
}

export function findCompetingTestProcesses(processTable, currentPid = process.pid) {
  const byPid = new Map(processTable.map((entry) => [entry.pid, entry]));
  const ownLineage = new Set();
  let cursor = currentPid;
  while (cursor > 0 && !ownLineage.has(cursor)) {
    ownLineage.add(cursor);
    cursor = byPid.get(cursor)?.ppid ?? 0;
  }
  return processTable.filter((entry) => (
    !ownLineage.has(entry.pid)
    && isCompetingTestCommand(entry.command)
  ));
}

function defaultReadinessSample() {
  const load1 = os.loadavg()[0];
  const output = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
  const processTable = output
    .split('\n')
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }));
  const competitors = findCompetingTestProcesses(processTable);
  return { load1, competitors };
}

export async function awaitDeadlineReadiness({
  maxLoad1 = 8,
  requiredConsecutiveSamples = 3,
  maxSamples = 60,
  sample = defaultReadinessSample,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  sampleIntervalMs = 15000,
  onSample = () => {},
} = {}) {
  let consecutiveSamples = 0;
  for (let samplesTaken = 1; samplesTaken <= maxSamples; samplesTaken += 1) {
    const entry = await sample();
    onSample(entry);
    if (entry.load1 <= maxLoad1 && entry.competitors.length === 0) consecutiveSamples += 1;
    else consecutiveSamples = 0;
    if (consecutiveSamples >= requiredConsecutiveSamples) {
      return { ready: true, consecutiveSamples, samplesTaken };
    }
    if (samplesTaken < maxSamples) await sleep(sampleIntervalMs);
  }
  return {
    ready: false,
    classification: 'DEADLINE_READINESS_EXHAUSTED',
    consecutiveSamples,
    samplesTaken: maxSamples,
  };
}

async function main() {
  const allTests = await collectTests(testsRoot);
  const { parallelTests, deadlineTests } = partitionTestPhases(allTests);

  const parallelExit = await runPhase('parallel core suite', parallelTests);
  if (parallelExit !== 0) return parallelExit;
  const readiness = await awaitDeadlineReadiness({
    onSample: ({ load1, competitors }) => {
      console.log(`# deadline readiness: load1=${load1.toFixed(2)} competitors=${competitors.length}`);
    },
  });
  if (!readiness.ready) {
    console.error(`# deadline phase not reached: ${readiness.classification}`);
    return 80;
  }
  return runPhase('isolated deadline-sensitive integrations', deadlineTests, { concurrency: 1 });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
