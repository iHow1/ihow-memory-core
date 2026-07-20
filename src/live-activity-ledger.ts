// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
// Metadata-only live activity ledger. It records observer state, never product verdicts or raw content.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Workspace } from './types.ts';
import { atomicWriteFile } from './store/files.ts';
import { withWorkspaceLock } from './store/lock.ts';

const HASH_RE = /^[a-f0-9]{64}$/;
const MAX_ACTIVITIES = 4096;
const MAX_REVISIONS_PER_ACTIVITY = 64;
const MIN_TTL_MS = 1_000;
const MAX_TTL_MS = 7 * 86_400_000;
const INPUT_KEYS = new Set([
  'activityKey', 'state', 'observedAt', 'ttlMs', 'expectedRevision', 'expectedTransitionHash', 'evidence', 'dedupeKey',
]);
const EVIDENCE_KEYS = new Set([
  'gitHeadSha256', 'processSha256', 'artifactSha256', 'fileTreeSha256', 'receiptSha256',
]);

export type LiveActivityState = 'RUNNING' | 'WAITING' | 'COMMITTED';
export type LiveActivityTransition = {
  schemaVersion: 1;
  activityId: string;
  state: LiveActivityState;
  revision: number;
  observedAt: string;
  receivedAt: string;
  expiresAt: string | null;
  freshness: 'CURRENT' | 'TERMINAL';
  productVerdict: 'NONE';
  evidence: Record<string, string>;
  dedupeHash: string;
  intentHash: string;
  previousTransitionHash: string | null;
  transitionHash: string;
};

type Store = {
  schemaVersion: 1;
  workspaceHash: string;
  transitionCount: number;
  tailTransitionHash: string | null;
  transitions: LiveActivityTransition[];
};

function sha256Domain(domain: string, value: string): string {
  return crypto.createHash('sha256').update(domain).update('\0').update(value).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(record: Record<string, unknown>, allowed: Set<string>, error: string): void {
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw new Error(`${error}:${key}`);
}

function boundedSecretInput(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > 512 || /\p{Cc}/u.test(value)) {
    throw new Error(`live_activity_${field}_invalid`);
  }
  return value;
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string' || value.length > 40) throw new Error('live_activity_observed_at_invalid');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error('live_activity_observed_at_invalid');
  return new Date(parsed).toISOString();
}

function evidence(value: unknown): Record<string, string> {
  if (!isRecord(value)) throw new Error('live_activity_evidence_invalid');
  exactKeys(value, EVIDENCE_KEYS, 'live_activity_evidence_unknown_field');
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'string' || !HASH_RE.test(raw)) throw new Error(`live_activity_evidence_hash_invalid:${key}`);
    result[key] = raw;
  }
  if (!Object.keys(result).length) throw new Error('live_activity_evidence_required');
  return result;
}

function transitionHash(row: Omit<LiveActivityTransition, 'transitionHash'>): string {
  return sha256Domain('live-activity-transition-v1', JSON.stringify(row));
}

function containmentRoot(workspace: Workspace): string {
  return workspace.mode === 'existing-memory-root' ? workspace.mcpDir : workspace.spaceDir;
}

function workspaceHash(workspace: Workspace): string {
  return sha256Domain('live-activity-workspace-v1', path.resolve(containmentRoot(workspace)));
}

function emptyStore(workspace: Workspace): Store {
  return {
    schemaVersion: 1,
    workspaceHash: workspaceHash(workspace),
    transitionCount: 0,
    tailTransitionHash: null,
    transitions: [],
  };
}

export function liveActivityLedgerPath(workspace: Workspace): string {
  return path.join(containmentRoot(workspace), 'live-activity', 'v1.json');
}

function validateStoreTransitions(transitions: unknown[]): LiveActivityTransition[] {
  const rows: LiveActivityTransition[] = [];
  const latestByActivity = new Map<string, LiveActivityTransition>();
  for (const value of transitions) {
    if (!isRecord(value)) throw new Error('live_activity_store_invalid');
    const row = value as unknown as LiveActivityTransition;
    const allowed = new Set([
      'schemaVersion', 'activityId', 'state', 'revision', 'observedAt', 'receivedAt', 'expiresAt', 'freshness',
      'productVerdict', 'evidence', 'dedupeHash', 'intentHash', 'previousTransitionHash', 'transitionHash',
    ]);
    try { exactKeys(value, allowed, 'live_activity_store_invalid'); } catch { throw new Error('live_activity_store_invalid'); }
    if (
      row.schemaVersion !== 1
      || !HASH_RE.test(row.activityId)
      || !HASH_RE.test(row.dedupeHash)
      || !HASH_RE.test(row.intentHash)
      || !HASH_RE.test(row.transitionHash)
      || (row.previousTransitionHash !== null && !HASH_RE.test(row.previousTransitionHash))
      || !Number.isSafeInteger(row.revision) || row.revision < 1
      || (row.state !== 'RUNNING' && row.state !== 'WAITING' && row.state !== 'COMMITTED')
      || row.productVerdict !== 'NONE'
      || row.freshness !== (row.state === 'COMMITTED' ? 'TERMINAL' : 'CURRENT')
    ) throw new Error('live_activity_store_invalid');
    try {
      timestamp(row.observedAt);
      timestamp(row.receivedAt);
      evidence(row.evidence);
      if (row.state === 'COMMITTED') {
        if (row.expiresAt !== null) throw new Error('invalid');
      } else if (row.expiresAt === null || Date.parse(timestamp(row.expiresAt)) <= Date.parse(row.receivedAt)) {
        throw new Error('invalid');
      }
    } catch {
      throw new Error('live_activity_store_invalid');
    }
    const { transitionHash: storedHash, ...base } = row;
    if (transitionHash(base) !== storedHash) throw new Error('live_activity_store_invalid');
    const prior = latestByActivity.get(row.activityId);
    if (prior) {
      if (row.revision !== prior.revision + 1 || row.previousTransitionHash !== prior.transitionHash || prior.state === 'COMMITTED') {
        throw new Error('live_activity_store_invalid');
      }
      const validTransition = prior.state === 'RUNNING'
        ? row.state === 'WAITING' || row.state === 'COMMITTED'
        : row.state === 'RUNNING' || row.state === 'COMMITTED';
      if (!validTransition) throw new Error('live_activity_store_invalid');
    } else if (row.revision !== 1 || row.previousTransitionHash !== null || row.state !== 'RUNNING') {
      throw new Error('live_activity_store_invalid');
    }
    latestByActivity.set(row.activityId, row);
    rows.push(row);
  }
  return rows;
}

async function readStore(workspace: Workspace): Promise<Store> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(liveActivityLedgerPath(workspace), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyStore(workspace);
    throw error;
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.transitions)) {
    throw new Error('live_activity_store_invalid');
  }
  const allowed = new Set(['schemaVersion', 'workspaceHash', 'transitionCount', 'tailTransitionHash', 'transitions']);
  try { exactKeys(parsed, allowed, 'live_activity_store_invalid'); } catch { throw new Error('live_activity_store_invalid'); }
  const transitions = validateStoreTransitions(parsed.transitions);
  const expectedTail = transitions.at(-1)?.transitionHash ?? null;
  if (
    parsed.workspaceHash !== workspaceHash(workspace)
    || parsed.transitionCount !== transitions.length
    || parsed.tailTransitionHash !== expectedTail
  ) throw new Error('live_activity_store_invalid');
  return {
    schemaVersion: 1,
    workspaceHash: parsed.workspaceHash as string,
    transitionCount: parsed.transitionCount as number,
    tailTransitionHash: parsed.tailTransitionHash as string | null,
    transitions,
  };
}

function latestFor(store: Store, activityId: string): LiveActivityTransition | undefined {
  for (let i = store.transitions.length - 1; i >= 0; i -= 1) {
    if (store.transitions[i].activityId === activityId) return store.transitions[i];
  }
  return undefined;
}

function evictOldestEligibleChains(
  store: Store,
  additionalTransitions: number,
  additionalActiveReservations: number,
  maxTransitions: number,
  nowMs: number,
): boolean {
  while (true) {
    const latestByActivity = new Map<string, LiveActivityTransition>();
    for (const row of store.transitions) latestByActivity.set(row.activityId, row);
    const activeReservations = [...latestByActivity.values()].filter((row) =>
      row.state !== 'COMMITTED' && (row.expiresAt === null || nowMs <= Date.parse(row.expiresAt)),
    ).length;
    if (store.transitions.length + additionalTransitions + activeReservations + additionalActiveReservations <= maxTransitions) break;
    const evictable = store.transitions.find((row) => {
      const latest = latestByActivity.get(row.activityId);
      return latest?.state === 'COMMITTED'
        || (latest?.expiresAt !== null && latest?.expiresAt !== undefined && nowMs > Date.parse(latest.expiresAt));
    });
    if (!evictable) return false;
    store.transitions = store.transitions.filter((row) => row.activityId !== evictable.activityId);
  }
  store.transitionCount = store.transitions.length;
  store.tailTransitionHash = store.transitions.at(-1)?.transitionHash ?? null;
  return true;
}

export function createLiveActivityLedger(
  workspace: Workspace,
  dependencies: { now?: () => number; maxTransitions?: number; maxRevisionsPerActivity?: number } = {},
): {
  transition(input: unknown): Promise<LiveActivityTransition>;
  read(activityKey: unknown, options?: { nowMs?: number }): Promise<(Omit<LiveActivityTransition, 'freshness'> & { freshness: 'CURRENT' | 'EXPIRED' | 'TERMINAL' }) | null>;
} {
  const now = dependencies.now ?? Date.now;
  const maxTransitions = dependencies.maxTransitions ?? MAX_ACTIVITIES;
  const maxRevisionsPerActivity = dependencies.maxRevisionsPerActivity ?? MAX_REVISIONS_PER_ACTIVITY;
  return {
    async transition(input: unknown): Promise<LiveActivityTransition> {
      if (!isRecord(input)) throw new Error('live_activity_schema_invalid');
      exactKeys(input, INPUT_KEYS, 'live_activity_unknown_field');
      const activityKey = boundedSecretInput(input.activityKey, 'activity_key');
      const dedupeKey = boundedSecretInput(input.dedupeKey, 'dedupe_key');
      if (input.state !== 'RUNNING' && input.state !== 'WAITING' && input.state !== 'COMMITTED') {
        throw new Error('live_activity_state_invalid');
      }
      const state = input.state;
      const observedAt = timestamp(input.observedAt);
      const receivedMs = now();
      if (!Number.isFinite(receivedMs)) throw new Error('live_activity_clock_invalid');
      const receivedAt = new Date(Math.trunc(receivedMs)).toISOString();
      const parsedEvidence = evidence(input.evidence);
      const activityId = sha256Domain('live-activity-key-v1', activityKey);
      const dedupeHash = sha256Domain('live-activity-dedupe-v1', `${activityId}\0${dedupeKey}`);
      const intentHash = sha256Domain('live-activity-intent-v1', JSON.stringify({
        activityId,
        state,
        observedAt,
        ttlMs: input.ttlMs ?? null,
        expectedRevision: input.expectedRevision ?? null,
        expectedTransitionHash: input.expectedTransitionHash ?? null,
        evidence: parsedEvidence,
      }));

      return await withWorkspaceLock(workspace, async () => {
        const store = await readStore(workspace);
        const duplicate = store.transitions.find((row) => row.activityId === activityId && row.dedupeHash === dedupeHash);
        if (duplicate) {
          if (duplicate.intentHash !== intentHash) throw new Error('live_activity_dedupe_divergence');
          if (duplicate.expiresAt !== null && receivedMs > Date.parse(duplicate.expiresAt)) throw new Error('live_activity_expired');
          return duplicate;
        }
        const prior = latestFor(store, activityId);
        if (!prior) {
          if (state !== 'RUNNING' || input.expectedRevision !== undefined || input.expectedTransitionHash !== undefined) {
            throw new Error('live_activity_initial_state_invalid');
          }
        } else {
          if (prior.state === 'COMMITTED') throw new Error('live_activity_terminal');
          if (prior.expiresAt !== null && receivedMs > Date.parse(prior.expiresAt)) throw new Error('live_activity_expired');
          if (input.expectedRevision !== prior.revision || input.expectedTransitionHash !== prior.transitionHash) {
            throw new Error('live_activity_cas_mismatch');
          }
          const allowed = prior.state === 'RUNNING'
            ? state === 'WAITING' || state === 'COMMITTED'
            : state === 'RUNNING' || state === 'COMMITTED';
          if (!allowed) throw new Error('live_activity_transition_invalid');
          if (state !== 'COMMITTED' && prior.revision >= maxRevisionsPerActivity) {
            throw new Error('live_activity_revision_limit');
          }
        }

        const latestByActivity = new Map<string, LiveActivityTransition>();
        for (const transition of store.transitions) latestByActivity.set(transition.activityId, transition);
        const nonterminalActivities = [...latestByActivity.values()].filter((transition) => transition.state !== 'COMMITTED').length;
        if (!prior) {
          const hasCapacity = evictOldestEligibleChains(store, 1, 1, maxTransitions, receivedMs);
          if (!hasCapacity) throw new Error('live_activity_capacity_exceeded');
        } else if (state !== 'COMMITTED' && store.transitions.length + 1 + nonterminalActivities > maxTransitions) {
          throw new Error('live_activity_capacity_exceeded');
        }

        let expiresAt: string | null;
        if (state === 'COMMITTED') {
          expiresAt = null;
        } else {
          const rawTtl = input.ttlMs;
          if (!Number.isSafeInteger(rawTtl) || (rawTtl as number) < MIN_TTL_MS || (rawTtl as number) > MAX_TTL_MS) {
            throw new Error('live_activity_ttl_invalid');
          }
          expiresAt = new Date(receivedMs + (rawTtl as number)).toISOString();
        }
        const base: Omit<LiveActivityTransition, 'transitionHash'> = {
          schemaVersion: 1,
          activityId,
          state,
          revision: (prior?.revision ?? 0) + 1,
          observedAt,
          receivedAt,
          expiresAt,
          freshness: state === 'COMMITTED' ? 'TERMINAL' : 'CURRENT',
          productVerdict: 'NONE',
          evidence: parsedEvidence,
          dedupeHash,
          intentHash,
          previousTransitionHash: prior?.transitionHash ?? null,
        };
        const row: LiveActivityTransition = { ...base, transitionHash: transitionHash(base) };
        store.transitions.push(row);
        store.transitionCount = store.transitions.length;
        store.tailTransitionHash = row.transitionHash;
        const file = liveActivityLedgerPath(workspace);
        await atomicWriteFile(file, `${JSON.stringify(store, null, 2)}\n`, containmentRoot(workspace), {
          directoryMode: 0o700, fileMode: 0o600, durable: true, boundedTemp: true,
        });
        return row;
      });
    },

    async read(activityKey: unknown, options = {}) {
      const raw = boundedSecretInput(activityKey, 'activity_key');
      const activityId = sha256Domain('live-activity-key-v1', raw);
      const latest = latestFor(await readStore(workspace), activityId);
      if (!latest) return null;
      const nowMs = Number.isFinite(options.nowMs) ? Math.trunc(options.nowMs as number) : Date.now();
      const freshness = latest.state === 'COMMITTED'
        ? 'TERMINAL' as const
        : latest.expiresAt !== null && nowMs > Date.parse(latest.expiresAt)
          ? 'EXPIRED' as const
          : 'CURRENT' as const;
      return { ...latest, freshness };
    },
  };
}
