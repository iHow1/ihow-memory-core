// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import type { RetrievalEngineStatus, WorkspaceOptions } from './types.ts';
import { resolveEngineConfig, semanticRecallFloor } from './engine/retrieval.ts';

export type RecallReadiness = {
  lexicalReady: boolean;
  semanticAvailable: boolean;
  semanticReady: boolean;
  provider: 'fts/lexical' | 'vector-gguf';
  requestedProvider: string;
  model: string | null;
  measuredSemanticModel: boolean;
  semanticRecallFloor: number | null;
  reason: string;
  warnings: string[];
};

type ProviderStatus = RetrievalEngineStatus & {
  fallback?: boolean;
  fallbackFrom?: string;
  requested?: RetrievalEngineStatus;
};

function semanticReason(
  status: ProviderStatus,
  opts: {
    hasProviderCommand: boolean;
    vectorModel: string | undefined;
    requestedId: string;
    floor: number | null;
  },
): { reason: string; warnings: string[] } {
  const warnings: string[] = [];
  if (!opts.hasProviderCommand || opts.requestedId !== 'vector-gguf') {
    return {
      reason: 'no semantic provider/config; lexical FTS-only',
      warnings,
    };
  }
  if (!opts.vectorModel) {
    return {
      reason: 'semantic provider configured without vector model; lexical FTS-only',
      warnings: ['vector_model_missing'],
    };
  }
  if (status.fallback === true || status.id === 'fts') {
    return {
      reason: `semantic provider unavailable; lexical FTS-only fallback${status.lastError ? ` (${status.lastError})` : ''}`,
      warnings: ['semantic_provider_fallback'],
    };
  }
  if (status.ready !== true) {
    return {
      reason: `semantic provider not ready; lexical FTS-only${status.lastError ? ` (${status.lastError})` : ''}`,
      warnings: ['semantic_provider_not_ready'],
    };
  }
  if (opts.floor === null) {
    return {
      reason: `semantic provider ready, but model "${opts.vectorModel}" has no measured recall floor; semantic bypass fail-closed`,
      warnings: ['semantic_model_unmeasured'],
    };
  }
  return {
    reason: `semantic provider ready with measured model "${opts.vectorModel}"`,
    warnings,
  };
}

// Alpha.26 recall-readiness is status-only: it describes whether the semantic lane is truly present and
// whether its model is measured for prompt-recall bypass decisions. It does NOT widen recall eligibility.
export function recallReadiness(options: WorkspaceOptions, providerStatus: ProviderStatus): RecallReadiness {
  const engine = resolveEngineConfig(options);
  const model = engine.vectorModel || providerStatus.requested?.model || providerStatus.model || null;
  const floor = semanticRecallFloor(model);
  const hasProviderCommand = Boolean(engine.vectorProviderCommand && engine.vectorProviderCommand.trim());
  const semanticAvailable = engine.requestedId === 'vector-gguf'
    && hasProviderCommand
    && providerStatus.id === 'vector-gguf'
    && providerStatus.ready === true
    && providerStatus.fallback !== true;
  const measuredSemanticModel = floor !== null;
  const semanticReady = semanticAvailable && measuredSemanticModel;
  const { reason, warnings } = semanticReason(providerStatus, {
    hasProviderCommand,
    vectorModel: engine.vectorModel,
    requestedId: engine.requestedId,
    floor,
  });

  return {
    lexicalReady: true,
    semanticAvailable,
    semanticReady,
    provider: semanticAvailable ? 'vector-gguf' : 'fts/lexical',
    requestedProvider: engine.requestedId,
    model,
    measuredSemanticModel,
    semanticRecallFloor: floor,
    reason,
    warnings,
  };
}
