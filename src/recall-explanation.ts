// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Alpha.26 Recall Explanation / Preview. This is a rendering of the shared selector's real decisions;
// excluded candidates are represented only by aggregate reason/count and never by path or content.
import type { WorkspaceOptions } from './types.ts';
import { openCore } from './core.ts';
import { resolveEngineConfig, semanticRecallFloor } from './engine/retrieval.ts';
import { resolveWorkspace } from './workspace.ts';
import { applySemanticEngine } from './semantic.ts';
import {
  PROMPT_RECALL_INCLUDE_LIMIT,
  PROMPT_RECALL_MAX_CHARS,
  PROMPT_RECALL_SEARCH_LIMIT,
  selectPromptRecall,
  type PromptRecallExcludedReason,
  type PromptRecallSelection,
  type PromptRecallTier,
} from './prompt-recall.ts';

export type RecallExplanationMode = 'lexical/FTS only' | 'semantic-ready';
export type RecallExplanationTier = PromptRecallTier;
export type RecallExplanationExcludedReason = PromptRecallExcludedReason;

export type RecallExplanationIncluded = {
  path: string;
  citation: { path: string; snippet: string };
  tier: RecallExplanationTier;
  reason: string;
  matchedTerms: string[];
};

export type RecallExplanation = {
  version: 'alpha26-recall-explanation-v0';
  mode: RecallExplanationMode;
  modeLabel: string;
  readiness: {
    lexicalReady: boolean;
    semanticAvailable: boolean;
    semanticReady: boolean;
    provider: 'fts/lexical' | 'vector-gguf';
    reason: string;
    warnings: string[];
  };
  bounded: {
    bounded: true;
    searchLimit: number;
    includeLimit: number;
    maxChars: number;
    considered: number;
    included: number;
  };
  included: RecallExplanationIncluded[];
  excluded: {
    total: number;
    counts: Partial<Record<RecallExplanationExcludedReason, number>>;
    reasons: Array<{ reason: RecallExplanationExcludedReason; count: number }>;
  };
  noRelevantRecall: boolean;
  summary: string;
};

export type RecallExplanationOptions = {
  searchLimit?: number;
  includeLimit?: number;
  maxChars?: number;
  semanticFloor?: number | null;
};

type ReadinessView = {
  lexicalReady: boolean;
  semanticAvailable: boolean;
  semanticReady: boolean;
  provider: 'fts/lexical' | 'vector-gguf';
  reason: string;
  warnings: string[];
  modeLabel: string;
};

export function recallExplanationFromSelection(readiness: ReadinessView, selection: PromptRecallSelection): RecallExplanation {
  const mode: RecallExplanationMode = readiness.semanticReady ? 'semantic-ready' : 'lexical/FTS only';
  const included = selection.included.map((item) => ({
    path: item.path,
    citation: { path: item.path, snippet: item.snippet },
    tier: item.tier,
    reason: item.reason,
    matchedTerms: item.matchedTerms,
  }));
  const noRelevantRecall = included.length === 0;
  return {
    version: 'alpha26-recall-explanation-v0',
    mode,
    modeLabel: readiness.modeLabel,
    readiness: {
      lexicalReady: readiness.lexicalReady,
      semanticAvailable: readiness.semanticAvailable,
      semanticReady: readiness.semanticReady,
      provider: readiness.provider,
      reason: readiness.reason,
      warnings: readiness.warnings,
    },
    bounded: {
      bounded: true,
      searchLimit: selection.policy.searchLimit,
      includeLimit: selection.policy.includeLimit,
      maxChars: selection.policy.maxChars,
      considered: selection.considered,
      included: included.length,
    },
    included,
    excluded: selection.excluded,
    noRelevantRecall,
    summary: noRelevantRecall
      ? `no relevant recall (${mode}; ${readiness.reason})`
      : `included ${included.length} recall item(s), excluded ${selection.excluded.total} by shared safe local gates (${mode})`,
  };
}

export async function explainPromptRecall(
  options: WorkspaceOptions,
  prompt: string,
  explanationOptions: RecallExplanationOptions = {},
): Promise<RecallExplanation> {
  const effective = applySemanticEngine(resolveWorkspace(options), options);
  const core = await openCore(effective);
  const status = await core.status();
  const searchLimit = explanationOptions.searchLimit ?? PROMPT_RECALL_SEARCH_LIMIT;
  const includeLimit = explanationOptions.includeLimit ?? PROMPT_RECALL_INCLUDE_LIMIT;
  const maxChars = explanationOptions.maxChars ?? PROMPT_RECALL_MAX_CHARS;
  const query = typeof prompt === 'string' ? prompt.trim() : '';
  const hits = query ? await core.search(query, { limit: searchLimit, includeFlagged: true }) : [];
  const configuredFloor = semanticRecallFloor(resolveEngineConfig(effective).vectorModel);
  const selection = await selectPromptRecall(core.workspace, query, hits, {
    searchLimit,
    includeLimit,
    maxChars,
    semanticFloor: explanationOptions.semanticFloor === undefined ? configuredFloor : explanationOptions.semanticFloor,
  });
  return recallExplanationFromSelection(status.recallReadiness, selection);
}
