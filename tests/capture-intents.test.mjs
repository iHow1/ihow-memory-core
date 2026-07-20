// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openCore } from '../src/core.ts';
import { canonicalJsonV1, canonicalSha256V1 } from '../src/evaluation.ts';
import { createMemoryProposalV1 } from '../src/memory-proposals.ts';

const RECEIPT_IDENTITY = Object.freeze({
  runtime: 'codex',
  projectId: '1'.repeat(64),
  sessionHash: '2'.repeat(64),
  turnId: 'turn-b4-capture-001',
  revision: 1,
});

function proposalFixture(sequence = '001') {
  return createMemoryProposalV1({
    schemaVersion: 1,
    kind: 'fact',
    text: `[memory:fact] subject=B4 | key=capture mode | value=review first ${sequence}`,
    subject: 'B4',
    key: 'capture mode',
    value: `review first ${sequence}`,
    scope: {
      declaredVisibility: 'project',
      effectiveVisibility: 'project',
      projectScope: 'b4-core',
      sourcePath: null,
      frontmatter: null,
    },
    provenance: {
      sourceKind: 'runtime-event',
      sourceId: `turn-b4-capture-001:delta-${sequence}`,
      runtime: 'codex',
      observedAt: '2026-07-18T12:00:01.000Z',
      sourceSha256: '4'.repeat(64),
      evidenceLocator: 'memory-delta:proposal:0',
    },
    relation: {
      verdict: 'new',
      targetProposalIds: [],
      targetPaths: [],
      reviewRequired: true,
      destructive: false,
      reason: 'no_existing_relation',
    },
    review: { mode: 'review-first', state: 'pending' },
    safety: {
      outcome: 'candidate-only',
      directDurableWrite: false,
      indexWrite: false,
      destructive: false,
      autoPromote: false,
    },
  });
}

function deltaFixture(proposal, receiptIdentity = RECEIPT_IDENTITY) {
  const { proposalId: _proposalId, ...proposalInput } = proposal;
  const hashInput = {
    schemaVersion: 1,
    receiptIdentity,
    finalEvidence: {
      finalSourceHash: `sha256:${'5'.repeat(64)}`,
      finalContentSha256: '6'.repeat(64),
      committedAt: '2026-07-18T12:00:02.000Z',
    },
    proposal: proposalInput,
  };
  return {
    ...hashInput,
    deltaHash: canonicalSha256V1(hashInput),
  };
}

function captureIntentKey(delta, proposal) {
  return `ci1_${canonicalSha256V1({
    schemaVersion: 1,
    receiptIdentity: delta.receiptIdentity,
    deltaHash: delta.deltaHash,
    proposalId: proposal.proposalId,
  })}`;
}

function pendingDirectory(core) {
  return path.join(core.workspace.spaceDir, 'capture-intents', 'pending');
}

async function seedPendingIntent(core, delta, proposal) {
  const directory = pendingDirectory(core);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  const file = path.join(directory, `${captureIntentKey(delta, proposal)}.json`);
  await fs.writeFile(file, canonicalJsonV1(delta), { mode: 0o600 });
  await fs.chmod(file, 0o600);
  return file;
}

async function snapshotFiles(root) {
  const snapshot = [];
  for (const file of await listFilesRecursive(root)) {
    const stat = await fs.stat(file);
    snapshot.push({
      path: path.relative(root, file).split(path.sep).join('/'),
      bytes: await fs.readFile(file),
      mode: stat.mode & 0o777,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });
  }
  return snapshot;
}

async function openReceipt(core, identity) {
  return await core.turnReceipts.open({
    schemaVersion: 1,
    ...identity,
    inputSourceHash: core.turnReceipts.hashSourceId(`host-input/${identity.turnId}`),
    inputContentSha256: '3'.repeat(64),
    openedAt: '2026-07-18T12:00:00.000Z',
  });
}

async function seedFullPendingStore(core, first) {
  const seeded = [];
  if (first) {
    await seedPendingIntent(core, first.delta, first.proposal);
    seeded.push(first);
  }
  for (let index = seeded.length; index < 256; index += 1) {
    const sequence = `pending-${index.toString().padStart(3, '0')}`;
    const identity = {
      ...RECEIPT_IDENTITY,
      turnId: `turn-b4-pending-${index.toString().padStart(3, '0')}`,
    };
    const proposal = proposalFixture(sequence);
    const delta = deltaFixture(proposal, identity);
    await seedPendingIntent(core, delta, proposal);
    seeded.push({ delta, proposal });
  }
  assert.equal((await listFilesRecursive(pendingDirectory(core))).length, 256);
  return seeded;
}

async function listFilesRecursive(root) {
  const files = [];
  async function walk(directory) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      if (entry.isFile()) files.push(absolute);
    }
  }
  await walk(root);
  return files.sort();
}

function frontmatterValue(content, key) {
  const match = content.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  assert.ok(match, `candidate frontmatter must contain ${key}`);
  return JSON.parse(match[1]);
}

async function candidateRecords(core) {
  const files = (await listFilesRecursive(core.workspace.candidatesDir))
    .filter((file) => file.endsWith('.md'));
  return await Promise.all(files.map(async (file) => {
    const content = await fs.readFile(file, 'utf8');
    return {
      path: path.relative(core.workspace.candidatesDir, file).split(path.sep).join('/'),
      candidateId: frontmatterValue(content, 'candidate_id'),
      proposalId: frontmatterValue(content, 'proposal_id'),
      content,
    };
  }));
}

function assertNoRawConversationFields(value) {
  const forbidden = ['prompt', 'response', 'transcriptbody', 'rawcontent', 'messagehistory'];
  const visit = (current) => {
    if (!current || typeof current !== 'object') return;
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    for (const [key, child] of Object.entries(current)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      assert.equal(
        forbidden.some((name) => normalized.includes(name)),
        false,
        `raw conversation field must not persist: ${key}`,
      );
      visit(child);
    }
  };
  visit(value);
}

async function persistedWorkspaceText(core) {
  const files = await listFilesRecursive(core.workspace.spaceDir);
  const chunks = [];
  for (const file of files) {
    chunks.push(await fs.readFile(file, 'utf8'));
  }
  return chunks.join('\n');
}

test('recovers a proposal-durable capture intent before emitting its turn receipt', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-b4-capture-intent-')));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });

  const openOptions = { root, cwd: root, space: 'capture-intents-test', engine: 'fts' };
  let core = await openCore(openOptions);
  const inputSourceHash = core.turnReceipts.hashSourceId('host-input/turn-b4-capture-001');
  const opened = await core.turnReceipts.open({
    schemaVersion: 1,
    ...RECEIPT_IDENTITY,
    inputSourceHash,
    inputContentSha256: '3'.repeat(64),
    openedAt: '2026-07-18T12:00:00.000Z',
  });
  assert.equal(opened.state, 'OPEN');
  assert.equal(opened.deltaState, 'not_emitted');

  const proposal = proposalFixture();
  const delta = deltaFixture(proposal);

  await assert.rejects(
    async () => await core.captureTurnDelta(delta, { failAfter: 'proposal_durable' }),
    /proposal_durable/,
  );

  core = await openCore(openOptions);
  const crashedReceipt = await core.turnReceipts.read(RECEIPT_IDENTITY);
  const crashedCandidates = await candidateRecords(core);
  const crashedIntents = (await listFilesRecursive(path.join(core.workspace.spaceDir, 'capture-intents', 'pending')))
    .filter((file) => file.endsWith('.json'));
  assert.ok(crashedReceipt);
  assert.equal(crashedReceipt.deltaState, 'not_emitted');
  assert.equal(crashedReceipt.deltaLinkage, undefined);
  assert.equal(crashedCandidates.length, 1, 'proposal_durable must leave exactly one review candidate');
  assert.equal(crashedIntents.length, 1);
  const deltaId = path.basename(crashedIntents[0], '.json');
  assert.match(deltaId, /^ci1_[a-f0-9]{64}$/);
  assert.equal(crashedCandidates[0].proposalId, proposal.proposalId);
  assert.equal(
    crashedReceipt.deltaState === 'emitted' && crashedCandidates.length === 0,
    false,
    'a crash state must never expose emitted-without-proposal',
  );

  const recovery = await core.recoverCaptureIntents();
  assert.equal(recovery.recovered, 1);
  assert.equal(recovery.pending, 0);
  assert.equal(
    recovery.completed + recovery.cleaned,
    1,
    'the recovered CaptureIntentV1 must be complete or cleaned',
  );

  const recoveredReceipt = await core.turnReceipts.read(RECEIPT_IDENTITY);
  const recoveredCandidates = await candidateRecords(core);
  assert.ok(recoveredReceipt);
  assert.equal(recoveredReceipt.deltaState, 'emitted');
  assert.deepEqual(recoveredReceipt.deltaLinkage, {
    deltaId,
    deltaHash: delta.deltaHash,
    proposalId: proposal.proposalId,
  });
  assert.equal(recoveredCandidates.length, 1);
  assert.equal(recoveredCandidates[0].proposalId, proposal.proposalId);
  assert.equal(recoveredCandidates[0].candidateId, crashedCandidates[0].candidateId);
  assert.equal(recoveredCandidates[0].path, crashedCandidates[0].path);

  await core.captureTurnDelta(delta);
  const replayedReceipt = await core.turnReceipts.read(RECEIPT_IDENTITY);
  const replayedCandidates = await candidateRecords(core);
  assert.deepEqual(replayedReceipt, recoveredReceipt);
  assert.equal(replayedCandidates.length, 1, 'the deterministic capture key must not duplicate candidates');
  assert.equal(replayedCandidates[0].candidateId, crashedCandidates[0].candidateId);
  assert.equal(replayedCandidates[0].path, crashedCandidates[0].path);
  assert.equal(replayedCandidates[0].proposalId, proposal.proposalId);

  const settled = await core.recoverCaptureIntents();
  assert.equal(settled.recovered, 0, 'a completed or cleaned intent must not recover twice');
  assert.equal(settled.pending, 0);

  assertNoRawConversationFields(crashedReceipt);
  assertNoRawConversationFields(recovery);
  assertNoRawConversationFields(recoveredReceipt);
  assertNoRawConversationFields(settled);
  assert.doesNotMatch(
    await persistedWorkspaceText(core),
    /(?:^|[,{\n]\s*)["']?(?:prompt|response|transcript_body|raw_content|message_history)["']?\s*:/im,
  );
});

test('a new capture key is rejected at 256 pending intents before any side effect', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-b4-capture-full-')));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const core = await openCore({ root, cwd: root, space: 'capture-full-test', engine: 'fts' });
  const identity = { ...RECEIPT_IDENTITY, turnId: 'turn-b4-capture-full-new' };
  await openReceipt(core, identity);
  const proposal = proposalFixture('full-new');
  const delta = deltaFixture(proposal, identity);
  await seedFullPendingStore(core);

  const receiptFile = path.join(core.workspace.spaceDir, 'turn-receipts', 'v1.json');
  const before = {
    pending: await snapshotFiles(pendingDirectory(core)),
    candidates: await snapshotFiles(core.workspace.candidatesDir),
    receiptBytes: await fs.readFile(receiptFile),
    receipt: await core.turnReceipts.read(identity),
  };

  await assert.rejects(
    async () => await core.captureTurnDelta(delta),
    /capture_intent_store_full/,
  );

  assert.deepEqual(await snapshotFiles(pendingDirectory(core)), before.pending);
  assert.deepEqual(await snapshotFiles(core.workspace.candidatesDir), before.candidates);
  assert.deepEqual(await fs.readFile(receiptFile), before.receiptBytes);
  assert.deepEqual(await core.turnReceipts.read(identity), before.receipt);
});

test('an existing capture key remains idempotently completable at the 256 pending limit', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-b4-capture-full-replay-')));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const core = await openCore({ root, cwd: root, space: 'capture-full-replay-test', engine: 'fts' });
  const identity = { ...RECEIPT_IDENTITY, turnId: 'turn-b4-capture-full-replay' };
  await openReceipt(core, identity);
  const proposal = proposalFixture('full-replay');
  const delta = deltaFixture(proposal, identity);
  await seedFullPendingStore(core, { delta, proposal });

  const result = await core.captureTurnDelta(delta);
  assert.equal(result.captureIntentKey, captureIntentKey(delta, proposal));
  assert.deepEqual(result.receipt.deltaLinkage, {
    deltaId: result.captureIntentKey,
    deltaHash: delta.deltaHash,
    proposalId: proposal.proposalId,
  });
  assert.equal((await listFilesRecursive(pendingDirectory(core))).length, 255);
  assert.equal((await candidateRecords(core)).length, 1);
});

test('the pre-write full-store scan validates every pending entry before reporting capacity', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-b4-capture-full-invalid-')));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const core = await openCore({ root, cwd: root, space: 'capture-full-invalid-test', engine: 'fts' });
  const identity = { ...RECEIPT_IDENTITY, turnId: 'turn-b4-capture-full-invalid-new' };
  await openReceipt(core, identity);
  const proposal = proposalFixture('full-invalid-new');
  const delta = deltaFixture(proposal, identity);
  const seeded = await seedFullPendingStore(core);
  const invalidFile = path.join(pendingDirectory(core), `${captureIntentKey(seeded[127].delta, seeded[127].proposal)}.json`);
  await fs.writeFile(invalidFile, '{"schemaVersion":1}\n', { mode: 0o600 });

  const before = {
    pending: await snapshotFiles(pendingDirectory(core)),
    candidates: await snapshotFiles(core.workspace.candidatesDir),
    receipt: await core.turnReceipts.read(identity),
  };
  await assert.rejects(
    async () => await core.captureTurnDelta(delta),
    /capture_delta_missing_field/,
  );
  assert.deepEqual(await snapshotFiles(pendingDirectory(core)), before.pending);
  assert.deepEqual(await snapshotFiles(core.workspace.candidatesDir), before.candidates);
  assert.deepEqual(await core.turnReceipts.read(identity), before.receipt);
});

test('a stale pending intent stops new capture and same-key replay without refreshing or side effects', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-b4-capture-stale-')));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const core = await openCore({ root, cwd: root, space: 'capture-stale-test', engine: 'fts' });
  const staleIdentity = { ...RECEIPT_IDENTITY, turnId: 'turn-b4-capture-stale-existing' };
  const newIdentity = { ...RECEIPT_IDENTITY, turnId: 'turn-b4-capture-stale-new' };
  await openReceipt(core, staleIdentity);
  await openReceipt(core, newIdentity);
  const staleProposal = proposalFixture('stale-existing');
  const staleDelta = deltaFixture(staleProposal, staleIdentity);
  const staleFile = await seedPendingIntent(core, staleDelta, staleProposal);
  const staleTime = new Date(Date.now() - 3_601_000);
  await fs.utimes(staleFile, staleTime, staleTime);
  const newProposal = proposalFixture('stale-new');
  const newDelta = deltaFixture(newProposal, newIdentity);
  const receiptFile = path.join(core.workspace.spaceDir, 'turn-receipts', 'v1.json');
  const before = {
    pending: await snapshotFiles(pendingDirectory(core)),
    candidates: await snapshotFiles(core.workspace.candidatesDir),
    receiptBytes: await fs.readFile(receiptFile),
    staleReceipt: await core.turnReceipts.read(staleIdentity),
    newReceipt: await core.turnReceipts.read(newIdentity),
  };

  for (const attempt of [
    async () => await core.captureTurnDelta(newDelta),
    async () => await core.captureTurnDelta(staleDelta),
  ]) {
    await assert.rejects(attempt, /capture_intent_stale/);
    assert.deepEqual(await snapshotFiles(pendingDirectory(core)), before.pending);
    assert.deepEqual(await snapshotFiles(core.workspace.candidatesDir), before.candidates);
    assert.deepEqual(await fs.readFile(receiptFile), before.receiptBytes);
    assert.deepEqual(await core.turnReceipts.read(staleIdentity), before.staleReceipt);
    assert.deepEqual(await core.turnReceipts.read(newIdentity), before.newReceipt);
  }
});

test('recovery preflights all pending ages before candidate or receipt side effects', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-b4-recover-stale-')));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const core = await openCore({ root, cwd: root, space: 'recover-stale-test', engine: 'fts' });
  const fixtures = [];
  for (const label of ['recover-valid', 'recover-stale']) {
    const identity = { ...RECEIPT_IDENTITY, turnId: `turn-b4-${label}` };
    await openReceipt(core, identity);
    const proposal = proposalFixture(label);
    const delta = deltaFixture(proposal, identity);
    const file = await seedPendingIntent(core, delta, proposal);
    fixtures.push({ identity, proposal, delta, file });
  }
  const orderedFiles = fixtures.map((fixture) => fixture.file).sort((a, b) => a.localeCompare(b));
  const staleTime = new Date(Date.now() - 3_601_000);
  await fs.utimes(orderedFiles[1], staleTime, staleTime);
  const receiptFile = path.join(core.workspace.spaceDir, 'turn-receipts', 'v1.json');
  const before = {
    pending: await snapshotFiles(pendingDirectory(core)),
    candidates: await snapshotFiles(core.workspace.candidatesDir),
    receiptBytes: await fs.readFile(receiptFile),
    receipts: await core.turnReceipts.list(),
  };

  await assert.rejects(
    async () => await core.recoverCaptureIntents(),
    /capture_intent_stale/,
  );
  assert.deepEqual(await snapshotFiles(pendingDirectory(core)), before.pending);
  assert.deepEqual(await snapshotFiles(core.workspace.candidatesDir), before.candidates);
  assert.deepEqual(await fs.readFile(receiptFile), before.receiptBytes);
  assert.deepEqual(await core.turnReceipts.list(), before.receipts);
});

test('a future pending intent mtime is rejected as capture_intent_stale', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-b4-capture-future-')));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const core = await openCore({ root, cwd: root, space: 'capture-future-test', engine: 'fts' });
  const identity = { ...RECEIPT_IDENTITY, turnId: 'turn-b4-capture-future' };
  await openReceipt(core, identity);
  const proposal = proposalFixture('future');
  const delta = deltaFixture(proposal, identity);
  const file = await seedPendingIntent(core, delta, proposal);
  const futureTime = new Date(Date.now() + 60_000);
  await fs.utimes(file, futureTime, futureTime);
  const before = {
    pending: await snapshotFiles(pendingDirectory(core)),
    candidates: await snapshotFiles(core.workspace.candidatesDir),
    receipt: await core.turnReceipts.read(identity),
  };

  await assert.rejects(
    async () => await core.captureTurnDelta(delta),
    /capture_intent_stale/,
  );
  await assert.rejects(
    async () => await core.recoverCaptureIntents(),
    /capture_intent_stale/,
  );
  assert.deepEqual(await snapshotFiles(pendingDirectory(core)), before.pending);
  assert.deepEqual(await snapshotFiles(core.workspace.candidatesDir), before.candidates);
  assert.deepEqual(await core.turnReceipts.read(identity), before.receipt);
});
