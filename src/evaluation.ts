// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import { createHash } from 'node:crypto';
import {
  PROMPT_RECALL_INCLUDE_LIMIT,
  PROMPT_RECALL_MAX_CHARS,
  PROMPT_RECALL_MIN_LEXICAL_TERMS,
  PROMPT_RECALL_MIN_QUERY_COVERAGE,
  PROMPT_RECALL_SEARCH_LIMIT,
  PROMPT_RECALL_SNIPPET_CAP,
} from './prompt-recall.ts';

export type EvaluationSplitNameV1 = 'train' | 'dev' | 'holdout';
export type EvaluationCategoryV1 =
  | 'fact'
  | 'preference'
  | 'status'
  | 'temporal'
  | 'recovery'
  | 'paraphrase'
  | 'no-answer';
export type EvaluationExpectedV1 = 'answer' | 'no-answer';
export type EvaluationModeV1 = 'smoke' | 'batch' | 'full';
export type EvaluationEngineIdV1 = 'fts';
export type EvaluationTokenMethodV1 = 'unicode-whitespace-v1';

export type EvaluationSafetyLabelsV1 = {
  staleIds: string[];
  forbiddenIds: string[];
  flaggedIds: string[];
  privateIds: string[];
  auditOnlyIds: string[];
  harmfulIds: string[];
};

export type EvaluationCaseV1 = {
  schemaVersion: 1;
  caseId: string;
  split: EvaluationSplitNameV1;
  category: EvaluationCategoryV1;
  expected: EvaluationExpectedV1;
  query: string;
  goldDocumentIds: string[];
  safety: EvaluationSafetyLabelsV1;
};

export type EvaluationDocumentV1 = {
  documentId: string;
  text: string;
};

export type EvaluationDatasetSplitV1 = {
  schemaVersion: 1;
  split: EvaluationSplitNameV1;
  documents: EvaluationDocumentV1[];
  cases: EvaluationCaseV1[];
};

export type DatasetManifestSplitV1 = {
  path: string;
  sha256: string;
  caseCount: number;
  documentCount: number;
};

export type DatasetManifestV1 = {
  schemaVersion: 1;
  datasetId: string;
  datasetVersion: string;
  splits: Record<EvaluationSplitNameV1, DatasetManifestSplitV1>;
  smokeCaseIds: string[];
  datasetSha256: string;
};

export type DatasetManifestProjectionV1 = {
  schemaVersion: 1;
  datasetId: string;
  datasetVersion: string;
  splits: Array<DatasetManifestSplitV1 & { name: EvaluationSplitNameV1 }>;
  smokeCaseIds: string[];
};

export type EvaluationObservationV1 = {
  schemaVersion: 1;
  caseId: string;
  split: EvaluationSplitNameV1;
  rankedIds: string[];
  injectedIds: string[];
  latencyMs: number;
  tokenCount: number;
  tokenMethod: EvaluationTokenMethodV1;
  error: string | null;
};

export type EvaluationQualityThresholdsV1 = {
  precisionAt3: number;
  recallAt3: number;
  recallAt5: number;
  recallAt10: number;
  mrr: number;
  ndcgAt10: number;
  noAnswerAccuracy: number;
  injectedPathPrecision: number;
};

export type EvaluationRecallPolicyV1 = {
  schemaVersion: 1;
  candidateDepth: 25;
  lexicalMinDistinctTerms: 2;
  lexicalMinQueryCoverage: 0.40;
  includeLimit: 3;
  maxChars: 1200;
  snippetCap: 280;
  reranker: 'off';
  temporalEntitySchemaVersion: 1;
};

export type EvaluationRunConfigV1 = {
  schemaVersion: 1;
  mode: EvaluationModeV1;
  splits: EvaluationSplitNameV1[];
  engine: {
    id: EvaluationEngineIdV1;
    cloud: false;
    model: null;
  };
  tokenMethod: EvaluationTokenMethodV1;
  datasetSha256: string;
  qualityThresholds: EvaluationQualityThresholdsV1;
  recallPolicy?: EvaluationRecallPolicyV1;
};

export type EvaluationAnswerMetricsV1 = {
  precisionAt3: number | null;
  recallAt3: number | null;
  recallAt5: number | null;
  recallAt10: number | null;
  mrr: number | null;
  ndcgAt10: number | null;
};

export type EvaluationRatioMetricV1 = {
  numerator: number;
  denominator: number;
  value: number | null;
};

export type EvaluationLatencyMetricV1 = {
  count: number;
  p50: number;
  p95: number;
  p99: number;
};

export type EvaluationSafetyMetricV1 = {
  numerator: number;
  denominator: number;
  value: number;
  violatingCaseIds: string[];
};

export type EvaluationGateV1 = {
  passed: boolean;
  failures: string[];
};

export type EvaluationPerCaseV1 = {
  caseId: string;
  split: EvaluationSplitNameV1;
  category: EvaluationCategoryV1;
  expected: EvaluationExpectedV1;
  rankedIds: string[];
  injectedIds: string[];
  predictedNoAnswer: boolean;
  metrics: {
    precisionAt3: number | null;
    recallAt3: number | null;
    recallAt5: number | null;
    recallAt10: number | null;
    mrr: number | null;
    ndcgAt10: number | null;
    injectedPathPrecision: number;
  };
  safety: {
    staleInjectedIds: string[];
    forbiddenInjectedIds: string[];
    harmfulInjectedIds: string[];
  };
  latencyMs: number;
  tokenCount: number;
  error: string | null;
};

export type EvaluationReportV1 = {
  schemaVersion: 1;
  mode: EvaluationModeV1;
  splits: EvaluationSplitNameV1[];
  caseCount: number;
  engine: EvaluationRunConfigV1['engine'];
  datasetSha256: string;
  configSha256: string;
  reportIdentitySha256: string;
  metrics: {
    answerCases: EvaluationAnswerMetricsV1;
    noAnswerAccuracy: EvaluationRatioMetricV1;
    /** Source-ID precision over canonical injected paths; not entailment or a separate citation signal. */
    injectedPathPrecision: EvaluationRatioMetricV1;
    tokensPerQuery: { method: EvaluationTokenMethodV1; total: number; count: number; average: number };
    latencyMs: EvaluationLatencyMetricV1;
    safety: {
      staleNotInjected: EvaluationSafetyMetricV1;
      forbiddenInjectionRate: EvaluationSafetyMetricV1;
      harmfulInjectionRate: EvaluationSafetyMetricV1;
    };
  };
  gates: {
    quality: EvaluationGateV1;
    safety: EvaluationGateV1;
    passed: boolean;
  };
  perCase: EvaluationPerCaseV1[];
  errorMap: Array<{ caseId: string; error: string }>;
  generatedAt: string | null;
  timings: {
    totalOperationMs: number;
    sampleCount: number;
  };
  tempPaths: string[];
  cleanup: {
    attempted: boolean;
    succeeded: boolean;
  };
};

export type EvaluationRunInputV1 = {
  datasets: EvaluationDatasetSplitV1[];
  observations: EvaluationObservationV1[];
  config: EvaluationRunConfigV1;
};

export class EvaluationValidationError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'EvaluationValidationError';
    this.path = path;
  }
}

type UnknownRecord = Record<string, unknown>;
type CanonicalJsonPrimitive = null | boolean | number | string;
export type CanonicalJsonValueV1 = CanonicalJsonPrimitive | CanonicalJsonValueV1[] | {
  [key: string]: CanonicalJsonValueV1;
};

function fail(path: string, message: string): never {
  throw new EvaluationValidationError(path, message);
}

function canonicalizeJsonValue(value: unknown, path: string, active: WeakSet<object>): CanonicalJsonValueV1 {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(path, 'must be a finite JSON value');
    return value;
  }
  if (typeof value !== 'object') fail(path, 'must be a JSON value');
  if (active.has(value)) fail(path, 'cyclic values are not JSON values');
  active.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) fail(`${path}[${index}]`, 'sparse arrays are not JSON values');
      }
      const extraKeys = Object.keys(value).filter((key) => !/^(0|[1-9][0-9]*)$/.test(key));
      if (extraKeys.length > 0 || Object.getOwnPropertySymbols(value).length > 0) {
        fail(path, 'arrays with extra properties are not JSON values');
      }
      return value.map((item, index) => canonicalizeJsonValue(item, `${path}[${index}]`, active));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail(path, 'must be a plain JSON value object');
    if (Object.getOwnPropertySymbols(value).length > 0) fail(path, 'symbol keys are not JSON values');
    const result: Record<string, CanonicalJsonValueV1> = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = canonicalizeJsonValue((value as UnknownRecord)[key], `${path}.${key}`, active);
    }
    return result;
  } finally {
    active.delete(value);
  }
}

export function canonicalJsonV1(value: unknown): string {
  return `${JSON.stringify(canonicalizeJsonValue(value, '$', new WeakSet()))}\n`;
}

export function canonicalSha256V1(value: unknown): string {
  return createHash('sha256').update(canonicalJsonV1(value), 'utf8').digest('hex');
}

export const canonicalJsonSha256V1 = canonicalSha256V1;

function exactRecord(
  value: unknown,
  keys: readonly string[],
  path: string,
  requiredKeys: readonly string[] = keys,
): UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(path, 'must be an object');
  }
  const record = value as UnknownRecord;
  const allowed = new Set(keys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, 'unknown field');
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(record, key)) fail(`${path}.${key}`, 'required field is missing');
  }
  return record;
}

function exactSchemaVersion(value: unknown, path: string): asserts value is 1 {
  if (value !== 1) fail(path, 'schemaVersion must be exactly 1');
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) fail(path, 'must be a non-empty string');
  if (value !== value.trim()) fail(path, 'must not have leading or trailing whitespace');
  return value;
}

function nullableNonEmptyString(value: unknown, path: string): string | null {
  if (value === null) return null;
  return nonEmptyString(value, path);
}

function finiteNumber(value: unknown, path: string, minimum = -Infinity): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
    fail(path, `must be a finite number >= ${minimum}`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail(path, 'must be a non-negative safe integer');
  }
  return value;
}

function fraction(value: unknown, path: string): number {
  const result = finiteNumber(value, path, 0);
  if (result > 1) fail(path, 'must be a fraction in [0,1]');
  return result;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    fail(path, `must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function idArray(value: unknown, path: string, options: { allowDuplicates?: boolean } = {}): string[] {
  if (!Array.isArray(value)) fail(path, 'must be an array');
  const result = value.map((item, index) => nonEmptyString(item, `${path}[${index}]`));
  if (!options.allowDuplicates && new Set(result).size !== result.length) fail(path, 'contains a duplicate ID');
  return result;
}

export function validateCanonicalRelPathV1(value: unknown, path = 'relPath'): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value !== value.trim()
    || value.includes('\\')
    || value.startsWith('/')
    || value.endsWith('/')
    || /^[A-Za-z]:/.test(value)
  ) {
    fail(path, 'must be a canonical repo-relative path');
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    fail(path, 'must be a canonical repo-relative path');
  }
  return value;
}

function relPathArray(value: unknown, path: string, options: { allowDuplicates?: boolean } = {}): string[] {
  if (!Array.isArray(value)) fail(path, 'must be an array');
  const result = value.map((item, index) => validateCanonicalRelPathV1(item, `${path}[${index}]`));
  if (!options.allowDuplicates && new Set(result).size !== result.length) fail(path, 'contains a duplicate ID');
  return result;
}

function sha256(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    fail(path, 'must be a lowercase SHA-256 hex digest');
  }
  return value;
}

function validateSafetyLabelsV1(value: unknown, path: string): EvaluationSafetyLabelsV1 {
  const item = exactRecord(value, [
    'staleIds',
    'forbiddenIds',
    'flaggedIds',
    'privateIds',
    'auditOnlyIds',
    'harmfulIds',
  ], path);
  for (const key of Object.keys(item)) relPathArray(item[key], `${path}.${key}`);
  return item as EvaluationSafetyLabelsV1;
}

export function validateEvaluationCaseV1(value: unknown, path = 'case'): EvaluationCaseV1 {
  const item = exactRecord(value, [
    'schemaVersion',
    'caseId',
    'split',
    'category',
    'expected',
    'query',
    'goldDocumentIds',
    'safety',
  ], path);
  exactSchemaVersion(item.schemaVersion, `${path}.schemaVersion`);
  nonEmptyString(item.caseId, `${path}.caseId`);
  enumValue(item.split, ['train', 'dev', 'holdout'], `${path}.split`);
  const category = enumValue(item.category, [
    'fact',
    'preference',
    'status',
    'temporal',
    'recovery',
    'paraphrase',
    'no-answer',
  ], `${path}.category`);
  const expected = enumValue(item.expected, ['answer', 'no-answer'], `${path}.expected`);
  nonEmptyString(item.query, `${path}.query`);
  const goldDocumentIds = relPathArray(item.goldDocumentIds, `${path}.goldDocumentIds`);
  validateSafetyLabelsV1(item.safety, `${path}.safety`);
  if (expected === 'answer') {
    if (category === 'no-answer') fail(path, 'answer cases cannot use the no-answer category');
    if (goldDocumentIds.length === 0) fail(path, 'answer cases require at least one gold ID');
  } else {
    if (category !== 'no-answer') fail(path, 'no-answer cases must use the no-answer category');
    if (goldDocumentIds.length !== 0) fail(path, 'no-answer cases require zero gold IDs');
  }
  return item as EvaluationCaseV1;
}

export function validateEvaluationObservationV1(value: unknown, path = 'observation'): EvaluationObservationV1 {
  const item = exactRecord(value, [
    'schemaVersion',
    'caseId',
    'split',
    'rankedIds',
    'injectedIds',
    'latencyMs',
    'tokenCount',
    'tokenMethod',
    'error',
  ], path);
  exactSchemaVersion(item.schemaVersion, `${path}.schemaVersion`);
  nonEmptyString(item.caseId, `${path}.caseId`);
  enumValue(item.split, ['train', 'dev', 'holdout'], `${path}.split`);
  relPathArray(item.rankedIds, `${path}.rankedIds`, { allowDuplicates: true });
  relPathArray(item.injectedIds, `${path}.injectedIds`, { allowDuplicates: true });
  finiteNumber(item.latencyMs, `${path}.latencyMs`, 0);
  nonNegativeInteger(item.tokenCount, `${path}.tokenCount`);
  enumValue(item.tokenMethod, ['unicode-whitespace-v1'], `${path}.tokenMethod`);
  nullableNonEmptyString(item.error, `${path}.error`);
  return item as EvaluationObservationV1;
}

function validateDocumentV1(value: unknown, path: string): EvaluationDocumentV1 {
  const item = exactRecord(value, ['documentId', 'text'], path);
  validateCanonicalRelPathV1(item.documentId, `${path}.documentId`);
  nonEmptyString(item.text, `${path}.text`);
  return item as EvaluationDocumentV1;
}

function assertUniqueIds(values: string[], path: string, label: string): void {
  if (new Set(values).size !== values.length) fail(path, `contains a duplicate ${label}`);
}

export function validateEvaluationDatasetSplitV1(
  value: unknown,
  path = 'dataset',
): EvaluationDatasetSplitV1 {
  const item = exactRecord(value, ['schemaVersion', 'split', 'documents', 'cases'], path);
  exactSchemaVersion(item.schemaVersion, `${path}.schemaVersion`);
  const split = enumValue(item.split, ['train', 'dev', 'holdout'], `${path}.split`);
  if (!Array.isArray(item.documents) || item.documents.length === 0) {
    fail(`${path}.documents`, 'must be a non-empty array');
  }
  if (!Array.isArray(item.cases) || item.cases.length === 0) fail(`${path}.cases`, 'must be a non-empty array');
  const documents = item.documents.map((document, index) => validateDocumentV1(document, `${path}.documents[${index}]`));
  const cases = item.cases.map((evaluationCase, index) => validateEvaluationCaseV1(evaluationCase, `${path}.cases[${index}]`));
  assertUniqueIds(documents.map((document) => document.documentId), `${path}.documents`, 'documentId');
  assertUniqueIds(cases.map((evaluationCase) => evaluationCase.caseId), `${path}.cases`, 'caseId');
  const documentIds = new Set(documents.map((document) => document.documentId));
  for (const evaluationCase of cases) {
    if (evaluationCase.split !== split) fail(`${path}.cases`, 'case split must match its dataset split');
    for (const id of evaluationCase.goldDocumentIds) {
      if (!documentIds.has(id)) fail(`${path}.cases`, `gold ID ${id} is absent from the same split corpus`);
    }
    for (const ids of Object.values(evaluationCase.safety)) {
      for (const id of ids) {
        if (!documentIds.has(id)) fail(`${path}.cases`, `safety ID ${id} is absent from the same split corpus`);
      }
    }
  }
  return item as EvaluationDatasetSplitV1;
}

function validateManifestSplitV1(value: unknown, path: string): DatasetManifestSplitV1 {
  const item = exactRecord(value, ['path', 'sha256', 'caseCount', 'documentCount'], path);
  nonEmptyString(item.path, `${path}.path`);
  sha256(item.sha256, `${path}.sha256`);
  nonNegativeInteger(item.caseCount, `${path}.caseCount`);
  nonNegativeInteger(item.documentCount, `${path}.documentCount`);
  return item as DatasetManifestSplitV1;
}

function validateDatasetManifestContentV1(value: unknown, path: string): DatasetManifestV1 {
  const item = exactRecord(value, [
    'schemaVersion', 'datasetId', 'datasetVersion', 'splits', 'smokeCaseIds', 'datasetSha256',
  ], path);
  exactSchemaVersion(item.schemaVersion, `${path}.schemaVersion`);
  nonEmptyString(item.datasetId, `${path}.datasetId`);
  nonEmptyString(item.datasetVersion, `${path}.datasetVersion`);
  const splits = exactRecord(item.splits, ['train', 'dev', 'holdout'], `${path}.splits`);
  validateManifestSplitV1(splits.train, `${path}.splits.train`);
  validateManifestSplitV1(splits.dev, `${path}.splits.dev`);
  validateManifestSplitV1(splits.holdout, `${path}.splits.holdout`);
  const smokeCaseIds = idArray(item.smokeCaseIds, `${path}.smokeCaseIds`);
  if (smokeCaseIds.length !== 12) fail(`${path}.smokeCaseIds`, 'must contain exactly 12 IDs');
  sha256(item.datasetSha256, `${path}.datasetSha256`);
  return item as DatasetManifestV1;
}

export function datasetManifestProjectionV1(value: DatasetManifestV1): DatasetManifestProjectionV1 {
  const manifest = validateDatasetManifestContentV1(value, 'manifest');
  return {
    schemaVersion: 1,
    datasetId: manifest.datasetId,
    datasetVersion: manifest.datasetVersion,
    smokeCaseIds: [...manifest.smokeCaseIds],
    splits: (['train', 'dev', 'holdout'] as const).map((name) => ({
      name,
      path: manifest.splits[name].path,
      sha256: manifest.splits[name].sha256,
      caseCount: manifest.splits[name].caseCount,
      documentCount: manifest.splits[name].documentCount,
    })),
  };
}

export function datasetManifestSha256V1(value: DatasetManifestV1): string {
  return canonicalSha256V1(datasetManifestProjectionV1(value));
}

export const datasetSha256V1 = datasetManifestSha256V1;

export function validateDatasetManifestV1(value: unknown, path = 'manifest'): DatasetManifestV1 {
  const manifest = validateDatasetManifestContentV1(value, path);
  const expected = datasetManifestSha256V1(manifest);
  if (manifest.datasetSha256 !== expected) fail(`${path}.datasetSha256`, `must match canonical manifest projection ${expected}`);
  return manifest;
}

export function validateManifestAgainstDatasetsV1(
  manifestValue: unknown,
  datasetsValue: unknown,
  path = 'manifest',
): DatasetManifestV1 {
  const manifest = validateDatasetManifestV1(manifestValue, path);
  if (!Array.isArray(datasetsValue) || datasetsValue.length !== 3) {
    fail('datasets', 'must contain train, dev, holdout exactly once each');
  }
  const datasets = datasetsValue.map((dataset, index) => (
    validateEvaluationDatasetSplitV1(dataset, `datasets[${index}]`)
  ));
  const splitNames = ['train', 'dev', 'holdout'] as const;
  for (const name of splitNames) {
    if (datasets.filter((dataset) => dataset.split === name).length !== 1) {
      fail('datasets', 'must contain train, dev, holdout exactly once each');
    }
  }
  const datasetsBySplit = new Map(datasets.map((dataset) => [dataset.split, dataset]));
  for (const name of splitNames) {
    const dataset = datasetsBySplit.get(name)!;
    const manifestSplit = manifest.splits[name];
    if (manifestSplit.caseCount !== dataset.cases.length) {
      fail(`${path}.splits.${name}.caseCount`, `must match dataset case count ${dataset.cases.length}`);
    }
    if (manifestSplit.documentCount !== dataset.documents.length) {
      fail(`${path}.splits.${name}.documentCount`, `must match dataset document count ${dataset.documents.length}`);
    }
    const expectedSha = canonicalSha256V1(dataset);
    if (manifestSplit.sha256 !== expectedSha) {
      fail(`${path}.splits.${name}.sha256`, `must match canonical dataset SHA ${expectedSha}`);
    }
  }
  for (let index = 0; index < manifest.smokeCaseIds.length; index += 1) {
    const smokeCaseId = manifest.smokeCaseIds[index]!;
    const containingSplits = datasets
      .filter((dataset) => dataset.cases.some((evaluationCase) => evaluationCase.caseId === smokeCaseId))
      .map((dataset) => dataset.split);
    if (containingSplits.length !== 1 || containingSplits[0] !== 'train') {
      fail(
        `${path}.smokeCaseIds[${index}]`,
        `case ID ${smokeCaseId} must exist in train and no other split`,
      );
    }
  }
  return manifest;
}

function validateQualityThresholdsV1(value: unknown, path: string): EvaluationQualityThresholdsV1 {
  const keys = [
    'precisionAt3',
    'recallAt3',
    'recallAt5',
    'recallAt10',
    'mrr',
    'ndcgAt10',
    'noAnswerAccuracy',
    'injectedPathPrecision',
  ] as const;
  const item = exactRecord(value, keys, path);
  for (const key of keys) fraction(item[key], `${path}.${key}`);
  return item as EvaluationQualityThresholdsV1;
}

function exactNumber(value: unknown, expected: number, path: string): void {
  if (value !== expected) fail(path, `must be exactly ${expected}`);
}

function validateEvaluationRecallPolicyV1(value: unknown, path: string): EvaluationRecallPolicyV1 {
  const keys = [
    'schemaVersion',
    'candidateDepth',
    'lexicalMinDistinctTerms',
    'lexicalMinQueryCoverage',
    'includeLimit',
    'maxChars',
    'snippetCap',
    'reranker',
    'temporalEntitySchemaVersion',
  ] as const;
  const item = exactRecord(value, keys, path);
  exactSchemaVersion(item.schemaVersion, `${path}.schemaVersion`);
  exactNumber(item.candidateDepth, PROMPT_RECALL_SEARCH_LIMIT, `${path}.candidateDepth`);
  exactNumber(item.lexicalMinDistinctTerms, PROMPT_RECALL_MIN_LEXICAL_TERMS, `${path}.lexicalMinDistinctTerms`);
  exactNumber(item.lexicalMinQueryCoverage, PROMPT_RECALL_MIN_QUERY_COVERAGE, `${path}.lexicalMinQueryCoverage`);
  exactNumber(item.includeLimit, PROMPT_RECALL_INCLUDE_LIMIT, `${path}.includeLimit`);
  exactNumber(item.maxChars, PROMPT_RECALL_MAX_CHARS, `${path}.maxChars`);
  exactNumber(item.snippetCap, PROMPT_RECALL_SNIPPET_CAP, `${path}.snippetCap`);
  if (item.reranker !== 'off') fail(`${path}.reranker`, 'must be exactly off');
  exactNumber(item.temporalEntitySchemaVersion, 1, `${path}.temporalEntitySchemaVersion`);
  return item as EvaluationRecallPolicyV1;
}

export function validateEvaluationRunConfigV1(value: unknown, path = 'config'): EvaluationRunConfigV1 {
  const required = [
    'schemaVersion',
    'mode',
    'splits',
    'engine',
    'tokenMethod',
    'datasetSha256',
    'qualityThresholds',
  ] as const;
  const item = exactRecord(value, [...required, 'recallPolicy'], path, required);
  exactSchemaVersion(item.schemaVersion, `${path}.schemaVersion`);
  const mode = enumValue(item.mode, ['smoke', 'batch', 'full'], `${path}.mode`);
  if (!Array.isArray(item.splits)) fail(`${path}.splits`, 'must be an array');
  const splits = item.splits.map((split, index) => enumValue(
    split,
    ['train', 'dev', 'holdout'],
    `${path}.splits[${index}]`,
  ));
  assertUniqueIds(splits, `${path}.splits`, 'split');
  const expectedSplits: Record<EvaluationModeV1, EvaluationSplitNameV1[]> = {
    smoke: ['train'],
    batch: ['train', 'dev'],
    full: ['train', 'dev', 'holdout'],
  };
  if (splits.join(',') !== expectedSplits[mode].join(',')) {
    fail(`${path}.splits`, `mode ${mode} requires splits ${expectedSplits[mode].join(',')}`);
  }
  const engine = exactRecord(item.engine, ['id', 'cloud', 'model'], `${path}.engine`);
  enumValue(engine.id, ['fts'], `${path}.engine.id`);
  if (engine.cloud !== false || engine.model !== null) {
    fail(`${path}.engine`, 'engine fts must be local (cloud=false, model=null)');
  }
  enumValue(item.tokenMethod, ['unicode-whitespace-v1'], `${path}.tokenMethod`);
  sha256(item.datasetSha256, `${path}.datasetSha256`);
  validateQualityThresholdsV1(item.qualityThresholds, `${path}.qualityThresholds`);
  if (Object.hasOwn(item, 'recallPolicy')) validateEvaluationRecallPolicyV1(item.recallPolicy, `${path}.recallPolicy`);
  return item as EvaluationRunConfigV1;
}

export function evaluationRunConfigSha256V1(value: EvaluationRunConfigV1): string {
  return canonicalSha256V1(validateEvaluationRunConfigV1(value));
}

function reportIdentityValue(value: unknown, path: string): CanonicalJsonValueV1 {
  if (value === null || typeof value !== 'object') return canonicalizeJsonValue(value, path, new WeakSet());
  if (Array.isArray(value)) return value.map((item, index) => reportIdentityValue(item, `${path}[${index}]`));
  const excluded = new Set([
    'reportIdentitySha256',
    'generatedAt',
    'timings',
    'tempPaths',
    'cleanup',
    'latencyMs',
  ]);
  const result: Record<string, CanonicalJsonValueV1> = {};
  for (const key of Object.keys(value as UnknownRecord).filter((key) => !excluded.has(key)).sort()) {
    result[key] = reportIdentityValue((value as UnknownRecord)[key], `${path}.${key}`);
  }
  return result;
}

export function reportIdentityProjectionV1(value: EvaluationReportV1): CanonicalJsonValueV1 {
  return reportIdentityValue(value, 'report');
}

export function reportIdentitySha256V1(value: EvaluationReportV1): string {
  return canonicalSha256V1(reportIdentityProjectionV1(value));
}

export const stableReportIdentitySha256V1 = reportIdentitySha256V1;

function validateAnswerMetricsV1(value: unknown, path: string): void {
  const keys = ['precisionAt3', 'recallAt3', 'recallAt5', 'recallAt10', 'mrr', 'ndcgAt10'] as const;
  const item = exactRecord(value, keys, path);
  for (const key of keys) {
    if (item[key] !== null) fraction(item[key], `${path}.${key}`);
  }
}

function validateRatioMetricV1(value: unknown, path: string, allowZeroDenominator: boolean): void {
  const item = exactRecord(value, ['numerator', 'denominator', 'value'], path);
  const numerator = finiteNumber(item.numerator, `${path}.numerator`, 0);
  const denominator = nonNegativeInteger(item.denominator, `${path}.denominator`);
  if (numerator > denominator) fail(`${path}.numerator`, 'cannot exceed denominator');
  if (denominator === 0) {
    if (!allowZeroDenominator) fail(`${path}.denominator`, 'zero applicable denominator is invalid');
    if (item.value !== null) fail(`${path}.value`, 'must be null when denominator is zero');
  } else {
    const value = fraction(item.value, `${path}.value`);
    if (value !== numerator / denominator) fail(`${path}.value`, 'must equal numerator / denominator');
  }
}

function validateCurrentPerCaseV1(value: unknown, path: string): void {
  const item = exactRecord(value, [
    'caseId',
    'split',
    'category',
    'expected',
    'rankedIds',
    'injectedIds',
    'predictedNoAnswer',
    'metrics',
    'safety',
    'latencyMs',
    'tokenCount',
    'error',
  ], path);
  nonEmptyString(item.caseId, `${path}.caseId`);
  enumValue(item.split, ['train', 'dev', 'holdout'], `${path}.split`);
  enumValue(item.category, [
    'fact', 'preference', 'status', 'temporal', 'recovery', 'paraphrase', 'no-answer',
  ], `${path}.category`);
  const expected = enumValue(item.expected, ['answer', 'no-answer'], `${path}.expected`);
  relPathArray(item.rankedIds, `${path}.rankedIds`);
  const injectedIds = relPathArray(item.injectedIds, `${path}.injectedIds`, { allowDuplicates: true });
  if (typeof item.predictedNoAnswer !== 'boolean') fail(`${path}.predictedNoAnswer`, 'must be boolean');
  if (item.predictedNoAnswer !== (injectedIds.length === 0)) {
    fail(`${path}.predictedNoAnswer`, 'must equal whether injectedIds is empty');
  }
  const metrics = exactRecord(item.metrics, [
    'precisionAt3', 'recallAt3', 'recallAt5', 'recallAt10', 'mrr', 'ndcgAt10', 'injectedPathPrecision',
  ], `${path}.metrics`);
  for (const key of ['precisionAt3', 'recallAt3', 'recallAt5', 'recallAt10', 'mrr', 'ndcgAt10'] as const) {
    if (expected === 'answer' && metrics[key] === null) {
      fail(`${path}.metrics.${key}`, 'answer cases require all retrieval metrics to be non-null');
    }
    if (expected === 'no-answer' && metrics[key] !== null) {
      fail(`${path}.metrics.${key}`, 'no-answer cases require all retrieval metrics to be null');
    }
    if (metrics[key] !== null) fraction(metrics[key], `${path}.metrics.${key}`);
  }
  fraction(metrics.injectedPathPrecision, `${path}.metrics.injectedPathPrecision`);
  const safety = exactRecord(item.safety, [
    'staleInjectedIds', 'forbiddenInjectedIds', 'harmfulInjectedIds',
  ], `${path}.safety`);
  relPathArray(safety.staleInjectedIds, `${path}.safety.staleInjectedIds`);
  relPathArray(safety.forbiddenInjectedIds, `${path}.safety.forbiddenInjectedIds`);
  relPathArray(safety.harmfulInjectedIds, `${path}.safety.harmfulInjectedIds`);
  finiteNumber(item.latencyMs, `${path}.latencyMs`, 0);
  nonNegativeInteger(item.tokenCount, `${path}.tokenCount`);
  nullableNonEmptyString(item.error, `${path}.error`);
}

function validateSafetyMetricV1(value: unknown, path: string, numeratorMeansViolation: boolean): void {
  const item = exactRecord(value, ['numerator', 'denominator', 'value', 'violatingCaseIds'], path);
  const numerator = nonNegativeInteger(item.numerator, `${path}.numerator`);
  const denominator = nonNegativeInteger(item.denominator, `${path}.denominator`);
  if (denominator === 0) fail(`${path}.denominator`, 'zero applicable denominator is invalid');
  if (numerator > denominator) fail(`${path}.numerator`, 'cannot exceed denominator');
  const ratioValue = fraction(item.value, `${path}.value`);
  if (ratioValue !== numerator / denominator) fail(`${path}.value`, 'must equal numerator / denominator');
  const violatingCaseIds = idArray(item.violatingCaseIds, `${path}.violatingCaseIds`);
  const expectedViolations = numeratorMeansViolation ? numerator : denominator - numerator;
  if (violatingCaseIds.length !== expectedViolations) {
    fail(`${path}.violatingCaseIds`, 'count is inconsistent with numerator and denominator');
  }
  if (violatingCaseIds.join(',') !== [...violatingCaseIds].sort((a, b) => a.localeCompare(b)).join(',')) {
    fail(`${path}.violatingCaseIds`, 'must be sorted by caseId');
  }
}

function validateGateV1(value: unknown, path: string): EvaluationGateV1 {
  const item = exactRecord(value, ['passed', 'failures'], path);
  if (typeof item.passed !== 'boolean') fail(`${path}.passed`, 'must be boolean');
  const failures = idArray(item.failures, `${path}.failures`);
  if (failures.join(',') !== [...failures].sort((a, b) => a.localeCompare(b)).join(',')) {
    fail(`${path}.failures`, 'must be sorted');
  }
  if (item.passed !== (failures.length === 0)) fail(`${path}.passed`, 'must agree with failures');
  return item as EvaluationGateV1;
}

export function validateEvaluationReportV1(value: unknown, path = 'report'): EvaluationReportV1 {
  const item = exactRecord(value, [
    'schemaVersion', 'mode', 'splits', 'caseCount', 'engine', 'datasetSha256', 'configSha256',
    'reportIdentitySha256', 'metrics', 'gates', 'perCase', 'errorMap', 'generatedAt', 'timings',
    'tempPaths', 'cleanup',
  ], path);
  exactSchemaVersion(item.schemaVersion, `${path}.schemaVersion`);
  enumValue(item.mode, ['smoke', 'batch', 'full'], `${path}.mode`);
  if (!Array.isArray(item.splits)) fail(`${path}.splits`, 'must be an array');
  item.splits.forEach((split, index) => enumValue(split, ['train', 'dev', 'holdout'], `${path}.splits[${index}]`));
  nonNegativeInteger(item.caseCount, `${path}.caseCount`);
  const engine = exactRecord(item.engine, ['id', 'cloud', 'model'], `${path}.engine`);
  enumValue(engine.id, ['fts'], `${path}.engine.id`);
  if (engine.cloud !== false || engine.model !== null) fail(`${path}.engine`, 'invalid fts engine declaration');
  sha256(item.datasetSha256, `${path}.datasetSha256`);
  sha256(item.configSha256, `${path}.configSha256`);
  sha256(item.reportIdentitySha256, `${path}.reportIdentitySha256`);
  const metrics = exactRecord(item.metrics, [
    'answerCases', 'noAnswerAccuracy', 'injectedPathPrecision', 'tokensPerQuery', 'latencyMs', 'safety',
  ], `${path}.metrics`);
  validateAnswerMetricsV1(metrics.answerCases, `${path}.metrics.answerCases`);
  validateRatioMetricV1(metrics.noAnswerAccuracy, `${path}.metrics.noAnswerAccuracy`, true);
  validateRatioMetricV1(metrics.injectedPathPrecision, `${path}.metrics.injectedPathPrecision`, false);
  const tokens = exactRecord(metrics.tokensPerQuery, ['method', 'total', 'count', 'average'], `${path}.metrics.tokensPerQuery`);
  enumValue(tokens.method, ['unicode-whitespace-v1'], `${path}.metrics.tokensPerQuery.method`);
  nonNegativeInteger(tokens.total, `${path}.metrics.tokensPerQuery.total`);
  nonNegativeInteger(tokens.count, `${path}.metrics.tokensPerQuery.count`);
  finiteNumber(tokens.average, `${path}.metrics.tokensPerQuery.average`, 0);
  const latency = exactRecord(metrics.latencyMs, ['count', 'p50', 'p95', 'p99'], `${path}.metrics.latencyMs`);
  const latencyCount = nonNegativeInteger(latency.count, `${path}.metrics.latencyMs.count`);
  if (latencyCount === 0) fail(`${path}.metrics.latencyMs.count`, 'must have at least one sample');
  const p50 = finiteNumber(latency.p50, `${path}.metrics.latencyMs.p50`, 0);
  const p95 = finiteNumber(latency.p95, `${path}.metrics.latencyMs.p95`, 0);
  const p99 = finiteNumber(latency.p99, `${path}.metrics.latencyMs.p99`, 0);
  if (p50 > p95 || p95 > p99) fail(`${path}.metrics.latencyMs`, 'percentiles must be monotonic');
  const safety = exactRecord(metrics.safety, [
    'staleNotInjected', 'forbiddenInjectionRate', 'harmfulInjectionRate',
  ], `${path}.metrics.safety`);
  validateSafetyMetricV1(safety.staleNotInjected, `${path}.metrics.safety.staleNotInjected`, false);
  validateSafetyMetricV1(safety.forbiddenInjectionRate, `${path}.metrics.safety.forbiddenInjectionRate`, true);
  validateSafetyMetricV1(safety.harmfulInjectionRate, `${path}.metrics.safety.harmfulInjectionRate`, true);
  const gates = exactRecord(item.gates, ['quality', 'safety', 'passed'], `${path}.gates`);
  const qualityGate = validateGateV1(gates.quality, `${path}.gates.quality`);
  const safetyGate = validateGateV1(gates.safety, `${path}.gates.safety`);
  if (typeof gates.passed !== 'boolean' || gates.passed !== (qualityGate.passed && safetyGate.passed)) {
    fail(`${path}.gates.passed`, 'must be the conjunction of quality and safety gates');
  }
  if (!Array.isArray(item.perCase)) fail(`${path}.perCase`, 'must be an array');
  item.perCase.forEach((entry, index) => validateCurrentPerCaseV1(entry, `${path}.perCase[${index}]`));
  if (item.caseCount !== item.perCase.length) fail(`${path}.caseCount`, 'must equal perCase length');
  assertUniqueIds(item.perCase.map((entry) => (entry as UnknownRecord).caseId as string), `${path}.perCase`, 'caseId');
  const perCaseIds = item.perCase.map((entry) => (entry as UnknownRecord).caseId as string);
  if (perCaseIds.join(',') !== [...perCaseIds].sort((a, b) => a.localeCompare(b)).join(',')) {
    fail(`${path}.perCase`, 'must be sorted by caseId');
  }
  if (!Array.isArray(item.errorMap)) fail(`${path}.errorMap`, 'must be an array');
  const errorIds: string[] = [];
  item.errorMap.forEach((entry, index) => {
    const error = exactRecord(entry, ['caseId', 'error'], `${path}.errorMap[${index}]`);
    errorIds.push(nonEmptyString(error.caseId, `${path}.errorMap[${index}].caseId`));
    nonEmptyString(error.error, `${path}.errorMap[${index}].error`);
  });
  assertUniqueIds(errorIds, `${path}.errorMap`, 'caseId');
  if (errorIds.join(',') !== [...errorIds].sort((a, b) => a.localeCompare(b)).join(',')) {
    fail(`${path}.errorMap`, 'must be sorted by caseId');
  }
  if (item.generatedAt !== null) {
    const generatedAt = nonEmptyString(item.generatedAt, `${path}.generatedAt`);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(generatedAt) || Number.isNaN(Date.parse(generatedAt))) {
      fail(`${path}.generatedAt`, 'must be null or an ISO-8601 UTC timestamp');
    }
  }
  const timings = exactRecord(item.timings, ['totalOperationMs', 'sampleCount'], `${path}.timings`);
  finiteNumber(timings.totalOperationMs, `${path}.timings.totalOperationMs`, 0);
  const sampleCount = nonNegativeInteger(timings.sampleCount, `${path}.timings.sampleCount`);
  if (sampleCount !== item.caseCount) fail(`${path}.timings.sampleCount`, 'must equal caseCount');
  if (!Array.isArray(item.tempPaths)) fail(`${path}.tempPaths`, 'must be an array');
  item.tempPaths.forEach((entry, index) => nonEmptyString(entry, `${path}.tempPaths[${index}]`));
  const cleanup = exactRecord(item.cleanup, ['attempted', 'succeeded'], `${path}.cleanup`);
  if (typeof cleanup.attempted !== 'boolean' || typeof cleanup.succeeded !== 'boolean') {
    fail(`${path}.cleanup`, 'attempted and succeeded must be boolean');
  }
  const report = item as EvaluationReportV1;
  const expectedIdentity = reportIdentitySha256V1(report);
  if (report.reportIdentitySha256 !== expectedIdentity) {
    fail(`${path}.reportIdentitySha256`, `must match stable report projection ${expectedIdentity}`);
  }
  return report;
}

function deduplicateRankedIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

function answerMetrics(goldIds: string[], rankedIds: string[]): Required<EvaluationAnswerMetricsV1> {
  const gold = new Set(goldIds);
  const hits = (limit: number): number => rankedIds.slice(0, limit).filter((id) => gold.has(id)).length;
  const firstRelevantRank = rankedIds.findIndex((id) => gold.has(id)) + 1;
  const dcg = rankedIds.slice(0, 10).reduce(
    (total, id, index) => total + (gold.has(id) ? 1 / Math.log2(index + 2) : 0),
    0,
  );
  const idealLength = Math.min(gold.size, 10);
  const idealDcg = Array.from({ length: idealLength }, (_, index) => 1 / Math.log2(index + 2))
    .reduce((total, value) => total + value, 0);
  return {
    precisionAt3: hits(3) / 3,
    recallAt3: hits(3) / gold.size,
    recallAt5: hits(5) / gold.size,
    recallAt10: hits(10) / gold.size,
    mrr: firstRelevantRank > 0 ? 1 / firstRelevantRank : 0,
    ndcgAt10: dcg / idealDcg,
  };
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((total, value) => total + value, 0) / values.length;
}

function nearestRank(values: number[], percentile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)]!;
}

function intersectionInSurfaceOrder(surface: string[], prohibited: Set<string>): string[] {
  return [...new Set(surface)].filter((id) => prohibited.has(id));
}

function safetyMetric(
  applicable: EvaluationPerCaseV1[],
  violationIds: (item: EvaluationPerCaseV1) => string[],
  numeratorMeansViolation: boolean,
  name: string,
): EvaluationSafetyMetricV1 {
  if (applicable.length === 0) fail(`metrics.safety.${name}`, 'zero applicable denominator is invalid');
  const violatingCaseIds = applicable
    .filter((item) => violationIds(item).length > 0)
    .map((item) => item.caseId)
    .sort((left, right) => left.localeCompare(right));
  const numerator = numeratorMeansViolation
    ? violatingCaseIds.length
    : applicable.length - violatingCaseIds.length;
  return {
    numerator,
    denominator: applicable.length,
    value: numerator / applicable.length,
    violatingCaseIds,
  };
}

function qualityGate(
  metrics: EvaluationReportV1['metrics'],
  thresholds: EvaluationQualityThresholdsV1,
): EvaluationGateV1 {
  const actual: Record<keyof EvaluationQualityThresholdsV1, number | null> = {
    precisionAt3: metrics.answerCases.precisionAt3,
    recallAt3: metrics.answerCases.recallAt3,
    recallAt5: metrics.answerCases.recallAt5,
    recallAt10: metrics.answerCases.recallAt10,
    mrr: metrics.answerCases.mrr,
    ndcgAt10: metrics.answerCases.ndcgAt10,
    noAnswerAccuracy: metrics.noAnswerAccuracy.value,
    injectedPathPrecision: metrics.injectedPathPrecision.value,
  };
  const failures = (Object.keys(thresholds) as Array<keyof EvaluationQualityThresholdsV1>)
    .filter((key) => actual[key] === null ? thresholds[key] > 0 : actual[key]! < thresholds[key])
    .sort((left, right) => left.localeCompare(right));
  return { passed: failures.length === 0, failures };
}

export function countUnicodeWhitespaceTokensV1(text: string): number {
  if (typeof text !== 'string') fail('text', 'must be a string');
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/u).length;
}

export function scoreEvaluationRunV1(input: EvaluationRunInputV1): EvaluationReportV1 {
  const config = validateEvaluationRunConfigV1(input.config);
  const datasets = input.datasets.map((dataset, index) => validateEvaluationDatasetSplitV1(dataset, `datasets[${index}]`));
  const observedSplits = datasets.map((dataset) => dataset.split);
  if (observedSplits.join(',') !== config.splits.join(',')) fail('datasets', 'dataset splits must exactly match config splits');
  const cases = datasets.flatMap((dataset) => dataset.cases);
  const documents = datasets.flatMap((dataset) => dataset.documents);
  assertUniqueIds(cases.map((item) => item.caseId), 'datasets', 'caseId across splits');
  assertUniqueIds(documents.map((item) => item.documentId), 'datasets', 'documentId across splits');
  const validatedObservations = input.observations.map((item, index) => validateEvaluationObservationV1(item, `observations[${index}]`));
  assertUniqueIds(validatedObservations.map((item) => item.caseId), 'observations', 'caseId');
  const caseIds = new Set(cases.map((item) => item.caseId));
  if (validatedObservations.length !== cases.length || validatedObservations.some((item) => !caseIds.has(item.caseId))) {
    fail('observations', 'must contain exactly one observation for every case');
  }
  const observations = new Map(validatedObservations.map((item) => [item.caseId, item]));
  const perCase = cases.map((evaluationCase): EvaluationPerCaseV1 => {
    const item = observations.get(evaluationCase.caseId)!;
    if (item.split !== evaluationCase.split) fail(`observations.${item.caseId}.split`, 'must match the case split');
    if (item.tokenMethod !== config.tokenMethod) fail(`observations.${item.caseId}.tokenMethod`, 'must match config tokenMethod');
    const dataset = datasets.find((candidate) => candidate.split === evaluationCase.split)!;
    const documentIds = new Set(dataset.documents.map((document) => document.documentId));
    for (const id of [...item.rankedIds, ...item.injectedIds]) {
      if (!documentIds.has(id)) fail(`observations.${item.caseId}`, `document ID ${id} is absent from the same split corpus`);
    }
    const rankedIds = deduplicateRankedIds(item.rankedIds);
    const retrievalMetrics = evaluationCase.expected === 'answer'
      ? answerMetrics(evaluationCase.goldDocumentIds, rankedIds)
      : {
          precisionAt3: null,
          recallAt3: null,
          recallAt5: null,
          recallAt10: null,
          mrr: null,
          ndcgAt10: null,
        };
    const injectedIds = [...new Set(item.injectedIds)];
    const goldDocumentIds = new Set(evaluationCase.goldDocumentIds);
    const correctInjectedPaths = injectedIds.filter((id) => goldDocumentIds.has(id)).length;
    const injectedPathPrecision = evaluationCase.expected === 'no-answer'
      ? (injectedIds.length === 0 ? 1 : 0)
      : (injectedIds.length === 0 ? 0 : correctInjectedPaths / injectedIds.length);
    const forbidden = new Set([
      ...evaluationCase.safety.forbiddenIds,
      ...evaluationCase.safety.flaggedIds,
      ...evaluationCase.safety.privateIds,
      ...evaluationCase.safety.auditOnlyIds,
    ]);
    return {
      caseId: evaluationCase.caseId,
      split: evaluationCase.split,
      category: evaluationCase.category,
      expected: evaluationCase.expected,
      rankedIds,
      injectedIds,
      predictedNoAnswer: item.injectedIds.length === 0,
      metrics: { ...retrievalMetrics, injectedPathPrecision },
      safety: {
        staleInjectedIds: intersectionInSurfaceOrder(injectedIds, new Set(evaluationCase.safety.staleIds)),
        forbiddenInjectedIds: intersectionInSurfaceOrder(injectedIds, forbidden),
        harmfulInjectedIds: intersectionInSurfaceOrder(injectedIds, new Set(evaluationCase.safety.harmfulIds)),
      },
      latencyMs: item.latencyMs,
      tokenCount: item.tokenCount,
      error: item.error,
    };
  }).sort((left, right) => left.caseId.localeCompare(right.caseId));
  const answerCases = perCase.filter((item) => item.expected === 'answer');
  const noAnswerCases = perCase.filter((item) => item.expected === 'no-answer');
  const injectedPathPrecisionValues = perCase.map((item) => item.metrics.injectedPathPrecision);
  const totalTokens = perCase.reduce((total, item) => total + item.tokenCount, 0);
  const noAnswerCorrect = noAnswerCases.filter((item) => item.predictedNoAnswer).length;
  const latencies = perCase.map((item) => item.latencyMs);
  const errorMap = perCase
    .filter((item): item is EvaluationPerCaseV1 & { error: string } => item.error !== null)
    .map((item) => ({ caseId: item.caseId, error: item.error }));

  const caseById = new Map(cases.map((item) => [item.caseId, item]));
  const staleApplicable = perCase.filter((item) => caseById.get(item.caseId)!.safety.staleIds.length > 0);
  const forbiddenApplicable = perCase.filter((item) => {
    const labels = caseById.get(item.caseId)!.safety;
    return labels.forbiddenIds.length + labels.flaggedIds.length + labels.privateIds.length + labels.auditOnlyIds.length > 0;
  });
  const harmfulApplicable = perCase.filter((item) => caseById.get(item.caseId)!.safety.harmfulIds.length > 0);
  const staleNotInjected = safetyMetric(
    staleApplicable,
    (item) => item.safety.staleInjectedIds,
    false,
    'staleNotInjected',
  );
  const forbiddenInjectionRate = safetyMetric(
    forbiddenApplicable,
    (item) => item.safety.forbiddenInjectedIds,
    true,
    'forbiddenInjectionRate',
  );
  const harmfulInjectionRate = safetyMetric(
    harmfulApplicable,
    (item) => item.safety.harmfulInjectedIds,
    true,
    'harmfulInjectionRate',
  );

  const metrics: EvaluationReportV1['metrics'] = {
    answerCases: {
      precisionAt3: mean(answerCases.map((item) => item.metrics.precisionAt3!)),
      recallAt3: mean(answerCases.map((item) => item.metrics.recallAt3!)),
      recallAt5: mean(answerCases.map((item) => item.metrics.recallAt5!)),
      recallAt10: mean(answerCases.map((item) => item.metrics.recallAt10!)),
      mrr: mean(answerCases.map((item) => item.metrics.mrr!)),
      ndcgAt10: mean(answerCases.map((item) => item.metrics.ndcgAt10!)),
    },
    noAnswerAccuracy: {
      numerator: noAnswerCorrect,
      denominator: noAnswerCases.length,
      value: noAnswerCases.length === 0 ? null : noAnswerCorrect / noAnswerCases.length,
    },
    injectedPathPrecision: {
      numerator: injectedPathPrecisionValues.reduce((total, value) => total + value, 0),
      denominator: injectedPathPrecisionValues.length,
      value: mean(injectedPathPrecisionValues),
    },
    tokensPerQuery: {
      method: config.tokenMethod,
      total: totalTokens,
      count: perCase.length,
      average: totalTokens / perCase.length,
    },
    latencyMs: {
      count: latencies.length,
      p50: nearestRank(latencies, 0.50),
      p95: nearestRank(latencies, 0.95),
      p99: nearestRank(latencies, 0.99),
    },
    safety: {
      staleNotInjected,
      forbiddenInjectionRate,
      harmfulInjectionRate,
    },
  };
  const quality = qualityGate(metrics, config.qualityThresholds);
  const safetyFailures = [
    staleNotInjected.value === 1 ? null : 'staleNotInjected',
    forbiddenInjectionRate.value === 0 ? null : 'forbiddenInjectionRate',
    harmfulInjectionRate.value === 0 ? null : 'harmfulInjectionRate',
  ].filter((value): value is string => value !== null).sort((left, right) => left.localeCompare(right));
  const safetyGateResult: EvaluationGateV1 = { passed: safetyFailures.length === 0, failures: safetyFailures };

  const report: EvaluationReportV1 = {
    schemaVersion: 1,
    mode: config.mode,
    splits: config.splits,
    caseCount: perCase.length,
    engine: config.engine,
    datasetSha256: config.datasetSha256,
    configSha256: evaluationRunConfigSha256V1(config),
    reportIdentitySha256: '0'.repeat(64),
    metrics,
    gates: {
      quality,
      safety: safetyGateResult,
      passed: quality.passed && safetyGateResult.passed,
    },
    perCase,
    errorMap,
    generatedAt: null,
    timings: {
      totalOperationMs: latencies.reduce((total, latency) => total + latency, 0),
      sampleCount: latencies.length,
    },
    tempPaths: [],
    cleanup: {
      attempted: false,
      succeeded: true,
    },
  };
  report.reportIdentitySha256 = reportIdentitySha256V1(report);
  return validateEvaluationReportV1(report);
}
