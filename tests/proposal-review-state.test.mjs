// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveWorkspace } from '../src/workspace.ts';
import { createProposalReviewStore, proposalReviewStorePath } from '../src/proposal-review-state.ts';

const H = (ch) => ch.repeat(64);
const P = `mp1_${'a'.repeat(64)}`;

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-review-state-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const workspace = resolveWorkspace({ root, space: 't' });
  let now = Date.parse('2026-07-20T03:00:00.000Z');
  return { workspace, store: createProposalReviewStore(workspace, { now: () => now }), setNow: (value) => { now = Date.parse(value); } };
}

test('proposal review is proposal-byte-bound, TTL-bounded, CAS-protected, and authority-write-free', async (t) => {
  const { workspace, store } = await fixture(t);
  const proposed = await store.propose({
    proposalId: P, proposalSha256: H('b'), relationVerdict: 'new', ttlMs: 60_000, dedupeKey: 'proposal-secret',
  });
  const approved = await store.decide({
    proposalId: P, proposalSha256: H('b'), decision: 'APPROVED', reviewerKey: 'reviewer-secret',
    expectedRevision: proposed.revision, expectedTransitionHash: proposed.transitionHash,
  });
  assert.deepEqual([proposed.state, approved.state], ['PROPOSED', 'APPROVED']);
  assert.equal(approved.authorityWrites, 0);
  assert.equal(approved.applyAllowed, false);
  const raw = await fs.readFile(proposalReviewStorePath(workspace), 'utf8');
  assert.equal(raw.includes('proposal-secret'), false);
  assert.equal(raw.includes('reviewer-secret'), false);
});

test('conflict or supersedes cannot be approved without explicit resolution evidence hash', async (t) => {
  const { store } = await fixture(t);
  for (const [index, relationVerdict] of ['conflict', 'supersedes'].entries()) {
    const proposalId = `mp1_${String(index + 1).repeat(64)}`;
    const proposed = await store.propose({ proposalId, proposalSha256: H('b'), relationVerdict, ttlMs: 60_000, dedupeKey: `p${index}` });
    await assert.rejects(() => store.decide({
      proposalId, proposalSha256: H('b'), decision: 'APPROVED', reviewerKey: 'r',
      expectedRevision: proposed.revision, expectedTransitionHash: proposed.transitionHash,
    }), /proposal_review_resolution_required/);
    const approved = await store.decide({
      proposalId, proposalSha256: H('b'), decision: 'APPROVED', reviewerKey: 'r', resolutionSha256: H('c'),
      expectedRevision: proposed.revision, expectedTransitionHash: proposed.transitionHash,
    });
    assert.equal(approved.state, 'APPROVED');
  }
});

test('expired, stale, divergent, or terminal decisions fail closed', async (t) => {
  const { store, setNow } = await fixture(t);
  const proposed = await store.propose({ proposalId: P, proposalSha256: H('b'), relationVerdict: 'new', ttlMs: 1_000, dedupeKey: 'p' });
  setNow('2026-07-20T03:00:02.000Z');
  await assert.rejects(() => store.decide({
    proposalId: P, proposalSha256: H('b'), decision: 'APPROVED', reviewerKey: 'r',
    expectedRevision: proposed.revision, expectedTransitionHash: proposed.transitionHash,
  }), /proposal_review_expired/);
  const expired = await store.read(P);
  assert.equal(expired.state, 'EXPIRED');

  await assert.rejects(() => store.decide({
    proposalId: P, proposalSha256: H('c'), decision: 'REJECTED', reviewerKey: 'r',
    expectedRevision: proposed.revision, expectedTransitionHash: proposed.transitionHash,
  }), /proposal_review_terminal|proposal_review_proposal_divergence|proposal_review_expired/);
});

test('identical review decision replay is idempotent but a divergent terminal decision is rejected', async (t) => {
  const { store } = await fixture(t);
  const proposed = await store.propose({ proposalId: P, proposalSha256: H('b'), relationVerdict: 'new', ttlMs: 60_000, dedupeKey: 'p' });
  const input = {
    proposalId: P, proposalSha256: H('b'), decision: 'APPROVED', reviewerKey: 'r',
    expectedRevision: proposed.revision, expectedTransitionHash: proposed.transitionHash,
  };
  const approved = await store.decide(input);
  assert.deepEqual(await store.decide(input), approved);
  await assert.rejects(() => store.decide({ ...input, decision: 'REJECTED' }), /proposal_review_terminal_divergence/);
});

test('tampered review chain or deleted predecessor fails closed', async (t) => {
  const { workspace, store } = await fixture(t);
  const proposed = await store.propose({ proposalId: P, proposalSha256: H('b'), relationVerdict: 'new', ttlMs: 60_000, dedupeKey: 'p' });
  await store.decide({
    proposalId: P, proposalSha256: H('b'), decision: 'REJECTED', reviewerKey: 'r',
    expectedRevision: proposed.revision, expectedTransitionHash: proposed.transitionHash,
  });
  const file = proposalReviewStorePath(workspace);
  const original = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.writeFile(file, `${JSON.stringify({ ...original, rows: original.rows.slice(1) }, null, 2)}\n`);
  await assert.rejects(() => store.read(P), /proposal_review_store_invalid/);

  original.rows[0].expiresAt = '2030-01-01T00:00:00.000Z';
  await fs.writeFile(file, `${JSON.stringify(original, null, 2)}\n`);
  await assert.rejects(() => store.read(P), /proposal_review_store_invalid/);
});
