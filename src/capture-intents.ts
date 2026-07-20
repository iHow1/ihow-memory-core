// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import fs from 'node:fs/promises';
import { constants as fsConstants, type Stats } from 'node:fs';
import path from 'node:path';
import type {
  TurnReceiptIdentityV1,
  TurnReceiptV1,
  Workspace,
} from './types.ts';
import {
  createMemoryProposalV1,
  type MemoryProposalInputV1,
  type MemoryProposalV1,
} from './memory-proposals.ts';
import { canonicalJsonV1, canonicalSha256V1 } from './evaluation.ts';
import { containsSecretLikeContent } from './governance.ts';
import { atomicWriteFile, assertRealPathWithin } from './store/files.ts';
import { withWorkspaceLock } from './store/lock.ts';
import { relativeToSpace } from './workspace.ts';
import type { TurnReceiptService } from './turn-receipts.ts';

const HASH_RE = /^[a-f0-9]{64}$/;
const SOURCE_HASH_RE = /^sha256:[a-f0-9]{64}$/;
const SAFE_ID_RE = /^[A-Za-z0-9._:-]+$/;
const PROPOSAL_ID_RE = /^mp1_[a-f0-9]{64}$/;
const CAPTURE_KEY_RE = /^ci1_[a-f0-9]{64}$/;
const MAX_DELTA_BYTES = 8 * 1024;
const MAX_PENDING_INTENTS = 256;
const CAPTURE_INTENT_TTL_SECONDS = 3600;
const MAX_CANDIDATE_BYTES = 16 * 1024;

export type MemoryDeltaV1 = {
  schemaVersion: 1;
  receiptIdentity: TurnReceiptIdentityV1;
  finalEvidence: {
    finalSourceHash: string;
    finalContentSha256: string;
    committedAt: string;
  };
  proposal: MemoryProposalInputV1;
  deltaHash: string;
};

export type CaptureTurnDeltaOptionsV1 = {
  failAfter?: 'proposal_durable';
};

export type CaptureTurnDeltaResultV1 = {
  schemaVersion: 1;
  status: 'captured';
  captureIntentKey: string;
  candidate: {
    candidateId: string;
    path: string;
  };
  receipt: TurnReceiptV1;
};

export type CaptureIntentRecoveryResultV1 = {
  recovered: number;
  pending: number;
  completed: number;
  cleaned: number;
};

type ValidatedDeltaV1 = {
  delta: MemoryDeltaV1;
  proposal: MemoryProposalV1;
};

type CaptureIdentityV1 = {
  captureIntentKey: string;
  candidateId: string;
  candidateAbsolutePath: string;
  candidatePath: string;
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactRecord(value: unknown, keys: readonly string[], label: string): UnknownRecord {
  if (!isRecord(value)) throw new Error(`capture_delta_${label}_invalid`);
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`capture_delta_unknown_field:${label}.${key}`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) throw new Error(`capture_delta_missing_field:${label}.${key}`);
  }
  return value;
}

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function assertNoRawContentFields(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoRawContentFields(item);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const normalized = normalizedKey(key);
    if (
      normalized.includes('prompt')
      || normalized.includes('response')
      || normalized.includes('transcriptbody')
      || normalized.includes('rawcontent')
      || normalized.includes('messagehistory')
      || normalized.includes('conversationhistory')
      || normalized.includes('tooloutput')
    ) throw new Error('capture_delta_raw_content_forbidden');
    assertNoRawContentFields(child);
  }
}

function exactString(value: unknown, pattern: RegExp, label: string, max: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || !pattern.test(value)) {
    throw new Error(`capture_delta_${label}_invalid`);
  }
  return value;
}

function exactTimestamp(value: unknown): string {
  if (typeof value !== 'string' || value.length > 32) throw new Error('capture_delta_committed_at_invalid');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error('capture_delta_committed_at_invalid');
  }
  return value;
}

function validateReceiptIdentity(value: unknown): TurnReceiptIdentityV1 {
  const record = exactRecord(value, ['runtime', 'projectId', 'sessionHash', 'turnId', 'revision'], 'receipt_identity');
  const runtime = exactString(record.runtime, SAFE_ID_RE, 'runtime', 64);
  const projectId = exactString(record.projectId, HASH_RE, 'project_id', 64);
  const sessionHash = exactString(record.sessionHash, HASH_RE, 'session_hash', 64);
  const turnId = exactString(record.turnId, SAFE_ID_RE, 'turn_id', 128);
  if (runtime !== runtime.toLowerCase()) throw new Error('capture_delta_runtime_invalid');
  if (!Number.isSafeInteger(record.revision) || (record.revision as number) < 1 || (record.revision as number) > 2_147_483_647) {
    throw new Error('capture_delta_revision_invalid');
  }
  return { runtime, projectId, sessionHash, turnId, revision: record.revision as number };
}

function validateFinalEvidence(value: unknown): MemoryDeltaV1['finalEvidence'] {
  const record = exactRecord(value, ['finalSourceHash', 'finalContentSha256', 'committedAt'], 'final_evidence');
  return {
    finalSourceHash: exactString(record.finalSourceHash, SOURCE_HASH_RE, 'final_source_hash', 71),
    finalContentSha256: exactString(record.finalContentSha256, HASH_RE, 'final_content_sha256', 64),
    committedAt: exactTimestamp(record.committedAt),
  };
}

export function validateMemoryDeltaV1(value: unknown): ValidatedDeltaV1 {
  assertNoRawContentFields(value);
  const record = exactRecord(
    value,
    ['schemaVersion', 'receiptIdentity', 'finalEvidence', 'proposal', 'deltaHash'],
    'envelope',
  );
  if (record.schemaVersion !== 1) throw new Error('capture_delta_schema_invalid');
  const receiptIdentity = validateReceiptIdentity(record.receiptIdentity);
  const finalEvidence = validateFinalEvidence(record.finalEvidence);
  const proposal = createMemoryProposalV1(record.proposal as MemoryProposalInputV1);
  const proposalInput = record.proposal as MemoryProposalInputV1;
  const deltaHash = exactString(record.deltaHash, HASH_RE, 'hash', 64);
  const hashInput = {
    schemaVersion: 1 as const,
    receiptIdentity,
    finalEvidence,
    proposal: proposalInput,
  };
  const expectedHash = canonicalSha256V1(hashInput);
  if (deltaHash !== expectedHash) throw new Error('capture_delta_hash_mismatch');
  const delta: MemoryDeltaV1 = { ...hashInput, deltaHash };
  const canonical = canonicalJsonV1(delta);
  if (Buffer.byteLength(canonical, 'utf8') > MAX_DELTA_BYTES) throw new Error('capture_delta_too_large');
  if (containsSecretLikeContent(canonical)) throw new Error('capture_delta_contains_secret_like_content');
  return { delta, proposal };
}

function parseCaptureOptions(value: unknown): CaptureTurnDeltaOptionsV1 {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error('capture_options_invalid');
  for (const key of Object.keys(value)) {
    if (key !== 'failAfter') throw new Error(`capture_options_unknown_field:${key}`);
  }
  if (value.failAfter !== undefined && value.failAfter !== 'proposal_durable') {
    throw new Error('capture_options_fail_after_invalid');
  }
  return value.failAfter === undefined ? {} : { failAfter: 'proposal_durable' };
}

function containmentRoot(workspace: Workspace): string {
  return workspace.mode === 'existing-memory-root' ? workspace.mcpDir : workspace.spaceDir;
}

function candidateContainmentRoot(workspace: Workspace): string {
  return workspace.mode === 'existing-memory-root' ? workspace.mcpDir : workspace.memoryDir;
}

function pendingDirectory(workspace: Workspace): string {
  return path.join(containmentRoot(workspace), 'capture-intents', 'pending');
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function ensurePrivateDirectoryTree(root: string, directory: string, errorPrefix: string): Promise<void> {
  if (!isInside(root, directory)) throw new Error(`${errorPrefix}_path_outside_store`);
  const rootEntry = await fs.lstat(root);
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
    throw new Error(`${errorPrefix}_path_outside_store`);
  }
  let current = path.resolve(root);
  const relative = path.relative(current, path.resolve(directory));
  for (const component of relative.split(path.sep).filter(Boolean)) {
    const next = path.join(current, component);
    let created = false;
    try {
      await fs.mkdir(next, { mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const entry = await fs.lstat(next);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`${errorPrefix}_path_outside_store`);
    await assertRealPathWithin(root, next).catch((error: unknown) => {
      if (error instanceof Error && error.message === 'path_outside_memory_workspace') {
        throw new Error(`${errorPrefix}_path_outside_store`);
      }
      throw error;
    });
    await fs.chmod(next, 0o700);
    if (created) await syncDirectory(current);
    current = next;
  }
}

function captureIdentity(workspace: Workspace, delta: MemoryDeltaV1, proposal: MemoryProposalV1): CaptureIdentityV1 {
  const captureIntentKey = `ci1_${canonicalSha256V1({
    schemaVersion: 1,
    receiptIdentity: delta.receiptIdentity,
    deltaHash: delta.deltaHash,
    proposalId: proposal.proposalId,
  })}`;
  const candidateId = `mc1_${canonicalSha256V1({
    schemaVersion: 1,
    captureIntentKey,
    proposalId: proposal.proposalId,
  })}`;
  const candidateAbsolutePath = path.join(workspace.candidatesDir, 'capture', `${candidateId}.md`);
  if (!isInside(workspace.candidatesDir, candidateAbsolutePath)) throw new Error('capture_candidate_path_outside_store');
  return {
    captureIntentKey,
    candidateId,
    candidateAbsolutePath,
    candidatePath: relativeToSpace(workspace, candidateAbsolutePath),
  };
}

function intentFile(workspace: Workspace, captureIntentKey: string): string {
  if (!CAPTURE_KEY_RE.test(captureIntentKey)) throw new Error('capture_intent_key_invalid');
  const file = path.join(pendingDirectory(workspace), `${captureIntentKey}.json`);
  if (!isInside(pendingDirectory(workspace), file)) throw new Error('capture_intent_path_outside_store');
  return file;
}

function renderCandidate(identity: CaptureIdentityV1, delta: MemoryDeltaV1, proposal: MemoryProposalV1): string {
  const frontmatter: Record<string, unknown> = {
    type: 'memory_candidate',
    candidate_id: identity.candidateId,
    proposal_id: proposal.proposalId,
    proposal_delta_hash: delta.deltaHash,
    status: 'candidate',
    proposal_review: proposal.review,
    proposal_safety: proposal.safety,
  };
  const lines = ['---'];
  for (const [key, value] of Object.entries(frontmatter)) lines.push(`${key}: ${canonicalJsonV1(value).trimEnd()}`);
  lines.push('---', '', proposal.text);
  const content = `${lines.join('\n')}\n`;
  if (Buffer.byteLength(content, 'utf8') > MAX_CANDIDATE_BYTES) throw new Error('capture_candidate_too_large');
  if (containsSecretLikeContent(content)) throw new Error('capture_candidate_contains_secret_like_content');
  return content;
}

async function readPrivateFile(
  file: string,
  root: string,
  maxBytes: number,
  errorPrefix: string,
): Promise<{ content: string; stat: Stats } | null> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP') throw new Error(`${errorPrefix}_path_outside_store`);
    throw error;
  }
  try {
    const real = await assertRealPathWithin(root, file).catch((error: unknown) => {
      if (error instanceof Error && error.message === 'path_outside_memory_workspace') {
        throw new Error(`${errorPrefix}_path_outside_store`);
      }
      throw error;
    });
    const [opened, current] = await Promise.all([handle.stat(), fs.stat(real)]);
    if (
      !opened.isFile()
      || opened.nlink !== 1
      || opened.dev !== current.dev
      || opened.ino !== current.ino
      || (process.platform !== 'win32' && (opened.mode & 0o777) !== 0o600)
    ) throw new Error(`${errorPrefix}_file_invalid`);
    if (opened.size > maxBytes) throw new Error(`${errorPrefix}_too_large`);
    return { content: await handle.readFile('utf8'), stat: opened };
  } finally {
    await handle.close();
  }
}

async function ensureDurableFileUnlocked(
  file: string,
  content: string,
  root: string,
  maxBytes: number,
  errorPrefix: string,
): Promise<void> {
  await ensurePrivateDirectoryTree(root, path.dirname(file), errorPrefix);
  const existing = await readPrivateFile(file, root, maxBytes, errorPrefix);
  if (existing !== null) {
    if (existing.content !== content) throw new Error(`${errorPrefix}_mismatch`);
    return;
  }
  try {
    await atomicWriteFile(file, content, root, {
      directoryMode: 0o700,
      fileMode: 0o600,
      durable: true,
      boundedTemp: true,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'path_outside_memory_workspace') {
      throw new Error(`${errorPrefix}_path_outside_store`);
    }
    throw error;
  }
  const durable = await readPrivateFile(file, root, maxBytes, errorPrefix);
  if (durable?.content !== content) throw new Error(`${errorPrefix}_durability_check_failed`);
}

async function ensurePendingIntent(workspace: Workspace, identity: CaptureIdentityV1, delta: MemoryDeltaV1): Promise<void> {
  const content = canonicalJsonV1(delta);
  await withWorkspaceLock(workspace, async () => {
    const target = intentFile(workspace, identity.captureIntentKey);
    const pending = await validatePendingStoreUnlocked(workspace);
    const files = pending.map((entry) => entry.file);
    const targetExists = files.includes(target);
    if (!targetExists && files.length >= MAX_PENDING_INTENTS) throw new Error('capture_intent_store_full');
    await ensureDurableFileUnlocked(
      target,
      content,
      containmentRoot(workspace),
      MAX_DELTA_BYTES,
      'capture_intent',
    );
  });
}

async function ensureCandidate(
  workspace: Workspace,
  identity: CaptureIdentityV1,
  delta: MemoryDeltaV1,
  proposal: MemoryProposalV1,
): Promise<void> {
  const content = renderCandidate(identity, delta, proposal);
  await withWorkspaceLock(workspace, async () => {
    await ensureDurableFileUnlocked(
      identity.candidateAbsolutePath,
      content,
      candidateContainmentRoot(workspace),
      MAX_CANDIDATE_BYTES,
      'capture_candidate',
    );
  });
}

async function emitReceipt(
  turnReceipts: TurnReceiptService,
  delta: MemoryDeltaV1,
  proposal: MemoryProposalV1,
  deltaId: string,
): Promise<TurnReceiptV1> {
  const existing = await turnReceipts.read(delta.receiptIdentity);
  if (!existing) throw new Error('turn_receipt_open_required');
  return await turnReceipts.commit({
    schemaVersion: 1,
    ...delta.receiptIdentity,
    inputSourceHash: existing.inputSourceHash,
    inputContentSha256: existing.inputContentSha256,
    finalSourceHash: delta.finalEvidence.finalSourceHash,
    finalContentSha256: delta.finalEvidence.finalContentSha256,
    committedAt: delta.finalEvidence.committedAt,
    deltaState: 'emitted',
    deltaLinkage: {
      deltaId,
      deltaHash: delta.deltaHash,
      proposalId: proposal.proposalId,
    },
  });
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_DIRECTORY);
  try {
    try {
      await handle.sync();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP' && !(process.platform === 'win32' && code === 'EPERM')) {
        throw error;
      }
    }
  } finally {
    await handle.close();
  }
}

async function cleanPendingIntent(workspace: Workspace, captureIntentKey: string): Promise<boolean> {
  return await withWorkspaceLock(workspace, async () => {
    const file = intentFile(workspace, captureIntentKey);
    const existing = await readPrivateFile(file, containmentRoot(workspace), MAX_DELTA_BYTES, 'capture_intent');
    if (existing === null) return false;
    await fs.unlink(file);
    await syncDirectory(path.dirname(file));
    return true;
  });
}

async function listPendingIntentFilesUnlocked(workspace: Workspace): Promise<string[]> {
  const directory = pendingDirectory(workspace);
  await ensurePrivateDirectoryTree(containmentRoot(workspace), directory, 'capture_intent');
  const entry = await fs.lstat(directory);
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('capture_intent_path_outside_store');
  await fs.chmod(directory, 0o700);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const item of entries) {
    if (item.isFile() && /^\.ci1_[a-f0-9]{64}\.json\.tmp$/.test(item.name)) continue;
    if (!item.isFile() || !/^ci1_[a-f0-9]{64}\.json$/.test(item.name)) {
      throw new Error('capture_intent_store_invalid');
    }
    files.push(path.join(directory, item.name));
  }
  return files.sort((a, b) => a.localeCompare(b));
}

async function readPendingIntentUnlocked(
  workspace: Workspace,
  file: string,
): Promise<ValidatedDeltaV1 & { identity: CaptureIdentityV1 }> {
  if (!isInside(pendingDirectory(workspace), file)) throw new Error('capture_intent_path_outside_store');
  const opened = await readPrivateFile(file, containmentRoot(workspace), MAX_DELTA_BYTES, 'capture_intent');
  if (opened === null) throw new Error('capture_intent_missing');
  const now = Date.now();
  if (
    opened.stat.mtimeMs > now
    || now - opened.stat.mtimeMs > CAPTURE_INTENT_TTL_SECONDS * 1000
  ) throw new Error('capture_intent_stale');
  const raw = opened.content;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('capture_intent_invalid');
  }
  const validated = validateMemoryDeltaV1(parsed);
  if (raw !== canonicalJsonV1(validated.delta)) throw new Error('capture_intent_noncanonical');
  const identity = captureIdentity(workspace, validated.delta, validated.proposal);
  if (path.basename(file) !== `${identity.captureIntentKey}.json`) throw new Error('capture_intent_identity_mismatch');
  return { ...validated, identity };
}

async function validatePendingStoreUnlocked(
  workspace: Workspace,
): Promise<Array<ValidatedDeltaV1 & { identity: CaptureIdentityV1; file: string }>> {
  const files = await listPendingIntentFilesUnlocked(workspace);
  const pending = [];
  for (const file of files) {
    pending.push({ ...(await readPendingIntentUnlocked(workspace, file)), file });
  }
  if (files.length > MAX_PENDING_INTENTS) throw new Error('capture_intent_store_full');
  return pending;
}

export function createCaptureIntentService(workspace: Workspace, turnReceipts: TurnReceiptService): {
  captureTurnDelta(input: unknown, options?: unknown): Promise<CaptureTurnDeltaResultV1>;
  recoverCaptureIntents(): Promise<CaptureIntentRecoveryResultV1>;
} {
  return {
    async captureTurnDelta(rawInput, rawOptions) {
      const options = parseCaptureOptions(rawOptions);
      const { delta, proposal } = validateMemoryDeltaV1(rawInput);
      const identity = captureIdentity(workspace, delta, proposal);

      await ensurePendingIntent(workspace, identity, delta);
      await ensureCandidate(workspace, identity, delta, proposal);
      if (options.failAfter === 'proposal_durable') throw new Error('capture_fail_after:proposal_durable');

      const receipt = await emitReceipt(turnReceipts, delta, proposal, identity.captureIntentKey);
      await cleanPendingIntent(workspace, identity.captureIntentKey);
      return {
        schemaVersion: 1,
        status: 'captured',
        captureIntentKey: identity.captureIntentKey,
        candidate: { candidateId: identity.candidateId, path: identity.candidatePath },
        receipt,
      };
    },
    async recoverCaptureIntents() {
      const pendingIntents = await withWorkspaceLock(
        workspace,
        async () => await validatePendingStoreUnlocked(workspace),
      );
      let recovered = 0;
      let cleaned = 0;
      for (const { delta, proposal, identity } of pendingIntents) {
        await ensureCandidate(workspace, identity, delta, proposal);
        await emitReceipt(turnReceipts, delta, proposal, identity.captureIntentKey);
        if (await cleanPendingIntent(workspace, identity.captureIntentKey)) cleaned += 1;
        recovered += 1;
      }
      const pending = await withWorkspaceLock(workspace, async () => (await listPendingIntentFilesUnlocked(workspace)).length);
      return { recovered, pending, completed: 0, cleaned };
    },
  };
}
