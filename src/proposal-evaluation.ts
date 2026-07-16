// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory

import {
  canonicalSha256V1,
  type CanonicalJsonValueV1,
} from './evaluation.ts';
import {
  MEMORY_PROPOSAL_KINDS_V1,
  normalizeRelationTextV1,
  type MemoryFeedbackEvidenceV1,
  type MemoryProposalKindV1,
  type MemoryProposalRelationVerdictV1,
  type MemoryProposalRequestV1,
} from './memory-proposals.ts';
import { containsSecretLikeContent, redactSecretLikeContent } from './governance.ts';

export const PROPOSAL_SOURCE_KINDS_V1 = ['transcript', 'runtime-event'] as const;
export const PROPOSAL_HOSTILE_CLASSES_V1 = ['secret', 'private', 'audit-only', 'malformed'] as const;

export type ProposalSourceKindV1 = typeof PROPOSAL_SOURCE_KINDS_V1[number];
export type ProposalHostileClassV1 = typeof PROPOSAL_HOSTILE_CLASSES_V1[number];
export type ProposalExpectedOutcomeV1 = 'stage' | 'ignore' | 'block';

export type ProposalEvaluationExpectedV1 = {
  kind: MemoryProposalKindV1;
  subject: string;
  key: string;
  value: string;
  relationVerdict: MemoryProposalRelationVerdictV1;
};

export type ProposalEvaluationSetupEntryV1 = {
  path: string;
  kind: MemoryProposalKindV1;
  subject: string;
  key: string;
  value: string;
};

export type ProposalEvaluationCaseV1 = {
  schemaVersion: 1;
  caseId: string;
  sourceKind: ProposalSourceKindV1;
  mustPropose: boolean;
  expectedOutcome: ProposalExpectedOutcomeV1;
  negativeControlClass: ProposalHostileClassV1 | null;
  request: MemoryProposalRequestV1 | Record<string, unknown>;
  expectedProposal: ProposalEvaluationExpectedV1 | null;
  setup: {
    existingProposals: ProposalEvaluationSetupEntryV1[];
    forgottenPaths: string[];
  };
};

export type ProposalEvaluationDatasetV1 = {
  schemaVersion: 1;
  datasetId: string;
  datasetVersion: string;
  cases: ProposalEvaluationCaseV1[];
  feedbackEvents: Array<{
    id: string;
    type: 'memory.forgotten' | 'memory.remembered';
    at: string;
    path: string;
  }>;
};

export type ProposalEvaluationConfigV1 = {
  schemaVersion: 1;
  datasetSha256: string;
  thresholds: {
    proposalPrecisionMin: number;
    mustProposeRecall: 1;
    unsafeDurableWritesMax: 0;
    unsafeIndexWritesMax: 0;
    stagingViolationsMax: 0;
    runtimeErrorsMax: 0;
    cleanupRequired: true;
  };
  requiredKinds: MemoryProposalKindV1[];
  requiredSourceKinds: ProposalSourceKindV1[];
  hostileClasses: ProposalHostileClassV1[];
};

export type ProposalEvaluationManifestV1 = {
  schemaVersion: 1;
  datasetId: string;
  datasetVersion: string;
  cases: {
    path: 'eval/proposals/v1/cases.json';
    sha256: string;
    caseCount: number;
  };
  config: ProposalEvaluationConfigV1;
  manifestSha256: string;
};

export type ProposalEvaluationObservationV1 = {
  schemaVersion: 1;
  caseId: string;
  observedOutcome: ProposalExpectedOutcomeV1;
  emittedProposals: Array<ProposalEvaluationExpectedV1 & { proposalId: string }>;
  persistence: {
    candidateDelta: number;
    eventDelta: number;
    durableDelta: number;
    historyDelta: number;
    ftsDelta: number;
    indexManifestDelta: number;
    eventTypes: string[];
  };
  error: string | null;
};

export type ProposalEvaluationRunInputV1 = {
  dataset: ProposalEvaluationDatasetV1;
  observations: ProposalEvaluationObservationV1[];
  config: ProposalEvaluationConfigV1;
  feedbackEvidence: MemoryFeedbackEvidenceV1[];
  alpha28: {
    datasetSha256: string;
    splits: { train: string; dev: string; holdout: string };
  };
  isolationPassed: boolean;
  cleanupSucceeded: boolean;
  generatedAt: string | null;
  timings: { totalOperationMs: number };
  tempPaths: string[];
};

type UnknownRecord = Record<string, unknown>;

function fail(path: string, message: string): never {
  throw new Error(`${path}: ${message}`);
}

function exactRecord(value: unknown, keys: readonly string[], path: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'must be an object');
  const item = value as UnknownRecord;
  for (const key of Object.keys(item)) if (!keys.includes(key)) fail(`${path}.${key}`, 'unknown field');
  for (const key of keys) if (!Object.hasOwn(item, key)) fail(`${path}.${key}`, 'missing field');
  return item;
}

function boundedString(value: unknown, path: string, max = 512): string {
  if (typeof value !== 'string') fail(path, 'must be a string');
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (!normalized) fail(path, 'must be non-empty');
  if (normalized.length > max) fail(path, `must be at most ${max} characters`);
  return normalized;
}

function literal<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) fail(path, `must be one of ${allowed.join('|')}`);
  return value as T;
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) fail(path, 'must be a non-negative integer');
  return value as number;
}

function sha256(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) fail(path, 'must be a lowercase SHA-256');
  return value;
}

function exactOrderedValues<T extends string>(value: unknown, expected: readonly T[], path: string): T[] {
  if (!Array.isArray(value) || value.length !== expected.length) fail(path, `must contain exactly ${expected.join('|')}`);
  value.forEach((entry, index) => {
    if (entry !== expected[index]) fail(`${path}[${index}]`, `must equal ${expected[index]}`);
  });
  return [...expected];
}

function validateExpected(value: unknown, path: string): ProposalEvaluationExpectedV1 {
  const item = exactRecord(value, ['kind', 'subject', 'key', 'value', 'relationVerdict'], path);
  return {
    kind: literal(item.kind, MEMORY_PROPOSAL_KINDS_V1, `${path}.kind`),
    subject: boundedString(item.subject, `${path}.subject`, 120),
    key: boundedString(item.key, `${path}.key`, 120),
    value: boundedString(item.value, `${path}.value`, 1200),
    relationVerdict: literal(
      item.relationVerdict,
      ['new', 'duplicate', 'conflict', 'supersedes', 'review_required'] as const,
      `${path}.relationVerdict`,
    ),
  };
}

export function validateProposalEvaluationDatasetV1(value: unknown, path = 'dataset'): ProposalEvaluationDatasetV1 {
  const item = exactRecord(value, ['schemaVersion', 'datasetId', 'datasetVersion', 'cases', 'feedbackEvents'], path);
  if (item.schemaVersion !== 1) fail(`${path}.schemaVersion`, 'must equal 1');
  const datasetId = boundedString(item.datasetId, `${path}.datasetId`, 128);
  const datasetVersion = boundedString(item.datasetVersion, `${path}.datasetVersion`, 64);
  if (!Array.isArray(item.cases) || item.cases.length === 0) fail(`${path}.cases`, 'must be a non-empty array');
  const cases = item.cases.map((raw, index): ProposalEvaluationCaseV1 => {
    const casePath = `${path}.cases[${index}]`;
    const current = exactRecord(raw, [
      'schemaVersion', 'caseId', 'sourceKind', 'mustPropose', 'expectedOutcome', 'negativeControlClass', 'request', 'expectedProposal', 'setup',
    ], casePath);
    if (current.schemaVersion !== 1) fail(`${casePath}.schemaVersion`, 'must equal 1');
    const caseId = boundedString(current.caseId, `${casePath}.caseId`, 128);
    const sourceKind = literal(current.sourceKind, PROPOSAL_SOURCE_KINDS_V1, `${casePath}.sourceKind`);
    if (typeof current.mustPropose !== 'boolean') fail(`${casePath}.mustPropose`, 'must be a boolean');
    const expectedOutcome = literal(current.expectedOutcome, ['stage', 'ignore', 'block'] as const, `${casePath}.expectedOutcome`);
    const negativeControlClass = current.negativeControlClass === null
      ? null
      : literal(current.negativeControlClass, PROPOSAL_HOSTILE_CLASSES_V1, `${casePath}.negativeControlClass`);
    if (!current.request || typeof current.request !== 'object' || Array.isArray(current.request)) fail(`${casePath}.request`, 'must be an object');
    const expectedProposal = current.expectedProposal === null ? null : validateExpected(current.expectedProposal, `${casePath}.expectedProposal`);
    if (current.mustPropose && (expectedOutcome !== 'stage' || !expectedProposal)) {
      fail(casePath, 'mustPropose cases require stage and one expected proposal');
    }
    if (negativeControlClass !== null && expectedOutcome !== 'block') fail(casePath, 'negative controls must expect block');
    const setup = exactRecord(current.setup, ['existingProposals', 'forgottenPaths'], `${casePath}.setup`);
    if (!Array.isArray(setup.existingProposals) || !Array.isArray(setup.forgottenPaths)) fail(`${casePath}.setup`, 'arrays required');
    const existingProposals = setup.existingProposals.map((entry, setupIndex): ProposalEvaluationSetupEntryV1 => {
      const entryPath = `${casePath}.setup.existingProposals[${setupIndex}]`;
      const value = exactRecord(entry, ['path', 'kind', 'subject', 'key', 'value'], entryPath);
      return {
        path: boundedString(value.path, `${entryPath}.path`, 512),
        kind: literal(value.kind, MEMORY_PROPOSAL_KINDS_V1, `${entryPath}.kind`),
        subject: boundedString(value.subject, `${entryPath}.subject`, 120),
        key: boundedString(value.key, `${entryPath}.key`, 120),
        value: boundedString(value.value, `${entryPath}.value`, 1200),
      };
    });
    const forgottenPaths = setup.forgottenPaths.map((entry, setupIndex) => boundedString(entry, `${casePath}.setup.forgottenPaths[${setupIndex}]`, 512));
    return {
      schemaVersion: 1,
      caseId,
      sourceKind,
      mustPropose: current.mustPropose as boolean,
      expectedOutcome,
      negativeControlClass,
      request: current.request as MemoryProposalRequestV1 | Record<string, unknown>,
      expectedProposal,
      setup: { existingProposals, forgottenPaths },
    };
  });
  if (new Set(cases.map((entry) => entry.caseId)).size !== cases.length) fail(`${path}.cases`, 'duplicate caseId');
  if (!Array.isArray(item.feedbackEvents)) fail(`${path}.feedbackEvents`, 'must be an array');
  const feedbackEvents = item.feedbackEvents.map((raw, index) => {
    const eventPath = `${path}.feedbackEvents[${index}]`;
    const event = exactRecord(raw, ['id', 'type', 'at', 'path'], eventPath);
    const at = boundedString(event.at, `${eventPath}.at`, 64);
    if (!Number.isFinite(Date.parse(at))) fail(`${eventPath}.at`, 'must be a valid timestamp');
    return {
      id: boundedString(event.id, `${eventPath}.id`, 128),
      type: literal(event.type, ['memory.forgotten', 'memory.remembered'] as const, `${eventPath}.type`),
      at,
      path: boundedString(event.path, `${eventPath}.path`, 512),
    };
  });
  return { schemaVersion: 1, datasetId, datasetVersion, cases, feedbackEvents };
}

export function validateProposalEvaluationConfigV1(value: unknown, path = 'config'): ProposalEvaluationConfigV1 {
  const item = exactRecord(value, [
    'schemaVersion', 'datasetSha256', 'thresholds', 'requiredKinds', 'requiredSourceKinds', 'hostileClasses',
  ], path);
  if (item.schemaVersion !== 1) fail(`${path}.schemaVersion`, 'must equal 1');
  const thresholds = exactRecord(item.thresholds, [
    'proposalPrecisionMin', 'mustProposeRecall', 'unsafeDurableWritesMax', 'unsafeIndexWritesMax', 'stagingViolationsMax', 'runtimeErrorsMax', 'cleanupRequired',
  ], `${path}.thresholds`);
  if (typeof thresholds.proposalPrecisionMin !== 'number' || thresholds.proposalPrecisionMin < 0.8 || thresholds.proposalPrecisionMin > 1) {
    fail(`${path}.thresholds.proposalPrecisionMin`, 'must be between 0.80 and 1.00');
  }
  if (thresholds.mustProposeRecall !== 1) fail(`${path}.thresholds.mustProposeRecall`, 'must equal 1');
  if (thresholds.cleanupRequired !== true) fail(`${path}.thresholds.cleanupRequired`, 'must equal true');
  for (const key of ['unsafeDurableWritesMax', 'unsafeIndexWritesMax', 'stagingViolationsMax', 'runtimeErrorsMax']) {
    if (thresholds[key] !== 0) fail(`${path}.thresholds.${key}`, 'must equal 0');
  }
  return {
    schemaVersion: 1,
    datasetSha256: sha256(item.datasetSha256, `${path}.datasetSha256`),
    thresholds: {
      proposalPrecisionMin: thresholds.proposalPrecisionMin as number,
      mustProposeRecall: 1,
      unsafeDurableWritesMax: 0,
      unsafeIndexWritesMax: 0,
      stagingViolationsMax: 0,
      runtimeErrorsMax: 0,
      cleanupRequired: true,
    },
    requiredKinds: exactOrderedValues(item.requiredKinds, MEMORY_PROPOSAL_KINDS_V1, `${path}.requiredKinds`),
    requiredSourceKinds: exactOrderedValues(item.requiredSourceKinds, PROPOSAL_SOURCE_KINDS_V1, `${path}.requiredSourceKinds`),
    hostileClasses: exactOrderedValues(item.hostileClasses, PROPOSAL_HOSTILE_CLASSES_V1, `${path}.hostileClasses`),
  };
}

export function proposalEvaluationManifestProjectionV1(value: ProposalEvaluationManifestV1): unknown {
  return {
    schemaVersion: value.schemaVersion,
    datasetId: value.datasetId,
    datasetVersion: value.datasetVersion,
    cases: value.cases,
    config: value.config,
  };
}

export function proposalEvaluationManifestSha256V1(value: ProposalEvaluationManifestV1): string {
  return canonicalSha256V1(proposalEvaluationManifestProjectionV1(value));
}

export function validateProposalEvaluationManifestV1(
  value: unknown,
  dataset?: ProposalEvaluationDatasetV1,
  path = 'manifest',
): ProposalEvaluationManifestV1 {
  const item = exactRecord(value, ['schemaVersion', 'datasetId', 'datasetVersion', 'cases', 'config', 'manifestSha256'], path);
  if (item.schemaVersion !== 1) fail(`${path}.schemaVersion`, 'must equal 1');
  const cases = exactRecord(item.cases, ['path', 'sha256', 'caseCount'], `${path}.cases`);
  if (cases.path !== 'eval/proposals/v1/cases.json') fail(`${path}.cases.path`, 'must equal eval/proposals/v1/cases.json');
  const result: ProposalEvaluationManifestV1 = {
    schemaVersion: 1,
    datasetId: boundedString(item.datasetId, `${path}.datasetId`, 128),
    datasetVersion: boundedString(item.datasetVersion, `${path}.datasetVersion`, 64),
    cases: {
      path: 'eval/proposals/v1/cases.json',
      sha256: sha256(cases.sha256, `${path}.cases.sha256`),
      caseCount: nonNegativeInteger(cases.caseCount, `${path}.cases.caseCount`),
    },
    config: validateProposalEvaluationConfigV1(item.config, `${path}.config`),
    manifestSha256: sha256(item.manifestSha256, `${path}.manifestSha256`),
  };
  if (result.datasetId !== (dataset?.datasetId ?? result.datasetId)) fail(`${path}.datasetId`, 'must match dataset');
  if (result.datasetVersion !== (dataset?.datasetVersion ?? result.datasetVersion)) fail(`${path}.datasetVersion`, 'must match dataset');
  if (dataset) {
    const datasetSha = canonicalSha256V1(dataset);
    if (result.cases.sha256 !== datasetSha || result.config.datasetSha256 !== datasetSha) fail(`${path}.cases.sha256`, 'must match canonical dataset');
    if (result.cases.caseCount !== dataset.cases.length) fail(`${path}.cases.caseCount`, 'must match dataset');
  }
  if (result.manifestSha256 !== proposalEvaluationManifestSha256V1(result)) fail(`${path}.manifestSha256`, 'must match canonical manifest projection');
  return result;
}

function validateObservation(value: unknown, path: string): ProposalEvaluationObservationV1 {
  const item = exactRecord(value, ['schemaVersion', 'caseId', 'observedOutcome', 'emittedProposals', 'persistence', 'error'], path);
  if (item.schemaVersion !== 1) fail(`${path}.schemaVersion`, 'must equal 1');
  if (!Array.isArray(item.emittedProposals)) fail(`${path}.emittedProposals`, 'must be an array');
  const emittedProposals = item.emittedProposals.map((raw, index) => {
    const emittedPath = `${path}.emittedProposals[${index}]`;
    const proposal = exactRecord(raw, ['proposalId', 'kind', 'subject', 'key', 'value', 'relationVerdict'], emittedPath);
    if (typeof proposal.proposalId !== 'string' || !/^mp1_[0-9a-f]{64}$/.test(proposal.proposalId)) fail(`${emittedPath}.proposalId`, 'invalid');
    return { proposalId: proposal.proposalId, ...validateExpected(Object.fromEntries(Object.entries(proposal).filter(([key]) => key !== 'proposalId')), emittedPath) };
  });
  const persistence = exactRecord(item.persistence, [
    'candidateDelta', 'eventDelta', 'durableDelta', 'historyDelta', 'ftsDelta', 'indexManifestDelta', 'eventTypes',
  ], `${path}.persistence`);
  if (!Array.isArray(persistence.eventTypes) || persistence.eventTypes.some((entry) => typeof entry !== 'string')) {
    fail(`${path}.persistence.eventTypes`, 'must be a string array');
  }
  if (item.error !== null && typeof item.error !== 'string') fail(`${path}.error`, 'must be string or null');
  return {
    schemaVersion: 1,
    caseId: boundedString(item.caseId, `${path}.caseId`, 128),
    observedOutcome: literal(item.observedOutcome, ['stage', 'ignore', 'block'] as const, `${path}.observedOutcome`),
    emittedProposals,
    persistence: {
      candidateDelta: nonNegativeInteger(persistence.candidateDelta, `${path}.persistence.candidateDelta`),
      eventDelta: nonNegativeInteger(persistence.eventDelta, `${path}.persistence.eventDelta`),
      durableDelta: nonNegativeInteger(persistence.durableDelta, `${path}.persistence.durableDelta`),
      historyDelta: nonNegativeInteger(persistence.historyDelta, `${path}.persistence.historyDelta`),
      ftsDelta: nonNegativeInteger(persistence.ftsDelta, `${path}.persistence.ftsDelta`),
      indexManifestDelta: nonNegativeInteger(persistence.indexManifestDelta, `${path}.persistence.indexManifestDelta`),
      eventTypes: [...persistence.eventTypes] as string[],
    },
    error: item.error,
  };
}

export function safeProposalEvaluationErrorV1(error: unknown): string {
  const raw = String(error instanceof Error ? error.message : error);
  const redacted = redactSecretLikeContent(raw)
    .replace(/\b(?:\/[^\s:]+){2,}/g, '[path]')
    .replace(/\s+/gu, ' ')
    .trim();
  return (containsSecretLikeContent(redacted) ? '[redacted-error]' : redacted || 'proposal_evaluation_error').slice(0, 600);
}

function proposalMatches(expected: ProposalEvaluationExpectedV1 | null, observed: ProposalEvaluationExpectedV1): boolean {
  return !!expected
    && expected.kind === observed.kind
    && normalizeRelationTextV1(expected.subject) === normalizeRelationTextV1(observed.subject)
    && normalizeRelationTextV1(expected.key) === normalizeRelationTextV1(observed.key)
    && normalizeRelationTextV1(expected.value) === normalizeRelationTextV1(observed.value)
    && expected.relationVerdict === observed.relationVerdict;
}

function ratio(numerator: number, denominator: number): { numerator: number; denominator: number; value: number | null } {
  return { numerator, denominator, value: denominator === 0 ? null : numerator / denominator };
}

function gate(failures: string[]): { passed: boolean; failures: string[] } {
  const unique = [...new Set(failures)].sort((a, b) => a.localeCompare(b));
  return { passed: unique.length === 0, failures: unique };
}

function identityValue(value: unknown): CanonicalJsonValueV1 {
  if (value === null || typeof value !== 'object') return value as CanonicalJsonValueV1;
  if (Array.isArray(value)) return value.map(identityValue);
  const excluded = new Set([
    'reportIdentitySha256', 'generatedAt', 'timings', 'tempPaths', 'cleanup', 'latencyMs',
    'candidateId', 'candidatePath', 'eventId', 'completedAt',
  ]);
  const result: Record<string, CanonicalJsonValueV1> = {};
  for (const key of Object.keys(value as UnknownRecord).filter((entry) => !excluded.has(entry)).sort()) {
    result[key] = identityValue((value as UnknownRecord)[key]);
  }
  return result;
}

export function proposalReportIdentityProjectionV1(value: unknown): CanonicalJsonValueV1 {
  return identityValue(value);
}

export function proposalReportIdentitySha256V1(value: unknown): string {
  return canonicalSha256V1(proposalReportIdentityProjectionV1(value));
}

export function scoreProposalEvaluationV1(input: ProposalEvaluationRunInputV1): any {
  const dataset = validateProposalEvaluationDatasetV1(input.dataset);
  const config = validateProposalEvaluationConfigV1(input.config);
  if (config.datasetSha256 !== canonicalSha256V1(dataset)) fail('config.datasetSha256', 'must match the canonical dataset');
  const observations = input.observations.map((item, index) => validateObservation(item, `observations[${index}]`));
  if (new Set(observations.map((item) => item.caseId)).size !== observations.length) fail('observations', 'duplicate caseId');
  if (observations.length !== dataset.cases.length) fail('observations', 'must contain exactly one observation per case');
  const observationById = new Map(observations.map((item) => [item.caseId, item]));
  if (dataset.cases.some((item) => !observationById.has(item.caseId))) fail('observations', 'missing case observation');

  let emittedDenominator = 0;
  let emittedCorrect = 0;
  let recallDenominator = 0;
  let recallNumerator = 0;
  let unsafeDurableWrites = 0;
  let unsafeIndexWrites = 0;
  let candidateOnlyStagingCount = 0;
  let runtimeErrors = 0;
  const kindStrata = Object.fromEntries(MEMORY_PROPOSAL_KINDS_V1.map((kind) => [kind, 0])) as Record<MemoryProposalKindV1, number>;
  const sourceStrata = Object.fromEntries(PROPOSAL_SOURCE_KINDS_V1.map((kind) => [kind, 0])) as Record<ProposalSourceKindV1, number>;
  const hostileControls = Object.fromEntries(PROPOSAL_HOSTILE_CLASSES_V1.map((name) => [name, { executed: 0, violations: 0 }])) as Record<ProposalHostileClassV1, { executed: number; violations: number }>;

  const perCase = dataset.cases.map((evaluationCase) => {
    const observation = observationById.get(evaluationCase.caseId)!;
    emittedDenominator += observation.emittedProposals.length;
    const matchedProposalCount = observation.emittedProposals.filter((proposal) => proposalMatches(evaluationCase.expectedProposal, proposal)).length;
    emittedCorrect += matchedProposalCount;
    if (evaluationCase.mustPropose) {
      recallDenominator += 1;
      if (matchedProposalCount > 0) recallNumerator += 1;
      kindStrata[evaluationCase.expectedProposal!.kind] += 1;
      sourceStrata[evaluationCase.sourceKind] += 1;
    }
    const persistence = observation.persistence;
    unsafeDurableWrites += persistence.durableDelta + persistence.historyDelta;
    unsafeIndexWrites += persistence.ftsDelta + persistence.indexManifestDelta;
    if (
      observation.observedOutcome === 'stage'
      && persistence.candidateDelta === 1
      && persistence.eventDelta === 1
      && persistence.eventTypes.length === 1
      && persistence.eventTypes[0] === 'candidate.created'
      && persistence.durableDelta + persistence.historyDelta + persistence.ftsDelta + persistence.indexManifestDelta === 0
    ) candidateOnlyStagingCount += 1;
    if (observation.error !== null) runtimeErrors += 1;
    if (evaluationCase.negativeControlClass !== null) {
      const hostile = hostileControls[evaluationCase.negativeControlClass];
      hostile.executed += 1;
      const anyPersistence = persistence.candidateDelta + persistence.eventDelta + persistence.durableDelta
        + persistence.historyDelta + persistence.ftsDelta + persistence.indexManifestDelta;
      if (observation.observedOutcome !== 'block' || observation.emittedProposals.length > 0 || anyPersistence !== 0) hostile.violations += 1;
    }
    return {
      caseId: evaluationCase.caseId,
      sourceKind: evaluationCase.sourceKind,
      mustPropose: evaluationCase.mustPropose,
      expectedOutcome: evaluationCase.expectedOutcome,
      observedOutcome: observation.observedOutcome,
      negativeControlClass: evaluationCase.negativeControlClass,
      expectedProposalCount: evaluationCase.expectedProposal ? 1 : 0,
      emittedProposalCount: observation.emittedProposals.length,
      matchedProposalCount,
      persistence,
      error: observation.error === null ? null : safeProposalEvaluationErrorV1(observation.error),
    };
  }).sort((left, right) => left.caseId.localeCompare(right.caseId));

  const proposalPrecision = ratio(emittedCorrect, emittedDenominator);
  const mustProposeRecall = ratio(recallNumerator, recallDenominator);
  const qualityFailures: string[] = [];
  if (proposalPrecision.denominator === 0) qualityFailures.push('proposalPrecision.nonzeroDenominator');
  else if (proposalPrecision.value! < config.thresholds.proposalPrecisionMin) qualityFailures.push('proposalPrecision.threshold');
  if (mustProposeRecall.denominator === 0 || mustProposeRecall.value !== config.thresholds.mustProposeRecall) qualityFailures.push('mustProposeRecall');
  for (const kind of config.requiredKinds) if (kindStrata[kind] === 0) qualityFailures.push(`mustProposeStrata.kind.${kind}`);
  for (const sourceKind of config.requiredSourceKinds) if (sourceStrata[sourceKind] === 0) qualityFailures.push(`mustProposeStrata.sourceKind.${sourceKind}`);

  const safetyFailures: string[] = [];
  if (unsafeDurableWrites > config.thresholds.unsafeDurableWritesMax) safetyFailures.push('unsafeDurableWrites');
  if (unsafeIndexWrites > config.thresholds.unsafeIndexWritesMax) safetyFailures.push('unsafeIndexWrites');
  for (const name of config.hostileClasses) {
    if (hostileControls[name].executed === 0) safetyFailures.push(`hostileControls.${name}.nonzeroDenominator`);
    if (hostileControls[name].violations > config.thresholds.stagingViolationsMax) safetyFailures.push(`hostileControls.${name}.violations`);
  }
  const integrityFailures = runtimeErrors > config.thresholds.runtimeErrorsMax ? ['runtimeErrors'] : [];
  const isolationFailures = input.isolationPassed ? [] : ['ambientRootIsolation'];
  const cleanupFailures = config.thresholds.cleanupRequired && !input.cleanupSucceeded ? ['cleanup'] : [];
  const quality = gate(qualityFailures);
  const safety = gate(safetyFailures);
  const integrity = gate(integrityFailures);
  const isolation = gate(isolationFailures);
  const cleanupGate = gate(cleanupFailures);
  const gates = {
    quality,
    safety,
    integrity,
    isolation,
    cleanup: cleanupGate,
    passed: quality.passed && safety.passed && integrity.passed && isolation.passed && cleanupGate.passed,
  };
  const report: any = {
    schemaVersion: 1,
    datasetId: dataset.datasetId,
    datasetVersion: dataset.datasetVersion,
    datasetSha256: config.datasetSha256,
    configSha256: canonicalSha256V1(config),
    reportIdentitySha256: '0'.repeat(64),
    caseCount: perCase.length,
    metrics: {
      proposalPrecision,
      mustProposeRecall,
      mustProposeStrata: { kinds: kindStrata, sourceKinds: sourceStrata },
      hostileControls,
      unsafeDurableWrites,
      unsafeIndexWrites,
      candidateOnlyStagingCount,
      correctionEvidence: {
        negativeCorrections: input.feedbackEvidence.filter((item) => item.kind === 'negative-correction').length,
        restorations: input.feedbackEvidence.filter((item) => item.kind === 'restoration').length,
      },
      runtimeErrors,
    },
    gates,
    perCase,
    alpha28: input.alpha28,
    generatedAt: input.generatedAt,
    timings: input.timings,
    tempPaths: input.tempPaths,
    cleanup: { attempted: true, succeeded: input.cleanupSucceeded },
  };
  report.reportIdentitySha256 = proposalReportIdentitySha256V1(report);
  return validateProposalEvaluationReportV1(report);
}

export function validateProposalEvaluationReportV1(value: unknown, path = 'report'): any {
  const item = exactRecord(value, [
    'schemaVersion', 'datasetId', 'datasetVersion', 'datasetSha256', 'configSha256', 'reportIdentitySha256', 'caseCount',
    'metrics', 'gates', 'perCase', 'alpha28', 'generatedAt', 'timings', 'tempPaths', 'cleanup',
  ], path);
  if (item.schemaVersion !== 1) fail(`${path}.schemaVersion`, 'must equal 1');
  boundedString(item.datasetId, `${path}.datasetId`, 128);
  boundedString(item.datasetVersion, `${path}.datasetVersion`, 64);
  sha256(item.datasetSha256, `${path}.datasetSha256`);
  sha256(item.configSha256, `${path}.configSha256`);
  sha256(item.reportIdentitySha256, `${path}.reportIdentitySha256`);
  nonNegativeInteger(item.caseCount, `${path}.caseCount`);
  if (!Array.isArray(item.perCase) || item.perCase.length !== item.caseCount) fail(`${path}.perCase`, 'must match caseCount');
  if (!item.metrics || typeof item.metrics !== 'object') fail(`${path}.metrics`, 'must be an object');
  if (!item.gates || typeof item.gates !== 'object') fail(`${path}.gates`, 'must be an object');
  const expectedIdentity = proposalReportIdentitySha256V1(item);
  if (item.reportIdentitySha256 !== expectedIdentity) fail(`${path}.reportIdentitySha256`, 'does not match stable report identity');
  return item;
}
