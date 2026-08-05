// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// `memory.context_probe` is the no-hook runtime automation trigger layer. It may diagnose, recall a
// verify-first handoff packet, and request a cooperative journal, but it does not auto-write floor
// journals for runtimes without a reliable transcript source.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { SearchOptions, SearchResult, Workspace } from './types.ts';
import { appendEvent, readEventsAllLanes, type MemoryEvent } from './store/events.ts';
import { buildHandoffPacket, type HandoffPacket } from './handoff.ts';
import { searchWithEngineFallback, resolveEngineConfig } from './engine/retrieval.ts';
import {
  PROMPT_RECALL_INCLUDE_LIMIT,
  PROMPT_RECALL_MAX_CHARS,
  PROMPT_RECALL_SEARCH_LIMIT,
  renderPromptRecall,
  selectPromptRecall,
} from './prompt-recall.ts';
import {
  appendActivationEvidenceFailOpen,
  type ActivationEvidenceEvent,
} from './activation-ledger.ts';

export type ContextProbeInput = {
  cwd: string;
  runtime?: string;
  sessionHint?: string;
  promptDigest?: string;
  eventHint: 'session_start' | 'prompt' | 'session_end' | 'tick';
};

export type ContextProbeOutput = {
  event: 'session_start' | 'prompt_recall' | 'session_end' | 'floor_capture' | 'tick';
  verdict: 'GREEN' | 'YELLOW' | 'RED' | 'NONE';
  injectText?: string;
  action: 'verify_anchors' | 'journal' | 'floor_journaled' | 'none';
  auditEventId?: string;
  citations?: string[];
  diagnostics?: {
    staleMarker?: boolean;
    overrideReason?: string;
    transcriptSource?: 'claude' | 'codex' | 'none';
    autoWriteAllowed?: boolean;
  };
};

type ProbeMarker = {
  updatedAt: string;
  cwdHash: string;
  runtime: string;
  sessionHint?: string;
  eventHint: ContextProbeInput['eventHint'];
};

export type ProbeMetrics = {
  probeCallsByRuntime: Record<string, number>;
  journalSuggestionsByRuntime: Record<string, number>;
  floorCaptureSources: Record<string, number>;
  cooperativeJournalCount: number;
  probeToJournalConversionRate: number | null;
};

const STALE_MARKER_MS = 30 * 60 * 1000;
const NO_HOOK_RUNTIMES = new Set(['workbuddy', 'opencode', 'gemini', 'unknown']);

function normalizedRuntime(runtime: unknown): string {
  const r = typeof runtime === 'string' && runtime.trim() ? runtime.trim().toLowerCase() : 'unknown';
  return r.replace(/\s+/g, '-');
}

function transcriptSource(runtime: string): 'claude' | 'codex' | 'none' {
  if (runtime === 'claude-code') return 'claude';
  if (runtime === 'codex') return 'codex';
  return 'none';
}

function markerPath(workspace: Workspace): string {
  return path.join(workspace.mcpDir, 'context-probe-marker.json');
}

function sha(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

async function readMarker(workspace: Workspace): Promise<ProbeMarker | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(markerPath(workspace), 'utf8')) as ProbeMarker;
    return parsed && typeof parsed.updatedAt === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function writeMarker(workspace: Workspace, marker: ProbeMarker): Promise<void> {
  await fs.mkdir(workspace.mcpDir, { recursive: true });
  await fs.writeFile(markerPath(workspace), `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
}

function markerIsStale(marker: ProbeMarker | undefined, now: number): boolean {
  if (!marker) return false;
  const at = Date.parse(marker.updatedAt);
  return Number.isFinite(at) && now - at > STALE_MARKER_MS;
}

function handoffVerdict(packet: HandoffPacket): ContextProbeOutput['verdict'] {
  const v = packet.candidates[0]?.verdict?.state;
  return v === 'GREEN' || v === 'YELLOW' || v === 'RED' ? v : 'NONE';
}

function handoffCitations(packet: HandoffPacket): string[] {
  return packet.candidates.slice(0, 3).map((c) => `${c.narrative.source}:${c.narrative.sessionId}`);
}

export type ContextProbeRecallRuntime = {
  search?: (query: string, options?: SearchOptions) => Promise<SearchResult[]>;
  semanticFloor?: number | null;
};

async function promptRecall(
  workspace: Workspace,
  promptDigest?: string,
  recallRuntime: ContextProbeRecallRuntime = {},
): Promise<{ injectText?: string; citations: string[]; count: number; reason?: string }> {
  const query = typeof promptDigest === 'string' ? promptDigest.trim() : '';
  if (!query) return { citations: [], count: 0, reason: 'empty promptDigest; no recall attempted' };
  const searchOptions = { limit: PROMPT_RECALL_SEARCH_LIMIT, includeFlagged: true };
  const hits = recallRuntime.search
    ? await recallRuntime.search(query, searchOptions)
    : (await searchWithEngineFallback(workspace, resolveEngineConfig(), query, searchOptions)).hits;
  const selection = await selectPromptRecall(workspace, query, hits, {
    searchLimit: PROMPT_RECALL_SEARCH_LIMIT,
    includeLimit: PROMPT_RECALL_INCLUDE_LIMIT,
    maxChars: PROMPT_RECALL_MAX_CHARS,
    semanticFloor: recallRuntime.semanticFloor ?? null,
  });
  const injectText = renderPromptRecall(selection);
  const relevanceMode = selection.policy.semanticEligibility === 'measured-floor'
    ? 'shared prompt-recall selector; measured semantic floor + lexical fallback'
    : 'shared prompt-recall selector; lexical-only relevance';
  const reason = selection.included.length
    ? relevanceMode
    : `no eligible prompt recall; ${relevanceMode}${selection.excluded.reasons.length ? ` (${selection.excluded.reasons.map((item) => `${item.reason}=${item.count}`).join(', ')})` : ''}`;
  return {
    injectText,
    citations: selection.included.map((item) => item.path),
    count: selection.included.length,
    reason,
  };
}

async function recordProbeEvent(
  workspace: Workspace,
  input: ContextProbeInput,
  output: ContextProbeOutput,
  runtime: string,
): Promise<MemoryEvent> {
  return await appendEvent(workspace, {
    type: 'memory.context_probe',
    actor: `context-probe:${runtime}`,
    metadata: {
      runtime,
      eventHint: input.eventHint,
      event: output.event,
      action: output.action,
      verdict: output.verdict,
      cwdHash: sha(input.cwd || ''),
      sessionHint: input.sessionHint ? sha(input.sessionHint) : undefined,
      promptDigestHash: input.promptDigest ? sha(input.promptDigest) : undefined,
      staleMarker: output.diagnostics?.staleMarker === true,
      transcriptSource: output.diagnostics?.transcriptSource || 'none',
      autoWriteAllowed: output.diagnostics?.autoWriteAllowed === true,
    },
  });
}

async function contextProbeInner(
  workspace: Workspace,
  input: ContextProbeInput,
  recallRuntime: ContextProbeRecallRuntime = {},
): Promise<ContextProbeOutput> {
  if (!input || typeof input !== 'object') throw new Error('context_probe_input_required');
  if (!['session_start', 'prompt', 'session_end', 'tick'].includes(input.eventHint)) throw new Error('context_probe_event_hint_required');
  if (typeof input.cwd !== 'string' || !input.cwd.trim()) throw new Error('context_probe_cwd_required');

  const runtime = normalizedRuntime(input.runtime);
  const source = transcriptSource(runtime);
  const now = Date.now();
  const previousMarker = await readMarker(workspace);
  const staleMarker = input.eventHint === 'session_start' && markerIsStale(previousMarker, now);
  let output: ContextProbeOutput;

  if (input.eventHint === 'session_start') {
    const packet = await buildHandoffPacket({ cwd: input.cwd, limit: 3, excludeSessionId: input.sessionHint });
    const verdict = staleMarker ? 'YELLOW' : handoffVerdict(packet);
    const staleNote = 'Previous context_probe marker is stale. No summary was fabricated; verify live project state and anchors before continuing.';
    output = {
      event: 'session_start',
      verdict,
      action: staleMarker || packet.candidates.length ? 'verify_anchors' : 'none',
      injectText: packet.candidates.length
        ? `${staleMarker ? `${staleNote}\n\n` : ''}${JSON.stringify(packet, null, 2)}`
        : staleMarker
          ? staleNote
          : 'No prior resumable session found.',
      citations: handoffCitations(packet),
      diagnostics: {
        staleMarker,
        transcriptSource: source,
        autoWriteAllowed: false,
        overrideReason: staleMarker ? 'stale marker detected; no automatic journal was written' : undefined,
      },
    };
  } else if (input.eventHint === 'prompt') {
    const recall = await promptRecall(workspace, input.promptDigest, recallRuntime);
    output = {
      event: 'prompt_recall',
      verdict: recall.count > 0 ? 'GREEN' : 'NONE',
      action: 'none',
      injectText: recall.injectText,
      citations: recall.citations,
      diagnostics: {
        staleMarker: false,
        transcriptSource: source,
        autoWriteAllowed: false,
        overrideReason: recall.reason,
      },
    };
  } else if (input.eventHint === 'session_end') {
    const noHook = NO_HOOK_RUNTIMES.has(runtime) || source === 'none';
    output = {
      event: 'session_end',
      verdict: 'NONE',
      action: noHook ? 'journal' : 'none',
      diagnostics: {
        staleMarker: false,
        transcriptSource: source,
        autoWriteAllowed: false,
        overrideReason: noHook
          ? 'no reliable transcript source; call memory.journal explicitly with a brief handoff'
          : 'context_probe does not auto-write floor journals in alpha.22 MVI',
      },
    };
  } else {
    output = {
      event: 'tick',
      verdict: 'NONE',
      action: 'none',
      diagnostics: {
        staleMarker: false,
        transcriptSource: source,
        autoWriteAllowed: false,
      },
    };
  }

  if (NO_HOOK_RUNTIMES.has(runtime) && output.action === 'floor_journaled') {
    throw new Error('context_probe_no_hook_floor_forbidden');
  }
  const audit = await recordProbeEvent(workspace, input, output, runtime);
  output.auditEventId = audit.id;
  await writeMarker(workspace, {
    updatedAt: new Date(now).toISOString(),
    cwdHash: sha(input.cwd),
    runtime,
    sessionHint: input.sessionHint ? sha(input.sessionHint) : undefined,
    eventHint: input.eventHint,
  });
  return output;
}

function probeActivationEvent(eventHint: ContextProbeInput['eventHint'] | undefined): ActivationEvidenceEvent {
  if (eventHint === 'session_start') return 'context-probe-session-start';
  if (eventHint === 'prompt') return 'context-probe-prompt';
  if (eventHint === 'session_end') return 'context-probe-session-end';
  return 'context-probe-tick';
}

export async function contextProbe(
  workspace: Workspace,
  input: ContextProbeInput,
  recallRuntime: ContextProbeRecallRuntime = {},
): Promise<ContextProbeOutput> {
  const runtime = normalizedRuntime(input?.runtime);
  const event = probeActivationEvent(input?.eventHint);
  const validHostProbe = !!input && typeof input === 'object' &&
    typeof input.cwd === 'string' && input.cwd.trim().length > 0 &&
    ['session_start', 'prompt', 'session_end', 'tick'].includes(input.eventHint);
  try {
    const output = await contextProbeInner(workspace, input, recallRuntime);
    await appendActivationEvidenceFailOpen(workspace, {
      runtime,
      event,
      source: 'context-probe',
      status: 'synthetic',
      dedupeKey: output.auditEventId ?? crypto.randomUUID(),
    });
    return output;
  } catch (error) {
    // Caller/schema errors are not runtime health evidence. Only a well-formed host probe that failed
    // during execution may influence recent-health diagnostics.
    if (validHostProbe) {
      await appendActivationEvidenceFailOpen(workspace, {
        runtime,
        event,
        source: 'context-probe',
        status: 'failed',
        dedupeKey: crypto.randomUUID(),
      });
    }
    throw error;
  }
}

export function deriveProbeMetrics(events: MemoryEvent[]): ProbeMetrics {
  const probeCallsByRuntime: Record<string, number> = {};
  const journalSuggestionsByRuntime: Record<string, number> = {};
  const floorCaptureSources: Record<string, number> = {};
  let cooperativeJournalCount = 0;
  let journalSuggestions = 0;
  for (const event of events) {
    const meta = event.metadata ?? {};
    if (event.type === 'memory.context_probe') {
      const runtime = normalizedRuntime(meta.runtime);
      probeCallsByRuntime[runtime] = (probeCallsByRuntime[runtime] ?? 0) + 1;
      if (meta.action === 'journal') {
        journalSuggestionsByRuntime[runtime] = (journalSuggestionsByRuntime[runtime] ?? 0) + 1;
        journalSuggestions += 1;
      }
    } else if (event.type === 'memory.journal.appended') {
      if (meta.floor === true) {
        const source = typeof meta.floorRuntime === 'string' ? meta.floorRuntime : 'unknown';
        floorCaptureSources[source] = (floorCaptureSources[source] ?? 0) + 1;
      } else {
        cooperativeJournalCount += 1;
      }
    }
  }
  return {
    probeCallsByRuntime,
    journalSuggestionsByRuntime,
    floorCaptureSources,
    cooperativeJournalCount,
    probeToJournalConversionRate: journalSuggestions > 0 ? cooperativeJournalCount / journalSuggestions : null,
  };
}

export async function probeMetrics(workspace: Workspace): Promise<ProbeMetrics> {
  return deriveProbeMetrics(await readEventsAllLanes(workspace));
}
