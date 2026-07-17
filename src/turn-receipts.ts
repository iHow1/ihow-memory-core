// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  TurnReceiptCommitInputV1,
  TurnReceiptDeltaStateV1,
  TurnReceiptIdentityV1,
  TurnReceiptListOptions,
  TurnReceiptOpenInputV1,
  TurnReceiptPageV1,
  TurnReceiptV1,
  Workspace,
} from './types.ts';
import { atomicWriteFile, assertRealPathWithin } from './store/files.ts';
import { withWorkspaceLock } from './store/lock.ts';

const HASH_RE = /^[a-f0-9]{64}$/;
const SOURCE_HASH_RE = /^sha256:[a-f0-9]{64}$/;
const SAFE_ID_RE = /^[A-Za-z0-9._:-]+$/;
const MAX_STORE_BYTES = 4 * 1024 * 1024;
// B1 deliberately fails closed at this capacity: there is no eviction. Callers can enumerate every
// record through TurnReceiptPageV1 before the limit is reached. Archival/rotation is deferred to B3
// and must land before this receipt store is presented as a user-facing completion mechanism.
const MAX_RECEIPTS = 4096;
const MAX_LIST_LIMIT = 100;

type TurnReceiptStoreV1 = {
  schemaVersion: 1;
  receipts: TurnReceiptV1[];
};

export type TurnReceiptService = {
  hashSessionId(sessionId: unknown): string;
  hashSourceId(rawSourceId: unknown): string;
  open(input: unknown): Promise<TurnReceiptV1>;
  commit(input: unknown): Promise<TurnReceiptV1>;
  read(identity: unknown): Promise<TurnReceiptV1 | null>;
  list(options?: unknown): Promise<TurnReceiptPageV1>;
  gaps(options?: unknown): Promise<TurnReceiptPageV1>;
};

export function hashTurnReceiptSessionId(sessionId: unknown): string {
  if (typeof sessionId !== 'string' || !sessionId.trim() || /\p{Cc}/u.test(sessionId)) {
    throw new Error('turn_receipt_session_id_invalid');
  }
  if (Buffer.byteLength(sessionId, 'utf8') > 512) throw new Error('turn_receipt_session_id_too_large');
  return crypto.createHash('sha256').update('turn-receipt-session-v1\0').update(sessionId).digest('hex');
}

export function hashTurnReceiptSourceId(rawSourceId: unknown): string {
  if (typeof rawSourceId !== 'string' || !rawSourceId.trim() || /\p{Cc}/u.test(rawSourceId)) {
    throw new Error('turn_receipt_source_id_invalid');
  }
  if (Buffer.byteLength(rawSourceId, 'utf8') > 512) throw new Error('turn_receipt_source_id_too_large');
  const digest = crypto.createHash('sha256')
    .update('turn-receipt-source-v1\0')
    .update(rawSourceId)
    .digest('hex');
  return `sha256:${digest}`;
}

function receiptStorePaths(workspace: Workspace): { containmentRoot: string; directory: string; file: string } {
  const containmentRoot = workspace.mode === 'existing-memory-root' ? workspace.mcpDir : workspace.spaceDir;
  const directory = path.join(containmentRoot, 'turn-receipts');
  return {
    containmentRoot,
    directory,
    file: path.join(directory, 'v1.json'),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function assertNoRawContentFields(value: unknown): void {
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const normalized = normalizedKey(key);
    if (
      normalized.includes('prompt')
      || normalized.includes('response')
      || normalized.includes('transcriptbody')
      || normalized.includes('conversationhistory')
      || normalized.includes('tooloutput')
    ) throw new Error('turn_receipt_raw_content_forbidden');
    assertNoRawContentFields(child);
  }
}

function assertRecord(value: unknown): Record<string, unknown> {
  assertNoRawContentFields(value);
  if (!isRecord(value)) throw new Error('turn_receipt_schema_invalid');
  return value;
}

function assertAllowedKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  const allow = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allow.has(key)) throw new Error(`turn_receipt_unknown_field:${key}`);
  }
}

function boundedString(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`turn_receipt_${field}_required`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`turn_receipt_${field}_required`);
  if (trimmed.length > max) throw new Error(`turn_receipt_${field}_too_large`);
  if (/\p{Cc}/u.test(trimmed)) throw new Error(`turn_receipt_${field}_invalid`);
  return trimmed;
}

function boundedId(value: unknown, field: string, max: number): string {
  const result = boundedString(value, field, max);
  if (!SAFE_ID_RE.test(result)) throw new Error(`turn_receipt_${field}_invalid`);
  return result;
}

function sourceHash(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`turn_receipt_${field}_required`);
  if (!SOURCE_HASH_RE.test(value)) throw new Error(`turn_receipt_${field}_invalid`);
  return value;
}

function sha256(value: unknown, field: string): string {
  const result = boundedString(value, field, 64).toLowerCase();
  if (!HASH_RE.test(result)) throw new Error(`turn_receipt_${field}_invalid`);
  return result;
}

function timestamp(value: unknown, field: string): string {
  const result = boundedString(value, field, 32);
  const parsed = Date.parse(result);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== result) {
    throw new Error(`turn_receipt_${field}_invalid`);
  }
  return result;
}

function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 2_147_483_647) {
    throw new Error('turn_receipt_revision_invalid');
  }
  return value as number;
}

const IDENTITY_KEYS = ['runtime', 'projectId', 'sessionHash', 'turnId', 'revision'] as const;

function parseIdentityFields(record: Record<string, unknown>): TurnReceiptIdentityV1 {
  return {
    runtime: boundedId(record.runtime, 'runtime', 64).toLowerCase(),
    projectId: sha256(record.projectId, 'project_id'),
    sessionHash: sha256(record.sessionHash, 'session_hash'),
    turnId: boundedId(record.turnId, 'turn_id', 128),
    revision: revision(record.revision),
  };
}

function parseIdentity(input: unknown): TurnReceiptIdentityV1 {
  const record = assertRecord(input);
  assertAllowedKeys(record, IDENTITY_KEYS);
  return parseIdentityFields(record);
}

function parseOpenInput(input: unknown): TurnReceiptOpenInputV1 {
  const record = assertRecord(input);
  assertAllowedKeys(record, [
    'schemaVersion',
    ...IDENTITY_KEYS,
    'inputSourceHash',
    'inputContentSha256',
    'openedAt',
  ]);
  if (record.schemaVersion !== 1) throw new Error('turn_receipt_schema_invalid');
  return {
    schemaVersion: 1,
    ...parseIdentityFields(record),
    inputSourceHash: sourceHash(record.inputSourceHash, 'input_source_hash'),
    inputContentSha256: sha256(record.inputContentSha256, 'input_content_sha256'),
    openedAt: timestamp(record.openedAt, 'opened_at'),
  };
}

function deltaState(value: unknown): TurnReceiptDeltaStateV1 {
  if (value === 'explicit_none' || value === 'not_emitted' || value === 'extraction_failed') return value;
  throw new Error('turn_receipt_delta_state_invalid');
}

function parseCommitInput(input: unknown): TurnReceiptCommitInputV1 {
  const record = assertRecord(input);
  assertAllowedKeys(record, [
    'schemaVersion',
    ...IDENTITY_KEYS,
    'inputSourceHash',
    'inputContentSha256',
    'finalSourceHash',
    'finalContentSha256',
    'committedAt',
    'deltaState',
  ]);
  if (record.schemaVersion !== 1) throw new Error('turn_receipt_schema_invalid');
  return {
    schemaVersion: 1,
    ...parseIdentityFields(record),
    inputSourceHash: sourceHash(record.inputSourceHash, 'input_source_hash'),
    inputContentSha256: sha256(record.inputContentSha256, 'input_content_sha256'),
    finalSourceHash: sourceHash(record.finalSourceHash, 'final_source_hash'),
    finalContentSha256: sha256(record.finalContentSha256, 'final_content_sha256'),
    committedAt: timestamp(record.committedAt, 'committed_at'),
    deltaState: deltaState(record.deltaState),
  };
}

function identityKey(identity: TurnReceiptIdentityV1): string {
  return [identity.runtime, identity.projectId, identity.sessionHash, identity.turnId, identity.revision].join('\0');
}

function logicalTurnKey(identity: TurnReceiptIdentityV1): string {
  return [identity.runtime, identity.projectId, identity.sessionHash, identity.turnId].join('\0');
}

function sameInputEvidence(
  existing: TurnReceiptV1,
  input: Pick<TurnReceiptOpenInputV1, 'inputSourceHash' | 'inputContentSha256'>,
): boolean {
  return existing.inputSourceHash === input.inputSourceHash
    && existing.inputContentSha256 === input.inputContentSha256;
}

function sameCommittedEvidence(existing: TurnReceiptV1, input: TurnReceiptCommitInputV1): boolean {
  return existing.state === 'COMMITTED'
    && existing.finalSourceHash === input.finalSourceHash
    && existing.finalContentSha256 === input.finalContentSha256
    && existing.deltaState === input.deltaState;
}

function canonicalOpenReceipt(input: TurnReceiptOpenInputV1): TurnReceiptV1 {
  return {
    schemaVersion: 1,
    state: 'OPEN',
    runtime: input.runtime,
    projectId: input.projectId,
    sessionHash: input.sessionHash,
    turnId: input.turnId,
    revision: input.revision,
    inputSourceHash: input.inputSourceHash,
    inputContentSha256: input.inputContentSha256,
    openedAt: input.openedAt,
    deltaState: 'not_emitted',
  };
}

function canonicalCommittedReceipt(
  existing: TurnReceiptIdentityV1 & Pick<TurnReceiptV1, 'inputSourceHash' | 'inputContentSha256' | 'openedAt'>,
  input: Pick<TurnReceiptCommitInputV1, 'finalSourceHash' | 'finalContentSha256' | 'committedAt' | 'deltaState'>,
): TurnReceiptV1 {
  return {
    schemaVersion: 1,
    state: 'COMMITTED',
    runtime: existing.runtime,
    projectId: existing.projectId,
    sessionHash: existing.sessionHash,
    turnId: existing.turnId,
    revision: existing.revision,
    inputSourceHash: existing.inputSourceHash,
    inputContentSha256: existing.inputContentSha256,
    openedAt: existing.openedAt,
    finalSourceHash: input.finalSourceHash,
    finalContentSha256: input.finalContentSha256,
    committedAt: input.committedAt,
    deltaState: input.deltaState,
  };
}

function validatePersistedReceipt(input: unknown): TurnReceiptV1 {
  const record = assertRecord(input);
  assertAllowedKeys(record, [
    'schemaVersion', 'state', ...IDENTITY_KEYS, 'inputSourceHash', 'inputContentSha256', 'openedAt',
    'finalSourceHash', 'finalContentSha256', 'committedAt', 'deltaState',
  ]);
  if (record.schemaVersion !== 1 || (record.state !== 'OPEN' && record.state !== 'COMMITTED')) {
    throw new Error('turn_receipt_store_invalid');
  }
  const base = {
    schemaVersion: 1,
    ...parseIdentityFields(record),
    inputSourceHash: sourceHash(record.inputSourceHash, 'input_source_hash'),
    inputContentSha256: sha256(record.inputContentSha256, 'input_content_sha256'),
    openedAt: timestamp(record.openedAt, 'opened_at'),
  } as const;
  if (record.state === 'OPEN') {
    if (record.deltaState !== 'not_emitted') throw new Error('turn_receipt_store_invalid');
    if (record.finalSourceHash !== undefined || record.finalContentSha256 !== undefined || record.committedAt !== undefined) {
      throw new Error('turn_receipt_store_invalid');
    }
    return canonicalOpenReceipt(base);
  }
  const committedAt = timestamp(record.committedAt, 'committed_at');
  if (Date.parse(committedAt) < Date.parse(base.openedAt)) throw new Error('turn_receipt_store_invalid');
  return canonicalCommittedReceipt(base, {
    finalSourceHash: sourceHash(record.finalSourceHash, 'final_source_hash'),
    finalContentSha256: sha256(record.finalContentSha256, 'final_content_sha256'),
    committedAt,
    deltaState: deltaState(record.deltaState),
  });
}

async function readStoreFile(file: string, containmentRoot: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP') throw new Error('turn_receipt_path_outside_store');
    throw error;
  }
  try {
    let real: string;
    try {
      real = await assertRealPathWithin(containmentRoot, file);
    } catch (error) {
      if (error instanceof Error && error.message === 'path_outside_memory_workspace') {
        throw new Error('turn_receipt_path_outside_store');
      }
      throw error;
    }
    const [opened, realStat] = await Promise.all([handle.stat(), fs.stat(real)]);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== realStat.dev || opened.ino !== realStat.ino) {
      throw new Error('turn_receipt_path_outside_store');
    }
    if (process.platform !== 'win32' && (opened.mode & 0o777) !== 0o600) {
      throw new Error('turn_receipt_store_permissions_invalid');
    }
    if (opened.size > MAX_STORE_BYTES) throw new Error('turn_receipt_store_too_large');
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

async function ensurePrivateReceiptDirectory(containmentRoot: string, directory: string): Promise<void> {
  const lexicalRelative = path.relative(path.resolve(containmentRoot), path.resolve(directory));
  if (lexicalRelative.startsWith('..') || path.isAbsolute(lexicalRelative)) {
    throw new Error('turn_receipt_path_outside_store');
  }
  const rootEntry = await fs.lstat(containmentRoot);
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
    throw new Error('turn_receipt_path_outside_store');
  }
  const containmentHandle = await fs.open(
    containmentRoot,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_DIRECTORY,
  );
  try {
    await containmentHandle.chmod(0o700);
    const rootStat = await containmentHandle.stat();
    if (
      !rootStat.isDirectory()
      || rootStat.dev !== rootEntry.dev
      || rootStat.ino !== rootEntry.ino
      || (process.platform !== 'win32' && (rootStat.mode & 0o777) !== 0o700)
    ) throw new Error('turn_receipt_path_outside_store');

    let created = false;
    try {
      await fs.mkdir(directory, { mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    const entry = await fs.lstat(directory);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('turn_receipt_path_outside_store');

    let realDirectory: string;
    try {
      realDirectory = await assertRealPathWithin(containmentRoot, directory);
    } catch (error) {
      if (error instanceof Error && error.message === 'path_outside_memory_workspace') {
        throw new Error('turn_receipt_path_outside_store');
      }
      throw error;
    }

    const directoryHandle = await fs.open(
      directory,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_DIRECTORY,
    );
    try {
      await directoryHandle.chmod(0o700);
      const [opened, current, currentReal] = await Promise.all([
        directoryHandle.stat(),
        fs.stat(realDirectory),
        fs.realpath(directory),
      ]);
      if (
        !opened.isDirectory()
        || !current.isDirectory()
        || opened.dev !== current.dev
        || opened.ino !== current.ino
        || currentReal !== realDirectory
        || (process.platform !== 'win32' && (opened.mode & 0o777) !== 0o700)
      ) throw new Error('turn_receipt_path_outside_store');
    } finally {
      await directoryHandle.close();
    }

    if (created) {
      try {
        await containmentHandle.sync();
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const unsupported = code === 'EINVAL' || code === 'ENOTSUP' || code === 'EOPNOTSUPP'
          || (process.platform === 'win32' && code === 'EPERM');
        if (!unsupported) throw error;
      }
    }
  } finally {
    await containmentHandle.close();
  }
}

async function loadStoreUnlocked(workspace: Workspace): Promise<TurnReceiptStoreV1> {
  const { containmentRoot, directory, file } = receiptStorePaths(workspace);
  await ensurePrivateReceiptDirectory(containmentRoot, directory);
  const raw = await readStoreFile(file, containmentRoot);
  if (raw === null) return { schemaVersion: 1, receipts: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('turn_receipt_store_invalid');
  }
  const record = assertRecord(parsed);
  assertAllowedKeys(record, ['schemaVersion', 'receipts']);
  if (record.schemaVersion !== 1 || !Array.isArray(record.receipts) || record.receipts.length > MAX_RECEIPTS) {
    throw new Error('turn_receipt_store_invalid');
  }
  const receipts = record.receipts.map(validatePersistedReceipt);
  if (new Set(receipts.map(identityKey)).size !== receipts.length) throw new Error('turn_receipt_store_invalid');
  return { schemaVersion: 1, receipts };
}

async function saveStoreUnlocked(workspace: Workspace, store: TurnReceiptStoreV1): Promise<void> {
  if (store.receipts.length > MAX_RECEIPTS) throw new Error('turn_receipt_store_full');
  const canonicalStore: TurnReceiptStoreV1 = {
    schemaVersion: 1,
    receipts: sortReceipts([...store.receipts]),
  };
  const serialized = `${JSON.stringify(canonicalStore, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_STORE_BYTES) throw new Error('turn_receipt_store_too_large');
  const { containmentRoot, file } = receiptStorePaths(workspace);
  try {
    await atomicWriteFile(file, serialized, containmentRoot, {
      directoryMode: 0o700,
      fileMode: 0o600,
      durable: true,
      // withWorkspaceLock serializes writers, so this single deterministic temp bounds crash debris.
      boundedTemp: true,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'path_outside_memory_workspace') {
      throw new Error('turn_receipt_path_outside_store');
    }
    throw error;
  }
}

function parseListOptions(input: unknown): TurnReceiptListOptions {
  if (input === undefined) return {};
  const record = assertRecord(input);
  assertAllowedKeys(record, ['offset', 'limit', 'currentOnly']);
  if (record.currentOnly !== undefined && typeof record.currentOnly !== 'boolean') {
    throw new Error('turn_receipt_current_only_invalid');
  }
  if (record.limit !== undefined && (!Number.isSafeInteger(record.limit) || (record.limit as number) < 1 || (record.limit as number) > MAX_LIST_LIMIT)) {
    throw new Error('turn_receipt_list_limit_invalid');
  }
  if (record.offset !== undefined && (!Number.isSafeInteger(record.offset) || (record.offset as number) < 0 || (record.offset as number) > MAX_RECEIPTS)) {
    throw new Error('turn_receipt_list_offset_invalid');
  }
  return {
    ...(record.offset !== undefined ? { offset: record.offset as number } : {}),
    ...(record.limit !== undefined ? { limit: record.limit as number } : {}),
    ...(record.currentOnly !== undefined ? { currentOnly: record.currentOnly } : {}),
  };
}

function pageReceipts(receipts: TurnReceiptV1[], options: TurnReceiptListOptions): TurnReceiptPageV1 {
  const offset = options.offset ?? 0;
  const limit = options.limit ?? MAX_LIST_LIMIT;
  const items = receipts.slice(offset, offset + limit);
  const next = offset + items.length;
  return {
    items,
    total: receipts.length,
    nextOffset: next < receipts.length ? next : null,
  };
}

function sortReceipts(receipts: TurnReceiptV1[]): TurnReceiptV1[] {
  return receipts.sort((a, b) => {
    for (const [left, right] of [
      [a.runtime, b.runtime],
      [a.projectId, b.projectId],
      [a.sessionHash, b.sessionHash],
      [a.turnId, b.turnId],
    ] as const) {
      if (left < right) return -1;
      if (left > right) return 1;
    }
    return a.revision - b.revision;
  });
}

function currentReceipts(receipts: readonly TurnReceiptV1[]): TurnReceiptV1[] {
  const current = new Map<string, TurnReceiptV1>();
  for (const receipt of receipts) {
    const key = logicalTurnKey(receipt);
    const previous = current.get(key);
    if (!previous || receipt.revision > previous.revision) current.set(key, receipt);
  }
  return [...current.values()];
}

export function createTurnReceiptService(workspace: Workspace): TurnReceiptService {
  return {
    hashSessionId: hashTurnReceiptSessionId,
    hashSourceId: hashTurnReceiptSourceId,
    async open(raw) {
      const input = parseOpenInput(raw);
      return await withWorkspaceLock(workspace, async () => {
        const store = await loadStoreUnlocked(workspace);
        const key = identityKey(input);
        const existing = store.receipts.find((receipt) => identityKey(receipt) === key);
        if (existing) {
          if (!sameInputEvidence(existing, input)) throw new Error('turn_receipt_conflict');
          return existing;
        }
        if (store.receipts.length >= MAX_RECEIPTS) throw new Error('turn_receipt_store_full');
        const receipt = canonicalOpenReceipt(input);
        store.receipts.push(receipt);
        await saveStoreUnlocked(workspace, store);
        return receipt;
      });
    },
    async commit(raw) {
      const input = parseCommitInput(raw);
      return await withWorkspaceLock(workspace, async () => {
        const store = await loadStoreUnlocked(workspace);
        const key = identityKey(input);
        const index = store.receipts.findIndex((receipt) => identityKey(receipt) === key);
        const existing = index < 0 ? undefined : store.receipts[index];
        if (!existing) throw new Error('turn_receipt_open_required');
        if (!sameInputEvidence(existing, input)) throw new Error('turn_receipt_conflict');
        if (existing.state === 'COMMITTED') {
          if (!sameCommittedEvidence(existing, input)) throw new Error('turn_receipt_conflict');
          return existing;
        }
        if (Date.parse(input.committedAt) < Date.parse(existing.openedAt)) {
          throw new Error('turn_receipt_timestamp_order_invalid');
        }
        const committed = canonicalCommittedReceipt(existing, {
          finalSourceHash: input.finalSourceHash,
          finalContentSha256: input.finalContentSha256,
          committedAt: input.committedAt,
          deltaState: input.deltaState,
        });
        store.receipts[index] = committed;
        await saveStoreUnlocked(workspace, store);
        return committed;
      });
    },
    async read(raw) {
      const identity = parseIdentity(raw);
      return await withWorkspaceLock(workspace, async () => {
        const store = await loadStoreUnlocked(workspace);
        const key = identityKey(identity);
        return store.receipts.find((receipt) => identityKey(receipt) === key) ?? null;
      });
    },
    async list(rawOptions) {
      const options = parseListOptions(rawOptions);
      return await withWorkspaceLock(workspace, async () => {
        const store = await loadStoreUnlocked(workspace);
        const receipts = sortReceipts(options.currentOnly ? currentReceipts(store.receipts) : [...store.receipts]);
        return pageReceipts(receipts, options);
      });
    },
    async gaps(rawOptions) {
      const options = parseListOptions(rawOptions);
      return await withWorkspaceLock(workspace, async () => {
        const store = await loadStoreUnlocked(workspace);
        const candidates = options.currentOnly ? currentReceipts(store.receipts) : store.receipts;
        const receipts = sortReceipts(candidates.filter((receipt) => (
          receipt.state === 'OPEN' || receipt.deltaState !== 'explicit_none'
        )));
        return pageReceipts(receipts, options);
      });
    },
  };
}
