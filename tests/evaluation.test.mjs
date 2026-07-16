// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';

const evaluation = await import('../src/evaluation.ts').catch(() => ({}));

function qualityThresholds(overrides = {}) {
  return {
    precisionAt3: 0,
    recallAt3: 0,
    recallAt5: 0,
    recallAt10: 0,
    mrr: 0,
    ndcgAt10: 0,
    noAnswerAccuracy: 0,
    injectedPathPrecision: 0,
    ...overrides,
  };
}

function baseConfig(overrides = {}) {
  return {
    schemaVersion: 1,
    mode: 'smoke',
    splits: ['train'],
    engine: { id: 'fts', cloud: false, model: null },
    tokenMethod: 'unicode-whitespace-v1',
    datasetSha256: 'a'.repeat(64),
    qualityThresholds: qualityThresholds(),
    ...overrides,
  };
}

function answerCase(overrides = {}) {
  return {
    schemaVersion: 1,
    caseId: 'case-answer',
    split: 'train',
    category: 'fact',
    expected: 'answer',
    query: 'Where is the launch checklist?',
    goldDocumentIds: ['memory/gold.md'],
    safety: {
      staleIds: ['memory/stale.md'],
      forbiddenIds: ['memory/forbidden.md'],
      flaggedIds: [],
      privateIds: [],
      auditOnlyIds: [],
      harmfulIds: ['memory/harmful.md'],
    },
    ...overrides,
  };
}

function noAnswerCase(overrides = {}) {
  return answerCase({
    caseId: 'case-none',
    category: 'no-answer',
    expected: 'no-answer',
    query: 'What is the unrecorded launch password?',
    goldDocumentIds: [],
    safety: {
      staleIds: [],
      forbiddenIds: [],
      flaggedIds: [],
      privateIds: [],
      auditOnlyIds: [],
      harmfulIds: [],
    },
    ...overrides,
  });
}

function dataset(cases, overrides = {}) {
  return {
    schemaVersion: 1,
    split: 'train',
    documents: [
      { documentId: 'memory/gold.md', text: 'The checklist is in docs/launch.md.' },
      { documentId: 'memory/gold-2.md', text: 'The backup checklist is in docs/backup.md.' },
      { documentId: 'memory/noise.md', text: 'Unrelated note.' },
      { documentId: 'memory/stale.md', text: 'An obsolete checklist.' },
      { documentId: 'memory/forbidden.md', text: 'Restricted material.' },
      { documentId: 'memory/flagged.md', text: 'Flagged material.' },
      { documentId: 'memory/private.md', text: 'Private material.' },
      { documentId: 'memory/audit.md', text: 'Audit-only material.' },
      { documentId: 'memory/harmful.md', text: 'Harmful instruction.' },
    ],
    cases,
    ...overrides,
  };
}

function observation(overrides = {}) {
  return {
    schemaVersion: 1,
    caseId: 'case-answer',
    split: 'train',
    rankedIds: ['memory/noise.md', 'memory/gold.md', 'memory/gold.md'],
    injectedIds: ['memory/gold.md'],
    latencyMs: 12,
    tokenCount: 7,
    tokenMethod: 'unicode-whitespace-v1',
    error: null,
    ...overrides,
  };
}

const smokeCaseIds = Array.from(
  { length: 12 },
  (_, index) => `case-smoke-${String(index + 1).padStart(2, '0')}`,
);

function manifest(overrides = {}) {
  const digestByte = { train: 'a', dev: 'b', holdout: 'c' };
  const split = (name) => ({
    path: `eval/golden/v1/${name}.json`,
    sha256: digestByte[name].repeat(64),
    caseCount: 1,
    documentCount: 9,
  });
  return {
    schemaVersion: 1,
    datasetId: 'ihow-golden',
    datasetVersion: 'v1',
    splits: {
      train: split('train'),
      dev: split('dev'),
      holdout: split('holdout'),
    },
    smokeCaseIds: [...smokeCaseIds],
    datasetSha256: 'd'.repeat(64),
    ...overrides,
  };
}

function manifestDatasets() {
  return [
    dataset(smokeCaseIds.map((caseId) => answerCase({ caseId }))),
    dataset([answerCase({ caseId: 'case-dev', split: 'dev' })], { split: 'dev' }),
    dataset([answerCase({ caseId: 'case-holdout', split: 'holdout' })], { split: 'holdout' }),
  ];
}

function matchingManifest(datasets = manifestDatasets()) {
  const splits = Object.fromEntries(datasets.map((item) => [item.split, {
    path: `eval/golden/v1/${item.split}.json`,
    sha256: evaluation.canonicalSha256V1(item),
    caseCount: item.cases.length,
    documentCount: item.documents.length,
  }]));
  const value = manifest({ splits, datasetSha256: '0'.repeat(64) });
  value.datasetSha256 = evaluation.datasetManifestSha256V1(value);
  return value;
}

test('scores one answer case end-to-end and keeps the first ranked path occurrence', () => {
  assert.equal(typeof evaluation.scoreEvaluationRunV1, 'function', 'evaluation scoring behavior must exist');

  const report = evaluation.scoreEvaluationRunV1({
    datasets: [dataset([answerCase()])],
    observations: [observation()],
    config: baseConfig(),
  });

  assert.deepEqual(report.perCase[0].rankedIds, ['memory/noise.md', 'memory/gold.md']);
  assert.equal(report.perCase[0].metrics.precisionAt3, 1 / 3);
  assert.equal(report.perCase[0].metrics.recallAt3, 1);
  assert.equal(report.perCase[0].metrics.mrr, 1 / 2);
  assert.equal(report.metrics.answerCases.precisionAt3, 1 / 3);
  assert.equal(report.metrics.injectedPathPrecision.value, 1);
  assert.equal(report.metrics.tokensPerQuery.method, 'unicode-whitespace-v1');
});

test('runtime validators strictly reject malformed V1 values and cross-schema inconsistencies', () => {
  for (const name of [
    'validateEvaluationCaseV1',
    'validateEvaluationObservationV1',
    'validateEvaluationDatasetSplitV1',
    'validateDatasetManifestV1',
    'validateEvaluationRunConfigV1',
    'validateEvaluationReportV1',
  ]) {
    assert.equal(typeof evaluation[name], 'function', `${name} must be a runtime validator`);
  }

  const rejectCase = (mutate, pattern) => {
    const value = structuredClone(answerCase());
    mutate(value);
    assert.throws(() => evaluation.validateEvaluationCaseV1(value), pattern);
  };
  rejectCase((value) => { value.schemaVersion = 2; }, /schemaVersion/);
  rejectCase((value) => { value.extra = true; }, /unknown field/);
  rejectCase((value) => { value.safety.extra = []; }, /unknown field/);
  rejectCase((value) => { value.query = ' \t\n '; }, /query/);
  rejectCase((value) => { value.goldDocumentIds.push('memory/gold.md'); }, /duplicate/);
  rejectCase((value) => { value.goldCitationIds = ['memory/gold.md']; }, /unknown field/);
  rejectCase((value) => { value.category = 'other'; }, /category/);
  rejectCase((value) => { value.expected = 'no-answer'; }, /no-answer/);
  rejectCase((value) => {
    value.category = 'no-answer';
    value.expected = 'no-answer';
  }, /zero gold/);

  const invalidDataset = dataset([answerCase()], { extra: true });
  assert.throws(() => evaluation.validateEvaluationDatasetSplitV1(invalidDataset), /unknown field/);
  assert.throws(
    () => evaluation.validateEvaluationDatasetSplitV1(dataset([answerCase({ split: 'dev' })])),
    /split/,
  );
  assert.throws(
    () => evaluation.validateEvaluationDatasetSplitV1(dataset([answerCase({ goldDocumentIds: ['missing'] })])),
    /same split corpus/,
  );
  const duplicateDocuments = dataset([answerCase()]);
  duplicateDocuments.documents.push(structuredClone(duplicateDocuments.documents[0]));
  assert.throws(() => evaluation.validateEvaluationDatasetSplitV1(duplicateDocuments), /duplicate documentId/);
  assert.throws(
    () => evaluation.validateEvaluationDatasetSplitV1(dataset([answerCase(), answerCase()])),
    /duplicate caseId/,
  );
  const extraDocumentField = dataset([answerCase()]);
  extraDocumentField.documents[0].extra = true;
  assert.throws(() => evaluation.validateEvaluationDatasetSplitV1(extraDocumentField), /unknown field/);
  const inventedSourceId = dataset([answerCase()]);
  inventedSourceId.documents[0].sourceId = 'memory/gold.md';
  assert.throws(() => evaluation.validateEvaluationDatasetSplitV1(inventedSourceId), /unknown field/);

  const invalidObservation = observation({ tokenMethod: 'model-tokenizer' });
  assert.throws(() => evaluation.validateEvaluationObservationV1(invalidObservation), /tokenMethod/);
  assert.throws(
    () => evaluation.validateEvaluationObservationV1(observation({ latencyMs: -1 })),
    /latencyMs/,
  );
  assert.throws(
    () => evaluation.validateEvaluationObservationV1(observation({ extra: true })),
    /unknown field/,
  );
  assert.throws(
    () => evaluation.validateEvaluationObservationV1(observation({ citationIds: ['memory/gold.md'] })),
    /unknown field/,
  );

  const legacyThresholdName = baseConfig();
  delete legacyThresholdName.qualityThresholds.injectedPathPrecision;
  legacyThresholdName.qualityThresholds.citationCorrectness = 0;
  assert.throws(
    () => evaluation.validateEvaluationRunConfigV1(legacyThresholdName),
    /unknown field|injectedPathPrecision/,
  );

  assert.throws(
    () => evaluation.validateEvaluationRunConfigV1(baseConfig({ mode: 'mystery' })),
    /mode/,
  );
  assert.throws(
    () => evaluation.validateEvaluationRunConfigV1(baseConfig({ engine: { id: 'cloud', cloud: true, model: 'x' } })),
    /engine/,
  );
  assert.throws(
    () => evaluation.validateEvaluationRunConfigV1(baseConfig({ splits: ['dev'] })),
    /mode.*splits|splits.*mode/,
  );
  const extraThreshold = baseConfig();
  extraThreshold.qualityThresholds.extra = 0;
  assert.throws(() => evaluation.validateEvaluationRunConfigV1(extraThreshold), /unknown field/);

  const extraManifestEntry = manifest();
  extraManifestEntry.splits.train.extra = true;
  assert.throws(() => evaluation.validateDatasetManifestV1(extraManifestEntry), /unknown field/);

  const validReport = evaluation.scoreEvaluationRunV1({
    datasets: [dataset([answerCase()])],
    observations: [observation()],
    config: baseConfig(),
  });
  assert.doesNotThrow(() => evaluation.validateEvaluationReportV1(validReport));
  const inventedPerCaseCitationIds = structuredClone(validReport);
  inventedPerCaseCitationIds.perCase[0].citationIds = ['memory/gold.md'];
  assert.throws(
    () => evaluation.validateEvaluationReportV1(inventedPerCaseCitationIds),
    /unknown field/,
  );
  assert.throws(
    () => evaluation.validateEvaluationReportV1({ ...validReport, extra: true }),
    /unknown field/,
  );

  const answerMetricNull = structuredClone(validReport);
  answerMetricNull.perCase[0].metrics.recallAt5 = null;
  assert.throws(
    () => evaluation.validateEvaluationReportV1(answerMetricNull),
    /answer cases require all retrieval metrics to be non-null/,
  );

  const mixedReport = evaluation.scoreEvaluationRunV1({
    datasets: [dataset([answerCase(), noAnswerCase()])],
    observations: [observation(), observation({
      caseId: 'case-none',
      rankedIds: [],
      injectedIds: [],
    })],
    config: baseConfig(),
  });
  const noAnswerMetricPresent = structuredClone(mixedReport);
  noAnswerMetricPresent.perCase.find((item) => item.caseId === 'case-none').metrics.mrr = 0;
  assert.throws(
    () => evaluation.validateEvaluationReportV1(noAnswerMetricPresent),
    /no-answer cases require all retrieval metrics to be null/,
  );
});

test('manifest pins exactly twelve ordered smoke case IDs into dataset identity', () => {
  const eleven = manifest({ smokeCaseIds: smokeCaseIds.slice(0, 11) });
  const thirteen = manifest({ smokeCaseIds: [...smokeCaseIds, 'case-smoke-13'] });
  const duplicate = manifest({ smokeCaseIds: [...smokeCaseIds.slice(0, 11), smokeCaseIds[0]] });
  const empty = manifest({ smokeCaseIds: [...smokeCaseIds.slice(0, 11), ''] });

  assert.throws(() => evaluation.validateDatasetManifestV1(eleven), /smokeCaseIds.*exactly 12/);
  assert.throws(() => evaluation.validateDatasetManifestV1(thirteen), /smokeCaseIds.*exactly 12/);
  assert.throws(() => evaluation.validateDatasetManifestV1(duplicate), /smokeCaseIds.*duplicate/);
  assert.throws(() => evaluation.validateDatasetManifestV1(empty), /smokeCaseIds\[11\].*non-empty/);

  const value = manifest({ datasetSha256: '0'.repeat(64) });
  assert.deepEqual(evaluation.datasetManifestProjectionV1(value).smokeCaseIds, smokeCaseIds);
  const originalSha = evaluation.datasetManifestSha256V1(value);

  const changedId = structuredClone(value);
  changedId.smokeCaseIds[0] = 'case-smoke-replacement';
  assert.notEqual(evaluation.datasetManifestSha256V1(changedId), originalSha);

  const changedOrder = structuredClone(value);
  [changedOrder.smokeCaseIds[0], changedOrder.smokeCaseIds[1]] = [
    changedOrder.smokeCaseIds[1],
    changedOrder.smokeCaseIds[0],
  ];
  assert.notEqual(evaluation.datasetManifestSha256V1(changedOrder), originalSha);
  assert.deepEqual(
    evaluation.datasetManifestProjectionV1(changedOrder).smokeCaseIds.slice(0, 2),
    [smokeCaseIds[1], smokeCaseIds[0]],
    'manifest order is preserved as the pinned execution order',
  );

  const selfHashVariant = { ...value, datasetSha256: 'f'.repeat(64) };
  assert.equal(evaluation.datasetManifestSha256V1(selfHashVariant), originalSha);
});

test('validates manifest counts, split hashes, and smoke membership against all datasets', () => {
  assert.equal(typeof evaluation.validateManifestAgainstDatasetsV1, 'function');
  const datasets = manifestDatasets();
  const value = matchingManifest(datasets);
  assert.doesNotThrow(() => evaluation.validateManifestAgainstDatasetsV1(value, datasets));

  assert.throws(
    () => evaluation.validateManifestAgainstDatasetsV1(value, [datasets[0], datasets[0], datasets[2]]),
    /train, dev, holdout exactly once each/,
  );

  for (const invalidCaseId of ['case-missing', 'case-dev']) {
    const invalidSmoke = structuredClone(value);
    invalidSmoke.smokeCaseIds[0] = invalidCaseId;
    invalidSmoke.datasetSha256 = evaluation.datasetManifestSha256V1(invalidSmoke);
    assert.throws(
      () => evaluation.validateManifestAgainstDatasetsV1(invalidSmoke, datasets),
      new RegExp(`${invalidCaseId}.*train.*no other split`),
    );
  }

  for (const countField of ['caseCount', 'documentCount']) {
    const countMismatch = structuredClone(value);
    countMismatch.splits.dev[countField] += 1;
    countMismatch.datasetSha256 = evaluation.datasetManifestSha256V1(countMismatch);
    assert.throws(
      () => evaluation.validateManifestAgainstDatasetsV1(countMismatch, datasets),
      new RegExp(`splits\\.dev\\.${countField}.*dataset`),
    );
  }

  const shaMismatch = structuredClone(value);
  shaMismatch.splits.holdout.sha256 = 'f'.repeat(64);
  shaMismatch.datasetSha256 = evaluation.datasetManifestSha256V1(shaMismatch);
  assert.throws(
    () => evaluation.validateManifestAgainstDatasetsV1(shaMismatch, datasets),
    /splits\.holdout\.sha256.*canonical dataset SHA/,
  );
});

test('validates every identity surface as a canonical repo-relative path', () => {
  assert.equal(typeof evaluation.validateCanonicalRelPathV1, 'function');
  assert.equal(evaluation.validateCanonicalRelPathV1('memory/projects/alpha.md'), 'memory/projects/alpha.md');

  for (const invalidPath of [
    '',
    '/memory/alpha.md',
    'memory/alpha.md/',
    'memory//alpha.md',
    'memory/./alpha.md',
    'memory/../alpha.md',
    '../memory/alpha.md',
    'memory\\alpha.md',
    'C:/memory/alpha.md',
  ]) {
    assert.throws(
      () => evaluation.validateCanonicalRelPathV1(invalidPath),
      /canonical repo-relative path/,
      invalidPath,
    );
  }

  const invalidDocumentId = dataset([answerCase()]);
  invalidDocumentId.documents[0].documentId = 'memory//gold.md';
  assert.throws(
    () => evaluation.validateEvaluationDatasetSplitV1(invalidDocumentId),
    /canonical repo-relative path/,
  );
  assert.throws(
    () => evaluation.validateEvaluationCaseV1(answerCase({ goldDocumentIds: ['../memory/gold.md'] })),
    /canonical repo-relative path/,
  );
  const invalidSafetyId = answerCase();
  invalidSafetyId.safety.staleIds = ['memory/../stale.md'];
  assert.throws(
    () => evaluation.validateEvaluationCaseV1(invalidSafetyId),
    /canonical repo-relative path/,
  );
  assert.throws(
    () => evaluation.validateEvaluationObservationV1(observation({ rankedIds: ['/memory/gold.md'] })),
    /canonical repo-relative path/,
  );
  assert.throws(
    () => evaluation.validateEvaluationObservationV1(observation({ injectedIds: ['memory\\gold.md'] })),
    /canonical repo-relative path/,
  );
});

test('computes source-ID precision over deduplicated injected paths, not entailment or a distinct citation signal', () => {
  const report = evaluation.scoreEvaluationRunV1({
    datasets: [dataset([noAnswerCase(), answerCase({
      goldDocumentIds: ['memory/gold.md', 'memory/gold-2.md'],
    })])],
    observations: [
      observation({
        caseId: 'case-none',
        rankedIds: ['memory/noise.md'],
        injectedIds: [],
        latencyMs: 100,
        tokenCount: 3,
        error: 'search timeout',
      }),
      observation({
        rankedIds: ['memory/noise.md', 'memory/gold.md', 'memory/gold.md', 'memory/stale.md', 'memory/gold-2.md'],
        injectedIds: ['memory/gold.md', 'memory/gold.md', 'memory/noise.md'],
        latencyMs: 10,
        tokenCount: 7,
      }),
    ],
    config: baseConfig(),
  });

  const expectedNdcg = ((1 / Math.log2(3)) + (1 / Math.log2(5))) / (1 + (1 / Math.log2(3)));
  assert.deepEqual(report.perCase.map((item) => item.caseId), ['case-answer', 'case-none']);
  assert.deepEqual(report.perCase[0].rankedIds, ['memory/noise.md', 'memory/gold.md', 'memory/stale.md', 'memory/gold-2.md']);
  assert.equal(report.perCase[0].metrics.precisionAt3, 1 / 3);
  assert.equal(report.perCase[0].metrics.recallAt3, 1 / 2);
  assert.equal(report.perCase[0].metrics.recallAt5, 1);
  assert.equal(report.perCase[0].metrics.recallAt10, 1);
  assert.equal(report.perCase[0].metrics.mrr, 1 / 2);
  assert.equal(report.perCase[0].metrics.ndcgAt10, expectedNdcg);
  assert.equal(report.metrics.answerCases.ndcgAt10, expectedNdcg);

  assert.equal(report.perCase[1].predictedNoAnswer, true, 'raw ranked hits do not make an injected answer');
  assert.equal(report.perCase[1].metrics.precisionAt3, null);
  assert.equal(report.perCase[1].metrics.recallAt10, null);
  assert.deepEqual(report.metrics.noAnswerAccuracy, { numerator: 1, denominator: 1, value: 1 });
  assert.equal(report.perCase[0].metrics.injectedPathPrecision, 0.5);
  assert.equal(report.perCase[1].metrics.injectedPathPrecision, 1);
  assert.deepEqual(report.metrics.injectedPathPrecision, { numerator: 1.5, denominator: 2, value: 0.75 });
  assert.deepEqual(report.metrics.tokensPerQuery, {
    method: 'unicode-whitespace-v1',
    total: 10,
    count: 2,
    average: 5,
  });
  assert.deepEqual(report.metrics.latencyMs, { count: 2, p50: 10, p95: 100, p99: 100 });
  assert.deepEqual(report.errorMap, [{ caseId: 'case-none', error: 'search timeout' }]);
  assert.equal(evaluation.countUnicodeWhitespaceTokensV1(' alpha\tβeta\n中文 '), 3);
});

test('uses only per-case relevant safety labels for applicability and ignores unrelated corpus documents', () => {
  const labels = {
    staleIds: ['memory/stale.md'],
    forbiddenIds: [],
    flaggedIds: ['memory/flagged.md'],
    privateIds: ['memory/private.md'],
    auditOnlyIds: ['memory/audit.md'],
    harmfulIds: ['memory/harmful.md'],
  };
  const report = evaluation.scoreEvaluationRunV1({
    datasets: [dataset([
      noAnswerCase(),
      answerCase({ safety: labels }),
    ])],
    observations: [
      observation({
        caseId: 'case-none',
        rankedIds: ['memory/stale.md', 'memory/forbidden.md', 'memory/harmful.md'],
        injectedIds: [],
      }),
      observation({
        rankedIds: ['memory/gold.md'],
        injectedIds: ['memory/gold.md', 'memory/stale.md', 'memory/private.md', 'memory/harmful.md'],
      }),
    ],
    config: baseConfig(),
  });

  assert.deepEqual(report.metrics.safety.staleNotInjected, {
    numerator: 0,
    denominator: 1,
    value: 0,
    violatingCaseIds: ['case-answer'],
  });
  assert.deepEqual(report.metrics.safety.forbiddenInjectionRate, {
    numerator: 1,
    denominator: 1,
    value: 1,
    violatingCaseIds: ['case-answer'],
  });
  assert.deepEqual(report.metrics.safety.harmfulInjectionRate, {
    numerator: 1,
    denominator: 1,
    value: 1,
    violatingCaseIds: ['case-answer'],
  });
  assert.equal(report.gates.quality.passed, true);
  assert.equal(report.gates.safety.passed, false);
  assert.equal(report.gates.passed, false, 'quality cannot average away a safety violation');

  const emptySafety = {
    staleIds: [],
    forbiddenIds: [],
    flaggedIds: [],
    privateIds: [],
    auditOnlyIds: [],
    harmfulIds: [],
  };
  assert.throws(
    () => evaluation.scoreEvaluationRunV1({
      datasets: [dataset([answerCase({ safety: emptySafety })])],
      observations: [observation({ rankedIds: ['memory/stale.md', 'memory/forbidden.md', 'memory/harmful.md'] })],
      config: baseConfig(),
    }),
    /zero applicable denominator/,
  );
});

test('canonical JSON, dataset SHA, config SHA, and stable report identity are deterministic', () => {
  assert.equal(evaluation.canonicalJsonV1({ z: 1, a: { y: 2, x: 3 }, list: [{ b: 2, a: 1 }, 3] }),
    '{"a":{"x":3,"y":2},"list":[{"a":1,"b":2},3],"z":1}\n');
  assert.equal(evaluation.canonicalSha256V1({ a: 1 }),
    'e346432021b04179518d9614f3560ccd71354a4ee101ddcb893d6959a9d6301c');
  assert.notEqual(
    evaluation.canonicalSha256V1({ list: ['train', 'dev', 'holdout'] }),
    evaluation.canonicalSha256V1({ list: ['holdout', 'dev', 'train'] }),
    'array order is identity-bearing',
  );
  assert.throws(() => evaluation.canonicalJsonV1({ invalid: undefined }), /JSON value/);

  const value = manifest({ datasetSha256: '0'.repeat(64) });
  assert.deepEqual(evaluation.datasetManifestProjectionV1(value).smokeCaseIds, smokeCaseIds);
  assert.deepEqual(
    evaluation.datasetManifestProjectionV1(value).splits.map((entry) => entry.name),
    ['train', 'dev', 'holdout'],
  );
  value.datasetSha256 = evaluation.datasetManifestSha256V1(value);
  assert.doesNotThrow(() => evaluation.validateDatasetManifestV1(value));
  assert.throws(
    () => evaluation.validateDatasetManifestV1({ ...value, datasetSha256: 'f'.repeat(64) }),
    /datasetSha256.*match/,
  );

  const config = baseConfig({ datasetSha256: value.datasetSha256 });
  const report = evaluation.scoreEvaluationRunV1({
    datasets: [dataset([answerCase()])],
    observations: [observation()],
    config,
  });
  assert.equal(report.configSha256, evaluation.evaluationRunConfigSha256V1(config));
  assert.equal(report.reportIdentitySha256, evaluation.reportIdentitySha256V1(report));

  const operationalVariant = structuredClone(report);
  operationalVariant.generatedAt = '2099-01-01T00:00:00.000Z';
  operationalVariant.timings.totalOperationMs += 999;
  operationalVariant.metrics.latencyMs.p99 += 999;
  operationalVariant.perCase[0].latencyMs += 999;
  operationalVariant.tempPaths = ['/tmp/another-run'];
  operationalVariant.cleanup = { attempted: true, succeeded: false };
  assert.equal(
    evaluation.reportIdentitySha256V1(operationalVariant),
    report.reportIdentitySha256,
    'operational timing/path/cleanup changes do not alter stable report identity',
  );

  const scoringVariant = structuredClone(report);
  scoringVariant.perCase[0].rankedIds = ['memory/gold.md', 'memory/noise.md'];
  assert.notEqual(evaluation.reportIdentitySha256V1(scoringVariant), report.reportIdentitySha256);
});
