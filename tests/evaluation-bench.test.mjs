// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  canonicalJsonV1,
  canonicalSha256V1,
  datasetManifestSha256V1,
  reportIdentityProjectionV1,
  validateEvaluationReportV1,
} from '../src/evaluation.ts';
import {
  runEvaluationBench,
} from '../scripts/evaluation-bench.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const BENCH_SCRIPT = fileURLToPath(new URL('../scripts/evaluation-bench.mjs', import.meta.url));

async function temporaryRoot(t, prefix) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return root;
}

function safety(hazardId) {
  return {
    staleIds: [hazardId],
    forbiddenIds: [hazardId],
    flaggedIds: [hazardId],
    privateIds: [hazardId],
    auditOnlyIds: [hazardId],
    harmfulIds: [hazardId],
  };
}

function evaluationCase({ caseId, split, category, query, goldDocumentIds, hazardId }) {
  return {
    schemaVersion: 1,
    caseId,
    split,
    category,
    expected: goldDocumentIds.length === 0 ? 'no-answer' : 'answer',
    query,
    goldDocumentIds,
    safety: safety(hazardId),
  };
}

function splitFixture(split, { train = false } = {}) {
  const goldA = `memory/scopes/general/${split}-amber.md`;
  const goldB = `memory/scopes/general/${split}-violet.md`;
  const hazard = `memory/scopes/private/${split}-hazard.md`;
  const documents = [
    {
      documentId: goldA,
      text: `${split.toUpperCase()}AMBER cedar constellation preference selects the amber lattice profile.`,
    },
    {
      documentId: goldB,
      text: `${split.toUpperCase()}VIOLET recovery runbook follows the violet harbor checklist.`,
    },
    {
      documentId: hazard,
      text: `${split.toUpperCase()}AMBER obsolete harmful private instruction selects the silver lattice profile.`,
    },
  ];
  const categories = ['fact', 'preference', 'status', 'temporal', 'recovery', 'paraphrase'];
  const cases = train
    ? Array.from({ length: 12 }, (_, index) => {
        const number = index + 1;
        if (number === 6) {
          return evaluationCase({
            caseId: `train-case-${String(number).padStart(2, '0')}`,
            split,
            category: 'no-answer',
            query: 'ZXABSENT neutrino orchard has no reviewed memory',
            goldDocumentIds: [],
            hazardId: hazard,
          });
        }
        const useAmber = number % 2 === 1;
        return evaluationCase({
          caseId: `train-case-${String(number).padStart(2, '0')}`,
          split,
          category: categories[index % categories.length],
          query: useAmber
            ? 'What is TRAINA MBER cedar constellation amber lattice preference?'.replace('TRAINA MBER', 'TRAINAMBER')
            : 'Which TRAINVIOLET recovery runbook follows the violet harbor checklist?',
          goldDocumentIds: [useAmber ? goldA : goldB],
          hazardId: hazard,
        });
      })
    : [
        evaluationCase({
          caseId: `${split}-case-01`,
          split,
          category: split === 'dev' ? 'fact' : 'recovery',
          query: split === 'dev'
            ? 'What is DEVAMBER cedar constellation amber lattice preference?'
            : 'Which HOLDOUTVIOLET recovery runbook follows the violet harbor checklist?',
          goldDocumentIds: [split === 'dev' ? goldA : goldB],
          hazardId: hazard,
        }),
      ];
  return { schemaVersion: 1, split, documents, cases };
}

async function createFixtureRepo(t) {
  const root = await temporaryRoot(t, 'ihow-eval-fixture-repo-');
  const golden = path.join(root, 'eval', 'golden', 'v1');
  await fs.mkdir(golden, { recursive: true });
  const train = splitFixture('train', { train: true });
  const dev = splitFixture('dev');
  const holdout = splitFixture('holdout');
  const smokeCaseIds = [
    'train-case-12',
    'train-case-01',
    'train-case-09',
    'train-case-03',
    'train-case-06',
    'train-case-11',
    'train-case-02',
    'train-case-08',
    'train-case-04',
    'train-case-10',
    'train-case-05',
    'train-case-07',
  ];
  const byName = { train, dev, holdout };
  const manifest = {
    schemaVersion: 1,
    datasetId: 'alpha28-focused-fixture',
    datasetVersion: '1.0.0-test',
    splits: Object.fromEntries(['train', 'dev', 'holdout'].map((name) => [name, {
      path: `eval/golden/v1/${name}.json`,
      sha256: canonicalSha256V1(byName[name]),
      caseCount: byName[name].cases.length,
      documentCount: byName[name].documents.length,
    }])),
    smokeCaseIds,
    datasetSha256: '0'.repeat(64),
  };
  manifest.datasetSha256 = datasetManifestSha256V1(manifest);
  for (const [name, value] of Object.entries({ train, dev, holdout, manifest })) {
    await fs.writeFile(path.join(golden, `${name}.json`), canonicalJsonV1(value), 'utf8');
  }
  return { root, golden, manifest, smokeCaseIds };
}

function runCli(cwd, mode, env = {}) {
  return spawnSync(process.execPath, ['--experimental-strip-types', BENCH_SCRIPT, mode], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

async function listTree(root) {
  return (await fs.readdir(root, { recursive: true })).sort();
}

test('package scripts add the three evaluation modes without changing the existing command surface', async () => {
  const packageJson = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts['eval:smoke'], 'node --experimental-strip-types scripts/evaluation-bench.mjs smoke');
  assert.equal(packageJson.scripts['eval:batch'], 'node --experimental-strip-types scripts/evaluation-bench.mjs batch');
  assert.equal(packageJson.scripts['eval:full'], 'node --experimental-strip-types scripts/evaluation-bench.mjs full');
  assert.equal(packageJson.scripts.test, 'node scripts/run-tests.mjs');
  assert.equal(packageJson.scripts.typecheck, 'tsc --noEmit');
});

test('smoke runs the real FTS write_candidate/promote/search/selector/render path in pinned order', async (t) => {
  const fixture = await createFixtureRepo(t);
  const hostile = await temporaryRoot(t, 'ihow-eval-direct-hostile-');
  const previous = {
    HOME: process.env.HOME,
    MEMORY_ROOT: process.env.MEMORY_ROOT,
    IHOW_MEMORY_ENGINE: process.env.IHOW_MEMORY_ENGINE,
  };
  process.env.HOME = hostile;
  process.env.MEMORY_ROOT = hostile;
  process.env.IHOW_MEMORY_ENGINE = 'vector';
  try {
    const result = await runEvaluationBench({ mode: 'smoke', repoRoot: fixture.root });
    const report = validateEvaluationReportV1(result.report);
    assert.deepEqual(result.executionCaseIds, fixture.smokeCaseIds, 'smoke execution order is manifest-pinned');
    assert.equal(result.evidence.seededDocumentIds.length, 3);
    assert.deepEqual(result.evidence.provider, {
      id: 'fts',
      cloud: false,
      model: null,
      fallback: false,
      semantic: false,
    });
    assert.equal(report.mode, 'smoke');
    assert.deepEqual(report.splits, ['train']);
    assert.equal(report.caseCount, 12);
    assert.equal(report.datasetSha256, fixture.manifest.datasetSha256);
    assert.equal(report.gates.passed, true, JSON.stringify({ gates: report.gates, metrics: report.metrics }));
    assert.ok(report.perCase.some((item) => item.rankedIds.length > 0), 'real core.search returned ranked paths');
    assert.ok(report.perCase.some((item) => item.injectedIds.length > 0), 'real selector/render path injected reviewed memory');
    assert.ok(report.perCase.every((item) => item.injectedIds.every((id) => !id.includes('/private/'))));
    assert.equal(report.cleanup.attempted, true);
    assert.equal(report.cleanup.succeeded, true);
    const parent = report.tempPaths[0];
    assert.ok(report.tempPaths.every((entry) => entry === parent || entry.startsWith(`${parent}${path.sep}`)));
    await assert.rejects(fs.access(parent), { code: 'ENOENT' });
    assert.equal(process.env.HOME, hostile);
    assert.equal(process.env.MEMORY_ROOT, hostile);
    assert.equal(process.env.IHOW_MEMORY_ENGINE, 'vector');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('batch/full select the required splits and repeated smoke has identical stable identity', async (t) => {
  const fixture = await createFixtureRepo(t);
  const first = await runEvaluationBench({ mode: 'smoke', repoRoot: fixture.root });
  const second = await runEvaluationBench({ mode: 'smoke', repoRoot: fixture.root });
  assert.equal(first.report.reportIdentitySha256, second.report.reportIdentitySha256);
  assert.deepEqual(reportIdentityProjectionV1(first.report), reportIdentityProjectionV1(second.report));
  assert.equal(first.report.configSha256, second.report.configSha256);
  assert.equal(first.report.datasetSha256, second.report.datasetSha256);

  const batch = await runEvaluationBench({ mode: 'batch', repoRoot: fixture.root });
  assert.deepEqual(batch.report.splits, ['train', 'dev']);
  assert.equal(batch.report.caseCount, 13);
  const full = await runEvaluationBench({ mode: 'full', repoRoot: fixture.root });
  assert.deepEqual(full.report.splits, ['train', 'dev', 'holdout']);
  assert.equal(full.report.caseCount, 14);
});

test('spawned CLI scrubs hostile ambient roots/providers and cleans its only temp parent', async (t) => {
  const fixture = await createFixtureRepo(t);
  const hostile = await temporaryRoot(t, 'ihow-eval-spawn-hostile-');
  await fs.writeFile(path.join(hostile, 'sentinel.txt'), 'unchanged\n', 'utf8');
  const before = await listTree(hostile);
  const result = runCli(fixture.root, 'smoke', {
    HOME: hostile,
    MEMORY_ROOT: hostile,
    IHOW_MEMORY_ROOT: hostile,
    IHOW_MEMORY_HOME: hostile,
    IHOW_MEMORY_STATE_ROOT: hostile,
    IHOW_MEMORY_ENGINE: 'vector',
    IHOW_MEMORY_PROVIDER: 'vector-gguf',
    IHOW_MEMORY_VECTOR_PROVIDER_COMMAND: '/bin/false',
    IHOW_MEMORY_VECTOR_MODEL: 'hostile-model',
    IHOW_MEMORY_VECTOR_CACHE: hostile,
    IHOW_MEMORY_VECTOR_CACHE_DIR: hostile,
    HERMES_HOME: hostile,
    CODEX_HOME: hostile,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = validateEvaluationReportV1(JSON.parse(result.stdout));
  const parent = report.tempPaths[0];
  assert.ok(report.tempPaths.every((entry) => entry === parent || entry.startsWith(`${parent}${path.sep}`)));
  assert.ok(!result.stdout.includes(hostile), 'successful stdout contains no hostile ambient path');
  assert.deepEqual(await listTree(hostile), before, 'hostile roots are byte-for-byte untouched by path shape');
  assert.equal(await fs.readFile(path.join(hostile, 'sentinel.txt'), 'utf8'), 'unchanged\n');
  await assert.rejects(fs.access(parent), { code: 'ENOENT' });
});

test('controlled path-escape seam fails closed before creating the escaped root', async (t) => {
  const fixture = await createFixtureRepo(t);
  const escapeRoot = path.join(await temporaryRoot(t, 'ihow-eval-escape-owner-'), 'must-not-exist');
  let caught;
  try {
    await runEvaluationBench({
      mode: 'smoke',
      repoRoot: fixture.root,
      pathOverrides: { root: escapeRoot },
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, 'path escape must reject');
  assert.equal(caught.code, 'isolation_failure');
  assert.equal(caught.cleanup.attempted, true);
  assert.equal(caught.cleanup.succeeded, true);
  assert.equal(caught.evidence.seededDocuments, 0);
  await assert.rejects(fs.access(escapeRoot), { code: 'ENOENT' });
  await assert.rejects(fs.access(caught.tempPaths[0]), { code: 'ENOENT' });
});

test('CLI returns JSON and nonzero for invalid mode and manifest integrity failure', async (t) => {
  const fixture = await createFixtureRepo(t);
  const invalidMode = runCli(fixture.root, 'wat');
  assert.notEqual(invalidMode.status, 0);
  assert.equal(JSON.parse(invalidMode.stdout).error.code, 'invalid_mode');

  const trainPath = path.join(fixture.golden, 'train.json');
  const manifestPath = path.join(fixture.golden, 'manifest.json');
  const train = JSON.parse(await fs.readFile(trainPath, 'utf8'));
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  train.documents = train.documents.map((document) => (
    document.documentId.includes('/general/')
      ? { ...document, text: 'Completely unrelated basalt meadow archive.' }
      : document
  ));
  const amberId = train.documents.find((document) => document.documentId.endsWith('/train-amber.md')).documentId;
  const violetId = train.documents.find((document) => document.documentId.endsWith('/train-violet.md')).documentId;
  train.cases = train.cases.map((item) => item.goldDocumentIds.length === 0 ? item : ({
    ...item,
    goldDocumentIds: [item.goldDocumentIds[0] === amberId ? violetId : amberId],
  }));
  manifest.splits.train.sha256 = canonicalSha256V1(train);
  manifest.datasetSha256 = '0'.repeat(64);
  manifest.datasetSha256 = datasetManifestSha256V1(manifest);
  await fs.writeFile(trainPath, canonicalJsonV1(train), 'utf8');
  await fs.writeFile(manifestPath, canonicalJsonV1(manifest), 'utf8');
  const gateFailure = runCli(fixture.root, 'smoke');
  assert.notEqual(gateFailure.status, 0);
  const failedReport = validateEvaluationReportV1(JSON.parse(gateFailure.stdout));
  assert.equal(failedReport.gates.passed, false);
  assert.equal(failedReport.cleanup.succeeded, true);

  manifest.datasetSha256 = 'f'.repeat(64);
  await fs.writeFile(manifestPath, canonicalJsonV1(manifest), 'utf8');
  const integrity = runCli(fixture.root, 'smoke');
  assert.notEqual(integrity.status, 0);
  const failure = JSON.parse(integrity.stdout);
  assert.equal(failure.error.code, 'integrity_failure');
  assert.equal(failure.cleanup.attempted, true);
  assert.equal(failure.cleanup.succeeded, true);
  assert.equal(failure.evidence.seededDocuments, 0);
});
