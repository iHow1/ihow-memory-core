// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  TurnReceiptCommitInputV1,
  TurnReceiptDeltaLinkageV1,
  TurnReceiptDeltaStateV1,
  TurnReceiptIdentityV1,
  TurnReceiptKnownClosedPreconditionV1,
  TurnReceiptKnownCoverageV1,
  TurnReceiptListOptions,
  TurnReceiptProjectionBindingV1,
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
const HERMES_IDENTITY_DOMAIN = 'hermes-transcript-v1';
const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_REVISION_BYTES = 4 * 1024 * 1024;
const MAX_DURABLE_REVISIONS = 4096;
const MAX_DURABLE_TURNS = 1024;

type TurnReceiptV2 = {
  schemaVersion: 2;
  state: 'OPEN' | 'COMMITTED';
  identityDomain: typeof HERMES_IDENTITY_DOMAIN;
  origin: 'native-hook' | 'durable-replay';
  runtime: 'hermes';
  projectId: string;
  sessionHash: string;
  turnId: string;
  revision: 1;
  inputSourceHash: string;
  inputContentSha256: string;
  openedAt: string;
  deltaState: TurnReceiptDeltaStateV1;
  finalSourceHash?: string;
  finalContentSha256?: string;
  committedAt?: string;
  durableRevision?: number;
  transcriptPath?: string;
  derivedFromRevision?: number;
  replayedAt?: string;
};

type TurnReceiptAny = TurnReceiptV1 | TurnReceiptV2;
type ReplayCursorV1 = { schemaVersion: 1; sessionHash: string; revision: number };
type TurnReceiptOpenInputV2 = Omit<
  TurnReceiptV2,
  'state' | 'deltaState' | 'finalSourceHash' | 'finalContentSha256' | 'committedAt'
  | 'durableRevision' | 'transcriptPath' | 'derivedFromRevision' | 'replayedAt'
>;

type TurnReceiptStoreV1 = {
  schemaVersion: 1;
  receipts: TurnReceiptAny[];
  replayCursors?: ReplayCursorV1[];
};

type ReplayResult = {
  status: 'ok' | 'anomaly' | 'rejected';
  code?: 'turn_receipt_replay_input_divergence' | 'turn_receipt_replay_cursor_regression' | 'turn_receipt_replay_rejected';
  receiptsWritten: number;
  cursorRevision?: number;
};
type TurnReceiptPageAny = { items: TurnReceiptAny[]; total: number; nextOffset: number | null };
type TurnReceiptProjectionV2 = {
  schemaVersion: 2;
  identityDomain: typeof HERMES_IDENTITY_DOMAIN;
  runtime: 'hermes';
  projectId: string;
  sessionHash: string;
};

export type TurnReceiptService = {
  hashSessionId(sessionId: unknown): string;
  hashSourceId(rawSourceId: unknown): string;
  open(input: unknown): Promise<TurnReceiptAny>;
  commit(input: unknown): Promise<TurnReceiptV1>;
  read(identity: unknown): Promise<TurnReceiptV1 | null>;
  list(options?: unknown): Promise<TurnReceiptPageAny>;
  gaps(options?: unknown): Promise<TurnReceiptPageV1>;
  knownCoverage(binding: unknown): Promise<TurnReceiptKnownCoverageV1>;
  consumeDurableTranscriptRevision(input: unknown): Promise<ReplayResult>;
  scanDurableTranscriptRevisions(input: unknown): Promise<ReplayResult>;
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

function lowerSha256(value: unknown, field: string): string {
  if (typeof value !== 'string' || !HASH_RE.test(value)) throw new Error(`turn_receipt_${field}_invalid`);
  return value;
}

function timestamp(value: unknown, field: string): string {
  const result = boundedString(value, field, 32);
  const parsed = Date.parse(result);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== result) {
    throw new Error(`turn_receipt_${field}_invalid`);
  }
  return result;
}

function isoTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length > 40) {
    throw new Error(`turn_receipt_${field}_invalid`);
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/.exec(value);
  if (match === null) throw new Error(`turn_receipt_${field}_invalid`);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const parsed = new Date(0);
  parsed.setUTCFullYear(year, month - 1, day);
  parsed.setUTCHours(hour, minute, second, 0);
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
    || parsed.getUTCHours() !== hour
    || parsed.getUTCMinutes() !== minute
    || parsed.getUTCSeconds() !== second
  ) throw new Error(`turn_receipt_${field}_invalid`);
  return value;
}

function hostPublicationTimestamp(value: unknown, field: string): string {
  const parsed = isoTimestamp(value, field);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(parsed)) {
    throw new Error(`turn_receipt_${field}_invalid`);
  }
  return parsed;
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

function parseOpenInputV2(input: unknown): TurnReceiptOpenInputV2 {
  const record = assertRecord(input);
  assertAllowedKeys(record, [
    'schemaVersion', 'runtime', 'identityDomain', 'origin', 'projectId', 'sessionHash', 'turnId',
    'revision', 'inputSourceHash', 'inputContentSha256', 'openedAt',
  ]);
  if (
    record.schemaVersion !== 2
    || record.runtime !== 'hermes'
    || record.identityDomain !== HERMES_IDENTITY_DOMAIN
    || record.origin !== 'native-hook'
    || record.revision !== 1
  ) throw new Error('turn_receipt_schema_invalid');
  return {
    schemaVersion: 2,
    runtime: 'hermes',
    identityDomain: HERMES_IDENTITY_DOMAIN,
    origin: 'native-hook',
    projectId: lowerSha256(record.projectId, 'project_id'),
    sessionHash: lowerSha256(record.sessionHash, 'session_hash'),
    turnId: lowerSha256(record.turnId, 'turn_id'),
    revision: 1,
    inputSourceHash: sourceHash(record.inputSourceHash, 'input_source_hash'),
    inputContentSha256: lowerSha256(record.inputContentSha256, 'input_content_sha256'),
    openedAt: timestamp(record.openedAt, 'opened_at'),
  };
}

function parseAnyOpenInput(input: unknown): TurnReceiptOpenInputV1 | TurnReceiptOpenInputV2 {
  if (!isRecord(input)) throw new Error('turn_receipt_schema_invalid');
  if (input.schemaVersion === 1) return parseOpenInput(input);
  if (input.schemaVersion === 2) return parseOpenInputV2(input);
  throw new Error('turn_receipt_schema_invalid');
}

function deltaState(value: unknown): TurnReceiptDeltaStateV1 {
  if (value === 'explicit_none' || value === 'not_emitted' || value === 'extraction_failed' || value === 'emitted') return value;
  throw new Error('turn_receipt_delta_state_invalid');
}

function deltaLinkage(value: unknown): TurnReceiptDeltaLinkageV1 {
  const record = assertRecord(value);
  assertAllowedKeys(record, ['deltaId', 'deltaHash', 'proposalId']);
  const deltaId = boundedString(record.deltaId, 'delta_id', 68);
  if (!/^ci1_[a-f0-9]{64}$/.test(deltaId)) throw new Error('turn_receipt_delta_id_invalid');
  const deltaHash = boundedString(record.deltaHash, 'delta_hash', 64);
  if (!/^[a-f0-9]{64}$/.test(deltaHash)) throw new Error('turn_receipt_delta_hash_invalid');
  const proposalId = boundedString(record.proposalId, 'proposal_id', 68);
  if (!/^mp1_[a-f0-9]{64}$/.test(proposalId)) throw new Error('turn_receipt_proposal_id_invalid');
  return {
    deltaId,
    deltaHash,
    proposalId,
  };
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
    'deltaLinkage',
  ]);
  if (record.schemaVersion !== 1) throw new Error('turn_receipt_schema_invalid');
  const parsedDeltaState = deltaState(record.deltaState);
  if (parsedDeltaState === 'emitted' && record.deltaLinkage === undefined) {
    throw new Error('turn_receipt_delta_linkage_required');
  }
  if (parsedDeltaState !== 'emitted' && record.deltaLinkage !== undefined) {
    throw new Error('turn_receipt_delta_linkage_forbidden');
  }
  return {
    schemaVersion: 1,
    ...parseIdentityFields(record),
    inputSourceHash: sourceHash(record.inputSourceHash, 'input_source_hash'),
    inputContentSha256: sha256(record.inputContentSha256, 'input_content_sha256'),
    finalSourceHash: sourceHash(record.finalSourceHash, 'final_source_hash'),
    finalContentSha256: sha256(record.finalContentSha256, 'final_content_sha256'),
    committedAt: timestamp(record.committedAt, 'committed_at'),
    deltaState: parsedDeltaState,
    ...(record.deltaLinkage === undefined ? {} : { deltaLinkage: deltaLinkage(record.deltaLinkage) }),
  };
}

function identityKey(identity: TurnReceiptAny | TurnReceiptIdentityV1 | TurnReceiptOpenInputV2): string {
  const schema = 'schemaVersion' in identity ? identity.schemaVersion : 1;
  const domain = 'schemaVersion' in identity && identity.schemaVersion === 2
    ? identity.identityDomain
    : 'legacy-v1';
  return [schema, domain, identity.runtime, identity.projectId, identity.sessionHash, identity.turnId, identity.revision].join('\0');
}

function logicalTurnKey(identity: TurnReceiptAny | TurnReceiptIdentityV1): string {
  const schema = 'schemaVersion' in identity ? identity.schemaVersion : 1;
  const domain = 'schemaVersion' in identity && identity.schemaVersion === 2
    ? identity.identityDomain
    : 'legacy-v1';
  return [schema, domain, identity.runtime, identity.projectId, identity.sessionHash, identity.turnId].join('\0');
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
    && existing.deltaState === input.deltaState
    && existing.deltaLinkage?.deltaId === input.deltaLinkage?.deltaId
    && existing.deltaLinkage?.deltaHash === input.deltaLinkage?.deltaHash
    && existing.deltaLinkage?.proposalId === input.deltaLinkage?.proposalId;
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

function canonicalOpenReceiptV2(input: TurnReceiptOpenInputV2): TurnReceiptV2 {
  return {
    ...input,
    state: 'OPEN',
    deltaState: 'not_emitted',
  };
}

function canonicalCommittedReceipt(
  existing: TurnReceiptIdentityV1 & Pick<TurnReceiptV1, 'inputSourceHash' | 'inputContentSha256' | 'openedAt'>,
  input: Pick<TurnReceiptCommitInputV1, 'finalSourceHash' | 'finalContentSha256' | 'committedAt' | 'deltaState' | 'deltaLinkage'>,
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
    ...(input.deltaLinkage === undefined ? {} : { deltaLinkage: input.deltaLinkage }),
  };
}

function validatePersistedReceipt(input: unknown): TurnReceiptV1 {
  const record = assertRecord(input);
  assertAllowedKeys(record, [
    'schemaVersion', 'state', ...IDENTITY_KEYS, 'inputSourceHash', 'inputContentSha256', 'openedAt',
    'finalSourceHash', 'finalContentSha256', 'committedAt', 'deltaState', 'deltaLinkage',
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
    if (
      record.finalSourceHash !== undefined
      || record.finalContentSha256 !== undefined
      || record.committedAt !== undefined
      || record.deltaLinkage !== undefined
    ) {
      throw new Error('turn_receipt_store_invalid');
    }
    return canonicalOpenReceipt(base);
  }
  const committedAt = timestamp(record.committedAt, 'committed_at');
  if (Date.parse(committedAt) < Date.parse(base.openedAt)) throw new Error('turn_receipt_store_invalid');
  const parsedDeltaState = deltaState(record.deltaState);
  if (parsedDeltaState === 'emitted' && record.deltaLinkage === undefined) {
    throw new Error('turn_receipt_store_invalid');
  }
  if (parsedDeltaState !== 'emitted' && record.deltaLinkage !== undefined) {
    throw new Error('turn_receipt_store_invalid');
  }
  return canonicalCommittedReceipt(base, {
    finalSourceHash: sourceHash(record.finalSourceHash, 'final_source_hash'),
    finalContentSha256: sha256(record.finalContentSha256, 'final_content_sha256'),
    committedAt,
    deltaState: parsedDeltaState,
    ...(record.deltaLinkage === undefined ? {} : { deltaLinkage: deltaLinkage(record.deltaLinkage) }),
  });
}

function validatePersistedReceiptV2(input: unknown): TurnReceiptV2 {
  const record = assertRecord(input);
  assertAllowedKeys(record, [
    'schemaVersion', 'state', 'identityDomain', 'origin', 'runtime', 'projectId', 'sessionHash', 'turnId',
    'revision', 'inputSourceHash', 'inputContentSha256', 'openedAt', 'finalSourceHash',
    'finalContentSha256', 'committedAt', 'deltaState', 'durableRevision', 'transcriptPath',
    'derivedFromRevision', 'replayedAt',
  ]);
  if (
    record.schemaVersion !== 2
    || (record.state !== 'OPEN' && record.state !== 'COMMITTED')
    || record.identityDomain !== HERMES_IDENTITY_DOMAIN
    || (record.origin !== 'native-hook' && record.origin !== 'durable-replay')
    || record.runtime !== 'hermes'
    || record.revision !== 1
  ) throw new Error('turn_receipt_store_invalid');
  const origin: TurnReceiptV2['origin'] = record.origin === 'native-hook' ? 'native-hook' : 'durable-replay';
  const base = {
    schemaVersion: 2,
    identityDomain: HERMES_IDENTITY_DOMAIN,
    origin,
    runtime: 'hermes',
    projectId: lowerSha256(record.projectId, 'project_id'),
    sessionHash: lowerSha256(record.sessionHash, 'session_hash'),
    turnId: lowerSha256(record.turnId, 'turn_id'),
    revision: 1,
    inputSourceHash: sourceHash(record.inputSourceHash, 'input_source_hash'),
    inputContentSha256: lowerSha256(record.inputContentSha256, 'input_content_sha256'),
    openedAt: isoTimestamp(record.openedAt, 'opened_at'),
  } as const;
  if (record.state === 'OPEN') {
    if (
      record.origin !== 'native-hook'
      || record.deltaState !== 'not_emitted'
      || record.finalSourceHash !== undefined
      || record.finalContentSha256 !== undefined
      || record.committedAt !== undefined
      || record.durableRevision !== undefined
      || record.transcriptPath !== undefined
      || record.derivedFromRevision !== undefined
      || record.replayedAt !== undefined
    ) throw new Error('turn_receipt_store_invalid');
    return { ...base, state: 'OPEN', deltaState: 'not_emitted' };
  }
  const durableRevision = revision(record.durableRevision);
  const transcriptPath = boundedString(record.transcriptPath, 'transcript_path', 256);
  if (transcriptPath !== `revisions/${base.sessionHash}/${durableRevision}.json`) {
    throw new Error('turn_receipt_store_invalid');
  }
  const committedAt = isoTimestamp(record.committedAt, 'committed_at');
  if (Date.parse(committedAt) < Date.parse(base.openedAt)) throw new Error('turn_receipt_store_invalid');
  const parsedDeltaState = deltaState(record.deltaState);
  const derivedFromRevision = record.derivedFromRevision === undefined
    ? undefined
    : revision(record.derivedFromRevision);
  const replayedAt = record.replayedAt === undefined ? undefined : isoTimestamp(record.replayedAt, 'replayed_at');
  return {
    ...base,
    state: 'COMMITTED',
    finalSourceHash: sourceHash(record.finalSourceHash, 'final_source_hash'),
    finalContentSha256: lowerSha256(record.finalContentSha256, 'final_content_sha256'),
    committedAt,
    deltaState: parsedDeltaState,
    durableRevision,
    transcriptPath,
    ...(derivedFromRevision === undefined ? {} : { derivedFromRevision }),
    ...(replayedAt === undefined ? {} : { replayedAt }),
  };
}

function validatePersistedReceiptAny(input: unknown): TurnReceiptAny {
  if (!isRecord(input)) throw new Error('turn_receipt_store_invalid');
  if (input.schemaVersion === 1) return validatePersistedReceipt(input);
  if (input.schemaVersion === 2) return validatePersistedReceiptV2(input);
  throw new Error('turn_receipt_store_invalid');
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
  assertAllowedKeys(record, ['schemaVersion', 'receipts', 'replayCursors']);
  if (record.schemaVersion !== 1 || !Array.isArray(record.receipts) || record.receipts.length > MAX_RECEIPTS) {
    throw new Error('turn_receipt_store_invalid');
  }
  const receipts = record.receipts.map(validatePersistedReceiptAny);
  if (new Set(receipts.map(identityKey)).size !== receipts.length) throw new Error('turn_receipt_store_invalid');
  let replayCursors: ReplayCursorV1[] | undefined;
  if (record.replayCursors !== undefined) {
    if (!Array.isArray(record.replayCursors) || record.replayCursors.length > MAX_RECEIPTS) {
      throw new Error('turn_receipt_store_invalid');
    }
    replayCursors = record.replayCursors.map((value) => {
      const cursor = assertRecord(value);
      assertAllowedKeys(cursor, ['schemaVersion', 'sessionHash', 'revision']);
      if (cursor.schemaVersion !== 1) throw new Error('turn_receipt_store_invalid');
      return {
        schemaVersion: 1 as const,
        sessionHash: lowerSha256(cursor.sessionHash, 'session_hash'),
        revision: revision(cursor.revision),
      };
    });
    if (new Set(replayCursors.map((cursor) => cursor.sessionHash)).size !== replayCursors.length) {
      throw new Error('turn_receipt_store_invalid');
    }
  }
  return { schemaVersion: 1, receipts, ...(replayCursors === undefined ? {} : { replayCursors }) };
}

async function saveStoreUnlocked(workspace: Workspace, store: TurnReceiptStoreV1): Promise<void> {
  if (store.receipts.length > MAX_RECEIPTS) throw new Error('turn_receipt_store_full');
  const canonicalStore: TurnReceiptStoreV1 = {
    schemaVersion: 1,
    receipts: sortReceipts([...store.receipts]),
    ...(store.replayCursors === undefined || store.replayCursors.length === 0 ? {} : {
      replayCursors: [...store.replayCursors].sort((a, b) => a.sessionHash.localeCompare(b.sessionHash)),
    }),
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
  assertAllowedKeys(record, ['offset', 'limit', 'currentOnly', 'runtime', 'projectId', 'sessionHash']);
  if (record.currentOnly !== undefined && typeof record.currentOnly !== 'boolean') {
    throw new Error('turn_receipt_current_only_invalid');
  }
  if (record.limit !== undefined && (!Number.isSafeInteger(record.limit) || (record.limit as number) < 1 || (record.limit as number) > MAX_LIST_LIMIT)) {
    throw new Error('turn_receipt_list_limit_invalid');
  }
  if (record.offset !== undefined && (!Number.isSafeInteger(record.offset) || (record.offset as number) < 0 || (record.offset as number) > MAX_RECEIPTS)) {
    throw new Error('turn_receipt_list_offset_invalid');
  }
  const projectionFields = [record.runtime, record.projectId, record.sessionHash];
  const projectionCount = projectionFields.filter((value) => value !== undefined).length;
  if (projectionCount !== 0 && projectionCount !== projectionFields.length) {
    throw new Error('turn_receipt_projection_required');
  }
  let projection: Pick<TurnReceiptListOptions, 'runtime' | 'projectId' | 'sessionHash'> = {};
  if (projectionCount === projectionFields.length) {
    const runtime = boundedId(record.runtime, 'runtime', 64).toLowerCase();
    if (typeof record.projectId !== 'string' || !HASH_RE.test(record.projectId)) {
      throw new Error('turn_receipt_project_id_invalid');
    }
    if (typeof record.sessionHash !== 'string' || !HASH_RE.test(record.sessionHash)) {
      throw new Error('turn_receipt_session_hash_invalid');
    }
    projection = { runtime, projectId: record.projectId, sessionHash: record.sessionHash };
  }
  return {
    ...(record.offset !== undefined ? { offset: record.offset as number } : {}),
    ...(record.limit !== undefined ? { limit: record.limit as number } : {}),
    ...(record.currentOnly !== undefined ? { currentOnly: record.currentOnly } : {}),
    ...projection,
  };
}

function parseProjectionV2(input: unknown): TurnReceiptProjectionV2 {
  const record = assertRecord(input);
  assertAllowedKeys(record, ['schemaVersion', 'identityDomain', 'runtime', 'projectId', 'sessionHash']);
  if (
    record.schemaVersion !== 2
    || record.identityDomain !== HERMES_IDENTITY_DOMAIN
    || record.runtime !== 'hermes'
  ) throw new Error('turn_receipt_projection_required');
  return {
    schemaVersion: 2,
    identityDomain: HERMES_IDENTITY_DOMAIN,
    runtime: 'hermes',
    projectId: lowerSha256(record.projectId, 'project_id'),
    sessionHash: lowerSha256(record.sessionHash, 'session_hash'),
  };
}

function isV2Projection(input: unknown): boolean {
  return isRecord(input) && input.schemaVersion === 2;
}

function projectReceiptsV2(receipts: readonly TurnReceiptAny[], projection: TurnReceiptProjectionV2): TurnReceiptV2[] {
  return receipts.filter((receipt): receipt is TurnReceiptV2 => (
    receipt.schemaVersion === 2
    && receipt.identityDomain === projection.identityDomain
    && receipt.runtime === projection.runtime
    && receipt.projectId === projection.projectId
    && receipt.sessionHash === projection.sessionHash
  ));
}

function parseProjectionBinding(input: unknown): Required<Pick<
  TurnReceiptListOptions,
  'runtime' | 'projectId' | 'sessionHash'
>> {
  const record = assertRecord(input);
  assertAllowedKeys(record, ['runtime', 'projectId', 'sessionHash']);
  const parsed = parseListOptions(record);
  if (parsed.runtime === undefined || parsed.projectId === undefined || parsed.sessionHash === undefined) {
    throw new Error('turn_receipt_projection_required');
  }
  return {
    runtime: parsed.runtime,
    projectId: parsed.projectId,
    sessionHash: parsed.sessionHash,
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

function sortReceipts<T extends TurnReceiptAny>(receipts: T[]): T[] {
  return receipts.sort((a, b) => {
    if (a.schemaVersion !== b.schemaVersion) return a.schemaVersion - b.schemaVersion;
    const aDomain = a.schemaVersion === 2 ? a.identityDomain : '';
    const bDomain = b.schemaVersion === 2 ? b.identityDomain : '';
    if (aDomain < bDomain) return -1;
    if (aDomain > bDomain) return 1;
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

function projectReceipts(
  receipts: readonly TurnReceiptAny[],
  options: TurnReceiptListOptions,
): TurnReceiptV1[] {
  const legacy = receipts.filter((receipt): receipt is TurnReceiptV1 => receipt.schemaVersion === 1);
  if (options.runtime === undefined) return legacy;
  return legacy.filter((receipt) => (
    receipt.runtime === options.runtime
    && receipt.projectId === options.projectId
    && receipt.sessionHash === options.sessionHash
  ));
}

function knownCoverageFromCurrent(
  binding: TurnReceiptProjectionBindingV1,
  currentReceiptsInput: readonly TurnReceiptV1[],
): TurnReceiptKnownCoverageV1 {
  const current = sortReceipts([...currentReceiptsInput]);
  if (current.length === 0) {
    return {
      status: 'unknown',
      reasonCode: 'turn_receipt_no_known_receipts',
      knownReceiptCount: 0,
      gapCount: 0,
    };
  }
  const gaps = current.filter((receipt) => (
    receipt.state === 'OPEN'
    || (receipt.deltaState !== 'explicit_none' && receipt.deltaState !== 'emitted')
  ));
  if (gaps.length > 0) {
    return {
      status: 'partial',
      reasonCode: 'turn_receipt_known_gaps',
      knownReceiptCount: current.length,
      gapCount: gaps.length,
    };
  }
  const snapshotSha256 = crypto.createHash('sha256').update(`${JSON.stringify({
    schemaVersion: 1,
    binding,
    currentReceipts: current,
  })}\n`).digest('hex');
  return {
    status: 'known_closed',
    reasonCode: 'turn_receipt_all_known_receipts_closed',
    knownReceiptCount: current.length,
    gapCount: 0,
    snapshotSha256,
  };
}

export async function readTurnReceiptKnownCoverageUnlocked(
  workspace: Workspace,
  rawBinding: unknown,
): Promise<TurnReceiptKnownCoverageV1> {
  const binding = parseProjectionBinding(rawBinding);
  const store = await loadStoreUnlocked(workspace);
  const current = currentReceipts(projectReceipts(store.receipts, binding));
  return knownCoverageFromCurrent(binding, current);
}

export function validateTurnReceiptKnownClosedPreconditionV1(
  input: unknown,
): TurnReceiptKnownClosedPreconditionV1 {
  const record = assertRecord(input);
  assertAllowedKeys(record, ['schemaVersion', 'binding', 'requiredStatus', 'expectedSnapshotSha256']);
  if (record.schemaVersion !== 1 || record.requiredStatus !== 'known_closed') {
    throw new Error('checkpoint_receipt_coverage_precondition_invalid');
  }
  const binding = parseProjectionBinding(record.binding);
  if (typeof record.expectedSnapshotSha256 !== 'string' || !HASH_RE.test(record.expectedSnapshotSha256)) {
    throw new Error('checkpoint_receipt_coverage_precondition_invalid');
  }
  return {
    schemaVersion: 1,
    binding,
    requiredStatus: 'known_closed',
    expectedSnapshotSha256: record.expectedSnapshotSha256,
  };
}

export async function assertTurnReceiptKnownClosedPreconditionUnlocked(
  workspace: Workspace,
  input: unknown,
): Promise<void> {
  if (input === undefined) return;
  const precondition = validateTurnReceiptKnownClosedPreconditionV1(input);
  const coverage = await readTurnReceiptKnownCoverageUnlocked(workspace, precondition.binding);
  if (
    coverage.status !== precondition.requiredStatus
    || coverage.snapshotSha256 !== precondition.expectedSnapshotSha256
  ) throw new Error('checkpoint_receipt_coverage_precondition_failed');
}

type DurableTurn = {
  turnId: string;
  inputSourceHash: string;
  inputContentSha256: string;
  finalSourceHash: string;
  finalContentSha256: string;
  deltaState: TurnReceiptDeltaStateV1;
};

type DurableRevision = {
  schemaVersion: 1;
  runtime: 'hermes';
  sessionHash: string;
  revision: number;
  previousRevision: number;
  turns: DurableTurn[];
};

type DurableManifest = {
  schemaVersion: 1;
  runtime: 'hermes';
  sessionHash: string;
  currentRevision: number;
  current: {
    path: string;
    contentSha256: string;
    byteLength: number;
    committedAt: string;
  };
};

type DurablePublication = {
  schemaVersion: 1;
  sessionHash: string;
  revision: number;
  manifestPath: string;
  transcriptPath: string;
  contentSha256: string;
  committedAt: string;
};

type DurableProof = DurableTurn & { durableRevision: number; transcriptPath: string };
type ValidatedDurableSession = {
  projectId: string;
  sessionHash: string;
  currentRevision: number;
  committedAt: string;
  proofs: DurableProof[];
};

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalizeJson(value[key])]));
  }
  return value;
}

function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(canonicalizeJson(value))}\n`, 'utf8');
}

function sha256Bytes(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function assertPrivateDurableDirectory(rootReal: string, directory: string): Promise<void> {
  const resolved = path.resolve(directory);
  const relative = path.relative(rootReal, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('turn_receipt_replay_rejected');
  const entry = await fs.lstat(resolved);
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('turn_receipt_replay_rejected');
  if (process.platform !== 'win32' && (entry.mode & 0o777) !== 0o700) {
    throw new Error('turn_receipt_replay_rejected');
  }
  const real = await fs.realpath(resolved);
  const realRelative = path.relative(rootReal, real);
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) throw new Error('turn_receipt_replay_rejected');
}

async function durableRoot(hermesHomeValue: unknown): Promise<{
  homeReal: string;
  exportRoot: string;
  manifestsDirectory: string;
  revisionsDirectory: string;
}> {
  const hermesHome = boundedString(hermesHomeValue, 'hermes_home', 4096);
  const homeEntry = await fs.lstat(hermesHome);
  if (homeEntry.isSymbolicLink() || !homeEntry.isDirectory()) throw new Error('turn_receipt_replay_rejected');
  if (process.platform !== 'win32' && (homeEntry.mode & 0o777) !== 0o700) {
    throw new Error('turn_receipt_replay_rejected');
  }
  const homeReal = await fs.realpath(hermesHome);
  if (path.resolve(hermesHome) !== homeReal) throw new Error('turn_receipt_replay_rejected');
  const exportsDirectory = path.join(homeReal, 'exports');
  const transcriptsDirectory = path.join(exportsDirectory, 'transcripts');
  const exportRoot = path.join(transcriptsDirectory, 'v1');
  const manifestsDirectory = path.join(exportRoot, 'manifests');
  const revisionsDirectory = path.join(exportRoot, 'revisions');
  for (const directory of [homeReal, exportsDirectory, transcriptsDirectory, exportRoot, manifestsDirectory, revisionsDirectory]) {
    await assertPrivateDurableDirectory(homeReal, directory);
  }
  return { homeReal, exportRoot, manifestsDirectory, revisionsDirectory };
}

async function readPrivateCanonicalJson(
  rootReal: string,
  file: string,
  maxBytes: number,
): Promise<{ parsed: unknown; bytes: Buffer }> {
  const resolved = path.resolve(file);
  const relative = path.relative(rootReal, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('turn_receipt_replay_rejected');
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(resolved, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    throw new Error('turn_receipt_replay_rejected');
  }
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || opened.nlink !== 1
      || opened.size > maxBytes
      || (process.platform !== 'win32' && (opened.mode & 0o777) !== 0o600)
    ) throw new Error('turn_receipt_replay_rejected');
    const real = await fs.realpath(resolved);
    const realRelative = path.relative(rootReal, real);
    if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
      throw new Error('turn_receipt_replay_rejected');
    }
    const realStat = await fs.stat(real);
    if (opened.dev !== realStat.dev || opened.ino !== realStat.ino || !realStat.isFile()) {
      throw new Error('turn_receipt_replay_rejected');
    }
    const bytes = await handle.readFile();
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new Error('turn_receipt_replay_rejected');
    }
    if (!bytes.equals(canonicalJsonBytes(parsed))) throw new Error('turn_receipt_replay_rejected');
    return { parsed, bytes };
  } finally {
    await handle.close();
  }
}

function parseDurableTurn(input: unknown): DurableTurn {
  const record = assertRecord(input);
  assertAllowedKeys(record, [
    'turnId', 'inputSourceHash', 'inputContentSha256', 'finalSourceHash', 'finalContentSha256', 'deltaState',
  ]);
  if (record.deltaState !== 'not_emitted') throw new Error('turn_receipt_replay_rejected');
  return {
    turnId: lowerSha256(record.turnId, 'turn_id'),
    inputSourceHash: sourceHash(record.inputSourceHash, 'input_source_hash'),
    inputContentSha256: lowerSha256(record.inputContentSha256, 'input_content_sha256'),
    finalSourceHash: sourceHash(record.finalSourceHash, 'final_source_hash'),
    finalContentSha256: lowerSha256(record.finalContentSha256, 'final_content_sha256'),
    deltaState: 'not_emitted',
  };
}

function parseDurableRevision(input: unknown, sessionHash: string, expectedRevision: number): DurableRevision {
  const record = assertRecord(input);
  assertAllowedKeys(record, ['schemaVersion', 'runtime', 'sessionHash', 'revision', 'previousRevision', 'turns']);
  if (
    record.schemaVersion !== 1
    || record.runtime !== 'hermes'
    || record.sessionHash !== sessionHash
    || record.revision !== expectedRevision
    || record.previousRevision !== expectedRevision - 1
    || !Array.isArray(record.turns)
    || record.turns.length > MAX_DURABLE_TURNS
  ) throw new Error('turn_receipt_replay_rejected');
  const turns = record.turns.map(parseDurableTurn);
  if (new Set(turns.map((turn) => turn.turnId)).size !== turns.length) {
    throw new Error('turn_receipt_replay_rejected');
  }
  return {
    schemaVersion: 1,
    runtime: 'hermes',
    sessionHash,
    revision: expectedRevision,
    previousRevision: expectedRevision - 1,
    turns,
  };
}

function parseDurableManifest(input: unknown, expectedSessionHash?: string): DurableManifest {
  const record = assertRecord(input);
  assertAllowedKeys(record, ['schemaVersion', 'runtime', 'sessionHash', 'currentRevision', 'current']);
  if (record.schemaVersion !== 1 || record.runtime !== 'hermes') {
    throw new Error('turn_receipt_replay_rejected');
  }
  const sessionHash = lowerSha256(record.sessionHash, 'session_hash');
  if (expectedSessionHash !== undefined && sessionHash !== expectedSessionHash) {
    throw new Error('turn_receipt_replay_rejected');
  }
  const currentRevision = revision(record.currentRevision);
  if (currentRevision > MAX_DURABLE_REVISIONS) throw new Error('turn_receipt_replay_rejected');
  const current = assertRecord(record.current);
  assertAllowedKeys(current, ['path', 'contentSha256', 'byteLength', 'committedAt']);
  const expectedPath = `revisions/${sessionHash}/${currentRevision}.json`;
  if (
    current.path !== expectedPath
    || !Number.isSafeInteger(current.byteLength)
    || (current.byteLength as number) < 1
    || (current.byteLength as number) > MAX_REVISION_BYTES
  ) throw new Error('turn_receipt_replay_rejected');
  return {
    schemaVersion: 1,
    runtime: 'hermes',
    sessionHash,
    currentRevision,
    current: {
      path: expectedPath,
      contentSha256: lowerSha256(current.contentSha256, 'content_sha256'),
      byteLength: current.byteLength as number,
      committedAt: hostPublicationTimestamp(current.committedAt, 'committed_at'),
    },
  };
}

function parseDurablePublication(input: unknown): DurablePublication {
  const record = assertRecord(input);
  assertAllowedKeys(record, [
    'schemaVersion', 'sessionHash', 'revision', 'manifestPath', 'transcriptPath', 'contentSha256', 'committedAt',
  ]);
  if (record.schemaVersion !== 1) throw new Error('turn_receipt_replay_rejected');
  const sessionHash = lowerSha256(record.sessionHash, 'session_hash');
  const durableRevision = revision(record.revision);
  const manifestPath = `manifests/${sessionHash}.json`;
  const transcriptPath = `revisions/${sessionHash}/${durableRevision}.json`;
  if (record.manifestPath !== manifestPath || record.transcriptPath !== transcriptPath) {
    throw new Error('turn_receipt_replay_rejected');
  }
  return {
    schemaVersion: 1,
    sessionHash,
    revision: durableRevision,
    manifestPath,
    transcriptPath,
    contentSha256: lowerSha256(record.contentSha256, 'content_sha256'),
    committedAt: hostPublicationTimestamp(record.committedAt, 'committed_at'),
  };
}

function publicationFromManifest(manifest: DurableManifest): DurablePublication {
  return {
    schemaVersion: 1,
    sessionHash: manifest.sessionHash,
    revision: manifest.currentRevision,
    manifestPath: `manifests/${manifest.sessionHash}.json`,
    transcriptPath: manifest.current.path,
    contentSha256: manifest.current.contentSha256,
    committedAt: manifest.current.committedAt,
  };
}

function sameDurableTurn(left: DurableTurn, right: DurableTurn): boolean {
  return left.turnId === right.turnId
    && left.inputSourceHash === right.inputSourceHash
    && left.inputContentSha256 === right.inputContentSha256
    && left.finalSourceHash === right.finalSourceHash
    && left.finalContentSha256 === right.finalContentSha256
    && left.deltaState === right.deltaState;
}

async function validateDurableSession(
  root: Awaited<ReturnType<typeof durableRoot>>,
  projectIdValue: unknown,
  publicationValue: unknown,
): Promise<ValidatedDurableSession> {
  const projectId = lowerSha256(projectIdValue, 'project_id');
  const publication = parseDurablePublication(publicationValue);
  const manifestFile = path.join(root.exportRoot, publication.manifestPath);
  const manifestRead = await readPrivateCanonicalJson(root.homeReal, manifestFile, MAX_MANIFEST_BYTES);
  const manifest = parseDurableManifest(manifestRead.parsed, publication.sessionHash);
  const expectedPublication = publicationFromManifest(manifest);
  if (
    publication.revision !== expectedPublication.revision
    || publication.manifestPath !== expectedPublication.manifestPath
    || publication.transcriptPath !== expectedPublication.transcriptPath
    || publication.contentSha256 !== expectedPublication.contentSha256
    || publication.committedAt !== expectedPublication.committedAt
  ) throw new Error('turn_receipt_replay_rejected');

  const sessionDirectory = path.join(root.revisionsDirectory, publication.sessionHash);
  await assertPrivateDurableDirectory(root.homeReal, sessionDirectory);
  const entries = await fs.readdir(sessionDirectory, { withFileTypes: true });
  const expectedNames = new Set(Array.from(
    { length: manifest.currentRevision },
    (_, index) => `${index + 1}.json`,
  ));
  if (
    entries.some((entry) => {
      if (!entry.isFile() || !/^[1-9]\d*\.json$/.test(entry.name)) return true;
      const value = Number(entry.name.slice(0, -5));
      return !Number.isSafeInteger(value) || value > 2_147_483_647;
    })
    || [...expectedNames].some((name) => !entries.some((entry) => entry.name === name))
  ) throw new Error('turn_receipt_replay_rejected');

  const earliest = new Map<string, DurableProof>();
  for (let durableRevision = 1; durableRevision <= manifest.currentRevision; durableRevision += 1) {
    const transcriptPath = `revisions/${publication.sessionHash}/${durableRevision}.json`;
    const revisionFile = path.join(root.exportRoot, transcriptPath);
    const revisionRead = await readPrivateCanonicalJson(root.homeReal, revisionFile, MAX_REVISION_BYTES);
    const durable = parseDurableRevision(revisionRead.parsed, publication.sessionHash, durableRevision);
    if (durableRevision === manifest.currentRevision) {
      if (
        revisionRead.bytes.length !== manifest.current.byteLength
        || sha256Bytes(revisionRead.bytes) !== manifest.current.contentSha256
      ) throw new Error('turn_receipt_replay_rejected');
    }
    for (const turn of durable.turns) {
      const previous = earliest.get(turn.turnId);
      if (previous === undefined) {
        earliest.set(turn.turnId, { ...turn, durableRevision, transcriptPath });
      } else if (!sameDurableTurn(previous, turn)) {
        throw new Error('turn_receipt_replay_rejected');
      }
    }
  }
  return {
    projectId,
    sessionHash: publication.sessionHash,
    currentRevision: manifest.currentRevision,
    committedAt: manifest.current.committedAt,
    proofs: [...earliest.values()].sort((a, b) => a.turnId.localeCompare(b.turnId)),
  };
}

async function scanValidatedDurableSessions(
  hermesHomeValue: unknown,
  projectIdValue: unknown,
): Promise<ValidatedDurableSession[]> {
  const root = await durableRoot(hermesHomeValue);
  const projectId = lowerSha256(projectIdValue, 'project_id');
  const entries = await fs.readdir(root.manifestsDirectory, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  if (
    entries.length > MAX_RECEIPTS
    || entries.some((entry) => !entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name))
  ) throw new Error('turn_receipt_replay_rejected');
  const sessions: ValidatedDurableSession[] = [];
  for (const entry of entries) {
    const sessionHash = entry.name.slice(0, -5);
    const manifestRead = await readPrivateCanonicalJson(
      root.homeReal,
      path.join(root.manifestsDirectory, entry.name),
      MAX_MANIFEST_BYTES,
    );
    const manifest = parseDurableManifest(manifestRead.parsed, sessionHash);
    sessions.push(await validateDurableSession(root, projectId, publicationFromManifest(manifest)));
  }
  return sessions;
}

function committedReceiptV2(
  existing: TurnReceiptV2 | undefined,
  session: ValidatedDurableSession,
  proof: DurableProof,
): TurnReceiptV2 {
  const openedAt = existing?.openedAt ?? session.committedAt;
  return {
    schemaVersion: 2,
    state: 'COMMITTED',
    identityDomain: HERMES_IDENTITY_DOMAIN,
    origin: existing?.origin ?? 'durable-replay',
    runtime: 'hermes',
    projectId: session.projectId,
    sessionHash: session.sessionHash,
    turnId: proof.turnId,
    revision: 1,
    inputSourceHash: proof.inputSourceHash,
    inputContentSha256: proof.inputContentSha256,
    finalSourceHash: proof.finalSourceHash,
    finalContentSha256: proof.finalContentSha256,
    openedAt,
    committedAt: session.committedAt,
    deltaState: proof.deltaState,
    durableRevision: proof.durableRevision,
    transcriptPath: proof.transcriptPath,
  };
}

function sameCommittedDurableEvidence(receipt: TurnReceiptV2, proof: DurableProof): boolean {
  return receipt.state === 'COMMITTED'
    && receipt.finalSourceHash === proof.finalSourceHash
    && receipt.finalContentSha256 === proof.finalContentSha256
    && receipt.deltaState === proof.deltaState
    && receipt.durableRevision === proof.durableRevision
    && receipt.transcriptPath === proof.transcriptPath;
}

async function applyValidatedDurableSessions(
  workspace: Workspace,
  sessions: readonly ValidatedDurableSession[],
): Promise<ReplayResult> {
  return await withWorkspaceLock(workspace, async () => {
    const store = await loadStoreUnlocked(workspace);
    const cursorMap = new Map((store.replayCursors ?? []).map((cursor) => [cursor.sessionHash, cursor]));
    for (const session of sessions) {
      const cursor = cursorMap.get(session.sessionHash);
      if (cursor !== undefined && session.currentRevision < cursor.revision) {
        return {
          status: 'rejected',
          code: 'turn_receipt_replay_cursor_regression',
          receiptsWritten: 0,
          cursorRevision: cursor.revision,
        };
      }
    }

    const planned = new Map<string, { existing: TurnReceiptV2 | undefined; receipt: TurnReceiptV2 }>();
    let additions = 0;
    for (const session of sessions) {
      for (const proof of session.proofs) {
        const key = [
          2,
          HERMES_IDENTITY_DOMAIN,
          'hermes',
          session.projectId,
          session.sessionHash,
          proof.turnId,
          1,
        ].join('\0');
        const found = store.receipts.find((receipt) => identityKey(receipt) === key);
        const existing = found?.schemaVersion === 2 ? found : undefined;
        if (
          existing !== undefined
          && (
            existing.inputSourceHash !== proof.inputSourceHash
            || existing.inputContentSha256 !== proof.inputContentSha256
          )
        ) {
          const cursorRevision = cursorMap.get(session.sessionHash)?.revision;
          return {
            status: 'anomaly',
            code: 'turn_receipt_replay_input_divergence',
            receiptsWritten: 0,
            ...(cursorRevision === undefined ? {} : { cursorRevision }),
          };
        }
        if (existing?.state === 'COMMITTED') {
          if (!sameCommittedDurableEvidence(existing, proof)) {
            const cursorRevision = cursorMap.get(session.sessionHash)?.revision;
            return {
              status: 'rejected',
              code: 'turn_receipt_replay_rejected',
              receiptsWritten: 0,
              ...(cursorRevision === undefined ? {} : { cursorRevision }),
            };
          }
          continue;
        }
        if (existing !== undefined && Date.parse(session.committedAt) < Date.parse(existing.openedAt)) {
          const cursorRevision = cursorMap.get(session.sessionHash)?.revision;
          return {
            status: 'rejected',
            code: 'turn_receipt_replay_rejected',
            receiptsWritten: 0,
            ...(cursorRevision === undefined ? {} : { cursorRevision }),
          };
        }
        if (existing === undefined) additions += 1;
        planned.set(key, { existing, receipt: committedReceiptV2(existing, session, proof) });
      }
    }
    if (store.receipts.length + additions > MAX_RECEIPTS) {
      return { status: 'rejected', code: 'turn_receipt_replay_rejected', receiptsWritten: 0 };
    }

    const receipts = [...store.receipts];
    let receiptsWritten = 0;
    for (const [key, plan] of planned) {
      const index = receipts.findIndex((receipt) => identityKey(receipt) === key);
      if (index < 0) receipts.push(plan.receipt);
      else receipts[index] = plan.receipt;
      receiptsWritten += 1;
    }
    let cursorChanged = false;
    for (const session of sessions) {
      const cursor = cursorMap.get(session.sessionHash);
      if (cursor === undefined || cursor.revision < session.currentRevision) {
        cursorMap.set(session.sessionHash, {
          schemaVersion: 1,
          sessionHash: session.sessionHash,
          revision: session.currentRevision,
        });
        cursorChanged = true;
      }
    }
    if (receiptsWritten > 0 || cursorChanged) {
      await saveStoreUnlocked(workspace, {
        schemaVersion: 1,
        receipts,
        replayCursors: [...cursorMap.values()],
      });
    }
    const cursorRevision = sessions.length === 0
      ? undefined
      : Math.max(...sessions.map((session) => session.currentRevision));
    return {
      status: 'ok',
      receiptsWritten,
      ...(cursorRevision === undefined ? {} : { cursorRevision }),
    };
  });
}

function rejectedReplay(): ReplayResult {
  return { status: 'rejected', code: 'turn_receipt_replay_rejected', receiptsWritten: 0 };
}

export function createTurnReceiptService(workspace: Workspace): TurnReceiptService {
  return {
    hashSessionId: hashTurnReceiptSessionId,
    hashSourceId: hashTurnReceiptSourceId,
    async open(raw) {
      const input = parseAnyOpenInput(raw);
      return await withWorkspaceLock(workspace, async () => {
        const store = await loadStoreUnlocked(workspace);
        const key = identityKey(input);
        const existing = store.receipts.find((receipt) => identityKey(receipt) === key);
        if (existing) {
          if (
            existing.inputSourceHash !== input.inputSourceHash
            || existing.inputContentSha256 !== input.inputContentSha256
          ) throw new Error('turn_receipt_conflict');
          return existing;
        }
        if (store.receipts.length >= MAX_RECEIPTS) throw new Error('turn_receipt_store_full');
        const receipt = input.schemaVersion === 1 ? canonicalOpenReceipt(input) : canonicalOpenReceiptV2(input);
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
        const found = index < 0 ? undefined : store.receipts[index];
        const existing = found?.schemaVersion === 1 ? found : undefined;
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
          deltaLinkage: input.deltaLinkage,
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
        const receipt = store.receipts.find((candidate) => identityKey(candidate) === key);
        return receipt?.schemaVersion === 1 ? receipt : null;
      });
    },
    async list(rawOptions) {
      if (isV2Projection(rawOptions)) {
        const projection = parseProjectionV2(rawOptions);
        return await withWorkspaceLock(workspace, async () => {
          const store = await loadStoreUnlocked(workspace);
          const items = sortReceipts(projectReceiptsV2(store.receipts, projection));
          return { items, total: items.length, nextOffset: null };
        });
      }
      const options = parseListOptions(rawOptions);
      return await withWorkspaceLock(workspace, async () => {
        const store = await loadStoreUnlocked(workspace);
        const projected = projectReceipts(store.receipts, options);
        const receipts = sortReceipts(options.currentOnly ? currentReceipts(projected) : projected);
        return pageReceipts(receipts, options);
      });
    },
    async gaps(rawOptions) {
      const options = parseListOptions(rawOptions);
      return await withWorkspaceLock(workspace, async () => {
        const store = await loadStoreUnlocked(workspace);
        const projected = projectReceipts(store.receipts, options);
        const candidates = options.currentOnly ? currentReceipts(projected) : projected;
        const receipts = sortReceipts(candidates.filter((receipt) => (
          receipt.state === 'OPEN'
          || (receipt.deltaState !== 'explicit_none' && receipt.deltaState !== 'emitted')
        )));
        return pageReceipts(receipts, options);
      });
    },
    async knownCoverage(rawBinding) {
      const binding = parseProjectionBinding(rawBinding);
      return await withWorkspaceLock(workspace, async () => (
        await readTurnReceiptKnownCoverageUnlocked(workspace, binding)
      ));
    },
    async consumeDurableTranscriptRevision(raw) {
      try {
        const record = assertRecord(raw);
        assertAllowedKeys(record, ['hermesHome', 'projectId', 'publication']);
        const root = await durableRoot(record.hermesHome);
        const session = await validateDurableSession(root, record.projectId, record.publication);
        return await applyValidatedDurableSessions(workspace, [session]);
      } catch {
        return rejectedReplay();
      }
    },
    async scanDurableTranscriptRevisions(raw) {
      try {
        const record = assertRecord(raw);
        assertAllowedKeys(record, ['hermesHome', 'projectId']);
        const sessions = await scanValidatedDurableSessions(record.hermesHome, record.projectId);
        return await applyValidatedDurableSessions(workspace, sessions);
      } catch {
        return rejectedReplay();
      }
    },
  };
}
