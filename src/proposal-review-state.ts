// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
// Review-only proposal state. This module cannot apply or roll back authoritative memory.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Workspace } from './types.ts';
import { atomicWriteFile } from './store/files.ts';
import { withWorkspaceLock } from './store/lock.ts';

const SHA_RE = /^[a-f0-9]{64}$/;
const PROPOSAL_RE = /^mp1_[a-f0-9]{64}$/;
const RELATIONS = new Set(['new', 'duplicate', 'conflict', 'supersedes', 'review_required']);
const MAX_TTL_MS = 7 * 86_400_000;
const PROPOSE_KEYS = new Set(['proposalId', 'proposalSha256', 'relationVerdict', 'ttlMs', 'dedupeKey']);
const DECIDE_KEYS = new Set([
  'proposalId', 'proposalSha256', 'decision', 'reviewerKey', 'resolutionSha256',
  'expectedRevision', 'expectedTransitionHash',
]);

export type ProposalReviewState = 'PROPOSED' | 'APPROVED' | 'REJECTED';
export type ProposalReviewRelation = 'new' | 'duplicate' | 'conflict' | 'supersedes' | 'review_required';
export type ProposalReviewRow = {
  schemaVersion: 1;
  proposalId: string;
  proposalSha256: string;
  relationVerdict: ProposalReviewRelation;
  state: ProposalReviewState;
  revision: number;
  receivedAt: string;
  expiresAt: string;
  dedupeHash: string;
  reviewerHash: string | null;
  resolutionSha256: string | null;
  decisionIntentHash: string | null;
  previousTransitionHash: string | null;
  transitionHash: string;
  authorityWrites: 0;
  applyAllowed: false;
};

type Store = { schemaVersion: 1; rows: ProposalReviewRow[] };

function hash(domain: string, value: string): string {
  return crypto.createHash('sha256').update(domain).update('\0').update(value).digest('hex');
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('proposal_review_schema_invalid');
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: Set<string>): void {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`proposal_review_unknown_field:${key}`);
}

function boundedSecret(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > 512 || /\p{Cc}/u.test(value)) {
    throw new Error(`proposal_review_${field}_invalid`);
  }
  return value;
}

function sha(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SHA_RE.test(value)) throw new Error(`proposal_review_${field}_invalid`);
  return value;
}

function proposal(value: unknown): string {
  if (typeof value !== 'string' || !PROPOSAL_RE.test(value)) throw new Error('proposal_review_proposal_id_invalid');
  return value;
}

function root(workspace: Workspace): string {
  return workspace.mode === 'existing-memory-root' ? workspace.mcpDir : workspace.spaceDir;
}

export function proposalReviewStorePath(workspace: Workspace): string {
  return path.join(root(workspace), 'proposal-reviews', 'v1.json');
}

function rowHash(row: Omit<ProposalReviewRow, 'transitionHash'>): string {
  return hash('proposal-review-transition-v1', JSON.stringify(row));
}

async function readStore(workspace: Workspace): Promise<Store> {
  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(proposalReviewStorePath(workspace), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, rows: [] };
    throw error;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('proposal_review_store_invalid');
  const store = value as Store;
  if (store.schemaVersion !== 1 || !Array.isArray(store.rows)) throw new Error('proposal_review_store_invalid');
  const latest = new Map<string, ProposalReviewRow>();
  for (const row of store.rows) {
    if (!row || row.schemaVersion !== 1 || !PROPOSAL_RE.test(row.proposalId) || !SHA_RE.test(row.proposalSha256)
      || !RELATIONS.has(row.relationVerdict) || !['PROPOSED', 'APPROVED', 'REJECTED'].includes(row.state)
      || row.authorityWrites !== 0 || row.applyAllowed !== false || !Number.isSafeInteger(row.revision)
      || !SHA_RE.test(row.dedupeHash) || (row.reviewerHash !== null && !SHA_RE.test(row.reviewerHash))
      || (row.resolutionSha256 !== null && !SHA_RE.test(row.resolutionSha256))
      || (row.decisionIntentHash !== null && !SHA_RE.test(row.decisionIntentHash))
      || (row.previousTransitionHash !== null && !SHA_RE.test(row.previousTransitionHash))
      || !SHA_RE.test(row.transitionHash)) throw new Error('proposal_review_store_invalid');
    const { transitionHash, ...base } = row;
    if (rowHash(base) !== transitionHash) throw new Error('proposal_review_store_invalid');
    const prior = latest.get(row.proposalId);
    if (prior) {
      if (prior.state !== 'PROPOSED' || row.revision !== prior.revision + 1 || row.previousTransitionHash !== prior.transitionHash
        || row.proposalSha256 !== prior.proposalSha256 || row.relationVerdict !== prior.relationVerdict) {
        throw new Error('proposal_review_store_invalid');
      }
    } else if (row.state !== 'PROPOSED' || row.revision !== 1 || row.previousTransitionHash !== null) {
      throw new Error('proposal_review_store_invalid');
    }
    latest.set(row.proposalId, row);
  }
  return store;
}

function latest(store: Store, proposalId: string): ProposalReviewRow | undefined {
  for (let i = store.rows.length - 1; i >= 0; i -= 1) if (store.rows[i].proposalId === proposalId) return store.rows[i];
  return undefined;
}

async function writeStore(workspace: Workspace, store: Store): Promise<void> {
  await atomicWriteFile(proposalReviewStorePath(workspace), `${JSON.stringify(store, null, 2)}\n`, root(workspace), {
    directoryMode: 0o700, fileMode: 0o600, durable: true, boundedTemp: true,
  });
}

export function createProposalReviewStore(workspace: Workspace, deps: { now?: () => number } = {}): {
  propose(input: unknown): Promise<ProposalReviewRow>;
  decide(input: unknown): Promise<ProposalReviewRow>;
  read(proposalId: unknown): Promise<(Omit<ProposalReviewRow, 'state'> & { state: ProposalReviewState | 'EXPIRED' }) | null>;
} {
  const now = deps.now ?? Date.now;
  const received = (): { ms: number; iso: string } => {
    const ms = now();
    if (!Number.isFinite(ms)) throw new Error('proposal_review_clock_invalid');
    return { ms: Math.trunc(ms), iso: new Date(Math.trunc(ms)).toISOString() };
  };
  return {
    async propose(input: unknown) {
      const item = record(input);
      exactKeys(item, PROPOSE_KEYS);
      const proposalId = proposal(item.proposalId);
      const proposalSha256 = sha(item.proposalSha256, 'proposal_sha256');
      if (typeof item.relationVerdict !== 'string' || !RELATIONS.has(item.relationVerdict)) throw new Error('proposal_review_relation_invalid');
      const relationVerdict = item.relationVerdict as ProposalReviewRelation;
      if (!Number.isSafeInteger(item.ttlMs) || (item.ttlMs as number) < 1_000 || (item.ttlMs as number) > MAX_TTL_MS) {
        throw new Error('proposal_review_ttl_invalid');
      }
      const dedupeKey = boundedSecret(item.dedupeKey, 'dedupe_key');
      const dedupeHash = hash('proposal-review-propose-dedupe-v1', `${proposalId}\0${dedupeKey}`);
      return await withWorkspaceLock(workspace, async () => {
        const store = await readStore(workspace);
        const prior = latest(store, proposalId);
        if (prior) {
          if (prior.proposalSha256 !== proposalSha256 || prior.relationVerdict !== relationVerdict) throw new Error('proposal_review_proposal_divergence');
          if (prior.dedupeHash !== dedupeHash) throw new Error('proposal_review_already_exists');
          return prior;
        }
        const at = received();
        const base: Omit<ProposalReviewRow, 'transitionHash'> = {
          schemaVersion: 1, proposalId, proposalSha256, relationVerdict, state: 'PROPOSED', revision: 1,
          receivedAt: at.iso, expiresAt: new Date(at.ms + (item.ttlMs as number)).toISOString(), dedupeHash,
          reviewerHash: null, resolutionSha256: null, decisionIntentHash: null, previousTransitionHash: null,
          authorityWrites: 0, applyAllowed: false,
        };
        const row = { ...base, transitionHash: rowHash(base) };
        store.rows.push(row);
        await writeStore(workspace, store);
        return row;
      });
    },

    async decide(input: unknown) {
      const item = record(input);
      exactKeys(item, DECIDE_KEYS);
      const proposalId = proposal(item.proposalId);
      const proposalSha256 = sha(item.proposalSha256, 'proposal_sha256');
      if (item.decision !== 'APPROVED' && item.decision !== 'REJECTED') throw new Error('proposal_review_decision_invalid');
      const decision = item.decision as 'APPROVED' | 'REJECTED';
      const reviewerHash = hash('proposal-review-reviewer-v1', boundedSecret(item.reviewerKey, 'reviewer_key'));
      const resolutionSha256 = item.resolutionSha256 === undefined ? null : sha(item.resolutionSha256, 'resolution_sha256');
      const decisionIntentHash = hash('proposal-review-decision-intent-v1', JSON.stringify({
        proposalId,
        proposalSha256,
        decision,
        reviewerHash,
        resolutionSha256,
        expectedRevision: item.expectedRevision,
        expectedTransitionHash: item.expectedTransitionHash,
      }));
      return await withWorkspaceLock(workspace, async () => {
        const store = await readStore(workspace);
        const prior = latest(store, proposalId);
        if (!prior) throw new Error('proposal_review_not_found');
        if (prior.proposalSha256 !== proposalSha256) throw new Error('proposal_review_proposal_divergence');
        if (prior.state !== 'PROPOSED') {
          if (prior.decisionIntentHash === decisionIntentHash) return prior;
          throw new Error('proposal_review_terminal_divergence');
        }
        const at = received();
        if (at.ms > Date.parse(prior.expiresAt)) throw new Error('proposal_review_expired');
        if (item.expectedRevision !== prior.revision || item.expectedTransitionHash !== prior.transitionHash) {
          throw new Error('proposal_review_cas_mismatch');
        }
        if (decision === 'APPROVED' && (prior.relationVerdict === 'conflict' || prior.relationVerdict === 'supersedes') && resolutionSha256 === null) {
          throw new Error('proposal_review_resolution_required');
        }
        const base: Omit<ProposalReviewRow, 'transitionHash'> = {
          ...prior,
          state: decision,
          revision: prior.revision + 1,
          receivedAt: at.iso,
          reviewerHash,
          resolutionSha256,
          decisionIntentHash,
          previousTransitionHash: prior.transitionHash,
        };
        delete (base as Partial<ProposalReviewRow>).transitionHash;
        const row = { ...base, transitionHash: rowHash(base) };
        store.rows.push(row);
        await writeStore(workspace, store);
        return row;
      });
    },

    async read(rawProposalId: unknown) {
      const proposalId = proposal(rawProposalId);
      const row = latest(await readStore(workspace), proposalId);
      if (!row) return null;
      if (row.state === 'PROPOSED' && received().ms > Date.parse(row.expiresAt)) return { ...row, state: 'EXPIRED' };
      return row;
    },
  };
}
