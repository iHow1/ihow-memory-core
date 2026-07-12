// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { createInterface } from 'node:readline';

const INPUT_MAX_BYTES = 16 * 1024 * 1024;
const TEST_PHASE_TIMEOUT_MS = 15_000;
const CLEANUP_MAX_DIRECTORY_ENTRIES = 4096;
const CLEANUP_MAX_PASSES = 8;

type FileIdentity = { dev: bigint; ino: bigint };
type WorkerOperation = 'replace' | 'create';
type WorkerPhase =
  | 'after-temp-open-before-write'
  | 'after-write-before-finalize'
  | 'after-finalize-before-final-check';

type WorkerRequest = {
  operation: WorkerOperation;
  basename: string;
  content: string;
  expectedDirectoryDev: string;
  expectedDirectoryIno: string;
  expectedDirectoryRealPath: string;
  expectedRootRealPath: string;
  testControlDirectory?: string;
  testPhase?: WorkerPhase;
  testFailAfterPhase?: boolean;
  guardedTempName?: string;
  guardedTempDev?: string;
  guardedTempIno?: string;
};

type WorkerResult = 'replaced' | 'created' | 'exists';
type ReaperCommand =
  | {
      command: 'prepare-commit';
      result: WorkerResult;
      targetDev: string;
      targetIno: string;
    }
  | { command: 'commit' }
  | { command: 'abort' };

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const inputIterator = input[Symbol.asyncIterator]();
let abortRequested = false;
process.once('SIGTERM', () => { abortRequested = true; });
process.stdin.once('close', () => { abortRequested = true; });

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
  if (
    name === ''
    || name === '.'
    || name === '..'
    || path.basename(name) !== name
    || name.includes('/')
    || name.includes('\\')
    || Buffer.byteLength(name, 'utf8') > 240
  ) fail('checkpoint_path_outside_store');
}

async function readLine(): Promise<string | undefined> {
  const next = await inputIterator.next();
  if (next.done) return undefined;
  if (Buffer.byteLength(next.value, 'utf8') > INPUT_MAX_BYTES) fail('checkpoint_file_too_large');
  return next.value;
}

function parseObjectLine(line: string | undefined): Record<string, unknown> {
  if (line === undefined) fail('checkpoint_internal_failure');
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    fail('checkpoint_internal_failure');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('checkpoint_internal_failure');
  return parsed as Record<string, unknown>;
}

async function readRequest(): Promise<WorkerRequest> {
  const item = parseObjectLine(await readLine());
  const allowed = new Set([
    'operation',
    'basename',
    'content',
    'expectedDirectoryDev',
    'expectedDirectoryIno',
    'expectedDirectoryRealPath',
    'expectedRootRealPath',
    'testControlDirectory',
    'testPhase',
    'testFailAfterPhase',
    'guardedTempName',
    'guardedTempDev',
    'guardedTempIno',
  ]);
  if (
    Object.keys(item).some((key) => !allowed.has(key))
    || (item.operation !== 'replace' && item.operation !== 'create')
    || typeof item.basename !== 'string'
    || typeof item.content !== 'string'
    || typeof item.expectedDirectoryDev !== 'string'
    || typeof item.expectedDirectoryIno !== 'string'
    || typeof item.expectedDirectoryRealPath !== 'string'
    || typeof item.expectedRootRealPath !== 'string'
    || !/^[0-9]+$/.test(item.expectedDirectoryDev)
    || !/^[0-9]+$/.test(item.expectedDirectoryIno)
    || !path.isAbsolute(item.expectedDirectoryRealPath)
    || !path.isAbsolute(item.expectedRootRealPath)
    || (item.testControlDirectory !== undefined && typeof item.testControlDirectory !== 'string')
    || (item.testPhase !== undefined && ![
      'after-temp-open-before-write',
      'after-write-before-finalize',
      'after-finalize-before-final-check',
    ].includes(item.testPhase as string))
    || (item.testFailAfterPhase !== undefined && typeof item.testFailAfterPhase !== 'boolean')
  ) fail('checkpoint_internal_failure');
  const guardedFields = [item.guardedTempName, item.guardedTempDev, item.guardedTempIno];
  if (guardedFields.some((value) => value !== undefined)) {
    if (
      typeof item.guardedTempName !== 'string'
      || typeof item.guardedTempDev !== 'string'
      || typeof item.guardedTempIno !== 'string'
      || !/^[0-9]+$/.test(item.guardedTempDev)
      || !/^[0-9]+$/.test(item.guardedTempIno)
    ) fail('checkpoint_internal_failure');
    assertBasename(item.guardedTempName);
  }
  if (!isWithin(item.expectedRootRealPath, item.expectedDirectoryRealPath) && item.expectedRootRealPath !== item.expectedDirectoryRealPath) {
    fail('checkpoint_path_outside_store');
  }
  if ((item.testControlDirectory === undefined) !== (item.testPhase === undefined)) fail('checkpoint_internal_failure');
  if (item.testControlDirectory !== undefined && !path.isAbsolute(item.testControlDirectory)) fail('checkpoint_internal_failure');
  assertBasename(item.basename);
  return item as WorkerRequest;
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function verifyOwnedAliasSet(
  request: WorkerRequest,
  directoryHandle: fs.FileHandle,
  expected: FileIdentity,
  allowedNames: readonly string[],
): Promise<void> {
  for (const name of allowedNames) assertBasename(name);
  if (new Set(allowedNames).size !== allowedNames.length) fail('checkpoint_internal_failure');
  await assertCwd(request, directoryHandle);
  const entries = await fs.readdir('.', { withFileTypes: true });
  if (entries.length > CLEANUP_MAX_DIRECTORY_ENTRIES) fail('checkpoint_cleanup_incomplete');
  const aliases: string[] = [];
  const linkCounts: bigint[] = [];
  for (const name of new Set(entries.map((entry) => entry.name))) {
    const stat = await fs.lstat(name, { bigint: true });
    if (!stat.isFile() || stat.dev !== expected.dev || stat.ino !== expected.ino) continue;
    aliases.push(name);
    linkCounts.push(stat.nlink);
  }
  aliases.sort();
  const allowed = [...allowedNames].sort();
  // nlink closes the enumerable-directory gap: a larger count proves that an alias exists outside
  // this pinned directory (or otherwise cannot be named by this scan). Fail closed, but never scan
  // or unlink outside the pinned directory; such an external hardlink is intentionally unlocatable.
  if (
    aliases.length !== allowed.length
    || aliases.some((name, index) => name !== allowed[index])
    || linkCounts.some((count) => count !== BigInt(allowed.length))
  ) fail('checkpoint_path_outside_store');
  await assertCwd(request, directoryHandle);
}

async function assertCwd(request: WorkerRequest, directoryHandle: fs.FileHandle): Promise<void> {
  if (abortRequested) fail('checkpoint_internal_failure');
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
    cwdReal !== request.expectedDirectoryRealPath
    || (cwdReal !== request.expectedRootRealPath && !isWithin(request.expectedRootRealPath, cwdReal))
    || !cwdStat.isDirectory()
    || !handleStat.isDirectory()
    || cwdStat.dev.toString() !== request.expectedDirectoryDev
    || cwdStat.ino.toString() !== request.expectedDirectoryIno
    || handleStat.dev.toString() !== request.expectedDirectoryDev
    || handleStat.ino.toString() !== request.expectedDirectoryIno
  ) fail('checkpoint_path_outside_store');
}

async function syncDirectory(directoryHandle: fs.FileHandle): Promise<void> {
  try {
    await directoryHandle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== 'win32' || (code !== 'EPERM' && code !== 'EINVAL' && code !== 'ENOTSUP')) throw error;
  }
}

async function phase(request: WorkerRequest, name: WorkerPhase): Promise<void> {
  if (!request.testControlDirectory || request.testPhase !== name) return;
  const ready = path.join(request.testControlDirectory, `${name}.ready`);
  const release = path.join(request.testControlDirectory, `${name}.release`);
  await fs.writeFile(ready, `${JSON.stringify({ pid: process.pid })}\n`, { flag: 'wx', mode: 0o600 });
  const deadline = Date.now() + TEST_PHASE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (abortRequested) fail('checkpoint_internal_failure');
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

async function unlinkExactRelative(name: string, expected: FileIdentity): Promise<boolean> {
  const actual = await relativeFileIdentity(name);
  if (!actual || !sameIdentity(actual, expected)) return false;
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(name, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ELOOP') return false;
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
  for (let pass = 0; pass < CLEANUP_MAX_PASSES; pass += 1) {
    const entries = await fs.readdir('.', { withFileTypes: true });
    if (entries.length > CLEANUP_MAX_DIRECTORY_ENTRIES) fail('checkpoint_cleanup_incomplete');
    let found = false;
    for (const name of new Set(entries.map((entry) => entry.name))) {
      const identity = await relativeFileIdentity(name);
      if (!identity || !sameIdentity(identity, expected)) continue;
      found = true;
      await unlinkExactRelative(name, expected);
    }
    if (!found) return;
  }
  fail('checkpoint_cleanup_incomplete');
}

async function verifyOwnedRelativeFile(
  request: WorkerRequest,
  directoryHandle: fs.FileHandle,
  name: string,
  expected: FileIdentity,
  expectedContent: string,
): Promise<void> {
  await assertCwd(request, directoryHandle);
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(name, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') fail('checkpoint_path_outside_store');
    throw error;
  }
  try {
    const [opened, pathStat] = await Promise.all([
      handle.stat({ bigint: true }),
      fs.lstat(name, { bigint: true }),
    ]);
    if (
      !opened.isFile()
      || !pathStat.isFile()
      || !sameIdentity({ dev: opened.dev, ino: opened.ino }, expected)
      || !sameIdentity({ dev: pathStat.dev, ino: pathStat.ino }, expected)
      || await handle.readFile('utf8') !== expectedContent
    ) fail('checkpoint_path_outside_store');
  } finally {
    await handle.close().catch(() => {});
  }
  await assertCwd(request, directoryHandle);
}

async function verifyRelativeFileIdentity(
  request: WorkerRequest,
  directoryHandle: fs.FileHandle,
  name: string,
  expected: FileIdentity,
): Promise<void> {
  await assertCwd(request, directoryHandle);
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(name, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') fail('checkpoint_path_outside_store');
    throw error;
  }
  try {
    const [opened, pathStat] = await Promise.all([
      handle.stat({ bigint: true }),
      fs.lstat(name, { bigint: true }),
    ]);
    if (
      !opened.isFile()
      || !pathStat.isFile()
      || !sameIdentity({ dev: opened.dev, ino: opened.ino }, expected)
      || !sameIdentity({ dev: pathStat.dev, ino: pathStat.ino }, expected)
    ) fail('checkpoint_path_outside_store');
  } finally {
    await handle.close().catch(() => {});
  }
  await assertCwd(request, directoryHandle);
}

async function waitForCommit(): Promise<void> {
  const item = parseObjectLine(await readLine());
  if (Object.keys(item).join(',') !== 'command' || (item.command !== 'commit' && item.command !== 'abort')) {
    fail('checkpoint_internal_failure');
  }
  if (item.command === 'abort') fail('checkpoint_path_outside_store');
}

async function waitForArm(): Promise<void> {
  const item = parseObjectLine(await readLine());
  if (Object.keys(item).join(',') !== 'command' || (item.command !== 'armed' && item.command !== 'abort')) {
    fail('checkpoint_internal_failure');
  }
  if (item.command === 'abort') fail('checkpoint_internal_failure');
}

async function workerMain(): Promise<WorkerResult> {
  const request = await readRequest();
  if (
    request.guardedTempName === undefined
    || request.guardedTempDev === undefined
    || request.guardedTempIno === undefined
  ) fail('checkpoint_internal_failure');
  let directoryHandle: fs.FileHandle;
  try {
    directoryHandle = await fs.open('.', fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  } catch {
    fail('checkpoint_path_outside_store');
  }
  let handle: fs.FileHandle | undefined;
  let owned: FileIdentity | undefined;
  let committed = false;
  const tmpName = request.guardedTempName;
  const guarded = { dev: BigInt(request.guardedTempDev), ino: BigInt(request.guardedTempIno) };
  let result: WorkerResult | undefined;
  let target: FileIdentity | undefined;
  try {
    await assertCwd(request, directoryHandle);
    handle = await fs.open(
      tmpName,
      fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
    );
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile()
      || opened.size !== 0n
      || opened.dev !== guarded.dev
      || opened.ino !== guarded.ino
    ) fail('checkpoint_path_outside_store');
    owned = { dev: opened.dev, ino: opened.ino };
    process.stdout.write(`${JSON.stringify({ ok: true, event: 'owned', dev: owned.dev.toString(), ino: owned.ino.toString() })}\n`);
    await waitForArm();
    await phase(request, 'after-temp-open-before-write');
    await assertCwd(request, directoryHandle);
    await handle.writeFile(request.content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await phase(request, 'after-write-before-finalize');
    await assertCwd(request, directoryHandle);
    const tempIdentity = await relativeFileIdentity(tmpName);
    if (!tempIdentity || !sameIdentity(tempIdentity, owned)) fail('checkpoint_path_outside_store');

    if (request.operation === 'create') {
      try {
        await fs.link(tmpName, request.basename);
        result = 'created';
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        result = 'exists';
      }
      if (result === 'created') await unlinkExactRelative(tmpName, owned);
    } else {
      await fs.rename(tmpName, request.basename);
      result = 'replaced';
    }

    await phase(request, 'after-finalize-before-final-check');
    if (owned && result !== 'exists') {
      await verifyOwnedRelativeFile(request, directoryHandle, request.basename, owned, request.content);
      target = owned;
      await verifyOwnedAliasSet(request, directoryHandle, owned, [request.basename]);
    } else {
      target = await relativeFileIdentity(request.basename);
      if (!target || (owned && sameIdentity(target, owned))) fail('checkpoint_path_outside_store');
      await verifyRelativeFileIdentity(request, directoryHandle, request.basename, target);
      if (owned) await verifyOwnedAliasSet(request, directoryHandle, owned, [tmpName]);
    }
    await syncDirectory(directoryHandle);
    await assertCwd(request, directoryHandle);

    process.stdout.write(`${JSON.stringify({
      ok: true,
      event: 'ready',
      result,
      targetDev: target.dev.toString(),
      targetIno: target.ino.toString(),
    })}\n`);
    await waitForCommit();
    if (result === 'exists') {
      await verifyRelativeFileIdentity(request, directoryHandle, request.basename, target);
      if (owned) await verifyOwnedAliasSet(request, directoryHandle, owned, [tmpName]);
    } else if (owned) {
      await verifyOwnedRelativeFile(request, directoryHandle, request.basename, owned, request.content);
      await verifyOwnedAliasSet(request, directoryHandle, owned, [request.basename]);
    }
    else fail('checkpoint_internal_failure');
    if (result === 'exists' && owned) {
      await cleanupOwnedInode(owned);
      await verifyOwnedAliasSet(request, directoryHandle, owned, []);
      owned = undefined;
      await verifyRelativeFileIdentity(request, directoryHandle, request.basename, target);
    }
    await syncDirectory(directoryHandle);
    committed = true;
    return result;
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (!committed && owned) await cleanupOwnedInode(owned);
    await directoryHandle.close().catch(() => {});
  }
}

async function readReaperCommand(): Promise<ReaperCommand | undefined> {
  const line = await readLine();
  if (line === undefined) return undefined;
  const item = parseObjectLine(line);
  if (
    item.command === 'prepare-commit'
    && Object.keys(item).sort().join(',') === 'command,result,targetDev,targetIno'
    && (item.result === 'replaced' || item.result === 'created' || item.result === 'exists')
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

async function verifyReaperCommitState(
  request: WorkerRequest,
  directoryHandle: fs.FileHandle,
  owned: FileIdentity,
  result: WorkerResult,
  target: FileIdentity,
  phase: 'prepare' | 'commit',
  ownedName: string,
): Promise<void> {
  if (
    (request.operation === 'create' && result === 'replaced')
    || (request.operation === 'replace' && result !== 'replaced')
  ) fail('checkpoint_internal_failure');
  if (result === 'exists') {
    if (sameIdentity(target, owned)) fail('checkpoint_path_outside_store');
    await verifyRelativeFileIdentity(request, directoryHandle, request.basename, target);
    if (phase === 'prepare') {
      await verifyOwnedAliasSet(request, directoryHandle, owned, [ownedName]);
    } else {
      await verifyOwnedAliasSet(request, directoryHandle, owned, []);
    }
    return;
  }
  if (!sameIdentity(target, owned)) fail('checkpoint_path_outside_store');
  await verifyOwnedRelativeFile(request, directoryHandle, request.basename, owned, request.content);
  await verifyOwnedAliasSet(request, directoryHandle, owned, [request.basename]);
}

async function reaperMain(): Promise<void> {
  const request = await readRequest();
  let directoryHandle: fs.FileHandle;
  try {
    directoryHandle = await fs.open('.', fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  } catch {
    fail('checkpoint_path_outside_store');
  }
  let owned: FileIdentity | undefined;
  let prepared = false;
  let preparedResult: WorkerResult | undefined;
  let preparedTarget: FileIdentity | undefined;
  let committed = false;
  let stopped = false;
  try {
    await assertCwd(request, directoryHandle);
    const tmpName = `.${request.basename}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const handle = await fs.open(
      tmpName,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile() || stat.size !== 0n) fail('checkpoint_path_outside_store');
      owned = { dev: stat.dev, ino: stat.ino };
    } finally {
      await handle.close().catch(() => {});
    }
    await syncDirectory(directoryHandle);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      event: 'reaper-ready',
      tmpName,
      dev: owned.dev.toString(),
      ino: owned.ino.toString(),
    })}\n`);

    while (!stopped) {
      const command = await readReaperCommand();
      if (!command || command.command === 'abort') {
        stopped = true;
        continue;
      }
      if (command.command === 'prepare-commit') {
        if (prepared) fail('checkpoint_internal_failure');
        preparedResult = command.result;
        preparedTarget = { dev: BigInt(command.targetDev), ino: BigInt(command.targetIno) };
        await verifyReaperCommitState(request, directoryHandle, owned, preparedResult, preparedTarget, 'prepare', tmpName);
        prepared = true;
        process.stdout.write(`${JSON.stringify({ ok: true, event: 'prepared' })}\n`);
        continue;
      }
      if (!prepared || !preparedResult || !preparedTarget) fail('checkpoint_internal_failure');
      await verifyReaperCommitState(request, directoryHandle, owned, preparedResult, preparedTarget, 'commit', tmpName);
      committed = true;
      process.stdout.write(`${JSON.stringify({ ok: true, event: 'committed' })}\n`);
      stopped = true;
    }
  } finally {
    if (!committed && owned) {
      await cleanupOwnedInode(owned);
      await syncDirectory(directoryHandle).catch(() => {});
    }
    await directoryHandle.close().catch(() => {});
  }
  if (!committed) process.stdout.write(`${JSON.stringify({ ok: true, event: 'aborted' })}\n`);
}

if (process.argv[2] === '--reaper') {
  try {
    await reaperMain();
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: stableError(error) })}\n`);
    process.exitCode = 1;
  }
} else {
  let response: { ok: true; result: WorkerResult } | { ok: false; error: string };
  let exitCode = 0;
  try {
    response = { ok: true, result: await workerMain() };
  } catch (error) {
    response = { ok: false, error: stableError(error) };
    exitCode = 1;
  }
  input.close();
  process.stdout.write(`${JSON.stringify(response)}\n`, () => {
    process.exitCode = exitCode;
  });
}
