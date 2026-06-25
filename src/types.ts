// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
export type JsonRecord = Record<string, unknown>;

export type WorkspaceOptions = {
  cwd?: string;
  root?: string;
  space?: string;
  memoryRoot?: string;
  stateRoot?: string;
  engine?: string;
  vectorProviderCommand?: string;
  vectorModel?: string;
  vectorTimeoutMs?: number;
};

export type Workspace = {
  mode: 'managed-space' | 'existing-memory-root';
  root: string;
  space: string;
  spaceDir: string;
  memoryDir: string;
  mcpDir: string;
  candidatesDir: string;
  promotedDir: string;
  eventsDir: string;
  historyDir: string;
  journalDir: string;
  indexPath: string;
  indexManifestPath: string;
  lockPath: string;
};

export type Citation = {
  path: string;
  snippet: string;
};

export type SearchResult = {
  path: string;
  snippet: string;
  score: number;
  source: string;
  citation: Citation;
  fallback?: {
    from: string;
    to: string;
    reason: string;
  };
};

export type SearchOptions = {
  limit?: number;
  rebuild?: boolean;
};

export type RetrievalEngineStatus = {
  id: string;
  model: string | null;
  ready: boolean;
  cloud: boolean;
  lastError?: string;
};

export type RetrievalEngine = {
  id: string;
  capabilities: {
    lexical?: boolean;
    semantic?: boolean;
  };
  index(workspace: Workspace): Promise<{ indexed: number }>;
  search(workspace: Workspace, query: string, opts?: SearchOptions): Promise<SearchResult[]>;
  status(workspace: Workspace): Promise<RetrievalEngineStatus>;
};

export type ReadResult = {
  path: string;
  content: string;
  snippet: string;
  source: 'markdown';
  citation: Citation;
};

export type WriteCandidatePayload = {
  text?: string;
  content?: string;
  title?: string;
  sourceAgent?: string;
  source?: string;
  metadata?: JsonRecord;
  // When true (the default), the engine evaluates the candidate against the
  // auto-promote floor and promotes it automatically if it qualifies. Set false
  // to only stage a candidate. High-risk content never auto-promotes regardless.
  autoPromote?: boolean;
};

// Outcome of the engine's auto-promote evaluation, attached to write_candidate.
export type AutoPromoteOutcome =
  | { promoted: true; path: string; eventId: string; tier: 'auto-promoted' }
  | { promoted: false; reason: string; category: 'secret' | 'governance' | 'no-provenance' | 'conflict' };

export type WriteCandidateResult = {
  candidateId: string;
  path: string;
  // 'promoted' when the engine auto-promoted on write — `path` then points at the durable file,
  // not the (now-moved) candidate. Callers doing a manual second promote must check this.
  status: 'candidate' | 'promoted';
  autoPromote?: AutoPromoteOutcome;
};

export type JournalPayload = {
  text?: string;
  content?: string;
  title?: string;
  sourceAgent?: string;
  source?: string;
};

export type JournalResult = {
  path: string;
  status: 'journaled';
  eventId: string;
  day: string;
};

export type PromoteTarget = {
  scope?: string;
  path?: string;
  title?: string;
};

export type PromoteResult = {
  candidateId: string;
  path: string;
  status: 'promoted';
  eventId: string;
};

export type DurablePromoteOptions = {
  dryRun?: boolean;
  realWrite?: boolean;
  actor?: string;
  target?: PromoteTarget;
};

export type DurablePromoteResult = {
  candidateId: string;
  status: 'dry-run' | 'promoted';
  dryRun: boolean;
  eventId?: string;
  path?: string;
  archivedCandidatePath?: string;
  plan: {
    candidatePath: string;
    targetPath: string;
    targetAbsolutePath: string;
    operation: 'append';
    appendContent: string;
    archiveCandidateTo: string;
    auditEventPath: string;
    auditEvent: {
      id: string;
      type: 'memory.promoted.durable';
      at: string;
      actor: string;
      candidatePath: string;
      targetPath: string;
      metadata: JsonRecord;
    };
    writeGuards: string[];
  };
  proof: {
    explicitDurableTrigger: true;
    sourceCandidateInboxOnly: true;
    protectedCoreBlocked: true;
    targetWhitelistEnforced: true;
    redactCheck: 'passed';
    dryRunNoWrites: boolean;
  };
};

export type CoreStatus = {
  ok: boolean;
  workspace: {
    root: string;
    space: string;
    path: string;
    mode: Workspace['mode'];
    memoryRoot: string;
  };
  index: {
    path: string;
    manifestPath: string;
    providerId: string;
    status: 'ready' | 'missing' | 'stale';
    documents: number;
    lastError?: string;
  };
  provider: RetrievalEngineStatus & {
    fallback?: boolean;
    fallbackFrom?: string;
    requested?: RetrievalEngineStatus;
  };
  sync: {
    enabled: false;
  };
};
