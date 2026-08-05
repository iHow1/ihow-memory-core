// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { openCore } from '../src/core.ts';
import { canonicalJsonV1, canonicalSha256V1 } from '../src/evaluation.ts';
import {
  feedbackEvidenceFromEventsV1,
  normalizeRelationTextV1,
  proposalPersistenceCensusV1,
} from '../src/memory-proposals.ts';
import {
  proposalEvaluationManifestSha256V1,
  safeProposalEvaluationErrorV1,
  scoreProposalEvaluationV1,
  validateProposalEvaluationDatasetV1,
  validateProposalEvaluationManifestV1,
} from '../src/proposal-evaluation.ts';
import { absoluteFromMemoryPath } from '../src/workspace.ts';
import { appendEvent } from '../src/store/events.ts';

const DANGEROUS_ENVIRONMENT_KEYS = [
  'HOME', 'MEMORY_ROOT', 'IHOW_MEMORY_ROOT', 'IHOW_MEMORY_HOME', 'IHOW_MEMORY_STATE_ROOT',
  'IHOW_MEMORY_ENGINE', 'IHOW_MEMORY_PROVIDER', 'IHOW_MEMORY_VECTOR_PROVIDER_COMMAND',
  'IHOW_MEMORY_VECTOR_MODEL', 'IHOW_MEMORY_VECTOR_CACHE', 'IHOW_MEMORY_VECTOR_CACHE_DIR',
  'HERMES_HOME', 'CODEX_HOME', 'XDG_CACHE_HOME', 'HF_HOME',
];

function isContained(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function surfaceChangeCount(before, after) {
  const left = new Map(before.files.map((item) => [item.path, item.sha256]));
  const right = new Map(after.files.map((item) => [item.path, item.sha256]));
  const keys = new Set([...left.keys(), ...right.keys()]);
  return [...keys].filter((key) => left.get(key) !== right.get(key)).length;
}

function fixtureProposalId(entry) {
  return `mp1_${canonicalSha256V1({
    path: entry.path,
    kind: entry.kind,
    subject: normalizeRelationTextV1(entry.subject),
    key: normalizeRelationTextV1(entry.key),
    value: normalizeRelationTextV1(entry.value),
  })}`;
}

async function seedCaseSetup(core, setup) {
  for (const entry of setup.existingProposals) {
    const absolute = absoluteFromMemoryPath(core.workspace, entry.path);
    if (!isContained(core.workspace.memoryDir, absolute)) throw new Error('setup_path_outside_memory');
    const proposalId = fixtureProposalId(entry);
    const content = [
      '---',
      'type: "memory"',
      'status: "promoted"',
      'proposal_schema_version: 1',
      `proposal_id: ${JSON.stringify(proposalId)}`,
      `proposal_kind: ${JSON.stringify(entry.kind)}`,
      `proposal_subject: ${JSON.stringify(entry.subject)}`,
      `proposal_key: ${JSON.stringify(entry.key)}`,
      `proposal_value: ${JSON.stringify(entry.value)}`,
      `proposal_subject_normalized: ${JSON.stringify(normalizeRelationTextV1(entry.subject))}`,
      `proposal_key_normalized: ${JSON.stringify(normalizeRelationTextV1(entry.key))}`,
      `proposal_value_normalized: ${JSON.stringify(normalizeRelationTextV1(entry.value))}`,
      'proposal_review_mode: "review-first"',
      'proposal_review_state: "pending"',
      'proposal_safety_outcome: "candidate-only"',
      '---',
      '',
      `# Fixture ${entry.kind}`,
      '',
      `[memory:${entry.kind}] subject=${entry.subject} | key=${entry.key} | value=${entry.value}`,
      '',
    ].join('\n');
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, 'utf8');
  }
  for (const forgottenPath of setup.forgottenPaths) {
    await appendEvent(core.workspace, {
      type: 'memory.forgotten',
      path: forgottenPath,
      actor: 'proposal-evaluation-fixture',
    });
  }
}

async function alpha28Readback(repoRoot) {
  const manifestPath = path.join(repoRoot, 'eval', 'golden', 'v1', 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (typeof manifest.datasetSha256 !== 'string' || !manifest.splits) throw new Error('alpha28_manifest_invalid');
  const splits = {};
  for (const name of ['train', 'dev', 'holdout']) {
    const entry = manifest.splits[name];
    if (!entry || typeof entry.path !== 'string' || typeof entry.sha256 !== 'string') throw new Error(`alpha28_manifest_${name}_invalid`);
    const bytes = await fs.readFile(path.join(repoRoot, entry.path));
    const actual = crypto.createHash('sha256').update(bytes).digest('hex');
    if (actual !== entry.sha256) throw new Error(`alpha28_${name}_sha_mismatch`);
    splits[name] = actual;
  }
  return { datasetSha256: manifest.datasetSha256, splits };
}

function observedOutcome(results) {
  if (results.some((item) => item.status === 'staged')) return 'stage';
  if (results.some((item) => item.status === 'blocked')) return 'block';
  return 'ignore';
}

function emittedProposals(results) {
  return results.filter((item) => item.status === 'staged').map((item) => ({
    proposalId: item.proposal.proposalId,
    kind: item.proposal.kind,
    subject: item.proposal.subject,
    key: item.proposal.key,
    value: item.proposal.value,
    relationVerdict: item.proposal.relation.verdict,
  }));
}

function saveAndScrubEnvironment() {
  const saved = new Map();
  for (const key of DANGEROUS_ENVIRONMENT_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

export async function runProposalEvaluation({ repoRoot = process.cwd() } = {}) {
  const absoluteRepo = path.resolve(repoRoot);
  const casesPath = path.join(absoluteRepo, 'eval', 'proposals', 'v1', 'cases.json');
  const manifestPath = path.join(absoluteRepo, 'eval', 'proposals', 'v1', 'manifest.json');
  const dataset = validateProposalEvaluationDatasetV1(JSON.parse(await fs.readFile(casesPath, 'utf8')));
  const manifest = validateProposalEvaluationManifestV1(JSON.parse(await fs.readFile(manifestPath, 'utf8')), dataset);
  const manifestSha256 = proposalEvaluationManifestSha256V1(manifest);
  const alpha28 = await alpha28Readback(absoluteRepo);
  const started = performance.now();
  const tempParent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-alpha29-proposals-')));
  const restoreEnvironment = saveAndScrubEnvironment();
  const observations = [];
  let isolationPassed = true;
  let cleanupSucceeded = false;
  let operationError = null;
  try {
    for (const evaluationCase of dataset.cases) {
      const caseCwd = path.join(tempParent, 'cwd', evaluationCase.caseId);
      await fs.mkdir(caseCwd, { recursive: true });
      const core = await openCore({
        root: tempParent,
        space: `proposal-${evaluationCase.caseId}`,
        cwd: caseCwd,
        engine: 'fts',
      });
      for (const candidate of [
        core.workspace.root,
        core.workspace.spaceDir,
        core.workspace.memoryDir,
        core.workspace.indexPath,
        core.workspace.indexManifestPath,
      ]) {
        if (!isContained(tempParent, candidate)) isolationPassed = false;
      }
      await seedCaseSetup(core, evaluationCase.setup);
      await core.rebuild();
      const before = await proposalPersistenceCensusV1(core.workspace);
      let results = [];
      let error = null;
      try {
        results = await core.propose_memory(evaluationCase.request);
        const relationError = results.find((item) => item.status === 'staged' && item.relationError)?.relationError;
        if (relationError) error = relationError;
      } catch (caught) {
        error = safeProposalEvaluationErrorV1(caught);
      }
      const after = await proposalPersistenceCensusV1(core.workspace);
      observations.push({
        schemaVersion: 1,
        caseId: evaluationCase.caseId,
        observedOutcome: observedOutcome(results),
        emittedProposals: emittedProposals(results),
        persistence: {
          candidateDelta: surfaceChangeCount(before.candidates, after.candidates),
          eventDelta: after.events.eventCount - before.events.eventCount,
          durableDelta: surfaceChangeCount(before.durable, after.durable),
          historyDelta: surfaceChangeCount(before.history, after.history),
          ftsDelta: surfaceChangeCount(before.fts, after.fts),
          indexManifestDelta: surfaceChangeCount(before.indexManifest, after.indexManifest),
          eventTypes: after.events.eventTypes.slice(before.events.eventTypes.length),
        },
        error,
      });
    }
  } catch (caught) {
    operationError = caught;
  } finally {
    restoreEnvironment();
    try {
      await fs.rm(tempParent, { recursive: true, force: true });
      await fs.access(tempParent).then(() => { cleanupSucceeded = false; }, () => { cleanupSucceeded = true; });
    } catch {
      cleanupSucceeded = false;
    }
  }
  if (operationError) throw operationError;
  const feedbackEvidence = feedbackEvidenceFromEventsV1(dataset.feedbackEvents);
  const report = scoreProposalEvaluationV1({
    dataset,
    observations,
    config: manifest.config,
    feedbackEvidence,
    alpha28,
    isolationPassed,
    cleanupSucceeded,
    generatedAt: new Date().toISOString(),
    timings: { totalOperationMs: Math.max(0, performance.now() - started) },
    tempPaths: [tempParent],
  });
  return {
    report,
    manifestSha256,
    datasetSha256: report.datasetSha256,
    configSha256: report.configSha256,
  };
}

async function main() {
  try {
    const result = await runProposalEvaluation({ repoRoot: process.cwd() });
    process.stdout.write(canonicalJsonV1(result.report));
    return result.report.gates.passed ? 0 : 1;
  } catch (error) {
    process.stdout.write(canonicalJsonV1({
      schemaVersion: 1,
      gates: { passed: false },
      error: safeProposalEvaluationErrorV1(error),
    }));
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
