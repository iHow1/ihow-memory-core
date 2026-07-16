// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { openCore } from '../src/core.ts';
import { selectPromptRecall, renderPromptRecall } from '../src/prompt-recall.ts';
import { absoluteFromMemoryPath, resolveWorkspace } from '../src/workspace.ts';
import {
  canonicalJsonV1,
  countUnicodeWhitespaceTokensV1,
  scoreEvaluationRunV1,
  validateDatasetManifestV1,
  validateEvaluationDatasetSplitV1,
  validateEvaluationReportV1,
  validateManifestAgainstDatasetsV1,
} from '../src/evaluation.ts';

const SPLIT_NAMES = ['train', 'dev', 'holdout'];
const MODE_SPLITS = Object.freeze({
  smoke: ['train'],
  batch: ['train', 'dev'],
  full: ['train', 'dev', 'holdout'],
});
const DATASET_RELATIVE_DIR = path.join('eval', 'golden', 'v1');
const SEARCH_LIMIT = 10;
const SPACE_PREFIX = 'alpha28-eval';

export const QUALITY_THRESHOLDS_V1 = Object.freeze({
  precisionAt3: 0.2,
  recallAt3: 0.6,
  recallAt5: 0.7,
  recallAt10: 0.8,
  mrr: 0.5,
  ndcgAt10: 0.6,
  noAnswerAccuracy: 0.8,
  injectedPathPrecision: 0.8,
});

const PROMPT_RECALL_OPTIONS = Object.freeze({
  semanticFloor: null,
  searchLimit: SEARCH_LIMIT,
  includeLimit: 3,
  maxChars: 1200,
  snippetCap: 280,
  includeAuto: false,
  autoDefaultOn: false,
  nowMs: 0,
});

const DANGEROUS_ENVIRONMENT_KEYS = [
  'HOME',
  'MEMORY_ROOT',
  'IHOW_MEMORY_ROOT',
  'IHOW_MEMORY_HOME',
  'IHOW_MEMORY_STATE_ROOT',
  'IHOW_MEMORY_ENGINE',
  'IHOW_MEMORY_PROVIDER',
  'IHOW_MEMORY_VECTOR_PROVIDER_COMMAND',
  'IHOW_MEMORY_VECTOR_MODEL',
  'IHOW_MEMORY_VECTOR_TIMEOUT_MS',
  'IHOW_MEMORY_VECTOR_INDEX_TIMEOUT_MS',
  'IHOW_MEMORY_VECTOR_COMMAND',
  'IHOW_MEMORY_VECTOR_CACHE',
  'IHOW_MEMORY_VECTOR_CACHE_DIR',
  'IHOW_MEMORY_EMBEDDING_CACHE',
  'IHOW_MEMORY_EMBEDDING_CACHE_DIR',
  'IHOW_VECTOR_PROVIDER_COMMAND',
  'IHOW_VECTOR_MODEL',
  'IHOW_VECTOR_CACHE',
  'IHOW_VECTOR_CACHE_DIR',
  'VECTOR_PROVIDER_COMMAND',
  'VECTOR_MODEL',
  'VECTOR_CACHE',
  'VECTOR_CACHE_DIR',
  'EMBEDDING_CACHE',
  'EMBEDDING_CACHE_DIR',
  'XDG_CACHE_HOME',
  'HF_HOME',
  'HUGGINGFACE_HUB_CACHE',
  'TRANSFORMERS_CACHE',
  'SENTENCE_TRANSFORMERS_HOME',
  'OLLAMA_MODELS',
  'HERMES_HOME',
  'CODEX_HOME',
];

export class EvaluationBenchError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EvaluationBenchError';
    this.code = code;
  }
}

function safeErrorMessage(error) {
  return String(error instanceof Error ? error.message : error)
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/\b(token|password|secret|api[_-]?key)=\S+/gi, '$1=[redacted]')
    .slice(0, 600);
}

function benchError(code, message) {
  return new EvaluationBenchError(code, message);
}

function validateMode(mode) {
  if (typeof mode !== 'string' || !Object.hasOwn(MODE_SPLITS, mode)) {
    throw benchError('invalid_mode', 'mode must be exactly one of smoke|batch|full');
  }
  return mode;
}

function isEqualOrBelow(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function plannedRealpath(target) {
  const absolute = path.resolve(target);
  let cursor = absolute;
  const missing = [];
  while (true) {
    try {
      const existing = await fs.realpath(cursor);
      return path.resolve(existing, ...missing.reverse());
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      missing.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

export async function resolveContainedPathV1(parent, candidate, label = 'path') {
  const realParent = await fs.realpath(parent);
  const resolved = await plannedRealpath(candidate);
  if (!isEqualOrBelow(realParent, resolved)) {
    throw benchError('isolation_failure', `${label} escapes the isolated evaluation parent`);
  }
  return resolved;
}

function environmentKeysToScrub() {
  const dynamic = Object.keys(process.env).filter((key) => (
    /^(?:IHOW_)?(?:MEMORY_)?(?:VECTOR|EMBEDDING)_/i.test(key)
    || /^(?:IHOW_)?MEMORY_(?:ENGINE|PROVIDER)$/i.test(key)
    || /(?:VECTOR|EMBEDDING).*(?:COMMAND|MODEL|CACHE)/i.test(key)
  ));
  return [...new Set([...DANGEROUS_ENVIRONMENT_KEYS, ...dynamic])];
}

function sanitizeEnvironment(home) {
  const keys = environmentKeysToScrub();
  const snapshot = new Map(keys.map((key) => [
    key,
    Object.hasOwn(process.env, key) ? process.env[key] : undefined,
  ]));
  for (const key of keys) delete process.env[key];
  process.env.HOME = home;
  return () => {
    for (const [key, value] of snapshot) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function assertGlobalDatasetIdentity(datasets) {
  const caseIds = new Set();
  const documentIds = new Set();
  for (const dataset of datasets) {
    for (const item of dataset.cases) {
      if (caseIds.has(item.caseId)) throw benchError('integrity_failure', `duplicate caseId across splits: ${item.caseId}`);
      caseIds.add(item.caseId);
    }
    for (const document of dataset.documents) {
      if (documentIds.has(document.documentId)) {
        throw benchError('integrity_failure', `duplicate documentId across splits: ${document.documentId}`);
      }
      documentIds.add(document.documentId);
    }
  }
}

async function readCanonicalJson(filePath, label) {
  const raw = await fs.readFile(filePath, 'utf8');
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw benchError('integrity_failure', `${label} is not valid JSON`);
  }
  if (raw !== canonicalJsonV1(value)) {
    throw benchError('integrity_failure', `${label} bytes are not canonical JSON v1`);
  }
  return value;
}

async function loadEvaluationBundle(datasetDir) {
  try {
    const [trainValue, devValue, holdoutValue, manifestValue] = await Promise.all([
      readCanonicalJson(path.join(datasetDir, 'train.json'), 'train.json'),
      readCanonicalJson(path.join(datasetDir, 'dev.json'), 'dev.json'),
      readCanonicalJson(path.join(datasetDir, 'holdout.json'), 'holdout.json'),
      readCanonicalJson(path.join(datasetDir, 'manifest.json'), 'manifest.json'),
    ]);
    const datasets = [
      validateEvaluationDatasetSplitV1(trainValue, 'train'),
      validateEvaluationDatasetSplitV1(devValue, 'dev'),
      validateEvaluationDatasetSplitV1(holdoutValue, 'holdout'),
    ];
    const manifest = validateDatasetManifestV1(manifestValue);
    validateManifestAgainstDatasetsV1(manifest, datasets);
    for (const name of SPLIT_NAMES) {
      const expected = `eval/golden/v1/${name}.json`;
      if (manifest.splits[name].path !== expected) {
        throw benchError('integrity_failure', `manifest split ${name} must load from ${expected}`);
      }
    }
    assertGlobalDatasetIdentity(datasets);
    return { datasets, manifest };
  } catch (error) {
    if (error instanceof EvaluationBenchError) throw error;
    throw benchError('integrity_failure', safeErrorMessage(error));
  }
}

function selectDatasetsForMode(mode, datasets, manifest) {
  const bySplit = new Map(datasets.map((dataset) => [dataset.split, dataset]));
  if (mode === 'smoke') {
    const train = bySplit.get('train');
    const casesById = new Map(train.cases.map((item) => [item.caseId, item]));
    return [{
      ...train,
      cases: manifest.smokeCaseIds.map((caseId) => casesById.get(caseId)),
    }];
  }
  return MODE_SPLITS[mode].map((split) => bySplit.get(split));
}

function workspaceStructuralPaths(workspace) {
  return [
    workspace.root,
    workspace.spaceDir,
    workspace.memoryDir,
    workspace.mcpDir,
    workspace.candidatesDir,
    workspace.promotedDir,
    workspace.eventsDir,
    workspace.historyDir,
    workspace.journalDir,
    workspace.indexPath,
    workspace.indexManifestPath,
    workspace.lockPath,
  ];
}

async function assertProviderIsExplicitFts(core) {
  const status = await core.status();
  if (status.index.providerId !== 'fts' || status.provider.id !== 'fts') {
    throw benchError('engine_failure', 'evaluation engine must be explicit FTS');
  }
  if (status.provider.cloud !== false || status.provider.model !== null) {
    throw benchError('engine_failure', 'evaluation FTS provider must be local with model=null');
  }
  if (status.provider.fallback === true || status.provider.fallbackFrom !== undefined) {
    throw benchError('engine_failure', 'evaluation FTS provider must not have an active fallback');
  }
  if (status.capabilities.semantic !== false
    || status.recallReadiness.semanticAvailable !== false
    || status.recallReadiness.semanticReady !== false) {
    throw benchError('engine_failure', 'evaluation FTS provider must report semantic=false');
  }
  return {
    id: status.provider.id,
    cloud: status.provider.cloud,
    model: status.provider.model,
    fallback: false,
    semantic: status.capabilities.semantic,
  };
}

function sameProviderEvidence(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function attachFailureEvidence(error, { cleanup, tempPaths, seededDocuments }) {
  const failure = error instanceof EvaluationBenchError
    ? error
    : benchError('operation_failure', safeErrorMessage(error));
  failure.cleanup = cleanup;
  failure.tempPaths = [...tempPaths];
  failure.evidence = { seededDocuments };
  return failure;
}

export async function runEvaluationBench(options = {}) {
  const mode = validateMode(options.mode);
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const datasetDir = path.resolve(options.datasetDir || path.join(repoRoot, DATASET_RELATIVE_DIR));
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-eval-')));
  const cleanup = { attempted: false, succeeded: false };
  const tempPaths = [parent];
  const seededDocumentIds = [];
  const executionCaseIds = [];
  const originalCwd = process.cwd();
  let restoreEnvironment = () => {};
  let cwdChanged = false;
  let primaryError;
  let report;
  let providerEvidence;

  try {
    const { datasets: allDatasets, manifest } = await loadEvaluationBundle(datasetDir);
    const selectedDatasets = selectDatasetsForMode(mode, allDatasets, manifest);
    const requested = {
      root: options.pathOverrides?.root || path.join(parent, 'root'),
      stateRoot: options.pathOverrides?.stateRoot || path.join(parent, 'state'),
      home: options.pathOverrides?.home || path.join(parent, 'home'),
      cwd: options.pathOverrides?.cwd || path.join(parent, 'cwd'),
    };
    const plannedWorkspaces = new Map(selectedDatasets.map((dataset) => {
      const space = `${SPACE_PREFIX}-${dataset.split}`;
      return [dataset.split, resolveWorkspace({
        root: requested.root,
        stateRoot: requested.stateRoot,
        cwd: requested.cwd,
        space,
        engine: 'fts',
      })];
    }));

    const structural = [requested.root, requested.stateRoot, requested.home, requested.cwd];
    for (const workspace of plannedWorkspaces.values()) structural.push(...workspaceStructuralPaths(workspace));
    for (const [index, candidate] of [...new Set(structural)].entries()) {
      const resolved = await resolveContainedPathV1(parent, candidate, `planned path ${index}`);
      if (!tempPaths.includes(resolved)) tempPaths.push(resolved);
    }

    restoreEnvironment = sanitizeEnvironment(requested.home);
    await Promise.all([
      fs.mkdir(requested.root, { recursive: true }),
      fs.mkdir(requested.stateRoot, { recursive: true }),
      fs.mkdir(requested.home, { recursive: true }),
      fs.mkdir(requested.cwd, { recursive: true }),
    ]);
    const [root, stateRoot, home, cwd] = await Promise.all([
      resolveContainedPathV1(parent, requested.root, 'root'),
      resolveContainedPathV1(parent, requested.stateRoot, 'stateRoot'),
      resolveContainedPathV1(parent, requested.home, 'HOME'),
      resolveContainedPathV1(parent, requested.cwd, 'cwd'),
    ]);
    process.env.HOME = home;
    process.chdir(cwd);
    cwdChanged = true;

    const cores = new Map();
    for (const dataset of selectedDatasets) {
      const space = `${SPACE_PREFIX}-${dataset.split}`;
      const core = await openCore({ root, stateRoot, cwd, space, engine: 'fts' });
      cores.set(dataset.split, core);
      for (const candidate of workspaceStructuralPaths(core.workspace)) {
        const resolved = await resolveContainedPathV1(parent, candidate, `${dataset.split} workspace path`);
        if (!tempPaths.includes(resolved)) tempPaths.push(resolved);
      }
      const initialProvider = await assertProviderIsExplicitFts(core);
      if (providerEvidence && !sameProviderEvidence(providerEvidence, initialProvider)) {
        throw benchError('engine_failure', 'provider identity changed between dataset splits');
      }
      providerEvidence = initialProvider;

      for (const document of dataset.documents) {
        const targetAbsolute = absoluteFromMemoryPath(core.workspace, document.documentId);
        await resolveContainedPathV1(parent, targetAbsolute, `document ${document.documentId}`);
        const title = path.basename(document.documentId, '.md');
        const candidate = await core.write_candidate({
          text: document.text,
          title,
          sourceAgent: 'alpha28-eval',
          autoPromote: false,
        });
        if (candidate.status !== 'candidate') {
          throw benchError('operation_failure', `document ${document.documentId} did not remain staged before promote`);
        }
        await resolveContainedPathV1(
          parent,
          absoluteFromMemoryPath(core.workspace, candidate.path),
          `candidate ${document.documentId}`,
        );
        const promoted = await core.promote(candidate.path, { path: document.documentId, title });
        if (promoted.path !== document.documentId) {
          throw benchError('integrity_failure', `promoted path ${promoted.path} does not equal ${document.documentId}`);
        }
        await resolveContainedPathV1(
          parent,
          absoluteFromMemoryPath(core.workspace, promoted.path),
          `promoted ${document.documentId}`,
        );
        seededDocumentIds.push(document.documentId);
      }

      const finalProvider = await assertProviderIsExplicitFts(core);
      if (!sameProviderEvidence(providerEvidence, finalProvider)) {
        throw benchError('engine_failure', 'provider identity changed while seeding a dataset split');
      }
    }

    const observations = [];
    for (const dataset of selectedDatasets) {
      const core = cores.get(dataset.split);
      for (const evaluationCase of dataset.cases) {
        executionCaseIds.push(evaluationCase.caseId);
        const started = performance.now();
        let rankedIds = [];
        let injectedIds = [];
        let rendered;
        let operationError = null;
        try {
          const hits = await core.search(evaluationCase.query, { limit: SEARCH_LIMIT });
          rankedIds = hits.map((hit) => hit.path);
          const selection = await selectPromptRecall(
            core.workspace,
            evaluationCase.query,
            hits,
            PROMPT_RECALL_OPTIONS,
          );
          rendered = renderPromptRecall(selection);
          injectedIds = selection.included.map((item) => item.path);
          if ((rendered === undefined) !== (selection.included.length === 0)) {
            throw new Error('selector/render no-answer invariant failed');
          }
        } catch (error) {
          operationError = safeErrorMessage(error);
          injectedIds = [];
          rendered = undefined;
        }
        const latencyMs = performance.now() - started;
        observations.push({
          schemaVersion: 1,
          caseId: evaluationCase.caseId,
          split: evaluationCase.split,
          rankedIds,
          injectedIds,
          latencyMs,
          tokenCount: countUnicodeWhitespaceTokensV1(rendered || ''),
          tokenMethod: 'unicode-whitespace-v1',
          error: operationError,
        });
      }
    }

    const config = {
      schemaVersion: 1,
      mode,
      splits: [...MODE_SPLITS[mode]],
      engine: { id: 'fts', cloud: false, model: null },
      tokenMethod: 'unicode-whitespace-v1',
      datasetSha256: manifest.datasetSha256,
      qualityThresholds: { ...QUALITY_THRESHOLDS_V1 },
    };
    report = scoreEvaluationRunV1({
      datasets: selectedDatasets,
      observations,
      config,
    });
  } catch (error) {
    primaryError = error;
  } finally {
    let restoreError;
    if (cwdChanged) {
      try {
        process.chdir(originalCwd);
      } catch (error) {
        restoreError = error;
      }
    }
    try {
      restoreEnvironment();
    } catch (error) {
      restoreError ||= error;
    }
    cleanup.attempted = true;
    try {
      await fs.rm(parent, { recursive: true, force: true });
      cleanup.succeeded = true;
    } catch (error) {
      cleanup.succeeded = false;
      restoreError ||= error;
    }
    primaryError ||= restoreError;
  }

  if (primaryError) {
    throw attachFailureEvidence(primaryError, {
      cleanup,
      tempPaths,
      seededDocuments: seededDocumentIds.length,
    });
  }
  if (!cleanup.succeeded) {
    throw attachFailureEvidence(benchError('cleanup_failure', 'isolated evaluation cleanup failed'), {
      cleanup,
      tempPaths,
      seededDocuments: seededDocumentIds.length,
    });
  }

  report.generatedAt = new Date().toISOString();
  report.tempPaths = [...tempPaths];
  report.cleanup = { ...cleanup };
  report = validateEvaluationReportV1(report);
  return {
    report,
    executionCaseIds,
    evidence: {
      seededDocumentIds,
      provider: providerEvidence,
      resolvedPaths: [...tempPaths],
    },
  };
}

function failurePayload(error) {
  return {
    schemaVersion: 1,
    ok: false,
    error: {
      code: typeof error?.code === 'string' ? error.code : 'operation_failure',
      message: safeErrorMessage(error),
    },
    cleanup: error?.cleanup || { attempted: false, succeeded: false },
    tempPaths: Array.isArray(error?.tempPaths) ? error.tempPaths : [],
    evidence: error?.evidence || { seededDocuments: 0 },
  };
}

async function main() {
  const mode = process.argv[2];
  if (process.argv.length !== 3) {
    const error = benchError('invalid_mode', 'usage: evaluation-bench.mjs smoke|batch|full');
    process.stdout.write(canonicalJsonV1(failurePayload(error)));
    process.stderr.write(`[evaluation-bench] ${error.code}: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  try {
    const { report } = await runEvaluationBench({ mode });
    process.stdout.write(canonicalJsonV1(report));
    if (!report.gates.passed || report.errorMap.length > 0) {
      process.stderr.write(
        `[evaluation-bench] ${mode} failed: gate=${report.gates.passed ? 'pass' : 'fail'} errors=${report.errorMap.length} cleanup=${report.cleanup.succeeded ? 'ok' : 'failed'}\n`,
      );
      process.exitCode = 1;
      return;
    }
    process.stderr.write(
      `[evaluation-bench] ${mode} passed: cases=${report.caseCount} engine=fts cleanup=ok\n`,
    );
  } catch (error) {
    const payload = failurePayload(error);
    process.stdout.write(canonicalJsonV1(payload));
    process.stderr.write(`[evaluation-bench] ${payload.error.code}: ${payload.error.message}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) await main();
