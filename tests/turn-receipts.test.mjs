// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { openCore } from '../src/core.ts';

const execFileAsync = promisify(execFile);
const CORE_MODULE_URL = new URL('../src/core.ts', import.meta.url).href;

function expectedSourceHash(rawSourceId) {
  return `sha256:${crypto.createHash('sha256')
    .update('turn-receipt-source-v1\0')
    .update(rawSourceId)
    .digest('hex')}`;
}

const INPUT_SOURCE_HASH = expectedSourceHash('host-inputs/turn-001');
const FINAL_SOURCE_HASH = expectedSourceHash('host-transcript/turn-001/revision-1');

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
    inputSourceHash: INPUT_SOURCE_HASH,
    inputContentSha256: 'a'.repeat(64),
    openedAt: '2026-07-17T12:00:00.000Z',
    ...overrides,
  };
}

function commitInput(identity = BASE_IDENTITY, overrides = {}) {
  return {
    schemaVersion: 1,
    ...identity,
    inputSourceHash: INPUT_SOURCE_HASH,
    inputContentSha256: 'a'.repeat(64),
    finalSourceHash: FINAL_SOURCE_HASH,
    finalContentSha256: 'b'.repeat(64),
    committedAt: '2026-07-17T12:00:03.000Z',
    deltaState: 'explicit_none',
    ...overrides,
  };
}

function receiptPaths(core) {
  const directory = path.join(core.workspace.spaceDir, 'turn-receipts');
  return { directory, file: path.join(directory, 'v1.json') };
}

function storedOpenReceipt(identity, overrides = {}) {
  return {
    schemaVersion: 1,
    state: 'OPEN',
    ...identity,
    inputSourceHash: expectedSourceHash(`input/${identity.turnId}/${identity.revision}`),
    inputContentSha256: 'a'.repeat(64),
    openedAt: '2026-07-17T12:00:00.000Z',
    deltaState: 'not_emitted',
    ...overrides,
  };
}

function storedCommittedReceipt(identity, overrides = {}) {
  return {
    ...storedOpenReceipt(identity),
    state: 'COMMITTED',
    finalSourceHash: expectedSourceHash(`final/${identity.turnId}/${identity.revision}`),
    finalContentSha256: 'b'.repeat(64),
    committedAt: '2026-07-17T12:00:03.000Z',
    deltaState: 'explicit_none',
    ...overrides,
  };
}

async function plantStore(core, receipts) {
  const { directory, file } = receiptPaths(core);
  await fs.mkdir(directory, { mode: 0o700 });
  const bytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, receipts }, null, 2)}\n`);
  await fs.writeFile(file, bytes, { mode: 0o600 });
  return { directory, file, bytes };
}

function receiptKey(receipt) {
  return [receipt.runtime, receipt.projectId, receipt.sessionHash, receipt.turnId, receipt.revision].join(':');
}

async function collectPages(fetchPage, options = {}, limit = 23) {
  const items = [];
  let offset = 0;
  let expectedTotal;
  for (;;) {
    const page = await fetchPage({ ...options, offset, limit });
    expectedTotal ??= page.total;
    assert.equal(page.total, expectedTotal);
    assert.ok(page.items.length <= limit);
    items.push(...page.items);
    if (page.nextOffset === null) break;
    assert.equal(page.nextOffset, offset + page.items.length);
    assert.ok(page.nextOffset > offset);
    offset = page.nextOffset;
  }
  assert.equal(items.length, expectedTotal);
  assert.equal(new Set(items.map(receiptKey)).size, items.length);
  return items;
}

test('creates an OPEN receipt and reads/lists the durable receipt', async (t) => {
  const core = await createTestCore(t);
  const receipt = await core.turnReceipts.open({
    schemaVersion: 1,
    ...BASE_IDENTITY,
    inputSourceHash: INPUT_SOURCE_HASH,
    inputContentSha256: 'a'.repeat(64),
    openedAt: '2026-07-17T12:00:00.000Z',
  });

  assert.deepEqual(receipt, {
    schemaVersion: 1,
    state: 'OPEN',
    ...BASE_IDENTITY,
    inputSourceHash: INPUT_SOURCE_HASH,
    inputContentSha256: 'a'.repeat(64),
    openedAt: '2026-07-17T12:00:00.000Z',
    deltaState: 'not_emitted',
  });
  assert.deepEqual(await core.turnReceipts.read(BASE_IDENTITY), receipt);
  assert.deepEqual(await core.turnReceipts.list(), {
    items: [receipt],
    total: 1,
    nextOffset: null,
  });
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
    finalSourceHash: FINAL_SOURCE_HASH,
    finalContentSha256: 'b'.repeat(64),
    committedAt: '2026-07-17T12:00:03.000Z',
    deltaState: 'explicit_none',
  });
  assert.deepEqual(await core.turnReceipts.commit(commitInput()), committed);
  assert.deepEqual(await core.turnReceipts.open(openInput()), committed);
  assert.deepEqual(await core.turnReceipts.read(BASE_IDENTITY), committed);
  assert.deepEqual((await core.turnReceipts.list()).items, [committed]);
});

test('same identity/revision with conflicting source or content hashes fails closed', async (t) => {
  const core = await createTestCore(t);
  await core.turnReceipts.open(openInput());

  await assert.rejects(
    async () => await core.turnReceipts.open(openInput(BASE_IDENTITY, {
      inputSourceHash: expectedSourceHash('host-inputs/other'),
    })),
    /turn_receipt_conflict/,
  );
  await assert.rejects(
    async () => await core.turnReceipts.open(openInput(BASE_IDENTITY, { inputContentSha256: 'c'.repeat(64) })),
    /turn_receipt_conflict/,
  );

  await core.turnReceipts.commit(commitInput());
  await assert.rejects(
    async () => await core.turnReceipts.commit(commitInput(BASE_IDENTITY, {
      finalSourceHash: expectedSourceHash('host-transcript/other'),
    })),
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

  const allDeltaStates = (await core.turnReceipts.list()).items
    .filter((receipt) => receipt.state === 'COMMITTED')
    .map((receipt) => receipt.deltaState)
    .sort();
  assert.deepEqual(allDeltaStates, ['explicit_none', 'extraction_failed', 'not_emitted']);

  const gaps = (await core.turnReceipts.gaps()).items;
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
    inputSourceHash: expectedSourceHash('host-inputs/turn-revised/revision-2'),
    inputContentSha256: 'c'.repeat(64),
    openedAt: '2026-07-17T12:01:00.000Z',
  }));
  const opened10 = await core.turnReceipts.open(openInput(revision10, {
    inputSourceHash: expectedSourceHash('host-inputs/turn-revised/revision-10'),
    inputContentSha256: 'd'.repeat(64),
    openedAt: '2026-07-17T12:02:00.000Z',
  }));

  assert.equal(opened1.revision, 1);
  assert.equal(opened2.revision, 2);
  assert.deepEqual(await core.turnReceipts.read(revision1), committed1);
  assert.deepEqual((await core.turnReceipts.list()).items.map((receipt) => receipt.revision), [1, 2, 10]);
  assert.deepEqual((await core.turnReceipts.list({ currentOnly: true })).items, [opened10]);
});

test('rejects unknown, oversized, raw-content, raw-source, and unhashed identity fields', async (t) => {
  const core = await createTestCore(t);

  for (const rawSource of [
    'password=hunter2',
    '/private/var/tmp/ihow/source/transcript.json',
    'https://private.example/session/123',
    'data:text/plain,raw-prompt-body',
    'plain source identity prose',
    `sha256:${'A'.repeat(64)}`,
  ]) {
    await assert.rejects(
      async () => await core.turnReceipts.open(openInput(BASE_IDENTITY, {
        inputSourceHash: rawSource,
      })),
      /turn_receipt_input_source_hash_invalid/,
    );
  }
  await assert.rejects(
    async () => await core.turnReceipts.open({ ...openInput(), inputSource: 'password=hunter2' }),
    /turn_receipt_unknown_field:inputSource/,
  );
  await assert.rejects(
    async () => await core.turnReceipts.commit(commitInput(BASE_IDENTITY, {
      finalSourceHash: '/private/var/tmp/ihow/source/transcript.json',
    })),
    /turn_receipt_final_source_hash_invalid/,
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
    async () => await core.turnReceipts.open(openInput(BASE_IDENTITY, {
      inputSourceHash: `sha256:${'x'.repeat(64)}`,
    })),
    /turn_receipt_input_source_hash_invalid/,
  );
  await assert.rejects(
    async () => await core.turnReceipts.open(openInput({ ...BASE_IDENTITY, sessionHash: 'raw-session-id' })),
    /turn_receipt_session_hash_invalid/,
  );
  await assert.rejects(
    async () => await core.turnReceipts.list({ offset: -1 }),
    /turn_receipt_list_offset_invalid/,
  );
  await assert.rejects(
    async () => await core.turnReceipts.list({ limit: 101 }),
    /turn_receipt_list_limit_invalid/,
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
  assert.deepEqual((await core.turnReceipts.list()).items, []);
});

test('hashes raw session/source identities deterministically and persists no raw canaries', async (t) => {
  const core = await createTestCore(t);
  const rawSessionId = 'private-session-2026-07-17';
  const rawInputSourceId = 'password=hunter2';
  const rawFinalSourceId = '/private/var/tmp/ihow/source/transcript.json';
  const sessionHash = core.turnReceipts.hashSessionId(rawSessionId);
  const inputSourceHash = core.turnReceipts.hashSourceId(rawInputSourceId);
  const finalSourceHash = core.turnReceipts.hashSourceId(rawFinalSourceId);

  assert.match(sessionHash, /^[a-f0-9]{64}$/);
  assert.equal(core.turnReceipts.hashSessionId(rawSessionId), sessionHash);
  assert.notEqual(core.turnReceipts.hashSessionId(`${rawSessionId}-other`), sessionHash);
  assert.equal(inputSourceHash, expectedSourceHash(rawInputSourceId));
  assert.match(inputSourceHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(core.turnReceipts.hashSourceId(rawInputSourceId), inputSourceHash);
  assert.notEqual(core.turnReceipts.hashSourceId(`${rawInputSourceId}-other`), inputSourceHash);
  assert.throws(() => core.turnReceipts.hashSourceId(''), /turn_receipt_source_id_invalid/);
  assert.throws(() => core.turnReceipts.hashSourceId('a\u0000b'), /turn_receipt_source_id_invalid/);
  assert.throws(() => core.turnReceipts.hashSourceId('x'.repeat(513)), /turn_receipt_source_id_too_large/);

  await core.turnReceipts.open(openInput({ ...BASE_IDENTITY, sessionHash }, { inputSourceHash }));
  await core.turnReceipts.commit(commitInput({ ...BASE_IDENTITY, sessionHash }, {
    inputSourceHash,
    finalSourceHash,
  }));
  const persisted = await fs.readFile(path.join(core.workspace.spaceDir, 'turn-receipts', 'v1.json'), 'utf8');
  assert.equal(persisted.includes(rawSessionId), false);
  assert.equal(persisted.includes(rawInputSourceId), false);
  assert.equal(persisted.includes(rawFinalSourceId), false);
  assert.equal(persisted.includes(sessionHash), true);
  assert.equal(persisted.includes(inputSourceHash), true);
  assert.equal(persisted.includes(finalSourceHash), true);
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
  assert.equal((await first.turnReceipts.list()).total, 1);

  const commits = await Promise.all(Array.from({ length: 32 }, (_, index) => (
    (index % 2 === 0 ? first : second).turnReceipts.commit(commitInput())
  )));
  assert.equal(new Set(commits.map((receipt) => JSON.stringify(receipt))).size, 1);
  assert.equal((await second.turnReceipts.list()).total, 1);
  assert.equal((await second.turnReceipts.read(BASE_IDENTITY)).state, 'COMMITTED');

  const storeEntries = await fs.readdir(path.join(first.workspace.spaceDir, 'turn-receipts'));
  assert.deepEqual(storeEntries, ['v1.json']);
  await assert.rejects(fs.access(first.workspace.lockPath));
});

test('twelve separate Node processes converge to one committed receipt', async (t) => {
  const core = await createTestCore(t);
  const childScript = `
    const { openCore } = await import(${JSON.stringify(CORE_MODULE_URL)});
    const core = await openCore(${JSON.stringify({
      root: core.workspace.root,
      cwd: core.workspace.root,
      space: core.workspace.space,
    })});
    const identity = ${JSON.stringify(BASE_IDENTITY)};
    const inputSourceHash = core.turnReceipts.hashSourceId('cross-process-input');
    const finalSourceHash = core.turnReceipts.hashSourceId('cross-process-final');
    await core.turnReceipts.open({
      schemaVersion: 1,
      ...identity,
      inputSourceHash,
      inputContentSha256: '${'a'.repeat(64)}',
      openedAt: '2026-07-17T12:00:00.000Z'
    });
    const receipt = await core.turnReceipts.commit({
      schemaVersion: 1,
      ...identity,
      inputSourceHash,
      inputContentSha256: '${'a'.repeat(64)}',
      finalSourceHash,
      finalContentSha256: '${'b'.repeat(64)}',
      committedAt: '2026-07-17T12:00:03.000Z',
      deltaState: 'explicit_none'
    });
    process.stdout.write(JSON.stringify({ state: receipt.state }));
  `;

  const results = await Promise.all(Array.from({ length: 12 }, async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      '--experimental-strip-types',
      '--input-type=module',
      '-e',
      childScript,
    ], { cwd: process.cwd(), timeout: 20_000 });
    return JSON.parse(stdout);
  }));

  assert.deepEqual(new Set(results.map((result) => result.state)), new Set(['COMMITTED']));
  const page = await core.turnReceipts.list();
  assert.equal(page.total, 1);
  assert.equal(page.items[0].state, 'COMMITTED');
  assert.equal(page.nextOffset, null);
});

test('list and gaps paginate every frozen receipt deterministically with currentOnly grouping', async (t) => {
  const core = await createTestCore(t);
  const uniqueGaps = Array.from({ length: 101 }, (_, index) => storedOpenReceipt({
    ...BASE_IDENTITY,
    turnId: `turn-gap-${String(index).padStart(3, '0')}`,
  }));
  const groupedIdentity = { ...BASE_IDENTITY, turnId: 'turn-revision-group' };
  const grouped = [
    storedOpenReceipt({ ...groupedIdentity, revision: 1 }),
    storedCommittedReceipt({ ...groupedIdentity, revision: 2 }),
    storedCommittedReceipt({ ...groupedIdentity, revision: 10 }, { deltaState: 'extraction_failed' }),
  ];
  await plantStore(core, [...grouped, ...uniqueGaps].reverse());

  const all = await collectPages((options) => core.turnReceipts.list(options));
  assert.equal(all.length, 104);
  assert.deepEqual(
    all.filter((receipt) => receipt.turnId === groupedIdentity.turnId).map((receipt) => receipt.revision),
    [1, 2, 10],
  );

  const gaps = await collectPages((options) => core.turnReceipts.gaps(options));
  assert.equal(gaps.length, 103);
  assert.deepEqual(
    gaps.filter((receipt) => receipt.turnId === groupedIdentity.turnId).map((receipt) => receipt.revision),
    [1, 10],
  );

  const currentGaps = await collectPages(
    (options) => core.turnReceipts.gaps(options),
    { currentOnly: true },
  );
  assert.equal(currentGaps.length, 102);
  assert.deepEqual(
    currentGaps.filter((receipt) => receipt.turnId === groupedIdentity.turnId).map((receipt) => receipt.revision),
    [10],
  );
});

test('malformed planted store fails closed and preserves exact bytes', async (t) => {
  const core = await createTestCore(t);
  const { directory, file } = receiptPaths(core);
  await fs.mkdir(directory, { mode: 0o700 });
  const before = Buffer.from('{"schemaVersion":1,"receipts":[');
  await fs.writeFile(file, before, { mode: 0o600 });

  await assert.rejects(
    async () => await core.turnReceipts.open(openInput()),
    /turn_receipt_store_invalid/,
  );
  const after = await fs.readFile(file);
  assert.equal(Buffer.compare(after, before), 0);
});

test('oversized planted store fails closed and preserves exact bytes', async (t) => {
  const core = await createTestCore(t);
  const { directory, file } = receiptPaths(core);
  await fs.mkdir(directory, { mode: 0o700 });
  const before = Buffer.alloc((4 * 1024 * 1024) + 1, 0x78);
  await fs.writeFile(file, before, { mode: 0o600 });

  await assert.rejects(
    async () => await core.turnReceipts.open(openInput()),
    /turn_receipt_store_too_large/,
  );
  const after = await fs.readFile(file);
  assert.equal(Buffer.compare(after, before), 0);
});

test('receipt directory and atomic files are private with no success-path temp files', async (t) => {
  const core = await createTestCore(t);
  await core.turnReceipts.open(openInput());
  await core.turnReceipts.commit(commitInput());
  const { directory, file } = receiptPaths(core);
  const [directoryStat, fileStat, entries] = await Promise.all([
    fs.lstat(directory),
    fs.lstat(file),
    fs.readdir(directory),
  ]);

  assert.equal(directoryStat.isSymbolicLink(), false);
  assert.equal(directoryStat.isDirectory(), true);
  assert.equal(directoryStat.mode & 0o777, 0o700);
  assert.equal(fileStat.isSymbolicLink(), false);
  assert.equal(fileStat.isFile(), true);
  assert.equal(fileStat.mode & 0o777, 0o600);
  assert.deepEqual(entries, ['v1.json']);
});

test('the B1 full condition is explicit, preserves all 4096 receipts, and never evicts', async (t) => {
  const core = await createTestCore(t);
  const receipts = Array.from({ length: 4096 }, (_, index) => storedOpenReceipt({
    ...BASE_IDENTITY,
    turnId: `turn-full-${String(index).padStart(4, '0')}`,
  }));
  const { file, bytes: before } = await plantStore(core, receipts);
  assert.ok(before.byteLength < 4 * 1024 * 1024);

  await assert.rejects(
    async () => await core.turnReceipts.open(openInput({ ...BASE_IDENTITY, turnId: 'turn-over-cap' })),
    /turn_receipt_store_full/,
  );
  const after = await fs.readFile(file);
  assert.equal(Buffer.compare(after, before), 0);

  const first = await core.turnReceipts.list({ limit: 100 });
  const last = await core.turnReceipts.list({ offset: 4000, limit: 100 });
  assert.equal(first.total, 4096);
  assert.equal(first.nextOffset, 100);
  assert.equal(last.total, 4096);
  assert.equal(last.items.length, 96);
  assert.equal(last.nextOffset, null);
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
  await fs.mkdir(receiptDir, { mode: 0o700 });
  await fs.symlink(outsideStore, path.join(receiptDir, 'v1.json'), 'file');
  await assert.rejects(
    async () => await core.turnReceipts.open(openInput()),
    /turn_receipt_path_outside_store/,
  );
  assert.equal(await fs.readFile(outsideStore, 'utf8'), outsideBefore);
  await fs.rm(receiptDir, { recursive: true });

  await core.turnReceipts.open(openInput());
  assert.deepEqual(await fs.readdir(receiptDir), ['v1.json']);
  await assert.rejects(fs.access(core.workspace.lockPath));

  await fs.rm(parent, { recursive: true, force: true });
  await assert.rejects(fs.access(parent));
});
