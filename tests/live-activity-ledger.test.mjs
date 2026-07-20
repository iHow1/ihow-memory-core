// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveWorkspace } from '../src/workspace.ts';
import {
  createLiveActivityLedger,
  liveActivityLedgerPath,
} from '../src/live-activity-ledger.ts';

const H = (ch) => ch.repeat(64);

async function fixture(t, slug, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `ihow-live-activity-${slug}-`));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const workspace = resolveWorkspace({ root, space: 't' });
  let nowMs = Date.parse('2026-07-20T03:00:00.000Z');
  return {
    workspace,
    ledger: createLiveActivityLedger(workspace, { now: () => nowMs, ...options }),
    setNow: (value) => { nowMs = typeof value === 'string' ? Date.parse(value) : value; },
  };
}

test('activity transitions RUNNING to WAITING to COMMITTED with hash-only CAS evidence', async (t) => {
  const { workspace, ledger } = await fixture(t, 'lifecycle');
  const running = await ledger.transition({
    activityKey: 'session:secret-never-persist',
    state: 'RUNNING',
    observedAt: '2026-07-20T03:00:00.000Z',
    ttlMs: 60_000,
    evidence: { gitHeadSha256: H('a') },
    dedupeKey: 'start:secret-never-persist',
  });
  const waiting = await ledger.transition({
    activityKey: 'session:secret-never-persist',
    state: 'WAITING',
    observedAt: '2026-07-20T03:00:10.000Z',
    ttlMs: 60_000,
    expectedRevision: running.revision,
    expectedTransitionHash: running.transitionHash,
    evidence: { processSha256: H('b') },
    dedupeKey: 'waiting:secret-never-persist',
  });
  const committed = await ledger.transition({
    activityKey: 'session:secret-never-persist',
    state: 'COMMITTED',
    observedAt: '2026-07-20T03:00:20.000Z',
    expectedRevision: waiting.revision,
    expectedTransitionHash: waiting.transitionHash,
    evidence: { artifactSha256: H('c'), fileTreeSha256: H('d') },
    dedupeKey: 'commit:secret-never-persist',
  });

  assert.deepEqual([running.state, waiting.state, committed.state], ['RUNNING', 'WAITING', 'COMMITTED']);
  assert.deepEqual([running.revision, waiting.revision, committed.revision], [1, 2, 3]);
  assert.equal(committed.productVerdict, 'NONE');
  assert.equal(committed.freshness, 'TERMINAL');
  const raw = await fs.readFile(liveActivityLedgerPath(workspace), 'utf8');
  for (const secret of ['session:secret-never-persist', 'start:secret-never-persist', 'waiting:secret-never-persist', 'commit:secret-never-persist']) {
    assert.equal(raw.includes(secret), false);
  }
  assert.equal(raw.includes('prompt'), false);
  assert.equal(raw.includes('response'), false);
});

test('replayed dedupe is idempotent while stale or expired late notifications fail closed', async (t) => {
  const { ledger, setNow } = await fixture(t, 'late');
  const running = await ledger.transition({
    activityKey: 'job-1', state: 'RUNNING', observedAt: '2026-07-20T03:00:00.000Z', ttlMs: 1_000,
    evidence: { gitHeadSha256: H('a') }, dedupeKey: 'same-start',
  });
  const replay = await ledger.transition({
    activityKey: 'job-1', state: 'RUNNING', observedAt: '2026-07-20T03:00:00.000Z', ttlMs: 1_000,
    evidence: { gitHeadSha256: H('a') }, dedupeKey: 'same-start',
  });
  assert.deepEqual(replay, running);

  setNow('2026-07-20T03:00:02.000Z');
  await assert.rejects(() => ledger.transition({
    activityKey: 'job-1', state: 'COMMITTED', observedAt: '2026-07-20T03:00:00.500Z',
    expectedRevision: running.revision, expectedTransitionHash: running.transitionHash,
    evidence: { artifactSha256: H('c') }, dedupeKey: 'late-commit',
  }), /live_activity_expired/);

  setNow('2026-07-20T03:00:00.000Z');
  const waiting = await ledger.transition({
    activityKey: 'job-2', state: 'RUNNING', observedAt: '2026-07-20T03:00:00.000Z', ttlMs: 60_000,
    evidence: { gitHeadSha256: H('a') }, dedupeKey: 'job2-start',
  });
  await assert.rejects(() => ledger.transition({
    activityKey: 'job-2', state: 'WAITING', observedAt: '2026-07-20T03:00:01.000Z', ttlMs: 60_000,
    expectedRevision: 0, expectedTransitionHash: H('f'), evidence: { processSha256: H('b') }, dedupeKey: 'stale',
  }), /live_activity_cas_mismatch/);
  assert.equal((await ledger.read('job-2', { nowMs: Date.parse('2026-07-20T03:00:02.000Z') })).revision, waiting.revision);
});

test('raw content fields and unknown evidence are rejected before persistence', async (t) => {
  const { workspace, ledger } = await fixture(t, 'privacy');
  await assert.rejects(() => ledger.transition({
    activityKey: 'job', state: 'RUNNING', observedAt: '2026-07-20T03:00:00.000Z', ttlMs: 60_000,
    evidence: { gitHeadSha256: H('a') }, dedupeKey: 'x', prompt: 'do not store me',
  }), /live_activity_unknown_field/);
  await assert.rejects(() => ledger.transition({
    activityKey: 'job', state: 'RUNNING', observedAt: '2026-07-20T03:00:00.000Z', ttlMs: 60_000,
    evidence: { command: 'rm -rf secret' }, dedupeKey: 'x',
  }), /live_activity_evidence_unknown_field/);
  await assert.rejects(fs.access(liveActivityLedgerPath(workspace)));
});

test('same dedupe with divergent transition intent is rejected rather than silently replayed', async (t) => {
  const { ledger } = await fixture(t, 'dedupe-divergence');
  await ledger.transition({
    activityKey: 'job', state: 'RUNNING', observedAt: '2026-07-20T03:00:00.000Z', ttlMs: 60_000,
    evidence: { gitHeadSha256: H('a') }, dedupeKey: 'same',
  });
  await assert.rejects(() => ledger.transition({
    activityKey: 'job', state: 'RUNNING', observedAt: '2026-07-20T03:00:00.000Z', ttlMs: 60_000,
    evidence: { gitHeadSha256: H('b') }, dedupeKey: 'same',
  }), /live_activity_dedupe_divergence/);
});

test('expired dedupe replay is rejected and capacity still permits terminalization of existing activity', async (t) => {
  const { ledger, setNow } = await fixture(t, 'capacity', { maxTransitions: 4 });
  const a = await ledger.transition({
    activityKey: 'a', state: 'RUNNING', observedAt: '2026-07-20T03:00:00.000Z', ttlMs: 1_000,
    evidence: { gitHeadSha256: H('a') }, dedupeKey: 'a-start',
  });
  await ledger.transition({
    activityKey: 'b', state: 'RUNNING', observedAt: '2026-07-20T03:00:00.000Z', ttlMs: 60_000,
    evidence: { gitHeadSha256: H('b') }, dedupeKey: 'b-start',
  });
  await assert.rejects(() => ledger.transition({
    activityKey: 'c', state: 'RUNNING', observedAt: '2026-07-20T03:00:00.000Z', ttlMs: 60_000,
    evidence: { gitHeadSha256: H('c') }, dedupeKey: 'c-start',
  }), /live_activity_capacity_exceeded/);

  const committed = await ledger.transition({
    activityKey: 'a', state: 'COMMITTED', observedAt: '2026-07-20T03:00:00.500Z',
    expectedRevision: a.revision, expectedTransitionHash: a.transitionHash,
    evidence: { artifactSha256: H('d') }, dedupeKey: 'a-commit',
  });
  assert.equal(committed.state, 'COMMITTED');

  const { ledger: expiring, setNow: setExpiringNow } = await fixture(t, 'expired-replay');
  const input = {
    activityKey: 'x', state: 'RUNNING', observedAt: '2026-07-20T03:00:00.000Z', ttlMs: 1_000,
    evidence: { gitHeadSha256: H('a') }, dedupeKey: 'x-start',
  };
  await expiring.transition(input);
  setExpiringNow('2026-07-20T03:00:02.000Z');
  await assert.rejects(() => expiring.transition(input), /live_activity_expired/);
});

test('store envelope detects tail deletion and cross-workspace store splice', async (t) => {
  const first = await fixture(t, 'envelope-a');
  const a = await first.ledger.transition({
    activityKey: 'a', state: 'RUNNING', observedAt: '2026-07-20T03:00:00.000Z', ttlMs: 60_000,
    evidence: { gitHeadSha256: H('a') }, dedupeKey: 'a-start',
  });
  await first.ledger.transition({
    activityKey: 'a', state: 'WAITING', observedAt: '2026-07-20T03:00:01.000Z', ttlMs: 60_000,
    expectedRevision: a.revision, expectedTransitionHash: a.transitionHash,
    evidence: { processSha256: H('b') }, dedupeKey: 'a-wait',
  });
  const fileA = liveActivityLedgerPath(first.workspace);
  const original = JSON.parse(await fs.readFile(fileA, 'utf8'));
  const truncated = { ...original, transitions: original.transitions.slice(0, -1) };
  await fs.writeFile(fileA, `${JSON.stringify(truncated, null, 2)}\n`);
  await assert.rejects(() => first.ledger.read('a'), /live_activity_store_invalid/);

  await fs.writeFile(fileA, `${JSON.stringify(original, null, 2)}\n`);
  const second = await fixture(t, 'envelope-b');
  await fs.mkdir(path.dirname(liveActivityLedgerPath(second.workspace)), { recursive: true });
  await fs.copyFile(fileA, liveActivityLedgerPath(second.workspace));
  await assert.rejects(() => second.ledger.read('a'), /live_activity_store_invalid/);
});

test('tampered transition evidence is rejected on read and write', async (t) => {
  const { workspace, ledger } = await fixture(t, 'tamper');
  const row = await ledger.transition({
    activityKey: 'job', state: 'RUNNING', observedAt: '2026-07-20T03:00:00.000Z', ttlMs: 60_000,
    evidence: { gitHeadSha256: H('a') }, dedupeKey: 'start',
  });
  const file = liveActivityLedgerPath(workspace);
  const store = JSON.parse(await fs.readFile(file, 'utf8'));
  store.transitions[0].evidence.gitHeadSha256 = H('f');
  await fs.writeFile(file, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  await assert.rejects(() => ledger.read('job'), /live_activity_store_invalid/);
  await assert.rejects(() => ledger.transition({
    activityKey: 'job', state: 'WAITING', observedAt: '2026-07-20T03:00:01.000Z', ttlMs: 60_000,
    expectedRevision: row.revision, expectedTransitionHash: row.transitionHash,
    evidence: { processSha256: H('b') }, dedupeKey: 'wait',
  }), /live_activity_store_invalid/);
});


test('capacity reserves terminal slots, bounds per-activity revisions, and evicts oldest committed history', async (t) => {
  const bounded = await fixture(t, 'bounded-revisions', { maxTransitions: 8, maxRevisionsPerActivity: 3 });
  const a1 = await bounded.ledger.transition({
    activityKey: 'bounded', state: 'RUNNING', observedAt: '2026-07-20T03:00:00.000Z', ttlMs: 60_000,
    evidence: { gitHeadSha256: H('a') }, dedupeKey: 'bounded-1',
  });
  const a2 = await bounded.ledger.transition({
    activityKey: 'bounded', state: 'WAITING', observedAt: '2026-07-20T03:00:01.000Z', ttlMs: 60_000,
    expectedRevision: a1.revision, expectedTransitionHash: a1.transitionHash,
    evidence: { processSha256: H('b') }, dedupeKey: 'bounded-2',
  });
  const a3 = await bounded.ledger.transition({
    activityKey: 'bounded', state: 'RUNNING', observedAt: '2026-07-20T03:00:02.000Z', ttlMs: 60_000,
    expectedRevision: a2.revision, expectedTransitionHash: a2.transitionHash,
    evidence: { processSha256: H('c') }, dedupeKey: 'bounded-3',
  });
  await assert.rejects(() => bounded.ledger.transition({
    activityKey: 'bounded', state: 'WAITING', observedAt: '2026-07-20T03:00:03.000Z', ttlMs: 60_000,
    expectedRevision: a3.revision, expectedTransitionHash: a3.transitionHash,
    evidence: { processSha256: H('d') }, dedupeKey: 'bounded-4',
  }), /live_activity_revision_limit/);

  const compacted = await fixture(t, 'compact-committed', { maxTransitions: 4 });
  for (const [activityKey, ch] of [['old-a', 'a'], ['old-b', 'b']]) {
    const running = await compacted.ledger.transition({
      activityKey, state: 'RUNNING', observedAt: `2026-07-20T03:00:0${ch === 'a' ? 0 : 2}.000Z`, ttlMs: 60_000,
      evidence: { gitHeadSha256: H(ch) }, dedupeKey: `${activityKey}-run`,
    });
    await compacted.ledger.transition({
      activityKey, state: 'COMMITTED', observedAt: `2026-07-20T03:00:0${ch === 'a' ? 1 : 3}.000Z`,
      expectedRevision: running.revision, expectedTransitionHash: running.transitionHash,
      evidence: { artifactSha256: H(ch) }, dedupeKey: `${activityKey}-commit`,
    });
  }
  await compacted.ledger.transition({
    activityKey: 'new-c', state: 'RUNNING', observedAt: '2026-07-20T03:00:04.000Z', ttlMs: 60_000,
    evidence: { gitHeadSha256: H('c') }, dedupeKey: 'new-c-run',
  });
  assert.equal(await compacted.ledger.read('old-a'), null);
  assert.equal((await compacted.ledger.read('old-b')).state, 'COMMITTED');
  assert.equal((await compacted.ledger.read('new-c')).state, 'RUNNING');
});


test('expired unfinished chains are evictable so capacity has a recovery path', async (t) => {
  const { workspace, ledger, setNow } = await fixture(t, 'expired-eviction', { maxTransitions: 4 });
  for (const [activityKey, ch] of [['expired-a', 'a'], ['expired-b', 'b']]) {
    await ledger.transition({
      activityKey, state: 'RUNNING', observedAt: '2026-07-20T03:00:00.000Z', ttlMs: 1_000,
      evidence: { gitHeadSha256: H(ch) }, dedupeKey: `${activityKey}-start`,
    });
  }
  setNow('2026-07-20T03:00:02.000Z');
  await ledger.transition({
    activityKey: 'fresh-c', state: 'RUNNING', observedAt: '2026-07-20T03:00:02.000Z', ttlMs: 60_000,
    evidence: { gitHeadSha256: H('c') }, dedupeKey: 'fresh-c-start',
  });
  const expiredA = await ledger.read('expired-a');
  const expiredB = await ledger.read('expired-b');
  for (const entry of [expiredA, expiredB]) assert.ok(entry === null || entry.freshness === 'EXPIRED');
  assert.equal((await ledger.read('fresh-c')).state, 'RUNNING');
  const persisted = JSON.parse(await fs.readFile(liveActivityLedgerPath(workspace), 'utf8'));
  assert.ok(persisted.transitions.length <= 4);
});
