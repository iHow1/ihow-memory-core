// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import fs from 'node:fs';
import type {
  CoreStatus,
  DurablePromoteOptions,
  DurablePromoteResult,
  JournalPayload,
  JournalResult,
  PromoteResult,
  PromoteTarget,
  ReadResult,
  SearchResult,
  Workspace,
  WorkspaceOptions,
  SearchOptions,
  WriteCandidatePayload,
  WriteCandidateResult,
} from './types.ts';
import { ensureWorkspace, resolveWorkspace } from './workspace.ts';
import { readMemoryFile } from './store/files.ts';
import { appendJournal, durablePromoteCandidate, evaluateAutoPromote, promoteCandidate, rollbackEvent, writeCandidate } from './governance.ts';
import type { RollbackResult } from './governance.ts';
import { readEventsAllLanes, mcpLaneWorkspace } from './store/events.ts';
import type { MemoryEvent } from './store/events.ts';
import { countIndexedDocuments } from './engine/fts.ts';
import { engineStatus, indexWithEngineFallback, resolveEngineConfig, searchWithEngineFallback } from './engine/retrieval.ts';
import { filterForgotten, forgetPath, listForgotten, rememberPath } from './forget.ts';
import type { ForgetOutcome, RememberOutcome } from './forget.ts';

export type MemoryCore = {
  workspace: Workspace;
  search(query: string, opts?: SearchOptions): Promise<SearchResult[]>;
  read(ref: string): Promise<ReadResult>;
  write_candidate(payload: WriteCandidatePayload): Promise<WriteCandidateResult>;
  journal(payload: JournalPayload): Promise<JournalResult>;
  promote(candidate: string, target?: PromoteTarget): Promise<PromoteResult>;
  durable_promote(candidate: string, options: DurablePromoteOptions): Promise<DurablePromoteResult>;
  status(): Promise<CoreStatus>;
  rebuild(): Promise<number>;
  audit(opts?: { since?: string }): Promise<MemoryEvent[]>;
  rollback(eventId: string): Promise<RollbackResult>;
  // C4 one-gesture correction: needle = a memory path (memory/….md) or free text resolved via search.
  forget(needle: string, opts?: { actor?: string; yes?: boolean; reason?: string }): Promise<ForgetOutcome>;
  remember(needle: string, opts?: { actor?: string }): Promise<RememberOutcome>;
  forgotten(): Promise<Array<{ path: string; snippet: string }>>;
};

function excerpt(content: string, max = 300): string {
  const compact = content.replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max - 3)}...` : compact;
}

export async function openCore(options: WorkspaceOptions = {}): Promise<MemoryCore> {
  const workspace = await ensureWorkspace(resolveWorkspace(options));
  const engineConfig = resolveEngineConfig(options);

  return {
    workspace,
    async search(query, opts = {}) {
      if (typeof query !== 'string' || !query.trim()) return [];
      const hits = (await searchWithEngineFallback(workspace, engineConfig, query, opts)).hits;
      // C4: forgotten entries stop surfacing HERE — the one chokepoint recall (hook), CLI search, MCP
      // memory.search and HTTP all flow through. Explicit includeForgotten (the forget/remember flows
      // themselves) opts out; the filter degrades OPEN on an unreadable event log (see forget.ts).
      if (opts.includeForgotten === true) return hits;
      return await filterForgotten(workspace, hits);
    },
    async read(ref) {
      const result = await readMemoryFile(workspace, ref);
      // snippet is a PREVIEW — skip frontmatter and the engine's "# Candidate <uuid>" heading so it
      // opens on content, not metadata (content itself stays raw: it IS the file)
      const snippet = excerpt(
        result.content
          .replace(/^﻿?\s*---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
          .replace(/^\s*#\s*Candidate\s+[0-9a-f][0-9a-f-]{6,}\s*\r?\n/gim, ''),
      );
      return {
        path: result.path,
        content: result.content,
        snippet,
        source: 'markdown',
        citation: {
          path: result.path,
          snippet,
        },
      };
    },
    async write_candidate(payload) {
      const result = await writeCandidate(workspace, payload);
      // Auto-promote (default ON): the engine floor decides the yellow sub-tier.
      // Clean content is durable immediately; flagged/unverified entries stay out
      // of default recall, while secrets and falsified anchors remain hard rejects.
      let autoPromote: WriteCandidateResult['autoPromote'];
      // Global kill switch: IHOW_AUTO_PROMOTE=0 forces every write to stay a candidate (full human gate),
      // for deployments that want zero machine-judged durable writes. The engine floor (engine-verified
      // provenance, not agent self-judgment) gates the rest.
      if (payload.autoPromote !== false && process.env.IHOW_AUTO_PROMOTE !== '0') {
        const verdict = evaluateAutoPromote(payload, { cwd: process.cwd() });
        if (verdict.allow) {
          const promoted = await promoteCandidate(workspace, result.path, {}, {
            actor: 'agent-auto',
            auto: true,
            tier: verdict.tier,
            flagReason: verdict.tier === 'flagged' ? verdict.reason : undefined,
            provenanceKind: verdict.tier === 'verified' ? verdict.provenanceKind : undefined,
            provenance: payload.metadata,
          });
          autoPromote = { promoted: true, path: promoted.path, eventId: promoted.eventId, tier: verdict.tier, reason: verdict.reason };
        } else {
          autoPromote = { promoted: false, reason: verdict.reason, category: verdict.category };
        }
      }
      await indexWithEngineFallback(workspace, engineConfig);
      // When auto-promoted, the candidate file has been moved — reflect the durable state so a
      // caller that does the classic write→promote(result.path) two-step doesn't hit ENOENT.
      if (autoPromote?.promoted) {
        return { ...result, status: 'promoted', path: autoPromote.path, autoPromote };
      }
      return autoPromote ? { ...result, autoPromote } : result;
    },
    async journal(payload) {
      const result = await appendJournal(workspace, payload);
      await indexWithEngineFallback(workspace, engineConfig);
      return result;
    },
    async promote(candidate, target = {}) {
      const result = await promoteCandidate(workspace, candidate, target);
      await indexWithEngineFallback(workspace, engineConfig);
      return result;
    },
    async durable_promote(candidate, promoteOptions) {
      const result = await durablePromoteCandidate(workspace, candidate, promoteOptions);
      if (result.status === 'promoted') await indexWithEngineFallback(workspace, engineConfig);
      return result;
    },
    async status() {
      const exists = fs.existsSync(workspace.indexPath);
      const documents = await countIndexedDocuments(workspace);
      const providerStatus = await engineStatus(workspace, engineConfig);
      // Honest capability gate: semantic is ON only when a semantic provider is BOTH the active engine
      // AND ready (not a fallback to FTS). The default binary, or an unreachable sidecar, reports false.
      const p = providerStatus.provider;
      const semanticActive = p.id === 'vector-gguf' && p.ready === true && p.fallback !== true;
      return {
        ok: true,
        workspace: {
          root: workspace.root,
          space: workspace.space,
          path: workspace.spaceDir,
          mode: workspace.mode,
          memoryRoot: workspace.memoryDir,
        },
        index: {
          path: workspace.indexPath,
          manifestPath: workspace.indexManifestPath,
          providerId: providerStatus.provider.id,
          status: exists ? 'ready' : 'missing',
          documents,
          lastError: providerStatus.manifestLastError,
        },
        provider: providerStatus.provider,
        capabilities: {
          lexical: true,
          semantic: semanticActive,
        },
        sync: {
          enabled: false,
        },
      };
    },
    async rebuild() {
      return await indexWithEngineFallback(workspace, engineConfig);
    },
    async audit(opts = {}) {
      // Surface BOTH the main lane and the MCP auto-capture (_mcp) lane so `audit` from the project
      // cwd shows auto-captured events (and their ids for rollback). See readEventsAllLanes.
      return await readEventsAllLanes(workspace, opts);
    },
    async rollback(eventId) {
      let result: RollbackResult;
      try {
        result = await rollbackEvent(workspace, eventId);
      } catch (caught) {
        // Auto-captured entries live in the _mcp lane; if the id isn't on the main lane, retry there
        // (managed store only — an existing-memory-root workspace already targets the _mcp lane).
        if (workspace.mode === 'managed-space' && caught instanceof Error && caught.message === 'rollback_event_not_found') {
          // Auto-captured ids live on the _mcp lane; retry there (the same lane the MCP server writes to).
          result = await rollbackEvent(mcpLaneWorkspace(workspace), eventId);
        } else {
          throw caught;
        }
      }
      if (result.removed) await indexWithEngineFallback(workspace, engineConfig);
      return result;
    },
    // C4 — one gesture, two entry shapes: an exact memory path applies directly; free text resolves via
    // search and applies ONLY on an unambiguous single match (multiple matches come back for the caller
    // to disambiguate — never guess which memory to silence). Resolution searches WITHOUT the forgotten
    // filter so `remember` can find what `forget` hid.
    async forget(needle, opts = {}) {
      const n = typeof needle === 'string' ? needle.trim() : '';
      if (!n) return { status: 'no-match' };
      if (/^memory\/.+\.md$/.test(n)) return await forgetPath(workspace, n, opts);
      // Uniqueness must be PROVEN, never window-shaped (red-team BLOCK 2026-07-02): the tombstone filter
      // runs AFTER the search cap, so a shallow window can hide a second LIVE match behind already-
      // forgotten hits (6 matches, 4 forgotten, limit-5 window → false "unique" → wrong tombstone).
      // Search deep; and if the raw window comes back FULL, uniqueness is unprovable → conservative
      // ambiguous (list what we saw, apply nothing) even when exactly one live match is visible.
      const FORGET_RESOLVE_LIMIT = 25;
      const hits = (await searchWithEngineFallback(workspace, engineConfig, n, { limit: FORGET_RESOLVE_LIMIT })).hits;
      const live = await filterForgotten(workspace, hits); // only things that still surface can be forgotten
      if (!live.length) return { status: 'no-match' };
      if (live.length > 1 || hits.length >= FORGET_RESOLVE_LIMIT) {
        return { status: 'ambiguous', matches: live.slice(0, 10).map((h) => ({ path: String(h.path), snippet: String(h.snippet ?? '') })) };
      }
      return await forgetPath(workspace, String(live[0].path), opts);
    },
    async remember(needle, opts = {}) {
      const n = typeof needle === 'string' ? needle.trim() : '';
      if (/^memory\/.+\.md$/.test(n)) return await rememberPath(workspace, n, opts);
      // free text: match against the FORGOTTEN list (path or snippet substring, case-insensitive)
      const gone = await listForgotten(workspace);
      const needleLc = n.toLowerCase();
      const matches = n ? gone.filter((g) => g.path.toLowerCase().includes(needleLc) || g.snippet.toLowerCase().includes(needleLc)) : [];
      if (!matches.length) return { status: 'not-forgotten' };
      if (matches.length > 1) return { status: 'ambiguous', matches };
      return await rememberPath(workspace, matches[0].path, opts);
    },
    async forgotten() {
      return await listForgotten(workspace);
    },
  };
}
