// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Cross-runtime deterministic capture floor (automation v2.1). The Claude-Code floor lives in the
// SessionStart hook (cli.ts runSessionStartHook): it is marker-driven and fires only for Claude Code.
// THIS is its runtime-neutral sibling — a sweep ANY MCP-server startup can fire to floor recent
// un-journaled sessions from EVERY runtime the engine can already read (Codex, Hermes, OpenCode,
// WorkBuddy, OpenClaw). It exists because `connect --runtime codex|hermes|...` installs the MCP server
// but NO capture hook, so those runtimes capture only when the agent self-invokes memory.journal /
// write_candidate — exactly the gap real test users hit ("iHow Memory doesn't auto-record; I have to
// remind the agent").
//
// SAFETY PROPERTIES (kept in lockstep with the Claude floor + the OpenClaw automation-v2 sign-off):
//   - WRITES ONLY the low-weight journal lane — never auto-recalled, excluded from default search; a
//     floor entry can never pollute authoritative retrieval.
//   - REDACTED at the source: listResumableSessions returns bodies already run through
//     redactSecretLikeContent; appendFloorJournalOnce then hard-rejects any residual secret-like content.
//   - IDEMPOTENT by a COMPOSITE (runtime, sessionId) key, enforced INSIDE the workspace lock by
//     appendFloorJournalOnce — so two MCP servers sweeping the same memory-root concurrently cannot both
//     write the same session. The pre-filter here is only a cheap optimization; the writer is the guarantee.
//   - SELF-EXCLUDES the live session by a generous idle threshold (FLOOR_IDLE_MS): an actively-writing
//     session bumps its transcript mtime within the window and is skipped. (The MCP server is not told the
//     runtime's session id, so the idle gate, not an excludeSessionId, is the real guard.) An ENDED session
//     is idle forever and is captured on a later sweep, so a long threshold only delays an ended session's
//     capture — it never drops it. KNOWN v1 BOUND: a session paused longer than the threshold and THEN
//     resumed is floored at its partial pre-pause state, and the composite (runtime, sessionId) dedup
//     then suppresses a re-floor of the post-pause work — partial capture, still strictly better than the
//     zero capture these hookless runtimes had before. A content-supersede pass is left for v2.
//   - DOES NOT dedup against the agent's own cooperative journals. Cooperative journals carry no
//     session id, so any attribution would be a coarse time-window guess that, in a busy multi-runtime
//     workspace, SUPPRESSES real captures (the opposite of this floor's purpose). A cooperatively-
//     journaled session may therefore also get one low-weight floor entry — a bounded, harmless dup (both
//     low-weight, the floor one tagged `${tool}-floor`, idempotent so it never repeats). Precise
//     cooperative dedup needs a session id on the journal tool — a separate v2.
//   - BOUNDED + best-effort + NEVER THROWS: capped per sweep, swallows every error, returns a summary.

import type { Workspace } from './types.ts';
import { gitAnchors } from './anchors.ts';
import {
  checkpointDraftFinalizationPrecondition,
  createCheckpointService,
  locateCheckpointDrafts,
  resolveCheckpointProjectIdentity,
  type CheckpointMachineAnchorProvider,
} from './checkpoints.ts';
import { listResumableSessions } from './handoff.ts';
import { appendFloorJournalOnce } from './governance.ts';
import { readEventsAllLanes } from './store/events.ts';

// A session must be idle at least this long before it is eligible. Generous on purpose: the gate's ONLY
// job is to avoid flooring a still-live session (whose transcript keeps getting touched), and an ended
// session stays idle forever so it is still captured on a later sweep. 30 min comfortably exceeds a
// normal interactive pause (reading a diff, a build, thinking) and absorbs plausible cross-process clock
// skew between the MCP host and a runtime that timestamps its own transcript.
const FLOOR_IDLE_MS = 30 * 60 * 1000;
// Only floor sessions seen within this window — an old backlog is not worth auto-capturing on startup.
const FLOOR_LOOKBACK_MS = 48 * 60 * 60 * 1000;
// Cap entries written per sweep so a large backlog can never make server startup slow or write a burst.
const FLOOR_MAX_PER_SWEEP = 5;
const FLOOR_TITLE = 'auto-capture (deterministic, cross-runtime)';
// Runtimes this sweep covers — EVERY engine-readable runtime EXCEPT claude-code, which keeps its own
// marker-driven SessionStart floor (covering it here too would double-write across two idempotency stores).
const SWEEP_RUNTIMES = new Set(['codex', 'hermes', 'workbuddy', 'opencode', 'openclaw']);

export type FloorSweepOutcome =
  | 'journaled'
  | 'skipped-already-floored'
  | 'skipped-too-fresh'
  | 'skipped-empty'
  | 'skipped-no-session-id'
  | 'error';

export type FloorSweepResult = {
  scanned: number;
  journaled: number;
  outcomes: Array<{ tool: string; sessionId: string; outcome: FloorSweepOutcome; eventId?: string }>;
  checkpointed: number;
  checkpointOutcomes: CheckpointFloorSweepOutcome[];
};

export type CheckpointFloorSweepOutcome = {
  tool: string;
  outcome: 'checkpointed-partial' | 'skipped-checkpoint-fresh' | 'checkpoint-error';
  artifactId?: string;
  reasonCode?: string;
};

export type FloorSweepOptions = {
  now: number; // injected for determinism in tests; the caller stamps Date.now()
  reindex?: () => Promise<unknown>; // best-effort: make the new entries searchable after the sweep
  idleMs?: number;
  lookbackMs?: number;
  maxPerSweep?: number;
  checkpointStaleMs?: number;
  checkpointAnchorProvider?: (projectDir: string) => ReturnType<CheckpointMachineAnchorProvider>; // controlled override; defaults to live git anchors
  runtimes?: Set<string>;
  excludeSessionId?: string; // optional; the idle gate is the primary self-exclude
};

// Composite idempotency key — sessionId alone is NOT globally unique across runtimes.
function floorKey(runtime: string, sessionId: string): string {
  return `${runtime}::${sessionId}`;
}

function checkpointFloorFailureCode(error: unknown): string {
  if (error instanceof Error && /^checkpoint_[a-z0-9_]+$/.test(error.message)) return error.message;
  return 'checkpoint_internal_failure';
}

function checkpointFloorAnchors(projectDir: string): {
  git?: { repo: string; branch?: string; head?: string; dirty?: boolean };
  files: [];
  commands: [];
} {
  const live = gitAnchors(projectDir);
  return {
    ...(live.isRepo && live.repo
      ? {
          git: {
            repo: live.repo,
            ...(live.branch ? { branch: live.branch } : {}),
            ...(live.head ? { head: live.head } : {}),
            dirty: (live.dirtyCount ?? 0) > 0,
          },
        }
      : {}),
    files: [],
    commands: [],
  };
}

async function finalizeStaleCheckpointDraft(
  workspace: Workspace,
  session: Awaited<ReturnType<typeof listResumableSessions>>[number],
  now: number,
  staleMs: number,
  checkpointAnchorProvider: FloorSweepOptions['checkpointAnchorProvider'],
): Promise<CheckpointFloorSweepOutcome | undefined> {
  if (!session.projectDir) return undefined;
  try {
    const options = { cwd: session.projectDir };
    const project = await resolveCheckpointProjectIdentity(options, workspace);
    const located = await locateCheckpointDrafts(
      workspace,
      project,
      session.tool,
      session.sessionId,
    );
    if (located.completeness === 'unknown') {
      return { tool: session.tool, outcome: 'checkpoint-error', reasonCode: located.reasonCode };
    }
    if (!located.open) return undefined;
    const updatedAt = Date.parse(located.open.updatedAt);
    if (!Number.isFinite(updatedAt)) {
      return { tool: session.tool, outcome: 'checkpoint-error', reasonCode: 'checkpoint_draft_schema_invalid' };
    }
    if (now - updatedAt < staleMs) {
      return { tool: session.tool, outcome: 'skipped-checkpoint-fresh' };
    }

    const checkpoints = await createCheckpointService(workspace, options);
    const supersedes = located.recentFinalized?.finalization?.artifactId;
    const precondition = checkpointDraftFinalizationPrecondition(located.open);
    const finalized = await checkpoints.finalizeDraft(located.open.draftId, {
      trigger: {
        kind: 'crash_floor',
        signal: 'shadow',
        sourceEvent: 'capture-floor-sweep',
        reasonCode: 'stale_checkpoint_draft',
      },
      ...(supersedes ? { supersedes } : {}),
    }, async () => checkpointAnchorProvider
      ? await checkpointAnchorProvider(session.projectDir as string)
      : checkpointFloorAnchors(session.projectDir as string), precondition);
    return {
      tool: session.tool,
      outcome: 'checkpointed-partial',
      artifactId: finalized.artifact.id,
    };
  } catch (error) {
    const reasonCode = checkpointFloorFailureCode(error);
    if (reasonCode === 'checkpoint_draft_precondition_failed') {
      return {
        tool: session.tool,
        outcome: 'skipped-checkpoint-fresh',
        reasonCode,
      };
    }
    return {
      tool: session.tool,
      outcome: 'checkpoint-error',
      reasonCode,
    };
  }
}

// Read the audit log once and derive the set of (runtime, sessionId) keys we have ALREADY floored. This
// is a cheap PRE-FILTER (skip obvious work); the authoritative dedup is inside appendFloorJournalOnce,
// under the lock. Tolerant: an unreadable audit log yields an empty set (we may attempt a write that the
// under-lock check then no-ops, never a crash).
async function readFlooredKeys(workspace: Workspace): Promise<Set<string>> {
  const keys = new Set<string>();
  let events: Awaited<ReturnType<typeof readEventsAllLanes>> = [];
  try {
    events = await readEventsAllLanes(workspace);
  } catch {
    return keys;
  }
  for (const event of events) {
    if (event.type !== 'memory.journal.appended') continue;
    const meta = (event.metadata ?? {}) as { floor?: unknown; sessionId?: unknown; floorRuntime?: unknown };
    if (meta.floor === true && typeof meta.sessionId === 'string' && meta.sessionId && typeof meta.floorRuntime === 'string' && meta.floorRuntime) {
      keys.add(floorKey(meta.floorRuntime, meta.sessionId));
    }
  }
  return keys;
}

// Sweep recent, idle, un-captured sessions from non-Claude runtimes and write one low-weight, redacted
// journal entry per session. Idempotent, bounded, never throws. Returns a summary for observability/tests.
export async function runCaptureFloorSweep(
  workspace: Workspace,
  options: FloorSweepOptions,
): Promise<FloorSweepResult> {
  const now = options.now;
  const idleMs = options.idleMs ?? FLOOR_IDLE_MS;
  const lookbackMs = options.lookbackMs ?? FLOOR_LOOKBACK_MS;
  const maxPerSweep = options.maxPerSweep ?? FLOOR_MAX_PER_SWEEP;
  const checkpointStaleMs = options.checkpointStaleMs ?? idleMs;
  const runtimes = options.runtimes ?? SWEEP_RUNTIMES;
  const result: FloorSweepResult = {
    scanned: 0,
    journaled: 0,
    outcomes: [],
    checkpointed: 0,
    checkpointOutcomes: [],
  };

  const flooredKeys = await readFlooredKeys(workspace);

  // Over-fetch so the per-runtime / idle / dedup filters below still leave up to maxPerSweep to write.
  // skipAnchors prevents construction of handoff anchors. Stage 4 still resolves project identity for
  // the explicitly selected floor runtimes (Hermes needs a bounded git-root probe for tool workdirs),
  // because an exact project binding is required before any checkpoint draft can be finalized.
  let sessions: Awaited<ReturnType<typeof listResumableSessions>>;
  try {
    sessions = await listResumableSessions(maxPerSweep * 6 + 12, options.excludeSessionId, {
      skipAnchors: true,
      resolveProject: true,
      runtimes,
    });
  } catch {
    return result; // discovery failed — nothing to do, never crash
  }

  // Checkpoint crash floor runs before journal dedupe. A session may already have a low-weight floor
  // journal while a newer cooperative checkpoint draft is still open; the journal key must not freeze
  // that checkpoint lane forever. Discovery resolves only the project binding; full live checkpoint
  // anchors are read only after an exact, stale, valid draft has been found.
  for (const session of sessions) {
    if (result.checkpointed >= maxPerSweep) break;
    if (!runtimes.has(session.tool)) continue;
    const sessionId = typeof session.sessionId === 'string' ? session.sessionId.trim() : '';
    if (!sessionId) continue;
    if (options.excludeSessionId && sessionId === options.excludeSessionId) continue;
    const lastMs = Date.parse(session.modifiedAt);
    if (!Number.isFinite(lastMs)) continue;
    const ageMs = now - lastMs;
    if (ageMs < idleMs || ageMs > lookbackMs) continue;
    const outcome = await finalizeStaleCheckpointDraft(
      workspace,
      session,
      now,
      checkpointStaleMs,
      options.checkpointAnchorProvider,
    );
    if (!outcome) continue;
    result.checkpointOutcomes.push(outcome);
    if (outcome.outcome === 'checkpointed-partial') result.checkpointed += 1;
  }

  for (const session of sessions) {
    if (result.journaled >= maxPerSweep) break;
    if (!runtimes.has(session.tool)) continue;
    const sessionId = typeof session.sessionId === 'string' ? session.sessionId.trim() : '';
    if (!sessionId) {
      // No usable id => cannot be deduped, so flooring it would re-floor every sweep. Skip (dedup-5).
      result.outcomes.push({ tool: session.tool, sessionId: '', outcome: 'skipped-no-session-id' });
      continue;
    }
    if (options.excludeSessionId && sessionId === options.excludeSessionId) continue;
    if (flooredKeys.has(floorKey(session.tool, sessionId))) {
      result.outcomes.push({ tool: session.tool, sessionId, outcome: 'skipped-already-floored' });
      continue;
    }
    const lastMs = Date.parse(session.modifiedAt);
    if (Number.isNaN(lastMs)) continue;
    const ageMs = now - lastMs;
    if (ageMs < idleMs) {
      // Still active (or the live session, or future-dated under clock skew) — let a later sweep capture it.
      result.outcomes.push({ tool: session.tool, sessionId, outcome: 'skipped-too-fresh' });
      continue;
    }
    if (ageMs > lookbackMs) continue; // too old to be worth auto-capturing
    result.scanned += 1;
    const body = (session.body ?? '').trim(); // already redacted by listResumableSessions
    if (!body) {
      result.outcomes.push({ tool: session.tool, sessionId, outcome: 'skipped-empty' });
      continue;
    }
    try {
      const written = await appendFloorJournalOnce(workspace, {
        text: body,
        runtime: session.tool,
        sessionId,
        title: FLOOR_TITLE,
      });
      if (written.status === 'journaled') {
        result.journaled += 1;
        result.outcomes.push({ tool: session.tool, sessionId, outcome: 'journaled', eventId: written.eventId });
      } else {
        // The under-lock dedup caught a concurrent/duplicate write — counts as already-floored.
        result.outcomes.push({ tool: session.tool, sessionId, outcome: 'skipped-already-floored' });
      }
    } catch {
      // e.g. a residual hard-detector hit on already-redacted text — record it, never crash the sweep.
      result.outcomes.push({ tool: session.tool, sessionId, outcome: 'error' });
    }
  }

  if (result.journaled > 0 && options.reindex) {
    try {
      await options.reindex(); // make the new entries searchable; failure just defers to the next rebuild
    } catch {
      // indexing failure does not undo the journal entries — they land on the next index rebuild
    }
  }
  return result;
}
