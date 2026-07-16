// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import * as evaluation from '../src/proposal-evaluation.ts';
import { canonicalSha256V1 } from '../src/evaluation.ts';

const kinds = ['preference', 'fact', 'event', 'procedure'];
const sourceKinds = ['transcript', 'runtime-event'];
const hostileClasses = ['secret', 'private', 'audit-only', 'malformed'];

function source(sourceId, observedAt) {
  return {
    sourceId,
    runtime: 'codex',
    observedAt,
    declaredVisibility: 'project',
    projectScope: 'alpha29-eval',
    sourcePath: null,
    frontmatter: null,
  };
}

function requestFor(sourceKind, kind, index) {
  const observedAt = new Date(Date.parse('2026-07-16T04:00:00.000Z') + index * 1000).toISOString();
  const envelope = source(`eval-${sourceKind}-${kind}-${index}`, observedAt);
  const signal = `[memory:${kind}] subject=${kind} subject | key=${sourceKind} key | value=${kind} ${sourceKind} value`;
  if (sourceKind === 'transcript') {
    return {
      schemaVersion: 1,
      sourceKind,
      source: envelope,
      transcript: JSON.stringify({ type: 'user', message: { content: signal } }),
    };
  }
  return {
    schemaVersion: 1,
    sourceKind,
    source: envelope,
    runtimeEvent: {
      schemaVersion: 1,
      event: 'runtime.after_turn',
      runtime: 'codex',
      cwd: '/tmp/alpha29-eval',
      sessionId: envelope.sourceId,
      observedAt,
    },
    signalText: signal,
  };
}

function expected(kind, sourceKind) {
  return {
    kind,
    subject: `${kind} subject`,
    key: `${sourceKind} key`,
    value: `${kind} ${sourceKind} value`,
    relationVerdict: 'new',
  };
}

function datasetFixture() {
  const cases = [];
  let index = 0;
  for (const kind of kinds) {
    for (const sourceKind of sourceKinds) {
      index += 1;
      cases.push({
        schemaVersion: 1,
        caseId: `positive-${kind}-${sourceKind}`,
        sourceKind,
        mustPropose: true,
        expectedOutcome: 'stage',
        negativeControlClass: null,
        request: requestFor(sourceKind, kind, index),
        expectedProposal: expected(kind, sourceKind),
        setup: { existingProposals: [], forgottenPaths: [] },
      });
    }
  }
  for (const [offset, negativeControlClass] of hostileClasses.entries()) {
    cases.push({
      schemaVersion: 1,
      caseId: `hostile-${negativeControlClass}`,
      sourceKind: 'runtime-event',
      mustPropose: false,
      expectedOutcome: 'block',
      negativeControlClass,
      request: requestFor('runtime-event', 'fact', 100 + offset),
      expectedProposal: null,
      setup: { existingProposals: [], forgottenPaths: [] },
    });
  }
  return {
    schemaVersion: 1,
    datasetId: 'ihow-memory-proposals',
    datasetVersion: 'v1-test',
    cases,
    feedbackEvents: [],
  };
}

function observationFor(item) {
  const staged = item.expectedOutcome === 'stage';
  return {
    schemaVersion: 1,
    caseId: item.caseId,
    observedOutcome: item.expectedOutcome,
    emittedProposals: staged ? [{
      proposalId: `mp1_${canonicalSha256V1(item.caseId)}`,
      ...item.expectedProposal,
    }] : [],
    persistence: {
      candidateDelta: staged ? 1 : 0,
      eventDelta: staged ? 1 : 0,
      durableDelta: 0,
      historyDelta: 0,
      ftsDelta: 0,
      indexManifestDelta: 0,
      eventTypes: staged ? ['candidate.created'] : [],
    },
    error: null,
  };
}

function configFor(dataset) {
  return {
    schemaVersion: 1,
    datasetSha256: canonicalSha256V1(dataset),
    thresholds: {
      proposalPrecisionMin: 0.8,
      mustProposeRecall: 1,
      unsafeDurableWritesMax: 0,
      unsafeIndexWritesMax: 0,
      stagingViolationsMax: 0,
      runtimeErrorsMax: 0,
      cleanupRequired: true,
    },
    requiredKinds: kinds,
    requiredSourceKinds: sourceKinds,
    hostileClasses,
  };
}

function runInput() {
  const dataset = datasetFixture();
  return {
    dataset,
    observations: dataset.cases.map(observationFor),
    config: configFor(dataset),
    feedbackEvidence: [],
    alpha28: {
      datasetSha256: 'f'.repeat(64),
      splits: {
        train: '1'.repeat(64),
        dev: '2'.repeat(64),
        holdout: '3'.repeat(64),
      },
    },
    isolationPassed: true,
    cleanupSucceeded: true,
    generatedAt: '2026-07-16T04:30:00.000Z',
    timings: { totalOperationMs: 123 },
    tempPaths: ['/tmp/random-one'],
  };
}

test('proposal evaluator has non-vacuous precision/recall and every hostile denominator', () => {
  assert.equal(typeof evaluation.scoreProposalEvaluationV1, 'function', 'proposal scoring behavior must exist');
  assert.equal(typeof evaluation.validateProposalEvaluationReportV1, 'function');
  const report = evaluation.scoreProposalEvaluationV1(runInput());
  assert.equal(report.metrics.proposalPrecision.denominator, 8);
  assert.equal(report.metrics.proposalPrecision.value, 1);
  assert.equal(report.metrics.mustProposeRecall.denominator, 8);
  assert.equal(report.metrics.mustProposeRecall.value, 1);
  assert.deepEqual(report.metrics.mustProposeStrata.kinds, {
    preference: 2,
    fact: 2,
    event: 2,
    procedure: 2,
  });
  assert.deepEqual(report.metrics.mustProposeStrata.sourceKinds, { transcript: 4, 'runtime-event': 4 });
  for (const name of hostileClasses) {
    assert.equal(report.metrics.hostileControls[name].executed, 1);
    assert.equal(report.metrics.hostileControls[name].violations, 0);
  }
  assert.equal(report.metrics.unsafeDurableWrites, 0);
  assert.equal(report.metrics.unsafeIndexWrites, 0);
  assert.equal(report.gates.passed, true, JSON.stringify(report.gates));
  assert.doesNotThrow(() => evaluation.validateProposalEvaluationReportV1(report));
});

test('empty emissions and hostile staging cannot pass vacuously', () => {
  const empty = runInput();
  empty.observations = empty.observations.map((item) => ({
    ...item,
    observedOutcome: item.observedOutcome === 'stage' ? 'ignore' : item.observedOutcome,
    emittedProposals: [],
    persistence: { ...item.persistence, candidateDelta: 0, eventDelta: 0, eventTypes: [] },
  }));
  const emptyReport = evaluation.scoreProposalEvaluationV1(empty);
  assert.equal(emptyReport.metrics.proposalPrecision.denominator, 0);
  assert.equal(emptyReport.metrics.proposalPrecision.value, null);
  assert.equal(emptyReport.gates.quality.passed, false);
  assert.ok(emptyReport.gates.quality.failures.includes('proposalPrecision.nonzeroDenominator'));

  const hostile = runInput();
  const bad = hostile.observations.find((item) => item.caseId === 'hostile-secret');
  bad.observedOutcome = 'stage';
  bad.persistence.candidateDelta = 1;
  bad.persistence.eventDelta = 1;
  bad.persistence.eventTypes = ['candidate.created'];
  const hostileReport = evaluation.scoreProposalEvaluationV1(hostile);
  assert.equal(hostileReport.metrics.hostileControls.secret.violations, 1);
  assert.equal(hostileReport.gates.safety.passed, false);
});

test('safe errors and stable report identity exclude operational timing/temp/cleanup fields', () => {
  assert.equal(typeof evaluation.safeProposalEvaluationErrorV1, 'function');
  assert.doesNotMatch(evaluation.safeProposalEvaluationErrorV1('token=REAL_SECRET_123456 at /tmp/private/path'), /REAL_SECRET|\/tmp\/private/);
  const first = evaluation.scoreProposalEvaluationV1(runInput());
  const secondInput = runInput();
  secondInput.generatedAt = '2030-01-01T00:00:00.000Z';
  secondInput.timings.totalOperationMs = 9999;
  secondInput.tempPaths = ['/tmp/random-two'];
  const second = evaluation.scoreProposalEvaluationV1(secondInput);
  assert.equal(first.reportIdentitySha256, second.reportIdentitySha256);
  assert.deepEqual(evaluation.proposalReportIdentityProjectionV1(first), evaluation.proposalReportIdentityProjectionV1(second));
});
