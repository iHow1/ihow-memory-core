// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalJsonV1, canonicalSha256V1 } from '../src/evaluation.ts';
import * as proposalEvaluation from '../src/proposal-evaluation.ts';
import * as bench from '../scripts/proposal-evaluation.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const BENCH_SCRIPT = fileURLToPath(new URL('../scripts/proposal-evaluation.mjs', import.meta.url));

async function temporaryRoot(t, prefix) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return root;
}

function spawnBench(cwd, env = {}) {
  return spawnSync(process.execPath, ['--experimental-strip-types', BENCH_SCRIPT], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

test('proposal fixture/manifest is canonical, SHA-pinned, and pre-registers frozen thresholds', async () => {
  assert.equal(typeof bench.runProposalEvaluation, 'function', 'real proposal harness behavior must exist');
  assert.equal(typeof proposalEvaluation.validateProposalEvaluationManifestV1, 'function');
  const casesPath = path.join(REPO_ROOT, 'eval', 'proposals', 'v1', 'cases.json');
  const manifestPath = path.join(REPO_ROOT, 'eval', 'proposals', 'v1', 'manifest.json');
  const casesRaw = await fs.readFile(casesPath, 'utf8');
  const manifestRaw = await fs.readFile(manifestPath, 'utf8');
  const dataset = proposalEvaluation.validateProposalEvaluationDatasetV1(JSON.parse(casesRaw));
  const manifest = proposalEvaluation.validateProposalEvaluationManifestV1(JSON.parse(manifestRaw), dataset);
  assert.equal(casesRaw, canonicalJsonV1(dataset));
  assert.equal(manifestRaw, canonicalJsonV1(manifest));
  assert.equal(manifest.cases.sha256, canonicalSha256V1(dataset));
  assert.equal(manifest.config.thresholds.proposalPrecisionMin, 0.8);
  assert.equal(manifest.config.thresholds.mustProposeRecall, 1);
  assert.equal(manifest.config.thresholds.unsafeDurableWritesMax, 0);
  assert.equal(manifest.config.thresholds.unsafeIndexWritesMax, 0);
  for (const name of ['secret', 'private', 'audit-only', 'malformed']) {
    assert.ok(dataset.cases.some((item) => item.negativeControlClass === name && item.expectedOutcome === 'block'));
  }
  for (const kind of ['preference', 'fact', 'event', 'procedure']) {
    for (const sourceKind of ['transcript', 'runtime-event']) {
      assert.ok(dataset.cases.some((item) => item.mustPropose && item.expectedProposal.kind === kind && item.sourceKind === sourceKind));
    }
  }
});

test('real core harness is isolated, candidate-only, cleans up, and repeats stable identity/metrics', async (t) => {
  const hostile = await temporaryRoot(t, 'ihow-alpha29-hostile-');
  await fs.writeFile(path.join(hostile, 'sentinel.txt'), 'unchanged\n', 'utf8');
  const previous = Object.fromEntries(['HOME', 'MEMORY_ROOT', 'IHOW_MEMORY_ROOT', 'IHOW_MEMORY_HOME', 'IHOW_MEMORY_STATE_ROOT', 'IHOW_MEMORY_ENGINE', 'CODEX_HOME'].map((key) => [key, process.env[key]]));
  for (const key of Object.keys(previous)) process.env[key] = hostile;
  try {
    const first = await bench.runProposalEvaluation({ repoRoot: REPO_ROOT });
    const second = await bench.runProposalEvaluation({ repoRoot: REPO_ROOT });
    assert.equal(first.report.gates.passed, true, JSON.stringify(first.report.gates));
    assert.equal(first.report.reportIdentitySha256, second.report.reportIdentitySha256);
    assert.equal(first.report.datasetSha256, second.report.datasetSha256);
    assert.equal(first.report.configSha256, second.report.configSha256);
    assert.equal(first.manifestSha256, second.manifestSha256);
    assert.deepEqual(first.report.metrics, second.report.metrics);
    assert.equal(first.report.metrics.proposalPrecision.denominator > 0, true);
    assert.equal(first.report.metrics.proposalPrecision.value >= 0.8, true);
    assert.equal(first.report.metrics.mustProposeRecall.value, 1);
    assert.equal(first.report.metrics.unsafeDurableWrites, 0);
    assert.equal(first.report.metrics.unsafeIndexWrites, 0);
    assert.equal(first.report.metrics.expectedOutcomeViolations, 0);
    assert.equal(first.report.metrics.candidateOnlyPersistenceViolations, 0);
    assert.deepEqual(first.report.metrics.correctionEvidence, { negativeCorrections: 1, restorations: 1 });
    assert.equal(first.report.cleanup.succeeded, true);
    for (const item of first.report.perCase) {
      assert.equal(item.expectedOutcomeMatched, true, item.caseId);
      assert.equal(item.persistenceContractMatched, true, item.caseId);
      if (item.expectedOutcome === 'stage') {
        assert.equal(item.persistence.candidateDelta, 1);
        assert.equal(item.persistence.eventDelta, 1);
        assert.deepEqual(item.persistence.eventTypes, ['candidate.created']);
      } else {
        assert.equal(item.persistence.candidateDelta, 0);
        assert.equal(item.persistence.eventDelta, 0);
        assert.deepEqual(item.persistence.eventTypes, []);
      }
      assert.equal(item.persistence.durableDelta, 0);
      assert.equal(item.persistence.historyDelta, 0);
      assert.equal(item.persistence.ftsDelta, 0);
      assert.equal(item.persistence.indexManifestDelta, 0);
    }
    assert.equal(await fs.readFile(path.join(hostile, 'sentinel.txt'), 'utf8'), 'unchanged\n');
    for (const [key, value] of Object.entries(previous)) {
      assert.equal(process.env[key], hostile);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('eval:proposals CLI emits JSON, succeeds on frozen data, and exits nonzero on integrity drift', async (t) => {
  const packageJson = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts['eval:proposals'], 'node --experimental-strip-types scripts/proposal-evaluation.mjs');
  const ok = spawnBench(REPO_ROOT, {
    HOME: '/tmp/hostile-home',
    MEMORY_ROOT: '/tmp/hostile-memory',
    IHOW_MEMORY_ENGINE: 'vector',
  });
  assert.equal(ok.status, 0, ok.stderr || ok.stdout);
  const report = JSON.parse(ok.stdout);
  assert.equal(report.gates.passed, true);

  const fixture = await temporaryRoot(t, 'ihow-alpha29-integrity-');
  await fs.mkdir(path.join(fixture, 'eval', 'proposals', 'v1'), { recursive: true });
  await fs.mkdir(path.join(fixture, 'eval', 'golden', 'v1'), { recursive: true });
  for (const name of ['cases.json', 'manifest.json']) {
    await fs.copyFile(path.join(REPO_ROOT, 'eval', 'proposals', 'v1', name), path.join(fixture, 'eval', 'proposals', 'v1', name));
  }
  await fs.copyFile(path.join(REPO_ROOT, 'eval', 'golden', 'v1', 'manifest.json'), path.join(fixture, 'eval', 'golden', 'v1', 'manifest.json'));
  const drifted = JSON.parse(await fs.readFile(path.join(fixture, 'eval', 'proposals', 'v1', 'cases.json'), 'utf8'));
  drifted.datasetVersion = 'tampered';
  await fs.writeFile(path.join(fixture, 'eval', 'proposals', 'v1', 'cases.json'), canonicalJsonV1(drifted), 'utf8');
  const failed = spawnBench(fixture);
  assert.notEqual(failed.status, 0);
  const failure = JSON.parse(failed.stdout);
  assert.equal(failure.gates.passed, false);
  assert.doesNotMatch(JSON.stringify(failure), /\/Users\/|REAL_SECRET|Bearer\s+\S+/);
});
