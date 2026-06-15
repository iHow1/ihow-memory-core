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
  WriteCandidatePayload,
  WriteCandidateResult,
} from './types.ts';
import { ensureWorkspace, resolveWorkspace } from './workspace.ts';
import { readMemoryFile } from './store/files.ts';
import { appendJournal, durablePromoteCandidate, promoteCandidate, rollbackJournalEvent, writeCandidate } from './governance.ts';
import type { RollbackResult } from './governance.ts';
import { readEventsAllLanes, mcpLaneWorkspace } from './store/events.ts';
import type { MemoryEvent } from './store/events.ts';
import { countIndexedDocuments } from './engine/fts.ts';
import { engineStatus, indexWithEngineFallback, resolveEngineConfig, searchWithEngineFallback } from './engine/retrieval.ts';

export type MemoryCore = {
  workspace: Workspace;
  search(query: string, opts?: { limit?: number }): Promise<SearchResult[]>;
  read(ref: string): Promise<ReadResult>;
  write_candidate(payload: WriteCandidatePayload): Promise<WriteCandidateResult>;
  journal(payload: JournalPayload): Promise<JournalResult>;
  promote(candidate: string, target?: PromoteTarget): Promise<PromoteResult>;
  durable_promote(candidate: string, options: DurablePromoteOptions): Promise<DurablePromoteResult>;
  status(): Promise<CoreStatus>;
  rebuild(): Promise<number>;
  audit(opts?: { since?: string }): Promise<MemoryEvent[]>;
  rollback(eventId: string): Promise<RollbackResult>;
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
      return (await searchWithEngineFallback(workspace, engineConfig, query, { limit: opts.limit })).hits;
    },
    async read(ref) {
      const result = await readMemoryFile(workspace, ref);
      const snippet = excerpt(result.content);
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
      await indexWithEngineFallback(workspace, engineConfig);
      return result;
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
        result = await rollbackJournalEvent(workspace, eventId);
      } catch (caught) {
        // Auto-captured entries live in the _mcp lane; if the id isn't on the main lane, retry there
        // (managed store only — an existing-memory-root workspace already targets the _mcp lane).
        if (workspace.mode === 'managed-space' && caught instanceof Error && caught.message === 'rollback_event_not_found') {
          // Auto-captured ids live on the _mcp lane; retry there (the same lane the MCP server writes to).
          result = await rollbackJournalEvent(mcpLaneWorkspace(workspace), eventId);
        } else {
          throw caught;
        }
      }
      if (result.removed) await indexWithEngineFallback(workspace, engineConfig);
      return result;
    },
  };
}
