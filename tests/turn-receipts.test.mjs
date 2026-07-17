// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openCore } from '../src/core.ts';

async function createTestCore(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-turn-receipts-')));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return await openCore({ root, cwd: root, space: 'turn-receipts-test' });
}

const BASE_IDENTITY = Object.freeze({
  runtime: 'hermes',
  projectId: '1'.repeat(64),
  sessionHash: '2'.repeat(64),
  turnId: 'turn-001',
  revision: 1,
});

function openInput(identity = BASE_IDENTITY, overrides = {}) {
  return {
    schemaVersion: 1,
    ...identity,
    inputSource: 'host-inputs/turn-001',
    inputContentSha256: 'a'.repeat(64),
    openedAt: '2026-07-17T12:00:00.000Z',
    ...overrides,
  };
}

function commitInput(identity = BASE_IDENTITY, overrides = {}) {
  return {
    schemaVersion: 1,
    ...identity,
    inputSource: 'host-inputs/turn-001',
    inputContentSha256: 'a'.repeat(64),
    finalSource: 'host-transcript/turn-001/revision-1',
    finalContentSha256: 'b'.repeat(64),
    committedAt: '2026-07-17T12:00:03.000Z',
    deltaState: 'explicit_none',
    ...overrides,
  };
}

test('creates an OPEN receipt and reads/lists the durable receipt', async (t) => {
  const core = await createTestCore(t);
  const receipt = await core.turnReceipts.open({
    schemaVersion: 1,
    ...BASE_IDENTITY,
    inputSource: 'host-inputs/turn-001',
    inputContentSha256: 'a'.repeat(64),
    openedAt: '2026-07-17T12:00:00.000Z',
  });

  assert.deepEqual(receipt, {
    schemaVersion: 1,
    state: 'OPEN',
    ...BASE_IDENTITY,
    inputSource: 'host-inputs/turn-001',
    inputContentSha256: 'a'.repeat(64),
    openedAt: '2026-07-17T12:00:00.000Z',
    deltaState: 'not_emitted',
  });
  assert.deepEqual(await core.turnReceipts.read(BASE_IDENTITY), receipt);
  assert.deepEqual(await core.turnReceipts.list(), [receipt]);
  assert.equal(JSON.stringify(receipt).includes('sessionId'), false);
});

test('rejects COMMITTED when the identity/revision has no OPEN receipt', async (t) => {
  const core = await createTestCore(t);
  await assert.rejects(async () => await core.turnReceipts.commit(commitInput()), /turn_receipt_open_required/);
});

test('identical replays are idempotent, COMMITTED replaces OPEN, and OPEN cannot regress it', async (t) => {
  const core = await createTestCore(t);
  const opened = await core.turnReceipts.open(openInput());
  assert.deepEqual(await core.turnReceipts.open(openInput()), opened);

  const committed = await core.turnReceipts.commit(commitInput());
  assert.deepEqual(committed, {
    ...opened,
    state: 'COMMITTED',
    finalSource: 'host-transcript/turn-001/revision-1',
    finalContentSha256: 'b'.repeat(64),
    committedAt: '2026-07-17T12:00:03.000Z',
    deltaState: 'explicit_none',
  });
  assert.deepEqual(await core.turnReceipts.commit(commitInput()), committed);
  assert.deepEqual(await core.turnReceipts.open(openInput()), committed);
  assert.deepEqual(await core.turnReceipts.read(BASE_IDENTITY), committed);
  assert.deepEqual(await core.turnReceipts.list(), [committed]);
});

test('same identity/revision with conflicting source or content hashes fails closed', async (t) => {
  const core = await createTestCore(t);
  await core.turnReceipts.open(openInput());

  await assert.rejects(
    async () => await core.turnReceipts.open(openInput(BASE_IDENTITY, { inputSource: 'host-inputs/other' })),
    /turn_receipt_conflict/,
  );
  await assert.rejects(
    async () => await core.turnReceipts.open(openInput(BASE_IDENTITY, { inputContentSha256: 'c'.repeat(64) })),
    /turn_receipt_conflict/,
  );

  await core.turnReceipts.commit(commitInput());
  await assert.rejects(
    async () => await core.turnReceipts.commit(commitInput(BASE_IDENTITY, { finalSource: 'host-transcript/other' })),
    /turn_receipt_conflict/,
  );
  await assert.rejects(
    async () => await core.turnReceipts.commit(commitInput(BASE_IDENTITY, { finalContentSha256: 'd'.repeat(64) })),
    /turn_receipt_conflict/,
  );
  await assert.rejects(
    async () => await core.turnReceipts.commit(commitInput(BASE_IDENTITY, { deltaState: 'extraction_failed' })),
    /turn_receipt_conflict/,
  );
});

test('supports all delta states and gaps exclude only COMMITTED explicit_none', async (t) => {
  const core = await createTestCore(t);
  const identities = {
    explicit: { ...BASE_IDENTITY, turnId: 'turn-explicit' },
    notEmitted: { ...BASE_IDENTITY, turnId: 'turn-not-emitted' },
    failed: { ...BASE_IDENTITY, turnId: 'turn-extraction' },
    open: { ...BASE_IDENTITY, turnId: 'turn-open' },
  };

  for (const identity of Object.values(identities)) await core.turnReceipts.open(openInput(identity));
  await core.turnReceipts.commit(commitInput(identities.explicit, { deltaState: 'explicit_none' }));
  await core.turnReceipts.commit(commitInput(identities.notEmitted, { deltaState: 'not_emitted' }));
  await core.turnReceipts.commit(commitInput(identities.failed, { deltaState: 'extraction_failed' }));

  const allDeltaStates = (await core.turnReceipts.list())
    .filter((receipt) => receipt.state === 'COMMITTED')
    .map((receipt) => receipt.deltaState)
    .sort();
  assert.deepEqual(allDeltaStates, ['explicit_none', 'extraction_failed', 'not_emitted']);

  const gaps = await core.turnReceipts.gaps();
  assert.deepEqual(
    gaps.map((receipt) => `${receipt.turnId}:${receipt.state}:${receipt.deltaState}`).sort(),
    [
      'turn-extraction:COMMITTED:extraction_failed',
      'turn-not-emitted:COMMITTED:not_emitted',
      'turn-open:OPEN:not_emitted',
    ],
  );
});

test('preserves older revisions in numeric order while currentOnly lists the newest revision', async (t) => {
  const core = await createTestCore(t);
  const revision1 = { ...BASE_IDENTITY, turnId: 'turn-revised', revision: 1 };
  const revision2 = { ...revision1, revision: 2 };
  const revision10 = { ...revision1, revision: 10 };

  const opened1 = await core.turnReceipts.open(openInput(revision1));
  const committed1 = await core.turnReceipts.commit(commitInput(revision1));
  const opened2 = await core.turnReceipts.open(openInput(revision2, {
    inputSource: 'host-inputs/turn-revised/revision-2',
    inputContentSha256: 'c'.repeat(64),
    openedAt: '2026-07-17T12:01:00.000Z',
  }));
  const opened10 = await core.turnReceipts.open(openInput(revision10, {
    inputSource: 'host-inputs/turn-revised/revision-10',
    inputContentSha256: 'd'.repeat(64),
    openedAt: '2026-07-17T12:02:00.000Z',
  }));

  assert.equal(opened1.revision, 1);
  assert.equal(opened2.revision, 2);
  assert.deepEqual(await core.turnReceipts.read(revision1), committed1);
  assert.deepEqual((await core.turnReceipts.list()).map((receipt) => receipt.revision), [1, 2, 10]);
  assert.deepEqual(await core.turnReceipts.list({ currentOnly: true }), [opened10]);
});

test('rejects unknown, oversized, raw-content, inline-data, and unhashed identity fields', async (t) => {
  const core = await createTestCore(t);

  await assert.rejects(
    async () => await core.turnReceipts.open(openInput(BASE_IDENTITY, {
      inputSource: 'data:text/plain,raw-prompt-body',
    })),
    /turn_receipt_input_source_invalid/,
  );
  await assert.rejects(
    async () => await core.turnReceipts.open({ ...openInput(), unexpected: true }),
    /turn_receipt_unknown_field:unexpected/,
  );
  await assert.rejects(
    async () => await core.turnReceipts.open({ ...openInput(), sessionId: 'raw-session-id' }),
    /turn_receipt_unknown_field:sessionId/,
  );
  await assert.rejects(
    async () => await core.turnReceipts.open(openInput({ ...BASE_IDENTITY, turnId: 't'.repeat(129) })),
    /turn_receipt_turn_id_too_large/,
  );
  await assert.rejects(
    async () => await core.turnReceipts.open(openInput(BASE_IDENTITY, { inputSource: `host/${'x'.repeat(508)}` })),
    /turn_receipt_input_source_too_large/,
  );
  await assert.rejects(
    async () => await core.turnReceipts.open(openInput({ ...BASE_IDENTITY, sessionHash: 'raw-session-id' })),
    /turn_receipt_session_hash_invalid/,
  );

  for (const forbidden of [
    { rawPrompt: 'secret' },
    { assistantResponse: 'secret' },
    { transcriptBody: 'secret' },
    { conversationHistory: ['secret'] },
    { toolOutput: 'secret' },
  ]) {
    await assert.rejects(
      async () => await core.turnReceipts.open({ ...openInput(), ...forbidden }),
      /turn_receipt_raw_content_forbidden/,
    );
  }
  assert.deepEqual(await core.turnReceipts.list(), []);
});

test('hashes raw session identity deterministically and never persists the raw value', async (t) => {
  const core = await createTestCore(t);
  const rawSessionId = 'private-session-2026-07-17';
  const sessionHash = core.turnReceipts.hashSessionId(rawSessionId);

  assert.match(sessionHash, /^[a-f0-9]{64}$/);
  assert.equal(core.turnReceipts.hashSessionId(rawSessionId), sessionHash);
  assert.notEqual(core.turnReceipts.hashSessionId(`${rawSessionId}-other`), sessionHash);

  await core.turnReceipts.open(openInput({ ...BASE_IDENTITY, sessionHash }));
  const persisted = await fs.readFile(path.join(core.workspace.spaceDir, 'turn-receipts', 'v1.json'), 'utf8');
  assert.equal(persisted.includes(rawSessionId), false);
  assert.equal(persisted.includes(sessionHash), true);
});

test('concurrent identical OPEN and COMMITTED writes converge to one receipt', async (t) => {
  const first = await createTestCore(t);
  const second = await openCore({
    root: first.workspace.root,
    cwd: first.workspace.root,
    space: first.workspace.space,
  });

  const opens = await Promise.all(Array.from({ length: 32 }, (_, index) => (
    (index % 2 === 0 ? first : second).turnReceipts.open(openInput())
  )));
  assert.equal(new Set(opens.map((receipt) => JSON.stringify(receipt))).size, 1);
  assert.equal((await first.turnReceipts.list()).length, 1);

  const commits = await Promise.all(Array.from({ length: 32 }, (_, index) => (
    (index % 2 === 0 ? first : second).turnReceipts.commit(commitInput())
  )));
  assert.equal(new Set(commits.map((receipt) => JSON.stringify(receipt))).size, 1);
  assert.equal((await second.turnReceipts.list()).length, 1);
  assert.equal((await second.turnReceipts.read(BASE_IDENTITY)).state, 'COMMITTED');

  const storeEntries = await fs.readdir(path.join(first.workspace.spaceDir, 'turn-receipts'));
  assert.deepEqual(storeEntries, ['v1.json']);
  await assert.rejects(fs.access(first.workspace.lockPath));
});

test('store is path-contained, leaves no temp files, and temporary roots clean up', async (t) => {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-turn-containment-')));
  t.after(async () => { await fs.rm(parent, { recursive: true, force: true }); });
  const root = path.join(parent, 'root');
  const outside = path.join(parent, 'outside');
  await fs.mkdir(root);
  await fs.mkdir(outside);
  const core = await openCore({ root, cwd: root, space: 'contained' });
  const receiptDir = path.join(core.workspace.spaceDir, 'turn-receipts');
  const outsideStore = path.join(outside, 'v1.json');
  const outsideBefore = '{"schemaVersion":1,"receipts":[]}\n';
  await fs.writeFile(outsideStore, outsideBefore, 'utf8');
  await fs.symlink(outside, receiptDir, 'dir');

  await assert.rejects(
    async () => await core.turnReceipts.open(openInput()),
    /turn_receipt_path_outside_store/,
  );
  assert.equal(await fs.readFile(outsideStore, 'utf8'), outsideBefore);
  assert.deepEqual(await fs.readdir(outside), ['v1.json']);

  await fs.rm(receiptDir);
  await core.turnReceipts.open(openInput());
  assert.deepEqual(await fs.readdir(receiptDir), ['v1.json']);
  await assert.rejects(fs.access(core.workspace.lockPath));

  await fs.rm(parent, { recursive: true, force: true });
  await assert.rejects(fs.access(parent));
});
