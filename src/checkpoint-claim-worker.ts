// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import {
  CHECKPOINT_ARTIFACT_MAX_BYTES,
  canonicalCheckpointJson,
  validateCheckpointArtifact,
} from './checkpoint-schema.ts';

const ARTIFACT_ID_RE = /^cp_[a-f0-9]{64}$/;
const WRITE_CLAIM_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const INPUT_MAX_BYTES = 64 * 1024;
const TEST_PHASE_TIMEOUT_MS = 15_000;
const CLEANUP_MAX_DIRECTORY_ENTRIES = 4096;
const CLEANUP_MAX_PASSES = 8;

type WorkerOperation = 'prepare' | 'link';
type WorkerPhase =
  | 'after-empty-open-before-write'
  | 'after-write-before-final-check'
  | 'after-claim-verified-before-link'
  | 'after-link-before-final-check'
  | 'after-final-check-before-directory-sync';

type BaseRequest = {
  operation: WorkerOperation;
  artifactId: string;
  writeClaimId: string;
  canonicalArtifact: string;
  expectedDirectoryDev: string;
  expectedDirectoryIno: string;
  expectedArtifactsRealPath: string;
  expectedRootRealPath: string;
  testControlDirectory?: string;
  testPhase?: WorkerPhase;
  testFailAfterPhase?: boolean;
};

type WorkerRequest = BaseRequest & {
  guardedClaimDev: string;
  guardedClaimIno: string;
  guardedClaimCreated: boolean;
};

type FileIdentity = { dev: bigint; ino: bigint };

type WorkerSuccess =
  | { ok: true; result: 'prepared'; targetDev: string; targetIno: string }
  | { ok: true; result: 'created' | 'owned' | 'unexpected-existing'; targetDev: string; targetIno: string };

type WorkerFailure = { ok: false; error: string };
type WorkerResult = WorkerSuccess['result'];
type GuardSetup = {
  ok: true;
  event: 'guard-ready';
  claimDev: string;
  claimIno: string;
  claimCreated: boolean;
};
type GuardResponse =
  | GuardSetup
  | { ok: true; event: 'link-result'; result: 'created' | 'unexpected-existing' }
  | { ok: true; event: 'committed' }
  | WorkerFailure;
type ReaperCommand =
  | { command: 'arm'; claimDev: string; claimIno: string; claimCreated: boolean }
  | { command: 'prepare-commit'; result: WorkerResult; targetDev: string; targetIno: string }
  | { command: 'commit' }
  | { command: 'abort' };

function fail(code: string): never {
  throw new Error(code);
}

function stableError(error: unknown): string {
  if (error instanceof Error && /^checkpoint_[a-z0-9_]+$/.test(error.message)) return error.message;
  return 'checkpoint_internal_failure';
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assertBasename(name: string): void {
  if (name === '' || name === '.' || name === '..' || path.basename(name) !== name || name.includes('/') || name.includes('\\')) {
    fail('checkpoint_artifact_write_claim_invalid');
  }
}

function claimName(artifactId: string, writeClaimId: string): string {
  if (!ARTIFACT_ID_RE.test(artifactId) || !WRITE_CLAIM_ID_RE.test(writeClaimId)) {
    fail('checkpoint_artifact_write_claim_invalid');
  }
  const name = `.${artifactId}.claim-${writeClaimId}.tmp`;
  assertBasename(name);
  return name;
}

function finalName(artifactId: string): string {
  if (!ARTIFACT_ID_RE.test(artifactId)) fail('checkpoint_artifact_id_invalid');
  const name = `${artifactId}.json`;
  assertBasename(name);
  return name;
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const inputIterator = input[Symbol.asyncIterator]();

async function readLine(): Promise<string | undefined> {
  const next = await inputIterator.next();
  if (next.done) return undefined;
  if (Buffer.byteLength(next.value, 'utf8') > INPUT_MAX_BYTES) fail('checkpoint_artifact_write_claim_invalid');
  return next.value;
}

function parseObjectLine(line: string | undefined): Record<string, unknown> {
  if (line === undefined) fail('checkpoint_internal_failure');
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    fail('checkpoint_artifact_write_claim_invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('checkpoint_artifact_write_claim_invalid');
  return parsed as Record<string, unknown>;
}

async function readRequest(guarded: boolean): Promise<BaseRequest | WorkerRequest> {
  const item = parseObjectLine(await readLine());
  const allowed = new Set([
    'operation',
    'artifactId',
    'writeClaimId',
    'canonicalArtifact',
    'expectedDirectoryDev',
    'expectedDirectoryIno',
    'expectedArtifactsRealPath',
    'expectedRootRealPath',
    'testControlDirectory',
    'testPhase',
    'testFailAfterPhase',
    ...(guarded ? ['guardedClaimDev', 'guardedClaimIno', 'guardedClaimCreated'] : []),
  ]);
  if (Object.keys(item).some((key) => !allowed.has(key))) fail('checkpoint_artifact_write_claim_invalid');
  if (
    (item.operation !== 'prepare' && item.operation !== 'link')
    || typeof item.artifactId !== 'string'
    || typeof item.writeClaimId !== 'string'
    || typeof item.canonicalArtifact !== 'string'
    || typeof item.expectedDirectoryDev !== 'string'
    || typeof item.expectedDirectoryIno !== 'string'
    || typeof item.expectedArtifactsRealPath !== 'string'
    || typeof item.expectedRootRealPath !== 'string'
    || (item.testControlDirectory !== undefined && typeof item.testControlDirectory !== 'string')
    || (item.testPhase !== undefined && ![
      'after-empty-open-before-write',
      'after-write-before-final-check',
      'after-claim-verified-before-link',
      'after-link-before-final-check',
      'after-final-check-before-directory-sync',
    ].includes(item.testPhase as string))
    || (item.testFailAfterPhase !== undefined && typeof item.testFailAfterPhase !== 'boolean')
    || (guarded && (
      typeof item.guardedClaimDev !== 'string'
      || typeof item.guardedClaimIno !== 'string'
      || typeof item.guardedClaimCreated !== 'boolean'
    ))
  ) fail('checkpoint_artifact_write_claim_invalid');
  if (Buffer.byteLength(item.canonicalArtifact, 'utf8') > CHECKPOINT_ARTIFACT_MAX_BYTES) {
    fail('checkpoint_artifact_write_claim_invalid');
  }
  let artifact: ReturnType<typeof validateCheckpointArtifact>;
  try {
    artifact = validateCheckpointArtifact(JSON.parse(item.canonicalArtifact));
  } catch {
    fail('checkpoint_artifact_write_claim_invalid');
  }
  if (artifact.id !== item.artifactId || canonicalCheckpointJson(artifact) !== item.canonicalArtifact) {
    fail('checkpoint_artifact_write_claim_invalid');
  }
  if (
    !/^[0-9]+$/.test(item.expectedDirectoryDev)
    || !/^[0-9]+$/.test(item.expectedDirectoryIno)
    || (guarded && (!/^[0-9]+$/.test(item.guardedClaimDev as string) || !/^[0-9]+$/.test(item.guardedClaimIno as string)))
  ) fail('checkpoint_artifact_write_claim_invalid');
  if (!path.isAbsolute(item.expectedArtifactsRealPath) || !path.isAbsolute(item.expectedRootRealPath)) {
    fail('checkpoint_path_outside_store');
  }
  if (!isWithin(item.expectedRootRealPath, item.expectedArtifactsRealPath)) fail('checkpoint_path_outside_store');
  if ((item.testControlDirectory === undefined) !== (item.testPhase === undefined)) {
    fail('checkpoint_artifact_write_claim_invalid');
  }
  if (item.testControlDirectory !== undefined && !path.isAbsolute(item.testControlDirectory)) {
    fail('checkpoint_artifact_write_claim_invalid');
  }
  return item as BaseRequest | WorkerRequest;
}

async function assertCwd(request: BaseRequest, directoryHandle: fs.FileHandle): Promise<void> {
  let cwdReal: string;
  let cwdStat: Awaited<ReturnType<typeof fs.stat>>;
  let handleStat: Awaited<ReturnType<fs.FileHandle['stat']>>;
  try {
    [cwdReal, cwdStat, handleStat] = await Promise.all([
      fs.realpath('.'),
      fs.stat('.', { bigint: true }),
      directoryHandle.stat({ bigint: true }),
    ]);
  } catch {
    fail('checkpoint_path_outside_store');
  }
  if (
    cwdReal !== request.expectedArtifactsRealPath
    || !isWithin(request.expectedRootRealPath, cwdReal)
    || !cwdStat.isDirectory()
    || !handleStat.isDirectory()
    || cwdStat.dev.toString() !== request.expectedDirectoryDev
    || cwdStat.ino.toString() !== request.expectedDirectoryIno
    || handleStat.dev.toString() !== request.expectedDirectoryDev
    || handleStat.ino.toString() !== request.expectedDirectoryIno
  ) fail('checkpoint_path_outside_store');
}

async function cwdIsExpected(request: BaseRequest, directoryHandle: fs.FileHandle): Promise<boolean> {
  try {
    await assertCwd(request, directoryHandle);
    return true;
  } catch {
    return false;
  }
}

async function syncDirectory(directoryHandle: fs.FileHandle): Promise<void> {
  try {
    await directoryHandle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== 'win32' || (code !== 'EPERM' && code !== 'EINVAL' && code !== 'ENOTSUP')) throw error;
  }
}

async function phase(request: BaseRequest, name: WorkerPhase): Promise<void> {
  if (!request.testControlDirectory || request.testPhase !== name) return;
  const ready = path.join(request.testControlDirectory, `${name}.ready`);
  const release = path.join(request.testControlDirectory, `${name}.release`);
  await fs.writeFile(ready, `${JSON.stringify({ pid: process.pid })}\n`, { flag: 'wx', mode: 0o600 });
  const deadline = Date.now() + TEST_PHASE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await fs.access(release);
      if (request.testFailAfterPhase) fail('checkpoint_internal_failure');
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  fail('checkpoint_internal_failure');
}

async function relativeFileIdentity(name: string): Promise<FileIdentity | undefined> {
  try {
    const stat = await fs.lstat(name, { bigint: true });
    if (!stat.isFile()) return undefined;
    return { dev: stat.dev, ino: stat.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function verifyOpenRelativeFile(
  request: BaseRequest,
  directoryHandle: fs.FileHandle,
  name: string,
  handle: fs.FileHandle,
): Promise<BigIntStats> {
  await assertCwd(request, directoryHandle);
  const [handleStat, pathStat] = await Promise.all([
    handle.stat({ bigint: true }),
    fs.lstat(name, { bigint: true }),
  ]);
  if (
    !handleStat.isFile()
    || !pathStat.isFile()
    || handleStat.dev !== pathStat.dev
    || handleStat.ino !== pathStat.ino
  ) fail('checkpoint_artifact_write_claim_invalid');
  await assertCwd(request, directoryHandle);
  return handleStat as BigIntStats;
}

async function unlinkExactRelative(name: string, expected: FileIdentity): Promise<boolean> {
  const actual = await relativeFileIdentity(name);
  if (!actual || !sameIdentity(actual, expected)) return false;

  // Re-open and re-check immediately before unlink. POSIX has no identity-conditional unlink primitive,
  // but this prevents stale directory-enumeration results and refuses symlink/leaf substitutions.
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(name, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ELOOP') return false;
    throw error;
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameIdentity({ dev: opened.dev, ino: opened.ino }, expected)) return false;
    const finalCheck = await relativeFileIdentity(name);
    if (!finalCheck || !sameIdentity(finalCheck, expected)) return false;
    await fs.unlink(name);
    return true;
  } finally {
    await handle.close().catch(() => {});
  }
}

async function cleanupOwnedInode(expected: FileIdentity): Promise<void> {
  // A claim/final name is attacker-controlled after creation: it may be renamed, and the containing
  // artifacts directory may itself be moved while this process keeps the original inode as cwd.
  // Enumerate that pinned cwd and remove every hardlink to the exact owned inode, irrespective of name.
  // Bounded passes and entry counts turn directory-flood/continuous-rename attacks into a stable
  // fail-closed error rather than unbounded cleanup work or a false cleanup acknowledgement.
  for (let pass = 0; pass < CLEANUP_MAX_PASSES; pass += 1) {
    const entries = await fs.readdir('.', { withFileTypes: true });
    if (entries.length > CLEANUP_MAX_DIRECTORY_ENTRIES) fail('checkpoint_cleanup_incomplete');
    const names = [...new Set(entries.map((entry) => entry.name))];
    let found = false;
    for (const name of names) {
      const identity = await relativeFileIdentity(name);
      if (!identity || !sameIdentity(identity, expected)) continue;
      found = true;
      await unlinkExactRelative(name, expected);
    }
    if (!found) return;
  }

  const remaining = await fs.readdir('.', { withFileTypes: true });
  if (remaining.length > CLEANUP_MAX_DIRECTORY_ENTRIES) fail('checkpoint_cleanup_incomplete');
  for (const entry of remaining) {
    const identity = await relativeFileIdentity(entry.name);
    if (identity && sameIdentity(identity, expected)) fail('checkpoint_cleanup_incomplete');
  }
}

async function cleanupOwnedInodeExcept(expected: FileIdentity, preservedName: string): Promise<void> {
  assertBasename(preservedName);
  for (let pass = 0; pass < CLEANUP_MAX_PASSES; pass += 1) {
    const entries = await fs.readdir('.', { withFileTypes: true });
    if (entries.length > CLEANUP_MAX_DIRECTORY_ENTRIES) fail('checkpoint_cleanup_incomplete');
    let found = false;
    for (const name of new Set(entries.map((entry) => entry.name))) {
      if (name === preservedName) continue;
      const identity = await relativeFileIdentity(name);
      if (!identity || !sameIdentity(identity, expected)) continue;
      found = true;
      await unlinkExactRelative(name, expected);
    }
    if (!found) return;
  }
  fail('checkpoint_cleanup_incomplete');
}

async function hasOwnedInode(expected: FileIdentity): Promise<boolean> {
  const entries = await fs.readdir('.', { withFileTypes: true });
  if (entries.length > CLEANUP_MAX_DIRECTORY_ENTRIES) fail('checkpoint_cleanup_incomplete');
  for (const entry of entries) {
    const identity = await relativeFileIdentity(entry.name);
    if (identity && sameIdentity(identity, expected)) return true;
  }
  return false;
}

async function openVerifiedClaim(
  request: BaseRequest,
  directoryHandle: fs.FileHandle,
  name: string,
): Promise<{ handle: fs.FileHandle; identity: FileIdentity }> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(name, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') fail('checkpoint_artifact_write_claim_invalid');
    throw error;
  }
  try {
    const stat = await verifyOpenRelativeFile(request, directoryHandle, name, handle);
    if (stat.size > BigInt(CHECKPOINT_ARTIFACT_MAX_BYTES)) fail('checkpoint_artifact_write_claim_invalid');
    const raw = await handle.readFile('utf8');
    if (raw !== request.canonicalArtifact) fail('checkpoint_artifact_write_claim_invalid');
    await assertCwd(request, directoryHandle);
    return { handle, identity: { dev: stat.dev, ino: stat.ino } };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function openDirectory(request: BaseRequest): Promise<fs.FileHandle> {
  let directoryHandle: fs.FileHandle;
  try {
    directoryHandle = await fs.open('.', fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  } catch {
    fail('checkpoint_path_outside_store');
  }
  try {
    await assertCwd(request, directoryHandle);
    return directoryHandle;
  } catch (error) {
    await directoryHandle.close().catch(() => {});
    throw error;
  }
}

async function prepareWorker(request: WorkerRequest, directoryHandle: fs.FileHandle): Promise<WorkerSuccess> {
  const name = claimName(request.artifactId, request.writeClaimId);
  const guarded = { dev: BigInt(request.guardedClaimDev), ino: BigInt(request.guardedClaimIno) };
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(name, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW);
    const opened = await verifyOpenRelativeFile(request, directoryHandle, name, handle);
    if (!sameIdentity(guarded, { dev: opened.dev, ino: opened.ino })) fail('checkpoint_artifact_write_claim_invalid');
    if (!request.guardedClaimCreated) {
      if (opened.size > BigInt(CHECKPOINT_ARTIFACT_MAX_BYTES)) fail('checkpoint_artifact_write_claim_invalid');
      if (await handle.readFile('utf8') !== request.canonicalArtifact) fail('checkpoint_artifact_write_claim_invalid');
      await assertCwd(request, directoryHandle);
      return {
        ok: true,
        result: 'prepared',
        targetDev: guarded.dev.toString(),
        targetIno: guarded.ino.toString(),
      };
    }
    if (opened.size !== 0n) fail('checkpoint_artifact_write_claim_invalid');
    await phase(request, 'after-empty-open-before-write');
    await handle.writeFile(request.canonicalArtifact, 'utf8');
    await handle.sync();
    await phase(request, 'after-write-before-final-check');
    const written = await verifyOpenRelativeFile(request, directoryHandle, name, handle);
    if (!sameIdentity(guarded, { dev: written.dev, ino: written.ino })) fail('checkpoint_artifact_write_claim_invalid');
    if (written.size !== BigInt(Buffer.byteLength(request.canonicalArtifact, 'utf8'))) {
      fail('checkpoint_artifact_write_claim_invalid');
    }
    await syncDirectory(directoryHandle);
    await assertCwd(request, directoryHandle);
    return {
      ok: true,
      result: 'prepared',
      targetDev: guarded.dev.toString(),
      targetIno: guarded.ino.toString(),
    };
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
      handle = undefined;
    }
    const movedAway = !(await cwdIsExpected(request, directoryHandle));
    if (request.guardedClaimCreated) await cleanupOwnedInode(guarded);
    if (movedAway) fail('checkpoint_path_outside_store');
    throw error;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function waitForLinkResult(): Promise<'created' | 'unexpected-existing'> {
  process.stdout.write(`${JSON.stringify({ event: 'link-request' })}\n`);
  const item = parseObjectLine(await readLine());
  if (
    Object.keys(item).sort().join(',') !== 'command,result'
    || item.command !== 'link-result'
    || (item.result !== 'created' && item.result !== 'unexpected-existing')
  ) fail('checkpoint_internal_failure');
  return item.result;
}

async function linkWorker(request: WorkerRequest, directoryHandle: fs.FileHandle): Promise<WorkerSuccess> {
  const source = claimName(request.artifactId, request.writeClaimId);
  const destination = finalName(request.artifactId);
  const guarded = { dev: BigInt(request.guardedClaimDev), ino: BigInt(request.guardedClaimIno) };
  const claim = await openVerifiedClaim(request, directoryHandle, source).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('checkpoint_artifact_write_claim_missing');
    throw error;
  });
  let linked = false;
  let finalHandle: fs.FileHandle | undefined;
  let claimClosed = false;
  try {
    if (!sameIdentity(claim.identity, guarded)) fail('checkpoint_artifact_write_claim_invalid');
    await phase(request, 'after-claim-verified-before-link');
    await assertCwd(request, directoryHandle);
    const linkResult = await waitForLinkResult();
    linked = linkResult === 'created';
    if (linked) await phase(request, 'after-link-before-final-check');
    await assertCwd(request, directoryHandle);

    try {
      finalHandle = await fs.open(destination, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (error) {
      if (!linked) fail('checkpoint_artifact_write_claim_invalid');
      throw error;
    }
    let finalStat: BigIntStats;
    try {
      finalStat = await verifyOpenRelativeFile(request, directoryHandle, destination, finalHandle);
    } catch (error) {
      if (!linked) fail('checkpoint_artifact_write_claim_invalid');
      throw error;
    }
    const finalIdentity = { dev: finalStat.dev, ino: finalStat.ino };
    if (!sameIdentity(claim.identity, finalIdentity)) {
      if (!linked) {
        return {
          ok: true,
          result: 'unexpected-existing',
          targetDev: finalIdentity.dev.toString(),
          targetIno: finalIdentity.ino.toString(),
        };
      }
      fail('checkpoint_artifact_write_claim_invalid');
    }
    if (finalStat.size > BigInt(CHECKPOINT_ARTIFACT_MAX_BYTES)) {
      if (!linked) {
        return {
          ok: true,
          result: 'unexpected-existing',
          targetDev: finalIdentity.dev.toString(),
          targetIno: finalIdentity.ino.toString(),
        };
      }
      fail('checkpoint_artifact_write_claim_invalid');
    }
    const raw = await finalHandle.readFile('utf8');
    if (raw !== request.canonicalArtifact) {
      if (!linked) {
        return {
          ok: true,
          result: 'unexpected-existing',
          targetDev: finalIdentity.dev.toString(),
          targetIno: finalIdentity.ino.toString(),
        };
      }
      fail('checkpoint_integrity_hash_collision');
    }
    await assertCwd(request, directoryHandle);
    if (linked) {
      await phase(request, 'after-final-check-before-directory-sync');
      await syncDirectory(directoryHandle);
      await assertCwd(request, directoryHandle);
    }
    return {
      ok: true,
      result: linked ? 'created' : 'owned',
      targetDev: finalIdentity.dev.toString(),
      targetIno: finalIdentity.ino.toString(),
    };
  } catch (error) {
    if (finalHandle) {
      await finalHandle.close().catch(() => {});
      finalHandle = undefined;
    }
    const movedAway = !(await cwdIsExpected(request, directoryHandle));
    if (linked) {
      if (movedAway) await cleanupOwnedInode(claim.identity);
      else await unlinkExactRelative(destination, claim.identity);
    }
    if (stableError(error) === 'checkpoint_path_outside_store') {
      await claim.handle.close().catch(() => {});
      claimClosed = true;
      await cleanupOwnedInode(claim.identity);
    }
    if (movedAway) fail('checkpoint_path_outside_store');
    throw error;
  } finally {
    if (finalHandle) await finalHandle.close().catch(() => {});
    if (!claimClosed) await claim.handle.close().catch(() => {});
  }
}

async function workerMain(): Promise<WorkerSuccess> {
  const request = await readRequest(true) as WorkerRequest;
  const directoryHandle = await openDirectory(request);
  try {
    return request.operation === 'prepare'
      ? await prepareWorker(request, directoryHandle)
      : await linkWorker(request, directoryHandle);
  } finally {
    await directoryHandle.close().catch(() => {});
  }
}

async function guardPrepare(
  request: BaseRequest,
  directoryHandle: fs.FileHandle,
): Promise<{ identity: FileIdentity; created: boolean }> {
  const name = claimName(request.artifactId, request.writeClaimId);
  await assertCwd(request, directoryHandle);
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(
      name,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = await openVerifiedClaim(request, directoryHandle, name);
    await existing.handle.close();
    return { identity: existing.identity, created: false };
  }
  try {
    const stat = await verifyOpenRelativeFile(request, directoryHandle, name, handle);
    if (stat.size !== 0n) fail('checkpoint_artifact_write_claim_invalid');
    await syncDirectory(directoryHandle);
    return { identity: { dev: stat.dev, ino: stat.ino }, created: true };
  } catch (error) {
    const stat = await handle.stat({ bigint: true }).catch(() => undefined);
    await handle.close().catch(() => {});
    if (stat) await cleanupOwnedInode({ dev: stat.dev, ino: stat.ino });
    throw error;
  } finally {
    await handle.close().catch(() => {});
  }
}

async function guardClaim(request: BaseRequest, directoryHandle: fs.FileHandle): Promise<FileIdentity> {
  const name = claimName(request.artifactId, request.writeClaimId);
  const claim = await openVerifiedClaim(request, directoryHandle, name).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('checkpoint_artifact_write_claim_missing');
    throw error;
  });
  await claim.handle.close();
  return claim.identity;
}

function writeGuardResponse(response: GuardResponse): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

async function guardMain(): Promise<void> {
  const request = await readRequest(false) as BaseRequest;
  const directoryHandle = await openDirectory(request);
  const source = claimName(request.artifactId, request.writeClaimId);
  const destination = finalName(request.artifactId);
  let claimIdentity: FileIdentity | undefined;
  let claimCreated = false;
  let finalLinked = false;
  let committed = false;
  try {
    if (request.operation === 'prepare') {
      const setup = await guardPrepare(request, directoryHandle);
      claimIdentity = setup.identity;
      claimCreated = setup.created;
    } else {
      claimIdentity = await guardClaim(request, directoryHandle);
    }
    if (request.testControlDirectory) {
      await fs.writeFile(
        path.join(request.testControlDirectory, 'guard.ready'),
        `${JSON.stringify({ pid: process.pid })}\n`,
        { flag: 'wx', mode: 0o600 },
      );
    }
    writeGuardResponse({
      ok: true,
      event: 'guard-ready',
      claimDev: claimIdentity.dev.toString(),
      claimIno: claimIdentity.ino.toString(),
      claimCreated,
    });

    while (true) {
      const line = await readLine();
      if (line === undefined) break;
      const command = parseObjectLine(line);
      if (Object.keys(command).join(',') !== 'command' || typeof command.command !== 'string') {
        fail('checkpoint_internal_failure');
      }
      if (command.command === 'link') {
        if (request.operation !== 'link' || finalLinked || !claimIdentity) fail('checkpoint_internal_failure');
        await assertCwd(request, directoryHandle);
        const actualClaim = await relativeFileIdentity(source);
        if (!actualClaim || !sameIdentity(actualClaim, claimIdentity)) fail('checkpoint_artifact_write_claim_invalid');
        let result: 'created' | 'unexpected-existing';
        try {
          await fs.link(source, destination);
          finalLinked = true;
          result = 'created';
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          result = 'unexpected-existing';
        }
        writeGuardResponse({ ok: true, event: 'link-result', result });
        continue;
      }
      if (command.command === 'commit') {
        if (!claimIdentity) fail('checkpoint_internal_failure');
        await assertCwd(request, directoryHandle);
        const verifiedClaim = await openVerifiedClaim(request, directoryHandle, source);
        try {
          if (!sameIdentity(verifiedClaim.identity, claimIdentity)) fail('checkpoint_artifact_write_claim_invalid');
        } finally {
          await verifiedClaim.handle.close().catch(() => {});
        }
        if (request.operation === 'link' && finalLinked) {
          const finalHandle = await fs.open(destination, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
          try {
            const finalStat = await verifyOpenRelativeFile(request, directoryHandle, destination, finalHandle);
            if (!sameIdentity(claimIdentity, { dev: finalStat.dev, ino: finalStat.ino })) {
              fail('checkpoint_artifact_write_claim_invalid');
            }
            if (await finalHandle.readFile('utf8') !== request.canonicalArtifact) fail('checkpoint_integrity_hash_collision');
          } finally {
            await finalHandle.close().catch(() => {});
          }
        }
        await syncDirectory(directoryHandle);
        await assertCwd(request, directoryHandle);
        committed = true;
        writeGuardResponse({ ok: true, event: 'committed' });
        return;
      }
      if (command.command === 'abort') return;
      fail('checkpoint_internal_failure');
    }
  } finally {
    if (!committed && claimIdentity) {
      const movedAway = !(await cwdIsExpected(request, directoryHandle));
      if (finalLinked) {
        if (movedAway) await cleanupOwnedInode(claimIdentity);
        else await unlinkExactRelative(destination, claimIdentity);
      }
      if (
        (request.operation === 'prepare' && (claimCreated || movedAway))
        || (request.operation === 'link' && movedAway)
      ) {
        await cleanupOwnedInode(claimIdentity);
      }
      await syncDirectory(directoryHandle).catch(() => {});
    }
    await directoryHandle.close().catch(() => {});
  }
}

async function readReaperCommand(): Promise<ReaperCommand | undefined> {
  const line = await readLine();
  if (line === undefined) return undefined;
  const item = parseObjectLine(line);
  if (
    item.command === 'arm'
    && Object.keys(item).sort().join(',') === 'claimCreated,claimDev,claimIno,command'
    && typeof item.claimDev === 'string'
    && typeof item.claimIno === 'string'
    && typeof item.claimCreated === 'boolean'
    && /^[0-9]+$/.test(item.claimDev)
    && /^[0-9]+$/.test(item.claimIno)
  ) return item as ReaperCommand;
  if (
    item.command === 'prepare-commit'
    && Object.keys(item).sort().join(',') === 'command,result,targetDev,targetIno'
    && (item.result === 'prepared' || item.result === 'created' || item.result === 'owned' || item.result === 'unexpected-existing')
    && typeof item.targetDev === 'string'
    && typeof item.targetIno === 'string'
    && /^[0-9]+$/.test(item.targetDev)
    && /^[0-9]+$/.test(item.targetIno)
  ) return item as ReaperCommand;
  if (
    (item.command === 'commit' || item.command === 'abort')
    && Object.keys(item).join(',') === 'command'
  ) return item as ReaperCommand;
  fail('checkpoint_internal_failure');
}

async function cleanupReaperClaim(
  request: BaseRequest,
  directoryHandle: fs.FileHandle,
  identity: FileIdentity,
  claimCreated: boolean,
): Promise<void> {
  const movedAway = !(await cwdIsExpected(request, directoryHandle));
  if (movedAway || (request.operation === 'prepare' && claimCreated)) {
    await cleanupOwnedInode(identity);
  } else if (request.operation === 'link') {
    // Keep the durable canonical claim for a retry, but remove every other exact-inode alias an
    // uncommitted link attempt may have created or an attacker may have renamed/hardlinked.
    await cleanupOwnedInodeExcept(identity, claimName(request.artifactId, request.writeClaimId));
  }
  await syncDirectory(directoryHandle).catch(() => {});
}

async function verifyReaperClaimState(
  request: BaseRequest,
  directoryHandle: fs.FileHandle,
  identity: FileIdentity,
  result: WorkerResult,
  target: FileIdentity,
): Promise<void> {
  if (
    (request.operation === 'prepare' && result !== 'prepared')
    || (request.operation === 'link' && result === 'prepared')
  ) fail('checkpoint_internal_failure');
  const source = await openVerifiedClaim(
    request,
    directoryHandle,
    claimName(request.artifactId, request.writeClaimId),
  );
  try {
    if (!sameIdentity(source.identity, identity)) fail('checkpoint_artifact_write_claim_invalid');
  } finally {
    await source.handle.close().catch(() => {});
  }
  if (request.operation === 'prepare') {
    if (!sameIdentity(target, identity)) fail('checkpoint_artifact_write_claim_invalid');
    return;
  }
  const destination = finalName(request.artifactId);
  let finalHandle: fs.FileHandle;
  try {
    finalHandle = await fs.open(destination, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    fail('checkpoint_artifact_write_claim_invalid');
  }
  try {
    const finalStat = await verifyOpenRelativeFile(request, directoryHandle, destination, finalHandle);
    const finalIdentity = { dev: finalStat.dev, ino: finalStat.ino };
    if (!sameIdentity(target, finalIdentity)) {
      fail('checkpoint_artifact_write_claim_invalid');
    }
    if (result === 'unexpected-existing') {
      if (sameIdentity(identity, finalIdentity)) fail('checkpoint_artifact_write_claim_invalid');
    } else {
      if (!sameIdentity(identity, finalIdentity)) fail('checkpoint_artifact_write_claim_invalid');
      if (await finalHandle.readFile('utf8') !== request.canonicalArtifact) fail('checkpoint_integrity_hash_collision');
    }
  } finally {
    await finalHandle.close().catch(() => {});
  }
}

async function reaperMain(): Promise<void> {
  const request = await readRequest(false) as BaseRequest;
  const directoryHandle = await openDirectory(request);
  let identity: FileIdentity | undefined;
  let claimCreated = false;
  let prepared = false;
  let preparedResult: WorkerResult | undefined;
  let preparedTarget: FileIdentity | undefined;
  let committed = false;
  let stopped = false;
  try {
    process.stdout.write(`${JSON.stringify({ ok: true, event: 'reaper-ready' })}\n`);
    const arm = await readReaperCommand();
    if (!arm || arm.command !== 'arm') fail('checkpoint_internal_failure');
    identity = { dev: BigInt(arm.claimDev), ino: BigInt(arm.claimIno) };
    claimCreated = arm.claimCreated;
    if (!(await hasOwnedInode(identity))) fail('checkpoint_cleanup_incomplete');
    process.stdout.write(`${JSON.stringify({ ok: true, event: 'armed' })}\n`);

    while (!stopped) {
      const command = await readReaperCommand();
      if (!command || command.command === 'abort') {
        stopped = true;
        continue;
      }
      if (command.command === 'arm') fail('checkpoint_internal_failure');
      if (command.command === 'prepare-commit') {
        if (prepared) fail('checkpoint_internal_failure');
        preparedResult = command.result;
        preparedTarget = { dev: BigInt(command.targetDev), ino: BigInt(command.targetIno) };
        await verifyReaperClaimState(request, directoryHandle, identity, preparedResult, preparedTarget);
        prepared = true;
        process.stdout.write(`${JSON.stringify({ ok: true, event: 'prepared' })}\n`);
        continue;
      }
      if (!prepared || !preparedResult || !preparedTarget) fail('checkpoint_internal_failure');
      await verifyReaperClaimState(request, directoryHandle, identity, preparedResult, preparedTarget);
      committed = true;
      process.stdout.write(`${JSON.stringify({ ok: true, event: 'committed' })}\n`);
      stopped = true;
    }
  } finally {
    if (!committed && identity) await cleanupReaperClaim(request, directoryHandle, identity, claimCreated);
    await directoryHandle.close().catch(() => {});
  }
  if (!committed) process.stdout.write(`${JSON.stringify({ ok: true, event: 'aborted' })}\n`);
}

if (process.argv[2] === '--guard') {
  try {
    await guardMain();
  } catch (error) {
    writeGuardResponse({ ok: false, error: stableError(error) });
    process.exitCode = 1;
  }
} else if (process.argv[2] === '--reaper') {
  try {
    await reaperMain();
  } catch (error) {
    writeGuardResponse({ ok: false, error: stableError(error) });
    process.exitCode = 1;
  }
} else {
  let response: WorkerSuccess | WorkerFailure;
  let exitCode = 0;
  try {
    response = await workerMain();
  } catch (error) {
    response = { ok: false, error: stableError(error) };
    exitCode = 1;
  }
  input.close();
  process.stdout.write(`${JSON.stringify(response)}\n`, () => {
    process.exitCode = exitCode;
  });
}
