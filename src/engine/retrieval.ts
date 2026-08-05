// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  RetrievalEngine,
  RetrievalEngineStatus,
  SearchOptions,
  SearchResult,
  Workspace,
  WorkspaceOptions,
} from '../types.ts';
import { countIndexedDocuments, ftsEngine } from './fts.ts';
import { readProviderManifest, writeProviderManifest } from './manifest.ts';
import { containsSecretLikeContent } from '../governance.ts';

// A search RESULT must never surface a secret-like path — and not only on the FTS lane (gated at
// collectDocuments). An OPT-IN vector provider can return a hit for an out-of-band PII/secret-named file the
// FTS index gate never saw, and RRF would fuse it into the result list (red-team r7). This is the result-
// boundary chokepoint applied to EVERY lane/return of searchWithEngineFallback, so MCP / CLI / HTTP / recall
// (all of which go through core.search → here) can never echo a foreign secret-like path. Engine-written
// durable paths are always slug-safe, so a normal hit is never dropped.
function gateSearchHits(hits: SearchResult[]): SearchResult[] {
  return hits.filter((hit) => hit && typeof hit.path === 'string' && !containsSecretLikeContent(hit.path));
}

const RELATION_READ_MAX = 16 * 1024;
const RELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function frontmatterId(value: string): string | null {
  const trimmed = value.trim();
  const unquoted = (trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ? trimmed.slice(1, -1)
    : trimmed;
  return RELATION_ID.test(unquoted) ? unquoted : null;
}

async function relationMetadata(spaceDir: string, hitPath: string): Promise<{ documentId?: string; supersededBy?: string } | null> {
  if (!hitPath || hitPath.includes('\0') || path.isAbsolute(hitPath)) return null;
  const root = await fs.realpath(spaceDir);
  const candidate = path.resolve(root, hitPath);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) return null;
  const real = await fs.realpath(candidate);
  if (real !== root && !real.startsWith(`${root}${path.sep}`)) return null;
  const handle = await fs.open(real, 'r');
  try {
    const buffer = Buffer.alloc(RELATION_READ_MAX);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return {};
    const openerEnd = text.indexOf('\n') + 1;
    const closingMatch = /(?:^|\n)---\r?(?=\n|$)/g;
    closingMatch.lastIndex = openerEnd;
    const closing = closingMatch.exec(text);
    if (!closing) return null;
    const close = closing.index + (closing[0].startsWith('\n') ? 1 : 0);
    const block = text.slice(openerEnd, close);
    const result: { documentId?: string; supersededBy?: string } = {};
    const seen = new Set<string>();
    for (const line of block.split(/\r?\n/)) {
      const match = line.match(/^\s*(document_id|superseded_by)\s*:\s*(.*?)\s*$/);
      if (!match) continue;
      if (seen.has(match[1])) return null;
      seen.add(match[1]);
      const id = frontmatterId(match[2]);
      if (!id) return null;
      if (match[1] === 'document_id') result.documentId = id;
      else result.supersededBy = id;
    }
    return result;
  } finally {
    await handle.close();
  }
}

export async function orderSupersededHits(
  workspace: Pick<Workspace, 'spaceDir'>,
  hits: SearchResult[],
  limit: number,
): Promise<SearchResult[]> {
  const count = Math.max(0, Math.min(Number(limit) || 0, 25));
  if (hits.length > count || hits.length > 25) return hits;
  try {
    const metadata = await Promise.all(hits.map((hit) => relationMetadata(workspace.spaceDir, hit.path)));
    if (metadata.some((item) => item === null)) return hits;
    const byId = new Map<string, number>();
    for (let i = 0; i < metadata.length; i++) {
      const id = metadata[i]?.documentId;
      if (!id) continue;
      if (byId.has(id)) return hits;
      byId.set(id, i);
    }
    const edges = new Map<string, string>();
    for (const item of metadata) {
      if (!item?.documentId || !item.supersededBy || !byId.has(item.supersededBy)) continue;
      if (item.documentId === item.supersededBy) return hits;
      edges.set(item.documentId, item.supersededBy);
    }
    for (const start of edges.keys()) {
      const seen = new Set<string>();
      let cursor: string | undefined = start;
      while (cursor && edges.has(cursor)) {
        if (seen.has(cursor)) return hits;
        seen.add(cursor);
        cursor = edges.get(cursor);
      }
    }
    if (!edges.size) return hits;
    const ordered = [...hits];
    for (const item of metadata) {
      if (!item?.documentId || !item.supersededBy || !edges.has(item.documentId)) continue;
      const staleIndex = ordered.findIndex((hit) => metadata[hits.indexOf(hit)]?.documentId === item.documentId);
      const currentIndex = ordered.findIndex((hit) => metadata[hits.indexOf(hit)]?.documentId === item.supersededBy);
      if (staleIndex < 0 || currentIndex < 0 || currentIndex < staleIndex) continue;
      const [current] = ordered.splice(currentIndex, 1);
      const adjustedStale = ordered.findIndex((hit) => metadata[hits.indexOf(hit)]?.documentId === item.documentId);
      ordered.splice(adjustedStale, 0, current);
    }
    return ordered;
  } catch {
    return hits;
  }
}

type EngineConfig = {
  requestedId: string;
  vectorProviderCommand?: string;
  vectorModel?: string;
  vectorTimeoutMs: number;
  // SEPARATE ceiling for the whole-corpus index() call. The interactive vectorTimeoutMs (default 1.5s, max 30s)
  // is right for status/search, but applying it to index() SIGTERM-killed a slow embedding model mid-index —
  // and the failure degraded silently to FTS while status could still look healthy (the exact "fake green" this
  // floor exists to prevent). index() is not interactive, so it gets a generous ceiling of its own.
  vectorIndexTimeoutMs: number;
};

type ProviderCall = 'status' | 'index' | 'search';

type FallbackInfo = {
  from: string;
  to: 'fts';
  reason: string;
};

export type EngineSearchResult = {
  hits: SearchResult[];
  fallback?: FallbackInfo;
};

const DEFAULT_VECTOR_TIMEOUT_MS = 1500;
// index() runs over the whole corpus and may legitimately take minutes on a slow local model — generous
// default, far higher ceiling than the interactive search timeout (which clamps to 30s).
const DEFAULT_VECTOR_INDEX_TIMEOUT_MS = 600_000; // 10 min

function stringEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

function parseTimeout(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_VECTOR_TIMEOUT_MS;
  return Math.max(100, Math.min(parsed, 30000));
}

// index() is non-interactive, so its ceiling is much higher than the search timeout — up to 1h.
function parseIndexTimeout(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_VECTOR_INDEX_TIMEOUT_MS;
  return Math.max(1000, Math.min(parsed, 3_600_000));
}

function requestedEngineId(options: WorkspaceOptions): string {
  const requested = options.engine || stringEnv('IHOW_MEMORY_ENGINE') || stringEnv('IHOW_MEMORY_PROVIDER') || 'fts';
  const normalized = requested.trim().toLowerCase();
  if (['vector', 'semantic', 'vector-process', 'vector-gguf'].includes(normalized)) return 'vector-gguf';
  return normalized || 'fts';
}

export function resolveEngineConfig(options: WorkspaceOptions = {}): EngineConfig {
  return {
    requestedId: requestedEngineId(options),
    vectorProviderCommand: options.vectorProviderCommand || stringEnv('IHOW_MEMORY_VECTOR_PROVIDER_COMMAND'),
    vectorModel: options.vectorModel || stringEnv('IHOW_MEMORY_VECTOR_MODEL') || null || undefined,
    vectorTimeoutMs: parseTimeout(options.vectorTimeoutMs || stringEnv('IHOW_MEMORY_VECTOR_TIMEOUT_MS')),
    vectorIndexTimeoutMs: parseIndexTimeout(options.vectorIndexTimeoutMs || stringEnv('IHOW_MEMORY_VECTOR_INDEX_TIMEOUT_MS')),
  };
}

function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, '[redacted]')
    .replace(/\b(token|password|secret|api[_-]?key)=\S+/gi, '$1=[redacted]')
    .slice(0, 500);
}

function splitCommand(input: string): string[] {
  return input.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => part.replace(/^["']|["']$/g, '')) || [];
}

function validProviderDimension(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 8192
    ? Number(value)
    : undefined;
}

class VectorProcessEngine implements RetrievalEngine {
  id = 'vector-gguf';

  capabilities = {
    lexical: false,
    semantic: true,
  };

  private readonly config: EngineConfig;

  constructor(config: EngineConfig) {
    this.config = config;
  }

  async index(workspace: Workspace): Promise<{ indexed: number }> {
    return (await this.callProvider('index', workspace)) as { indexed: number };
  }

  async search(workspace: Workspace, query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    const result = (await this.callProvider('search', workspace, { query, opts })) as {
      hits?: SearchResult[];
      results?: SearchResult[];
    };
    const hits = result.hits || result.results || [];
    return hits.map((hit) => ({
      ...hit,
      source: hit.source || this.id,
      citation: hit.citation || {
        path: hit.path,
        snippet: hit.snippet,
      },
    }));
  }

  async status(workspace: Workspace): Promise<RetrievalEngineStatus> {
    const status = (await this.callProvider('status', workspace)) as Partial<RetrievalEngineStatus>;
    return {
      id: String(status.id || this.id),
      model: typeof status.model === 'string' ? status.model : this.config.vectorModel || null,
      ready: status.ready === true,
      cloud: status.cloud === true,
      dimension: validProviderDimension(status.dimension),
      lastError: typeof status.lastError === 'string' ? status.lastError : undefined,
    };
  }

  private async callProvider(method: ProviderCall, workspace: Workspace, payload: Record<string, unknown> = {}) {
    if (!this.config.vectorProviderCommand) throw new Error('vector_provider_unconfigured');
    const parts = splitCommand(this.config.vectorProviderCommand);
    const [command, ...baseArgs] = parts;
    if (!command) throw new Error('vector_provider_unconfigured');

    const request = {
      method,
      workspace: {
        root: workspace.root,
        space: workspace.space,
        memoryDir: workspace.memoryDir,
        indexPath: workspace.indexPath,
        indexManifestPath: workspace.indexManifestPath,
      },
      provider: {
        id: this.id,
        model: this.config.vectorModel || null,
      },
      ...payload,
    };

    return await new Promise((resolve, reject) => {
      const child = spawn(command, [...baseArgs, method], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      // index() gets its own generous ceiling; status/search keep the tight interactive timeout.
      const timeoutMs = method === 'index' ? this.config.vectorIndexTimeoutMs : this.config.vectorTimeoutMs;
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`vector_provider_timeout:${method}:${timeoutMs}ms`));
      }, timeoutMs);

      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`vector_provider_exit_${code}:${stderr.trim() || method}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout.trim() || '{}'));
        } catch {
          reject(new Error(`vector_provider_invalid_json:${method}`));
        }
      });
      child.stdin.end(`${JSON.stringify(request)}\n`);
    });
  }
}

function isVectorRequested(config: EngineConfig): boolean {
  return config.requestedId === 'vector-gguf';
}

function vectorEngine(config: EngineConfig): RetrievalEngine {
  return new VectorProcessEngine(config);
}

async function writeReadyManifest(workspace: Workspace, status: RetrievalEngineStatus, documents?: number): Promise<void> {
  await writeProviderManifest(workspace, {
    providerId: status.id,
    modelId: status.model,
    dims: status.dimension ?? null,
    createdAt: new Date().toISOString(),
    corpusFingerprint: null,
    status: status.ready ? 'ready' : 'error',
    ready: status.ready,
    cloud: status.cloud,
    activeProviderId: status.id,
    lastError: status.lastError,
    providers: {
      fts: {
        id: 'fts',
        model: null,
        ready: documents === undefined ? true : documents >= 0,
        cloud: false,
        capabilities: ftsEngine.capabilities,
      },
      [status.id]: {
        id: status.id,
        model: status.model,
        ready: status.ready,
        cloud: status.cloud,
        dimension: status.dimension,
        lastError: status.lastError,
        capabilities: {
          semantic: true,
        },
      },
    },
  });
}

async function writeFallbackManifest(workspace: Workspace, fallback: FallbackInfo): Promise<void> {
  const documents = await countIndexedDocuments(workspace);
  await writeProviderManifest(workspace, {
    providerId: 'fts',
    modelId: null,
    dims: null,
    createdAt: new Date().toISOString(),
    corpusFingerprint: null,
    status: 'fallback',
    ready: true,
    cloud: false,
    activeProviderId: 'fts',
    fallbackFrom: fallback.from,
    fallbackTo: fallback.to,
    lastError: fallback.reason,
    providers: {
      fts: {
        id: 'fts',
        model: null,
        ready: true,
        cloud: false,
        capabilities: ftsEngine.capabilities,
      },
      [fallback.from]: {
        id: fallback.from,
        model: null,
        ready: false,
        cloud: false,
        lastError: fallback.reason,
        capabilities: {
          semantic: true,
        },
      },
    },
  });
  if (documents < 0) {
    throw new Error('unreachable_index_document_count');
  }
}

export async function indexWithEngineFallback(workspace: Workspace, config: EngineConfig): Promise<number> {
  const ftsIndexed = (await ftsEngine.index(workspace)).indexed;
  if (!isVectorRequested(config)) return ftsIndexed;

  try {
    const requested = vectorEngine(config);
    const status = await requested.status(workspace);
    if (!status.ready) throw new Error(status.lastError || 'vector_provider_not_ready');
    await requested.index(workspace);
    await writeReadyManifest(workspace, status, ftsIndexed);
    return ftsIndexed;
  } catch (error) {
    // LOUD, not silent: a failed semantic INDEX must not look like a healthy build. The manifest records
    // status:'fallback' + this reason, which status/doctor surface — so a user sees "semantic index failed,
    // search is lexical-only" instead of a quiet green. (The interactive search-time fallback says less.)
    await writeFallbackManifest(workspace, {
      from: 'vector-gguf',
      to: 'fts',
      reason: `semantic index FAILED — search is LEXICAL-ONLY until a successful reindex: ${safeErrorMessage(error)}`,
    });
    return ftsIndexed;
  }
}

// Reciprocal Rank Fusion (RRF). Vector hits JOIN the same ranked list as FTS; neither lane can
// add a result the other rejected as INELIGIBLE — fusion only re-orders the UNION of what each lane
// already surfaced. RRF is rank-based (not score-based), so the two incomparable score scales
// (bm25 distance vs cosine similarity) never need normalizing, and a single lane's outlier score
// cannot dominate. k=60 is the canonical RRF constant. The FTS lane is always present and seeded
// first, so its citation/snippet/source (the audited lexical record) wins ties on identical paths.
const RRF_K = 60;

// C3 (semantic recall): did this hit arrive on the SEMANTIC lane? The vector engine already judged it
// relevant (cosine over the whole entry), so recall's lexical share-a-term gate — which exists to stop
// FTS stopword matches, a failure mode the semantic lane doesn't have — must not veto it. FAIL-CLOSED:
// only a recognized vector/semantic source qualifies; 'fts', a missing source, or any unknown value keeps
// the lexical gate. fuseRrf keeps the FTS representation (source:'fts') for a path BOTH lanes surfaced,
// so this admits only semantic-ONLY hits — the paraphrase wins lexical search could never see.
export function isSemanticSourced(hit: { source?: unknown } | null | undefined): boolean {
  const s = typeof hit?.source === 'string' ? hit.source.toLowerCase() : '';
  return s === 'semantic' || s === 'vector' || s.startsWith('vector-');
}

// C3 similarity floor — MEASURED per embedding model (2026-07-01 live calibration on short ZH/EN memory
// text; see the alpha19 plan §3). Raw cosine only means "nearest", never "relevant" — the provider returns
// top-K neighbors for ANY prompt — so the lexical-gate bypass may fire only above a floor with measured
// separation between related and off-topic pairs:
//   • bge-m3: separates. Scaled calibration (18 related / 144 off-topic ZH pairs): floor 0.58 → 0
//     off-topic pairs leak, 15/18 paraphrases rescued (worst off-topic 0.575 nginx↔pnpm; the 3 misses
//     fall back to the lexical gate = status quo). Cross-language pairs (~0.57) sit at the boundary —
//     an honest, documented weak spot, not a safety gap (a rare leak is one fenced reference-only line
//     that still passed the curated/tier/C1 checks and the top-N cap).
//   • nomic-embed-text: does NOT separate on short CJK text (off-topic pairs reach 0.79, ABOVE most true
//     positives, prefixed or not) → bypass DISABLED; it keeps its semantic RANKING value, which is safe.
//   • unknown models: DISABLED (fail-closed) until measured.
// IHOW_RECALL_SEMANTIC_MIN overrides (an explicit local calibration beats the table).
const SEMANTIC_RECALL_FLOORS: Array<[RegExp, number]> = [
  [/^bge-m3\b/i, 0.58],
];
export function semanticRecallFloor(model: string | null | undefined): number | null {
  const raw = process.env.IHOW_RECALL_SEMANTIC_MIN;
  if (raw !== undefined && raw.trim() !== '') {
    const env = Number(raw);
    // clamp to [0,1]: cosine range — a stray negative/huge override must not self-harm (red-team polish)
    if (Number.isFinite(env)) return Math.min(1, Math.max(0, env));
  }
  const m = (model || '').trim();
  for (const [re, floor] of SEMANTIC_RECALL_FLOORS) if (re.test(m)) return floor;
  return null; // no measured separation for this model -> the lexical relevance gate stays authoritative
}

export function fuseRrf(ftsHits: SearchResult[], vectorHits: SearchResult[], limit: number): SearchResult[] {
  const acc = new Map<string, { hit: SearchResult; score: number }>();
  const fold = (hits: SearchResult[], prefer: boolean): void => {
    hits.forEach((hit, rank) => {
      if (!hit || typeof hit.path !== 'string') return;
      const semanticLane = !prefer && isSemanticSourced(hit);
      const contribution = (semanticLane ? 1.25 : 1) / (RRF_K + rank + 1);
      // C3: preserve the semantic lane's raw cosine as `semanticScore` BEFORE any representation swap —
      // on a shared path the FTS shape wins below, which would otherwise erase the only evidence that the
      // semantic engine surfaced this path (an FTS stopword co-match must not veto the paraphrase win).
      // Only a semantic-sourced lane may stamp it (a second lexical lane could never smuggle evidence in).
      const semScore = semanticLane && Number.isFinite(Number(hit.score)) ? Number(hit.score) : undefined;
      const existing = acc.get(hit.path);
      if (existing) {
        existing.score += contribution;
        // keep the FTS-lane representation (citation/snippet/source) as the canonical one when present —
        // but never at the cost of an already-stamped semanticScore (fold order must not matter here)
        if (prefer) {
          const kept = existing.hit.semanticScore;
          existing.hit = { ...hit, score: existing.score, ...(kept !== undefined ? { semanticScore: kept } : {}) };
        }
        if (semScore !== undefined && existing.hit.semanticScore === undefined) {
          existing.hit = { ...existing.hit, semanticScore: semScore };
        }
      } else {
        acc.set(hit.path, { hit: semScore !== undefined ? { ...hit, semanticScore: semScore } : hit, score: contribution });
      }
    });
  };
  // FTS folded FIRST (prefer=true): the always-on lexical lane owns the canonical hit shape.
  fold(ftsHits, true);
  fold(vectorHits, false);
  return [...acc.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    // RRF score replaces the lane-local score; downstream consumers (recall) re-gate by path, not score,
    // so this rewrite only affects ORDER, never eligibility.
    .map((entry) => ({ ...entry.hit, score: entry.score }));
}

export async function searchWithEngineFallback(
  workspace: Workspace,
  config: EngineConfig,
  query: string,
  opts: SearchOptions = {},
): Promise<EngineSearchResult> {
  // FTS5/BM25 is the MANDATORY lexical floor — always run, always present. When no semantic provider
  // is requested, it is the only lane (default zero-dependency binary). `capabilities.semantic` stays
  // false in this path because no semantic engine was even constructed.
  const ftsHits = await ftsEngine.search(workspace, query, opts);
  if (!isVectorRequested(config)) {
    return { hits: gateSearchHits(ftsHits) };
  }

  // The manifest is the authoritative index-readiness record. A reachable provider plus an old sidecar
  // cannot recover a failed build during search; only indexWithEngineFallback may write readiness again.
  const manifest = await readProviderManifest(workspace);
  const manifestRequested = manifest?.providers?.[config.requestedId];
  if (
    (manifest?.status === 'fallback' || manifest?.status === 'error') &&
    (manifest.fallbackFrom === config.requestedId || manifestRequested?.ready === false)
  ) {
    const fallback = {
      from: config.requestedId,
      to: 'fts' as const,
      reason: manifest.lastError || manifestRequested?.lastError || 'vector_index_not_ready',
    };
    return {
      hits: gateSearchHits(ftsHits.map((hit) => ({ ...hit, fallback }))),
      fallback,
    };
  }

  // Semantic lane is OPT-IN. Run it ALONGSIDE FTS (not instead of) and RRF-fuse: vector hits re-order
  // the list but ride the same FTS floor. If the sidecar/provider is unreachable or not ready, we fall
  // back to the FTS hits we already have — semantic is additive, never load-bearing for availability.
  const requested = vectorEngine(config);
  try {
    const status = await requested.status(workspace);
    if (!status.ready) throw new Error(status.lastError || 'vector_provider_not_ready');
    // Pull a deeper vector slice than the caller's limit so fusion has rank signal to work with.
    const vectorLimit = Math.max(Number(opts.limit || 5), 10);
    const vectorHits = await requested.search(workspace, query, { ...opts, limit: vectorLimit });
    await writeReadyManifest(workspace, status);
    const limit = Math.max(1, Math.min(Number(opts.limit || 5), 25));
    const gated = gateSearchHits(fuseRrf(ftsHits, vectorHits, limit));
    return { hits: await orderSupersededHits(workspace, gated, limit) };
  } catch (error) {
    const fallback = {
      from: requested.id,
      to: 'fts' as const,
      reason: safeErrorMessage(error),
    };
    await writeFallbackManifest(workspace, fallback);
    return {
      hits: gateSearchHits(ftsHits.map((hit) => ({
        ...hit,
        fallback,
      }))),
      fallback,
    };
  }
}

export async function engineStatus(workspace: Workspace, config: EngineConfig): Promise<{
  provider: RetrievalEngineStatus & {
    fallback?: boolean;
    fallbackFrom?: string;
    requested?: RetrievalEngineStatus;
  };
  manifestLastError?: string;
}> {
  if (!isVectorRequested(config)) {
    const manifest = await readProviderManifest(workspace);
    return {
      provider: {
        id: 'fts',
        model: null,
        ready: true,
        cloud: false,
        lastError: manifest?.providerId === 'fts' ? manifest.lastError : undefined,
      },
      manifestLastError: manifest?.lastError,
    };
  }

  const requested = vectorEngine(config);
  const manifest = await readProviderManifest(workspace);
  const requestedManifestStatus = manifest?.providers?.[requested.id];
  if (
    (manifest?.status === 'fallback' || manifest?.status === 'error') &&
    (manifest.fallbackFrom === requested.id || requestedManifestStatus?.ready === false)
  ) {
    const reason = manifest.lastError || requestedManifestStatus?.lastError || 'vector_index_not_ready';
    const requestedStatus = {
      id: requested.id,
      model: requestedManifestStatus?.model || config.vectorModel || null,
      ready: false,
      cloud: requestedManifestStatus?.cloud === true,
      lastError: reason,
    };
    return {
      provider: {
        id: 'fts',
        model: null,
        ready: true,
        cloud: false,
        lastError: reason,
        fallback: true,
        fallbackFrom: requested.id,
        requested: requestedStatus,
      },
      manifestLastError: reason,
    };
  }
  try {
    const requestedStatus = await requested.status(workspace);
    if (!requestedStatus.ready) throw new Error(requestedStatus.lastError || 'vector_provider_not_ready');
    await writeReadyManifest(workspace, requestedStatus);
    return {
      provider: requestedStatus,
      manifestLastError: requestedStatus.lastError,
    };
  } catch (error) {
    const fallback = {
      from: requested.id,
      to: 'fts' as const,
      reason: safeErrorMessage(error),
    };
    await writeFallbackManifest(workspace, fallback);
    const requestedStatus = {
      id: requested.id,
      model: config.vectorModel || null,
      ready: false,
      cloud: false,
      lastError: fallback.reason,
    };
    return {
      provider: {
        id: 'fts',
        model: null,
        ready: true,
        cloud: false,
        lastError: fallback.reason,
        fallback: true,
        fallbackFrom: requested.id,
        requested: requestedStatus,
      },
      manifestLastError: fallback.reason,
    };
  }
}
