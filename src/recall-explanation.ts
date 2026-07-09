// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Alpha.26 Recall Explanation / Preview v0.
// This module is an EXPERIENCE/DIAGNOSTIC layer over the existing recall gates: it explains what the
// default prompt-recall path would consider, without widening eligibility and without exposing excluded
// content. It is local-only and deterministic; no telemetry or upload is performed here.
import fs from 'node:fs/promises';
import type { SearchResult, WorkspaceOptions } from './types.ts';
import { openCore } from './core.ts';
import { absoluteFromMemoryPath, isCuratedMemoryPath, resolveWorkspace } from './workspace.ts';
import { applySemanticEngine } from './semantic.ts';
import { containsSecretLikeContent, redactSecretLikeContent } from './governance.ts';
import { defaultPromptRecallBoundary, type RecallBoundaryReason } from './recall-quality.ts';

export type RecallExplanationMode = 'lexical/FTS only' | 'semantic-ready';
export type RecallExplanationTier = 'reviewed' | 'auto';
export type RecallExplanationExcludedReason = RecallBoundaryReason | 'not-curated' | 'irrelevant' | 'secret' | 'unreadable' | 'over-budget';

export type RecallExplanationIncluded = {
  path: string;
  citation: {
    path: string;
    snippet: string;
  };
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
};

const DEFAULT_SEARCH_LIMIT = 25;
const DEFAULT_INCLUDE_LIMIT = 3;
const DEFAULT_MAX_CHARS = 1200;
const STOPWORDS = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'what', 'which', 'how', 'who', 'when', 'where', 'why', 'do', 'does', 'did', 'this', 'that', 'these', 'those', 'about', 'with', 'from', 'your', 'our', 'memory', 'recall', 'preview']);
const CJK_COMMON_BIGRAMS = new Set(['什么', '怎么', '怎样', '为何', '是否', '哪个', '哪些', '哪里', '如何', '意思', '翻译', '说明', '现在', '目前', '今天', '昨天', '我们', '你们', '他们', '这个', '那个', '这些', '那些', '如果', '因为', '所以', '但是', '关于', '对于', '通过', '使用', '进行', '以及', '问题', '事情', '情况', '方法', '内容', '结果', '可以', '没有', '不是', '需要', '应该', '继续']);

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(Math.floor(n), max));
}

function frontmatter(content: string): string {
  const match = String(content || '').match(/^\ufeff?\s*---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  return match ? match[1] : '';
}

function stripFrontmatter(content: string): string {
  return String(content || '').replace(/^\ufeff?\s*---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '');
}

function recallTerms(s: string): Set<string> {
  const out = new Set<string>();
  for (const tok of String(s || '').slice(0, 8000).toLowerCase().match(/[a-z0-9]+|[一-鿿]+/g) || []) {
    if (/[一-鿿]/.test(tok)) {
      if (tok.length === 2) {
        if (!CJK_COMMON_BIGRAMS.has(tok)) out.add(tok);
      } else {
        for (let i = 0; i + 2 <= tok.length; i += 1) {
          const bg = tok.slice(i, i + 2);
          if (!CJK_COMMON_BIGRAMS.has(bg)) out.add(bg);
        }
      }
    } else if (tok.length >= 4 && !STOPWORDS.has(tok)) {
      out.add(tok);
    }
  }
  return out;
}

function matchedTerms(promptTerms: Set<string>, text: string): string[] {
  const t = String(text || '').toLowerCase();
  const matched: string[] = [];
  for (const term of promptTerms) {
    if (/[一-鿿]/.test(term)) {
      if (t.includes(term)) matched.push(term);
    } else if (new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(t)) {
      matched.push(term);
    }
  }
  return matched.slice(0, 12);
}

function cleanSnippet(value: string): string {
  return redactSecretLikeContent(String(value || '')
    .replace(/[\[\]]/g, '')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '')
    .replace(/\b(candidate_id|status|type|source_agent|created_at|promoted_at|promoted_by|reviewed|tier|day|weight|entryAt|command|exitCode):\s*"?[^"\n]*"?/gi, '')
    .replace(/^\s*#+\s*Candidate\s+[0-9a-f][0-9a-f-]{6,}\s*$/gim, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s…]+/u, '')
    .replace(/[\s…]+$/u, '')
    .trim())
    .slice(0, 280);
}

function tierFromContent(content: string): RecallExplanationTier {
  const fm = frontmatter(content);
  const isAuto = /^\s*reviewed:\s*["']?false\b/im.test(fm) || /^\s*tier:\s*["']?auto-promoted\b/im.test(fm);
  return isAuto ? 'auto' : 'reviewed';
}

function addExcluded(counts: Partial<Record<RecallExplanationExcludedReason, number>>, reason: RecallExplanationExcludedReason): void {
  counts[reason] = (counts[reason] || 0) + 1;
}

function semanticPass(hit: SearchResult, floor: number | null): boolean {
  return floor !== null && typeof hit.semanticScore === 'number' && hit.semanticScore >= floor;
}

export async function explainPromptRecall(
  options: WorkspaceOptions,
  prompt: string,
  explanationOptions: RecallExplanationOptions = {},
): Promise<RecallExplanation> {
  const effective = applySemanticEngine(resolveWorkspace(options), options);
  const core = await openCore(effective);
  const status = await core.status();
  const readiness = status.recallReadiness;
  const mode: RecallExplanationMode = readiness.semanticReady ? 'semantic-ready' : 'lexical/FTS only';
  const searchLimit = clampInt(explanationOptions.searchLimit, DEFAULT_SEARCH_LIMIT, 1, 25);
  const includeLimit = clampInt(explanationOptions.includeLimit, DEFAULT_INCLUDE_LIMIT, 1, 10);
  const maxChars = clampInt(explanationOptions.maxChars, DEFAULT_MAX_CHARS, 200, 5000);
  const query = typeof prompt === 'string' ? prompt.trim() : '';
  const promptTerms = recallTerms(query);
  const hits = query ? await core.search(query, { limit: searchLimit, includeFlagged: true }) : [];
  const included: RecallExplanationIncluded[] = [];
  const excludedCounts: Partial<Record<RecallExplanationExcludedReason, number>> = {};
  let usedChars = 0;

  for (const hit of hits) {
    const relPath = typeof hit?.path === 'string' ? hit.path : '';
    if (!relPath || !isCuratedMemoryPath(relPath)) {
      addExcluded(excludedCounts, 'not-curated');
      continue;
    }

    let raw = '';
    try {
      raw = await fs.readFile(absoluteFromMemoryPath(core.workspace, relPath), 'utf8');
    } catch {
      addExcluded(excludedCounts, 'unreadable');
      continue;
    }

    const boundary = defaultPromptRecallBoundary(raw, relPath);
    if (!boundary.allowed) {
      addExcluded(excludedCounts, boundary.reason || 'irrelevant');
      continue;
    }

    const body = stripFrontmatter(raw);
    const snippet = cleanSnippet(String(hit.snippet || body));
    if (!snippet || containsSecretLikeContent(snippet)) {
      addExcluded(excludedCounts, 'secret');
      continue;
    }

    const terms = matchedTerms(promptTerms, `${relPath}\n${snippet}\n${body.slice(0, 2000)}`);
    const semanticRelevant = semanticPass(hit, readiness.semanticRecallFloor);
    if (!semanticRelevant && terms.length === 0) {
      addExcluded(excludedCounts, 'irrelevant');
      continue;
    }

    const projectedChars = usedChars + snippet.length + relPath.length;
    if (included.length >= includeLimit || projectedChars > maxChars) {
      addExcluded(excludedCounts, 'over-budget');
      continue;
    }
    usedChars = projectedChars;
    included.push({
      path: relPath,
      citation: { path: relPath, snippet },
      tier: tierFromContent(raw),
      reason: semanticRelevant
        ? `semantic score cleared measured floor${terms.length ? `; matched terms: ${terms.join(', ')}` : ''}`
        : `curated ${tierFromContent(raw)} memory matched prompt terms: ${terms.join(', ')}`,
      matchedTerms: terms,
    });
  }

  const reasons = (Object.entries(excludedCounts) as Array<[RecallExplanationExcludedReason, number]>)
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([reason, count]) => ({ reason, count }));
  const excludedTotal = reasons.reduce((sum, item) => sum + item.count, 0);
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
      searchLimit,
      includeLimit,
      maxChars,
      considered: hits.length,
      included: included.length,
    },
    included,
    excluded: {
      total: excludedTotal,
      counts: excludedCounts,
      reasons,
    },
    noRelevantRecall,
    summary: noRelevantRecall
      ? `no relevant recall (${mode}; ${readiness.reason})`
      : `included ${included.length} recall item(s), excluded ${excludedTotal} by safe local gates (${mode})`,
  };
}
