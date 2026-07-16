// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import {
  canonicalJsonV1,
  canonicalSha256V1,
  datasetManifestSha256V1,
  validateDatasetManifestV1,
  validateEvaluationDatasetSplitV1,
  validateManifestAgainstDatasetsV1,
} from '../src/evaluation.ts';

const splitNames = ['train', 'dev', 'holdout'];
const categories = ['fact', 'preference', 'status', 'temporal', 'recovery', 'paraphrase', 'no-answer'];
const safetyKinds = {
  stale: 'staleIds',
  private: 'privateIds',
  forbidden: 'forbiddenIds',
  harmful: 'harmfulIds',
};
const expectedSmokeCaseIds = [
  'train-fact-01',
  'train-preference-01',
  'train-status-01',
  'train-temporal-01',
  'train-recovery-01',
  'train-paraphrase-01',
  'train-no-answer-01',
  'train-fact-02',
  'train-status-02',
  'train-recovery-02',
  'train-paraphrase-02',
  'train-no-answer-02',
];

const datasetDirectory = new URL('../eval/golden/v1/', import.meta.url);
const rawSplits = Object.fromEntries(await Promise.all(splitNames.map(async (name) => [
  name,
  await readFile(new URL(`${name}.json`, datasetDirectory)),
])));
const rawManifest = await readFile(new URL('manifest.json', datasetDirectory));
const datasets = splitNames.map((name) => JSON.parse(rawSplits[name].toString('utf8')));
const manifest = JSON.parse(rawManifest.toString('utf8'));

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertCanonicalBytes(label, raw, parsed) {
  const expected = Buffer.from(canonicalJsonV1(parsed), 'utf8');
  assert.deepEqual(raw, expected, `${label} must be exact canonicalJsonV1 bytes with one trailing LF`);
}

function coverageFor(dataset) {
  const categoryCounts = Object.fromEntries(categories.map((category) => [
    category,
    dataset.cases.filter((item) => item.category === category).length,
  ]));
  const safetyCounts = Object.fromEntries(Object.entries(safetyKinds).map(([kind, field]) => [
    kind,
    dataset.cases.filter((item) => item.safety[field].length > 0).length,
  ]));
  return { categoryCounts, safetyCounts };
}

function assertCoverage(dataset) {
  const coverage = coverageFor(dataset);
  for (const category of categories) {
    assert.ok(coverage.categoryCounts[category] > 0, `${dataset.split} missing category ${category}`);
  }
  for (const kind of Object.keys(safetyKinds)) {
    assert.ok(
      coverage.safetyCounts[kind] >= 2,
      `${dataset.split} ${kind} safety coverage must contain at least 2 applicable cases`,
    );
  }
  return coverage;
}

function assertGlobalDisjoint(valuesBySplit, label) {
  const owner = new Map();
  for (const [split, values] of Object.entries(valuesBySplit)) {
    for (const value of values) {
      assert.equal(owner.has(value), false, `${label} ${value} is duplicated across ${owner.get(value)} and ${split}`);
      owner.set(value, split);
    }
  }
}

function assertNoSecretShapedFixtureStrings(dataset) {
  const patterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
    /\bAKIA[0-9A-Z]{16}\b/u,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/u,
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u,
    /\b(?:api[_ -]?key|access[_ -]?token|client[_ -]?secret|password)\s*[:=]\s*\S+/iu,
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
    /\b\d{3}-\d{2}-\d{4}\b/u,
    /\b(?:\d[ -]*?){13,19}\b/u,
  ];
  const fixtureStrings = [
    ...dataset.documents.map((item) => item.text),
    ...dataset.cases.map((item) => item.query),
  ];
  for (const value of fixtureStrings) {
    for (const pattern of patterns) assert.doesNotMatch(value, pattern, `${dataset.split} contains a secret-shaped fixture`);
  }
}

test('golden V1 files are canonical, valid, hash-pinned, and manifest-consistent', () => {
  datasets.forEach((dataset, index) => {
    assert.equal(dataset.split, splitNames[index]);
    assert.doesNotThrow(() => validateEvaluationDatasetSplitV1(dataset, `datasets.${dataset.split}`));
    assertCanonicalBytes(`${dataset.split}.json`, rawSplits[dataset.split], dataset);
    assert.equal(sha256Bytes(rawSplits[dataset.split]), canonicalSha256V1(dataset));
    assert.equal(manifest.splits[dataset.split].path, `eval/golden/v1/${dataset.split}.json`);
    assert.equal(manifest.splits[dataset.split].caseCount, dataset.cases.length);
    assert.equal(manifest.splits[dataset.split].documentCount, dataset.documents.length);
    assert.equal(manifest.splits[dataset.split].sha256, canonicalSha256V1(dataset));
  });

  assertCanonicalBytes('manifest.json', rawManifest, manifest);
  assert.doesNotThrow(() => validateDatasetManifestV1(manifest));
  assert.equal(manifest.datasetSha256, datasetManifestSha256V1(manifest));
  assert.doesNotThrow(() => validateManifestAgainstDatasetsV1(manifest, datasets));
});

test('every split meets size, category, safety, answer, and retrieval-fixture requirements', () => {
  let totalCases = 0;
  for (const dataset of datasets) {
    totalCases += dataset.cases.length;
    assert.ok(dataset.cases.length >= 25, `${dataset.split} must contain at least 25 cases`);
    assertCoverage(dataset);
    assert.ok(
      dataset.cases.filter((item) => item.goldDocumentIds.length >= 2).length >= 6,
      `${dataset.split} must contain at least 6 multi-gold cases`,
    );
    assert.ok(
      dataset.documents.filter((item) => item.documentId.includes('/hard-negative/')).length >= 7,
      `${dataset.split} must contain at least 7 retrieval hard negatives`,
    );

    const documentIds = new Set(dataset.documents.map((item) => item.documentId));
    for (const item of dataset.cases) {
      if (item.expected === 'no-answer') {
        assert.equal(item.category, 'no-answer');
        assert.deepEqual(item.goldDocumentIds, []);
      } else {
        assert.notEqual(item.category, 'no-answer');
        assert.ok(item.goldDocumentIds.length >= 1);
      }
      for (const id of item.goldDocumentIds) assert.ok(documentIds.has(id), `${item.caseId} gold ID must be local`);
      for (const ids of Object.values(item.safety)) {
        for (const id of ids) assert.ok(documentIds.has(id), `${item.caseId} safety ID must be local`);
      }
    }
    assertNoSecretShapedFixtureStrings(dataset);
  }
  assert.ok(totalCases >= 75, 'golden dataset must contain at least 75 total cases');
});

test('case IDs and canonical document paths are globally disjoint', () => {
  assertGlobalDisjoint(
    Object.fromEntries(datasets.map((dataset) => [dataset.split, dataset.cases.map((item) => item.caseId)])),
    'case ID',
  );
  assertGlobalDisjoint(
    Object.fromEntries(datasets.map((dataset) => [dataset.split, dataset.documents.map((item) => item.documentId)])),
    'document path',
  );
});

test('manifest pins the exact ordered twelve-case train smoke set', () => {
  assert.deepEqual(manifest.smokeCaseIds, expectedSmokeCaseIds);
  assert.equal(manifest.smokeCaseIds.length, 12);
  assert.equal(new Set(manifest.smokeCaseIds).size, 12);
  const trainIds = new Set(datasets[0].cases.map((item) => item.caseId));
  manifest.smokeCaseIds.forEach((caseId) => assert.ok(trainIds.has(caseId), `${caseId} must belong to train`));
});

test('negative mutations catch coverage, identity, byte, hash, and smoke regressions', () => {
  const missingCategory = structuredClone(datasets[0]);
  missingCategory.cases = missingCategory.cases.filter((item) => item.category !== 'no-answer');
  assert.throws(() => assertCoverage(missingCategory), /missing category no-answer/);

  const lowSafetyCoverage = structuredClone(datasets[1]);
  for (const item of lowSafetyCoverage.cases) item.safety.staleIds = [];
  lowSafetyCoverage.cases[0].safety.staleIds = [lowSafetyCoverage.documents[0].documentId];
  assert.throws(() => assertCoverage(lowSafetyCoverage), /stale safety coverage.*at least 2/);

  const duplicateCaseDatasets = structuredClone(datasets);
  duplicateCaseDatasets[1].cases[0].caseId = duplicateCaseDatasets[0].cases[0].caseId;
  assert.throws(() => assertGlobalDisjoint(
    Object.fromEntries(duplicateCaseDatasets.map((dataset) => [
      dataset.split,
      dataset.cases.map((item) => item.caseId),
    ])),
    'case ID',
  ), /duplicated across train and dev/);

  const wrongSplitSha = structuredClone(manifest);
  wrongSplitSha.splits.holdout.sha256 = 'f'.repeat(64);
  wrongSplitSha.datasetSha256 = datasetManifestSha256V1(wrongSplitSha);
  assert.throws(
    () => validateManifestAgainstDatasetsV1(wrongSplitSha, datasets),
    /splits\.holdout\.sha256.*canonical dataset SHA/,
  );

  const noncanonicalBytes = Buffer.concat([rawSplits.train, Buffer.from('\n')]);
  assert.throws(
    () => assertCanonicalBytes('mutated train.json', noncanonicalBytes, datasets[0]),
    /exact canonicalJsonV1 bytes/,
  );

  const invalidSmoke = structuredClone(manifest);
  invalidSmoke.smokeCaseIds[0] = datasets[1].cases[0].caseId;
  invalidSmoke.datasetSha256 = datasetManifestSha256V1(invalidSmoke);
  assert.throws(
    () => validateManifestAgainstDatasetsV1(invalidSmoke, datasets),
    /must exist in train and no other split/,
  );
});
