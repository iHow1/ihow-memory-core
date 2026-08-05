// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import type { Workspace } from '../types.ts';
import {
  canonicalCheckpointJson,
  CHECKPOINT_ARTIFACT_MAX_BYTES,
  CHECKPOINT_DRAFT_MAX_BYTES,
  computeCheckpointSemanticSha256,
  type CheckpointArtifactV1,
  type CheckpointArtifactBuildV1,
  type CheckpointDraftV1,
  type CheckpointProjectIdentity,
  type CheckpointSessionIdentity,
  validateCheckpointArtifact,
  validateCheckpointArtifactBuild,
  validateCheckpointDraft,
} from '../checkpoint-schema.ts';
import { containsSecretLikeContent } from '../governance.ts';
import { assertRealPathWithin } from './files.ts';

export type CheckpointFinalizationIntentV1 = {
  schemaVersion: 1;
  draftId: string;
  artifactId: string;
  creationProvenance: 'created' | 'deduplicated';
  writeClaimId?: string;
  build: CheckpointArtifactBuildV1;
};

export type CheckpointAuditEvent = {
  schemaVersion: 1;
  id: string;
  at: string;
  type:
    | 'checkpoint.draft.created'
    | 'checkpoint.draft.updated'
    | 'checkpoint.artifact.created'
    | 'checkpoint.artifact.deduplicated'
    | 'checkpoint.rejected';
  operation: 'draft.create' | 'draft.update' | 'artifact.finalize' | 'artifact.read' | 'artifact.inspect' | 'artifact.list';
  draftId?: string;
  artifactId?: string;
  reasonCode?: string;
  supersedes?: string;
};

export function checkpointStorePaths(workspace: Workspace): {
  root: string;
  drafts: string;
  artifacts: string;
  finalizations: string;
  audit: string;
} {
  const root = workspace.mode === 'existing-memory-root'
    ? path.join(workspace.mcpDir, 'checkpoints')
    : path.join(workspace.spaceDir, 'checkpoints');
  return {
    root,
    drafts: path.join(root, 'drafts'),
    artifacts: path.join(root, 'artifacts'),
    finalizations: path.join(root, 'finalizations'),
    audit: path.join(root, 'audit.ndjson'),
  };
}

export function checkpointAuditV2Paths(workspace: Workspace): {
  root: string;
  current: string;
  control: string;
  state: string;
  pending: string;
  segments: string;
  finalizations: string;
} {
  const root = path.join(checkpointStorePaths(workspace).root, 'audit-v2');
  const control = path.join(root, 'control');
  return {
    root,
    current: path.join(root, 'CURRENT'),
    control,
    state: path.join(control, 'state.json'),
    pending: path.join(control, 'pending.json'),
    segments: path.join(root, 'segments'),
    finalizations: path.join(root, 'finalizations'),
  };
}

function checkpointContainmentRoot(workspace: Workspace): string {
  return workspace.mode === 'existing-memory-root' ? workspace.mcpDir : workspace.spaceDir;
}

async function ensureCheckpointDirectoryExact(containmentRoot: string, directory: string): Promise<void> {
  const rootRealPath = await fs.realpath(containmentRoot);
  const relative = path.relative(containmentRoot, directory);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('checkpoint_path_outside_store');
  }
  const expectedRealPath = path.join(rootRealPath, relative);
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try {
      await fs.mkdir(directory, { mode: 0o700 });
    } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
    }
    stat = await fs.lstat(directory);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('checkpoint_path_outside_store');

  let handle: fs.FileHandle;
  try {
    handle = await fs.open(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'ENOTDIR') throw new Error('checkpoint_path_outside_store');
    throw error;
  }
  try {
    const [realPath, opened, realStat] = await Promise.all([
      fs.realpath(directory),
      handle.stat({ bigint: true }),
      fs.stat(expectedRealPath, { bigint: true }),
    ]);
    if (
      realPath !== expectedRealPath
      || !opened.isDirectory()
      || !realStat.isDirectory()
      || opened.dev !== realStat.dev
      || opened.ino !== realStat.ino
    ) throw new Error('checkpoint_path_outside_store');
  } finally {
    await handle.close().catch(() => {});
  }
}

async function assertCheckpointDirectoryExact(containmentRoot: string, directory: string): Promise<void> {
  const rootRealPath = await fs.realpath(containmentRoot);
  const relative = path.relative(containmentRoot, directory);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('checkpoint_path_outside_store');
  }
  const expectedRealPath = path.join(rootRealPath, relative);
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('checkpoint_audit_state_invalid');
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('checkpoint_path_outside_store');
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'ENOTDIR') throw new Error('checkpoint_path_outside_store');
    throw error;
  }
  try {
    const [realPath, opened, realStat] = await Promise.all([
      fs.realpath(directory),
      handle.stat({ bigint: true }),
      fs.stat(expectedRealPath, { bigint: true }),
    ]);
    if (
      realPath !== expectedRealPath
      || !opened.isDirectory()
      || !realStat.isDirectory()
      || opened.dev !== realStat.dev
      || opened.ino !== realStat.ino
    ) throw new Error('checkpoint_path_outside_store');
  } finally {
    await handle.close().catch(() => {});
  }
}

export async function ensureCheckpointStore(workspace: Workspace): Promise<ReturnType<typeof checkpointStorePaths>> {
  const paths = checkpointStorePaths(workspace);
  const containmentRoot = checkpointContainmentRoot(workspace);
  // Every segment is checked as an exact, non-symlink directory before the next segment is created.
  // In particular, a `checkpoints -> <space root>` alias must fail before drafts/artifacts/audit bytes
  // can be created through the alias.
  await ensureCheckpointDirectoryExact(containmentRoot, paths.root);
  await ensureCheckpointDirectoryExact(containmentRoot, paths.drafts);
  await ensureCheckpointDirectoryExact(containmentRoot, paths.artifacts);
  await ensureCheckpointDirectoryExact(containmentRoot, paths.finalizations);
  try { await fs.chmod(paths.root, 0o700); } catch { /* best effort on non-POSIX filesystems */ }
  return paths;
}

type CheckpointFileWorkerPhase =
  | 'after-temp-open-before-write'
  | 'after-write-before-finalize'
  | 'after-finalize-before-final-check';

export type CheckpointFileWorkerTestOptions = {
  testControlDirectory?: string;
  testPhase?: CheckpointFileWorkerPhase;
  testFailAfterPhase?: boolean;
  testTimeoutMs?: number;
};

type PinnedCheckpointDirectory = {
  path: string;
  handle: fs.FileHandle;
  dev: bigint;
  ino: bigint;
  directoryRealPath: string;
  rootRealPath: string;
};

type CheckpointFileIdentity = { dev: bigint; ino: bigint };

const CHECKPOINT_FILE_WORKER_TIMEOUT_MS = 20_000;
const CHECKPOINT_FILE_WORKER_OUTPUT_MAX_BYTES = 4 * 1024;
const CHECKPOINT_FILE_WORKER_INPUT_MAX_BYTES = 16 * 1024 * 1024;

function isPathWithinOrEqual(root: string, candidate: string): boolean {
  if (root === candidate) return true;
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function openPinnedCheckpointDirectory(root: string, directory: string): Promise<PinnedCheckpointDirectory> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'ENOTDIR') throw new Error('checkpoint_path_outside_store');
    throw error;
  }
  try {
    const [rootRealPath, directoryRealPath, handleStat] = await Promise.all([
      fs.realpath(root),
      assertRealPathWithin(root, directory),
      handle.stat({ bigint: true }),
    ]);
    const realStat = await fs.stat(directoryRealPath, { bigint: true });
    if (
      !isPathWithinOrEqual(rootRealPath, directoryRealPath)
      || !handleStat.isDirectory()
      || !realStat.isDirectory()
      || handleStat.ino !== realStat.ino
      || handleStat.dev !== realStat.dev
    ) throw new Error('checkpoint_path_outside_store');
    return {
      path: directory,
      handle,
      dev: handleStat.dev,
      ino: handleStat.ino,
      directoryRealPath,
      rootRealPath,
    };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function assertPinnedCheckpointDirectoryCurrent(pinned: PinnedCheckpointDirectory): Promise<void> {
  let real: string;
  let current: Awaited<ReturnType<typeof fs.stat>>;
  let opened: Awaited<ReturnType<fs.FileHandle['stat']>>;
  try {
    [real, current, opened] = await Promise.all([
      fs.realpath(pinned.path),
      fs.stat(pinned.path, { bigint: true }),
      pinned.handle.stat({ bigint: true }),
    ]);
  } catch {
    throw new Error('checkpoint_path_outside_store');
  }
  if (
    real !== pinned.directoryRealPath
    || !isPathWithinOrEqual(pinned.rootRealPath, real)
    || !current.isDirectory()
    || !opened.isDirectory()
    || current.dev !== pinned.dev
    || current.ino !== pinned.ino
    || opened.dev !== pinned.dev
    || opened.ino !== pinned.ino
  ) throw new Error('checkpoint_path_outside_store');
}

function sameCheckpointFileIdentity(left: CheckpointFileIdentity, right: CheckpointFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function verifyPinnedCheckpointFile(
  pinned: PinnedCheckpointDirectory,
  basename: string,
  expected: CheckpointFileIdentity,
  expectedContent?: string,
): Promise<void> {
  await assertPinnedCheckpointDirectoryCurrent(pinned);
  const file = path.join(pinned.directoryRealPath, basename);
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    throw new Error('checkpoint_path_outside_store');
  }
  try {
    const [opened, current] = await Promise.all([
      handle.stat({ bigint: true }),
      fs.lstat(file, { bigint: true }),
    ]);
    if (
      !opened.isFile()
      || !current.isFile()
      || !sameCheckpointFileIdentity({ dev: opened.dev, ino: opened.ino }, expected)
      || !sameCheckpointFileIdentity({ dev: current.dev, ino: current.ino }, expected)
      || (expectedContent !== undefined && await handle.readFile('utf8') !== expectedContent)
    ) throw new Error('checkpoint_path_outside_store');
  } finally {
    await handle.close().catch(() => {});
  }
  await assertPinnedCheckpointDirectoryCurrent(pinned);
}

async function verifyPinnedCheckpointOwnedAliasSet(
  pinned: PinnedCheckpointDirectory,
  expected: CheckpointFileIdentity,
  allowedNames: readonly string[],
): Promise<void> {
  if (
    new Set(allowedNames).size !== allowedNames.length
    || allowedNames.some((name) => (
      name === ''
      || name === '.'
      || name === '..'
      || path.basename(name) !== name
      || name.includes('/')
      || name.includes('\\')
    ))
  ) throw new Error('checkpoint_internal_failure');
  await assertPinnedCheckpointDirectoryCurrent(pinned);
  const aliases: string[] = [];
  const linkCounts: bigint[] = [];
  let directory: Awaited<ReturnType<typeof fs.opendir>>;
  try {
    directory = await fs.opendir(pinned.directoryRealPath);
  } catch {
    throw new Error('checkpoint_path_outside_store');
  }
  let visited = 0;
  try {
    for await (const entry of directory) {
      visited += 1;
      // Do not allocate the whole directory before enforcing the cleanup/alias budget. The 4097th
      // entry fails immediately, while the first 4096 are inspected inode-by-inode.
      if (visited > 4096) throw new Error('checkpoint_cleanup_incomplete');
      const stat = await fs.lstat(path.join(pinned.directoryRealPath, entry.name), { bigint: true });
      if (!stat.isFile() || stat.dev !== expected.dev || stat.ino !== expected.ino) continue;
      aliases.push(entry.name);
      linkCounts.push(stat.nlink);
    }
  } finally {
    await directory.close().catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ERR_DIR_CLOSED') throw error;
    });
  }
  aliases.sort();
  const allowed = [...allowedNames].sort();
  // nlink also detects hardlinks outside this enumerable pinned directory. The controller rejects
  // those states; cleanup remains inode-exact and directory-local rather than attempting a disk scan.
  if (
    aliases.length !== allowed.length
    || aliases.some((name, index) => name !== allowed[index])
    || linkCounts.some((count) => count !== BigInt(allowed.length))
  ) throw new Error('checkpoint_path_outside_store');
  await assertPinnedCheckpointDirectoryCurrent(pinned);
}

function checkpointFileWorkerInvocation(mode?: 'reaper'): { command: string; args: string[] } {
  const currentFile = fileURLToPath(import.meta.url);
  const sourceRuntime = currentFile.endsWith('.ts');
  const worker = fileURLToPath(new URL(sourceRuntime ? '../checkpoint-file-worker.ts' : '../checkpoint-file-worker.js', import.meta.url));
  return {
    command: process.execPath,
    args: [
      ...(sourceRuntime ? ['--no-warnings', '--experimental-strip-types'] : []),
      worker,
      ...(mode === 'reaper' ? ['--reaper'] : []),
    ],
  };
}

async function atomicWriteCheckpointFile(
  root: string,
  file: string,
  content: string,
  operation: 'replace' | 'create',
  options?: CheckpointFileWorkerTestOptions,
): Promise<'replaced' | 'created' | 'exists'> {
  const directory = path.dirname(file);
  const basename = path.basename(file);
  if (basename === '' || basename === '.' || basename === '..' || path.join(directory, basename) !== file) {
    throw new Error('checkpoint_path_outside_store');
  }
  const pinned = await openPinnedCheckpointDirectory(root, directory);
  const request = {
    operation,
    basename,
    content,
    expectedDirectoryDev: pinned.dev.toString(),
    expectedDirectoryIno: pinned.ino.toString(),
    expectedDirectoryRealPath: pinned.directoryRealPath,
    expectedRootRealPath: pinned.rootRealPath,
    ...(options?.testControlDirectory && options.testPhase
      ? {
          testControlDirectory: options.testControlDirectory,
          testPhase: options.testPhase,
          ...(options.testFailAfterPhase ? { testFailAfterPhase: true } : {}),
        }
      : {}),
  };
  // The worker rejects a line above 16 MiB. Reject before spawning/sending as well so a future
  // caller cannot turn a large replacement into an expensive worker failure or partial protocol.
  if (Buffer.byteLength(JSON.stringify({
    ...request,
    guardedTempName: '.guarded-placeholder',
    guardedTempDev: '18446744073709551615',
    guardedTempIno: '18446744073709551615',
  }), 'utf8') > CHECKPOINT_FILE_WORKER_INPUT_MAX_BYTES) {
    throw new Error('checkpoint_file_too_large');
  }
  const reaperInvocation = checkpointFileWorkerInvocation('reaper');
  const reaper = spawn(reaperInvocation.command, reaperInvocation.args, {
    cwd: pinned.directoryRealPath,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  reaper.stdin.on('error', () => {});
  const reaperCompletion = childCompletion(reaper);
  const readReaperLine = childLineReader(reaper);
  const reaperStderr: Buffer[] = [];
  let reaperStderrBytes = 0;
  reaper.stderr.on('data', (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    reaperStderrBytes += buffer.length;
    if (reaperStderrBytes <= CHECKPOINT_FILE_WORKER_OUTPUT_MAX_BYTES) reaperStderr.push(buffer);
    else reaper.kill('SIGKILL');
  });

  const invocation = checkpointFileWorkerInvocation();
  const child = spawn(invocation.command, invocation.args, {
    cwd: pinned.directoryRealPath,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdin.on('error', () => {});
  const completion = childCompletion(child);
  const readLine = childLineReader(child);
  const stderr: Buffer[] = [];
  let stderrBytes = 0;
  let stdoutBytes = 0;
  let timedOut = false;
  let timeout: NodeJS.Timeout | undefined;
  let killTimeout: NodeJS.Timeout | undefined;
  let reaperCommitted = false;
  let reaperArmed = false;
  child.stdout.on('data', (chunk: Buffer | string) => {
    stdoutBytes += Buffer.byteLength(chunk);
    if (stdoutBytes > CHECKPOINT_FILE_WORKER_OUTPUT_MAX_BYTES) child.kill('SIGTERM');
  });
  child.stderr.on('data', (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    stderrBytes += buffer.length;
    if (stderrBytes <= CHECKPOINT_FILE_WORKER_OUTPUT_MAX_BYTES) stderr.push(buffer);
    else child.kill('SIGTERM');
  });
  try {
    const timeoutMs = options?.testTimeoutMs ?? CHECKPOINT_FILE_WORKER_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > CHECKPOINT_FILE_WORKER_TIMEOUT_MS) {
      throw new Error('checkpoint_internal_failure');
    }
    timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimeout = setTimeout(() => child.kill('SIGKILL'), 2_000);
    }, timeoutMs);
    writeChildLine(reaper, request);
    const reaperReadyLine = await readReaperLine();
    if (reaperReadyLine === undefined) throw new Error('checkpoint_internal_failure');
    const reaperReady = parseJsonObjectLine(reaperReadyLine);
    if (
      reaperReady.ok !== true
      || reaperReady.event !== 'reaper-ready'
      || Object.keys(reaperReady).sort().join(',') !== 'dev,event,ino,ok,tmpName'
      || typeof reaperReady.tmpName !== 'string'
      || typeof reaperReady.dev !== 'string'
      || typeof reaperReady.ino !== 'string'
      || !/^[0-9]+$/.test(reaperReady.dev)
      || !/^[0-9]+$/.test(reaperReady.ino)
      || path.basename(reaperReady.tmpName) !== reaperReady.tmpName
    ) {
      throw new Error('checkpoint_internal_failure');
    }
    reaperArmed = true;

    writeChildLine(child, {
      ...request,
      guardedTempName: reaperReady.tmpName,
      guardedTempDev: reaperReady.dev,
      guardedTempIno: reaperReady.ino,
    });

    const ownedLine = await readLine();
    if (ownedLine === undefined || Buffer.byteLength(ownedLine, 'utf8') > CHECKPOINT_FILE_WORKER_OUTPUT_MAX_BYTES) {
      throw new Error('checkpoint_internal_failure');
    }
    const owned = parseJsonObjectLine(ownedLine);
    if (owned.ok === false && typeof owned.error === 'string' && /^checkpoint_[a-z0-9_]+$/.test(owned.error)) {
      const status = await completion;
      if (status.exitCode !== 1 || status.signal !== null) throw new Error('checkpoint_internal_failure');
      throw new Error(owned.error);
    }
    if (
      owned.ok !== true
      || owned.event !== 'owned'
      || Object.keys(owned).sort().join(',') !== 'dev,event,ino,ok'
      || typeof owned.dev !== 'string'
      || typeof owned.ino !== 'string'
      || !/^[0-9]+$/.test(owned.dev)
      || !/^[0-9]+$/.test(owned.ino)
      || owned.dev !== reaperReady.dev
      || owned.ino !== reaperReady.ino
    ) throw new Error('checkpoint_internal_failure');
    writeChildLine(child, { command: 'armed' });

    const readyLine = await readLine();
    if (readyLine === undefined || Buffer.byteLength(readyLine, 'utf8') > CHECKPOINT_FILE_WORKER_OUTPUT_MAX_BYTES) {
      throw new Error('checkpoint_internal_failure');
    }
    const ready = parseJsonObjectLine(readyLine);
    if (ready.ok === false && typeof ready.error === 'string' && /^checkpoint_[a-z0-9_]+$/.test(ready.error)) {
      const status = await completion;
      if (status.exitCode !== 1 || status.signal !== null) throw new Error('checkpoint_internal_failure');
      throw new Error(ready.error);
    }
    if (
      ready.ok !== true
      || ready.event !== 'ready'
      || Object.keys(ready).sort().join(',') !== 'event,ok,result,targetDev,targetIno'
      || (ready.result !== 'replaced' && ready.result !== 'created' && ready.result !== 'exists')
      || typeof ready.targetDev !== 'string'
      || typeof ready.targetIno !== 'string'
      || !/^[0-9]+$/.test(ready.targetDev)
      || !/^[0-9]+$/.test(ready.targetIno)
    ) throw new Error('checkpoint_internal_failure');
    const ownedIdentity = { dev: BigInt(owned.dev as string), ino: BigInt(owned.ino as string) };
    const targetIdentity = { dev: BigInt(ready.targetDev), ino: BigInt(ready.targetIno) };
    if (
      (ready.result === 'exists' && (
        operation !== 'create'
        || sameCheckpointFileIdentity(targetIdentity, ownedIdentity)
      ))
      || (ready.result !== 'exists' && (
        !sameCheckpointFileIdentity(targetIdentity, ownedIdentity)
        || (operation === 'create' && ready.result !== 'created')
        || (operation === 'replace' && ready.result !== 'replaced')
      ))
    ) throw new Error('checkpoint_internal_failure');

    await assertPinnedCheckpointDirectoryCurrent(pinned);
    writeChildLine(reaper, {
      command: 'prepare-commit',
      result: ready.result,
      targetDev: ready.targetDev,
      targetIno: ready.targetIno,
    });
    const preparedLine = await readReaperLine();
    if (preparedLine === undefined) throw new Error('checkpoint_internal_failure');
    const prepared = parseJsonObjectLine(preparedLine);
    if (prepared.ok !== true || prepared.event !== 'prepared' || Object.keys(prepared).sort().join(',') !== 'event,ok') {
      throw new Error('checkpoint_internal_failure');
    }
    writeChildLine(child, { command: 'commit' });
    const finalLine = await readLine();
    child.stdin.end();
    const status = await completion;
    if (
      timedOut
      || stdoutBytes > CHECKPOINT_FILE_WORKER_OUTPUT_MAX_BYTES
      || stderrBytes !== 0
      || Buffer.concat(stderr).length !== 0
      || status.exitCode !== 0
      || status.signal !== null
      || finalLine === undefined
      || Buffer.byteLength(finalLine, 'utf8') > CHECKPOINT_FILE_WORKER_OUTPUT_MAX_BYTES
    ) throw new Error('checkpoint_internal_failure');
    const final = parseJsonObjectLine(finalLine);
    if (
      final.ok !== true
      || final.result !== ready.result
      || Object.keys(final).sort().join(',') !== 'ok,result'
    ) throw new Error('checkpoint_internal_failure');

    // This is the parent controller's last canonical-path verification before the pinned reaper's
    // identity/content-checked commit. A same-user mutation after that final check remains the normal
    // POSIX namespace boundary; mutations at any earlier worker/reaper handoff fail closed.
    await verifyPinnedCheckpointFile(
      pinned,
      basename,
      targetIdentity,
      ready.result === 'exists' ? undefined : content,
    );
    await verifyPinnedCheckpointOwnedAliasSet(
      pinned,
      ready.result === 'exists' ? ownedIdentity : targetIdentity,
      ready.result === 'exists' ? [] : [basename],
    );
    writeChildLine(reaper, { command: 'commit' });
    const committedLine = await readReaperLine();
    if (committedLine === undefined) throw new Error('checkpoint_internal_failure');
    const committed = parseJsonObjectLine(committedLine);
    if (committed.ok !== true || committed.event !== 'committed' || Object.keys(committed).sort().join(',') !== 'event,ok') {
      throw new Error('checkpoint_internal_failure');
    }
    reaperCommitted = true;
    reaper.stdin.end();
    const reaperStatus = await reaperCompletion;
    if (
      reaperStatus.exitCode !== 0
      || reaperStatus.signal !== null
      || reaperStderrBytes !== 0
      || Buffer.concat(reaperStderr).length !== 0
    ) throw new Error('checkpoint_internal_failure');
    return final.result as 'replaced' | 'created' | 'exists';
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      try { writeChildLine(child, { command: 'abort' }); } catch { /* worker may not be reading */ }
      child.stdin.end();
      child.kill('SIGTERM');
    }
    await completion.catch(() => {});
    let cleanupConfirmed = false;
    if (!reaperCommitted) {
      if (reaper.stdin.writable && !reaper.stdin.destroyed) {
        try { writeChildLine(reaper, { command: 'abort' }); } catch { /* handled by confirmation below */ }
        reaper.stdin.end();
      }
      const abortedLine = await readReaperLine().catch(() => undefined);
      const reaperStatus = await reaperCompletion.catch(() => ({ exitCode: null, signal: null }));
      if (abortedLine !== undefined) {
        const aborted = parseJsonObjectLine(abortedLine);
        cleanupConfirmed = (
          aborted.ok === true
          && aborted.event === 'aborted'
          && Object.keys(aborted).sort().join(',') === 'event,ok'
          && reaperStatus.exitCode === 0
          && reaperStatus.signal === null
          && reaperStderrBytes === 0
          && Buffer.concat(reaperStderr).length === 0
        );
      }
    }
    if (reaperArmed && !cleanupConfirmed) throw new Error('checkpoint_internal_failure');
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    if (killTimeout) clearTimeout(killTimeout);
    if (!reaperCommitted && reaper.exitCode === null && reaper.signalCode === null) reaper.kill('SIGKILL');
    await pinned.handle.close().catch(() => {});
  }
}

async function readContainedFile(root: string, file: string, maxBytes?: number, tooLargeCode?: string): Promise<string> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new Error('checkpoint_path_outside_store');
    throw error;
  }
  try {
    const real = await assertRealPathWithin(root, file);
    const [fdStat, realStat] = await Promise.all([handle.stat(), fs.stat(real)]);
    if (fdStat.ino !== realStat.ino || fdStat.dev !== realStat.dev) throw new Error('checkpoint_path_outside_store');
    if (!fdStat.isFile()) throw new Error('checkpoint_path_outside_store');
    if (maxBytes !== undefined && fdStat.size > maxBytes) throw new Error(tooLargeCode ?? 'checkpoint_file_too_large');
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

function draftPath(workspace: Workspace, draftId: string): string {
  if (!/^draft_[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(draftId)) throw new Error('checkpoint_draft_id_invalid');
  return path.join(checkpointStorePaths(workspace).drafts, `${draftId}.json`);
}

function artifactPath(workspace: Workspace, artifactId: string): string {
  if (!/^cp_[a-f0-9]{64}$/.test(artifactId)) throw new Error('checkpoint_artifact_id_invalid');
  return path.join(checkpointStorePaths(workspace).artifacts, `${artifactId}.json`);
}

function finalizationPath(workspace: Workspace, draftId: string): string {
  if (!/^draft_[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(draftId)) throw new Error('checkpoint_draft_id_invalid');
  return path.join(checkpointStorePaths(workspace).finalizations, `${draftId}.json`);
}

const NATIVE_PRECOMPACT_DEDUPE_KEY_RE = /^[a-f0-9]{64}$/;
const CHECKPOINT_DRAFT_BASENAME_RE = /^draft_[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.json$/;
const CHECKPOINT_SHA256_RE = /^[a-f0-9]{64}$/;
const CHECKPOINT_ARTIFACT_ID_RE = /^cp_[a-f0-9]{64}$/;
export const CHECKPOINT_OPEN_DRAFT_MAX = 8;
const CHECKPOINT_DRAFT_LOCATOR_FALLBACK_VISITS = 64;
const CHECKPOINT_DRAFT_LOCATOR_MAX_BYTES = 4096;
const CHECKPOINT_DRAFT_OPEN_SET_MAX_VISITS = 32;
const CHECKPOINT_DRAFT_OPEN_SET_FORMAT_MAX_BYTES = 256;
const CHECKPOINT_DRAFT_OPEN_SET_MEMBER_MAX_BYTES = 512;

type CheckpointDraftLocatorRefV1 = {
  draftId: string;
  contentSha256: string;
};

type CheckpointDraftLocatorRecentV1 = CheckpointDraftLocatorRefV1 & {
  artifactId: string;
};

type CheckpointDraftLocatorV1 = {
  schemaVersion: 1;
  identityKey: string;
  openSetComplete: boolean;
  open: CheckpointDraftLocatorRefV1[];
  recentFinalized?: CheckpointDraftLocatorRecentV1;
};

type CheckpointDraftOpenSetFormatV1 = {
  schemaVersion: 1;
  format: 'checkpoint-draft-open-set-v1';
};

type CheckpointDraftOpenSetMemberV1 = {
  schemaVersion: 1;
  identityKey: string;
  draftId: string;
};

type CheckpointSemanticArtifactIndexV1 = {
  schemaVersion: 1;
  semanticSha256: string;
  artifactId: string;
  artifactContentSha256: string;
};

export type CheckpointDraftLocatorMatch =
  | {
      completeness: 'complete';
      open?: CheckpointDraftV1;
      recentFinalized?: CheckpointDraftV1;
    }
  | {
      completeness: 'unknown';
      reasonCode: 'checkpoint_draft_locator_incomplete';
    };

type VerifiedCheckpointDraftLocator = {
  locator: CheckpointDraftLocatorV1;
  open: Array<{ ref: CheckpointDraftLocatorRefV1; draft: CheckpointDraftV1 }>;
  recentFinalized?: { ref: CheckpointDraftLocatorRecentV1; draft: CheckpointDraftV1 };
};

type CheckpointDraftLocatorState = {
  complete: boolean;
  open: Array<{ ref: CheckpointDraftLocatorRefV1; draft: CheckpointDraftV1 }>;
  recentFinalized?: { ref: CheckpointDraftLocatorRecentV1; draft: CheckpointDraftV1 };
};

export function checkpointPrivateIndexPaths(workspace: Workspace): {
  root: string;
  draftLocators: string;
  draftOpenSets: string;
  artifactSemantic: string;
} {
  const root = path.join(checkpointStorePaths(workspace).root, 'private-indexes');
  return {
    root,
    draftLocators: path.join(root, 'draft-locators'),
    draftOpenSets: path.join(root, 'draft-open-sets'),
    artifactSemantic: path.join(root, 'artifact-semantic'),
  };
}

async function ensureCheckpointPrivateIndexDirectory(
  workspace: Workspace,
  kind: 'draft-locators' | 'draft-open-sets' | 'artifact-semantic',
): Promise<string> {
  await ensureCheckpointStore(workspace);
  const paths = checkpointPrivateIndexPaths(workspace);
  await ensureCheckpointDirectoryExact(checkpointContainmentRoot(workspace), paths.root);
  const directory = kind === 'draft-locators'
    ? paths.draftLocators
    : kind === 'draft-open-sets'
      ? paths.draftOpenSets
      : paths.artifactSemantic;
  await ensureCheckpointDirectoryExact(checkpointContainmentRoot(workspace), directory);
  return directory;
}

function checkpointDraftIdentityKey(
  project: CheckpointProjectIdentity,
  session: CheckpointSessionIdentity,
): string {
  return crypto.createHash('sha256').update(canonicalCheckpointJson({ project, session })).digest('hex');
}

function checkpointDraftLocatorPath(workspace: Workspace, identityKey: string): string {
  if (!CHECKPOINT_SHA256_RE.test(identityKey)) throw new Error('checkpoint_draft_locator_invalid');
  return path.join(checkpointPrivateIndexPaths(workspace).draftLocators, `${identityKey}.json`);
}

function checkpointDraftOpenSetFormatPath(workspace: Workspace): string {
  return path.join(checkpointPrivateIndexPaths(workspace).draftOpenSets, 'FORMAT.json');
}

function checkpointDraftOpenSetLocation(workspace: Workspace, identityKey: string): {
  first: string;
  second: string;
  directory: string;
} {
  if (!CHECKPOINT_SHA256_RE.test(identityKey)) throw new Error('checkpoint_draft_locator_invalid');
  const root = checkpointPrivateIndexPaths(workspace).draftOpenSets;
  const first = path.join(root, identityKey.slice(0, 2));
  const second = path.join(first, identityKey.slice(2, 4));
  return { first, second, directory: path.join(second, identityKey) };
}

function checkpointDraftOpenSetMemberPath(workspace: Workspace, identityKey: string, draftId: string): string {
  if (!CHECKPOINT_DRAFT_BASENAME_RE.test(`${draftId}.json`)) throw new Error('checkpoint_draft_locator_invalid');
  return path.join(checkpointDraftOpenSetLocation(workspace, identityKey).directory, `${draftId}.json`);
}

function checkpointSemanticArtifactIndexPath(workspace: Workspace, semanticSha256: string): string {
  if (!CHECKPOINT_SHA256_RE.test(semanticSha256)) throw new Error('checkpoint_semantic_index_invalid');
  return path.join(checkpointPrivateIndexPaths(workspace).artifactSemantic, `${semanticSha256}.json`);
}

function checkpointDraftContentSha256(draft: CheckpointDraftV1): string {
  return crypto.createHash('sha256').update(canonicalCheckpointJson(draft)).digest('hex');
}

function sameCheckpointDraftIdentity(
  draft: CheckpointDraftV1,
  project: CheckpointProjectIdentity,
  session: CheckpointSessionIdentity,
): boolean {
  return (
    canonicalCheckpointJson(draft.project) === canonicalCheckpointJson(project)
    && canonicalCheckpointJson(draft.session) === canonicalCheckpointJson(session)
  );
}

function validateCheckpointDraftLocatorRef(value: unknown): CheckpointDraftLocatorRefV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('checkpoint_draft_locator_invalid');
  const item = value as Record<string, unknown>;
  if (Object.keys(item).sort().join(',') !== 'contentSha256,draftId') throw new Error('checkpoint_draft_locator_invalid');
  if (
    typeof item.draftId !== 'string'
    || !CHECKPOINT_DRAFT_BASENAME_RE.test(`${item.draftId}.json`)
    || typeof item.contentSha256 !== 'string'
    || !CHECKPOINT_SHA256_RE.test(item.contentSha256)
  ) throw new Error('checkpoint_draft_locator_invalid');
  return { draftId: item.draftId, contentSha256: item.contentSha256 };
}

function validateCheckpointDraftLocator(value: unknown, identityKey: string): CheckpointDraftLocatorV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('checkpoint_draft_locator_invalid');
  const item = value as Record<string, unknown>;
  const expectedKeys = item.recentFinalized === undefined
    ? 'identityKey,open,openSetComplete,schemaVersion'
    : 'identityKey,open,openSetComplete,recentFinalized,schemaVersion';
  if (Object.keys(item).sort().join(',') !== expectedKeys) throw new Error('checkpoint_draft_locator_invalid');
  if (
    item.schemaVersion !== 1
    || item.identityKey !== identityKey
    || typeof item.openSetComplete !== 'boolean'
    || !Array.isArray(item.open)
    || item.open.length > CHECKPOINT_OPEN_DRAFT_MAX
  ) throw new Error('checkpoint_draft_locator_invalid');
  const open = item.open.map(validateCheckpointDraftLocatorRef);
  if (new Set(open.map((entry) => entry.draftId)).size !== open.length) throw new Error('checkpoint_draft_locator_invalid');
  let recentFinalized: CheckpointDraftLocatorRecentV1 | undefined;
  if (item.recentFinalized !== undefined) {
    if (!item.recentFinalized || typeof item.recentFinalized !== 'object' || Array.isArray(item.recentFinalized)) {
      throw new Error('checkpoint_draft_locator_invalid');
    }
    const recent = item.recentFinalized as Record<string, unknown>;
    if (Object.keys(recent).sort().join(',') !== 'artifactId,contentSha256,draftId') {
      throw new Error('checkpoint_draft_locator_invalid');
    }
    if (
      typeof recent.draftId !== 'string'
      || !CHECKPOINT_DRAFT_BASENAME_RE.test(`${recent.draftId}.json`)
      || typeof recent.contentSha256 !== 'string'
      || !CHECKPOINT_SHA256_RE.test(recent.contentSha256)
      || typeof recent.artifactId !== 'string'
      || !CHECKPOINT_ARTIFACT_ID_RE.test(recent.artifactId)
    ) {
      throw new Error('checkpoint_draft_locator_invalid');
    }
    recentFinalized = {
      draftId: recent.draftId,
      contentSha256: recent.contentSha256,
      artifactId: recent.artifactId,
    };
  }
  return {
    schemaVersion: 1,
    identityKey,
    openSetComplete: item.openSetComplete,
    open,
    ...(recentFinalized ? { recentFinalized } : {}),
  };
}

function validateCheckpointDraftOpenSetFormat(value: unknown): CheckpointDraftOpenSetFormatV1 {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value as Record<string, unknown>).sort().join(',') !== 'format,schemaVersion'
    || (value as Record<string, unknown>).schemaVersion !== 1
    || (value as Record<string, unknown>).format !== 'checkpoint-draft-open-set-v1'
  ) throw new Error('checkpoint_draft_locator_invalid');
  return value as CheckpointDraftOpenSetFormatV1;
}

function validateCheckpointDraftOpenSetMember(
  value: unknown,
  identityKey: string,
  draftId: string,
): CheckpointDraftOpenSetMemberV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('checkpoint_draft_locator_invalid');
  }
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).sort().join(',') !== 'draftId,identityKey,schemaVersion'
    || item.schemaVersion !== 1
    || item.identityKey !== identityKey
    || item.draftId !== draftId
  ) throw new Error('checkpoint_draft_locator_invalid');
  return item as CheckpointDraftOpenSetMemberV1;
}

async function checkpointDirectoryExistsExact(workspace: Workspace, directory: string): Promise<boolean> {
  try {
    await fs.lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  await assertCheckpointDirectoryExact(checkpointContainmentRoot(workspace), directory);
  return true;
}

async function readCheckpointDraftOpenSetFormat(
  workspace: Workspace,
): Promise<'active' | 'missing' | 'invalid'> {
  await ensureCheckpointStore(workspace);
  const paths = checkpointPrivateIndexPaths(workspace);
  try {
    if (!await checkpointDirectoryExistsExact(workspace, paths.root)) return 'missing';
    if (!await checkpointDirectoryExistsExact(workspace, paths.draftOpenSets)) return 'missing';
    const raw = await readContainedFile(
      checkpointContainmentRoot(workspace),
      checkpointDraftOpenSetFormatPath(workspace),
      CHECKPOINT_DRAFT_OPEN_SET_FORMAT_MAX_BYTES,
      'checkpoint_draft_locator_invalid',
    ).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (raw === undefined) return 'missing';
    const parsed = JSON.parse(raw) as unknown;
    const format = validateCheckpointDraftOpenSetFormat(parsed);
    if (raw !== canonicalCheckpointJson(format)) throw new Error('checkpoint_draft_locator_invalid');
    return 'active';
  } catch {
    return 'invalid';
  }
}

async function tryInitializeCheckpointDraftOpenSetFormat(workspace: Workspace): Promise<boolean> {
  const existing = await readCheckpointDraftOpenSetFormat(workspace);
  if (existing === 'active') return true;
  if (existing === 'invalid') throw new Error('checkpoint_draft_locator_incomplete');

  // A format marker makes an absent identity shard authoritative-empty for future identities. Only
  // establish it online when the canonical draft namespace is empty; an older populated store keeps
  // using the conservative bounded fallback rather than silently declaring legacy drafts indexed.
  const paths = await ensureCheckpointStore(workspace);
  let directory: Awaited<ReturnType<typeof fs.opendir>>;
  try {
    directory = await fs.opendir(paths.drafts);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    directory = await fs.opendir((await ensureCheckpointStore(workspace)).drafts);
  }
  let visited = 0;
  let canonicalEntryFound = false;
  try {
    for await (const entry of directory) {
      visited += 1;
      if (visited > CHECKPOINT_DRAFT_LOCATOR_FALLBACK_VISITS) return false;
      if (CHECKPOINT_DRAFT_BASENAME_RE.test(entry.name)) {
        canonicalEntryFound = true;
        break;
      }
    }
  } finally {
    await directory.close().catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ERR_DIR_CLOSED') throw error;
    });
  }
  if (canonicalEntryFound) return false;

  await ensureCheckpointPrivateIndexDirectory(workspace, 'draft-open-sets');
  const format: CheckpointDraftOpenSetFormatV1 = {
    schemaVersion: 1,
    format: 'checkpoint-draft-open-set-v1',
  };
  const raw = canonicalCheckpointJson(format);
  const result = await atomicWriteCheckpointFile(
    checkpointContainmentRoot(workspace),
    checkpointDraftOpenSetFormatPath(workspace),
    raw,
    'create',
  );
  if (result !== 'created' && result !== 'exists') throw new Error('checkpoint_internal_failure');
  if (result === 'exists') {
    const persisted = await readContainedFile(
      checkpointContainmentRoot(workspace),
      checkpointDraftOpenSetFormatPath(workspace),
      CHECKPOINT_DRAFT_OPEN_SET_FORMAT_MAX_BYTES,
      'checkpoint_draft_locator_invalid',
    );
    if (persisted !== raw) throw new Error('checkpoint_draft_locator_incomplete');
  }
  return true;
}

function validateCheckpointSemanticArtifactIndex(
  value: unknown,
  semanticSha256: string,
): CheckpointSemanticArtifactIndexV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('checkpoint_semantic_index_invalid');
  const item = value as Record<string, unknown>;
  if (Object.keys(item).sort().join(',') !== 'artifactContentSha256,artifactId,schemaVersion,semanticSha256') {
    throw new Error('checkpoint_semantic_index_invalid');
  }
  if (
    item.schemaVersion !== 1
    || item.semanticSha256 !== semanticSha256
    || typeof item.artifactId !== 'string'
    || !CHECKPOINT_ARTIFACT_ID_RE.test(item.artifactId)
    || typeof item.artifactContentSha256 !== 'string'
    || !CHECKPOINT_SHA256_RE.test(item.artifactContentSha256)
    || item.artifactId !== `cp_${item.artifactContentSha256}`
  ) throw new Error('checkpoint_semantic_index_invalid');
  return item as CheckpointSemanticArtifactIndexV1;
}

type NativePreCompactReceiptV1 = {
  schemaVersion: 1;
  dedupeKey: string;
  draftId: string;
  artifactId: string;
  completedAt: string;
};

function nativePreCompactReceiptDirectory(workspace: Workspace): string {
  return path.join(checkpointStorePaths(workspace).root, 'native-precompact-receipts');
}

function nativePreCompactReceiptPath(workspace: Workspace, dedupeKey: string): string {
  if (!NATIVE_PRECOMPACT_DEDUPE_KEY_RE.test(dedupeKey)) throw new Error('checkpoint_native_precompact_receipt_invalid');
  return path.join(nativePreCompactReceiptDirectory(workspace), `${dedupeKey}.json`);
}

function validateNativePreCompactReceipt(value: unknown): NativePreCompactReceiptV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('checkpoint_native_precompact_receipt_invalid');
  const item = value as Record<string, unknown>;
  if (Object.keys(item).sort().join(',') !== 'artifactId,completedAt,dedupeKey,draftId,schemaVersion') {
    throw new Error('checkpoint_native_precompact_receipt_invalid');
  }
  if (
    item.schemaVersion !== 1
    || typeof item.dedupeKey !== 'string'
    || !NATIVE_PRECOMPACT_DEDUPE_KEY_RE.test(item.dedupeKey)
    || typeof item.draftId !== 'string'
    || !CHECKPOINT_DRAFT_BASENAME_RE.test(`${item.draftId}.json`)
    || typeof item.artifactId !== 'string'
    || !/^cp_[a-f0-9]{64}$/.test(item.artifactId)
    || typeof item.completedAt !== 'string'
    || Number.isNaN(Date.parse(item.completedAt))
    || new Date(item.completedAt).toISOString() !== item.completedAt
  ) throw new Error('checkpoint_native_precompact_receipt_invalid');
  return item as NativePreCompactReceiptV1;
}

const WRITE_CLAIM_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function artifactWriteClaimPath(workspace: Workspace, artifactId: string, writeClaimId: string): string {
  if (!/^cp_[a-f0-9]{64}$/.test(artifactId)) throw new Error('checkpoint_artifact_id_invalid');
  if (!WRITE_CLAIM_ID_RE.test(writeClaimId)) throw new Error('checkpoint_artifact_write_claim_invalid');
  return path.join(checkpointStorePaths(workspace).artifacts, `.${artifactId}.claim-${writeClaimId}.tmp`);
}

function validateFinalizationIntent(value: unknown): CheckpointFinalizationIntentV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('checkpoint_finalization_intent_invalid');
  const item = value as Record<string, unknown>;
  const keys = Object.keys(item).sort();
  const expectedKeys = item.creationProvenance === 'created'
    ? 'artifactId,build,creationProvenance,draftId,schemaVersion,writeClaimId'
    : 'artifactId,build,creationProvenance,draftId,schemaVersion';
  if (keys.join(',') !== expectedKeys) throw new Error('checkpoint_finalization_intent_invalid');
  if (
    item.schemaVersion !== 1
    || typeof item.draftId !== 'string'
    || typeof item.artifactId !== 'string'
    || (item.creationProvenance !== 'created' && item.creationProvenance !== 'deduplicated')
  ) throw new Error('checkpoint_finalization_intent_invalid');
  if (!/^draft_[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(item.draftId)) throw new Error('checkpoint_finalization_intent_invalid');
  if (!/^cp_[a-f0-9]{64}$/.test(item.artifactId)) throw new Error('checkpoint_finalization_intent_invalid');
  if (item.creationProvenance === 'created' && (typeof item.writeClaimId !== 'string' || !WRITE_CLAIM_ID_RE.test(item.writeClaimId))) {
    throw new Error('checkpoint_finalization_intent_invalid');
  }
  return {
    schemaVersion: 1,
    draftId: item.draftId,
    artifactId: item.artifactId,
    creationProvenance: item.creationProvenance,
    ...(item.creationProvenance === 'created' ? { writeClaimId: item.writeClaimId as string } : {}),
    build: validateCheckpointArtifactBuild(item.build),
  };
}

export async function writeCheckpointFinalizationIntentUnlocked(
  workspace: Workspace,
  intent: CheckpointFinalizationIntentV1,
  options?: CheckpointFileWorkerTestOptions,
): Promise<void> {
  const validated = validateFinalizationIntent(intent);
  const paths = await ensureCheckpointStore(workspace);
  const result = await atomicWriteCheckpointFile(
    checkpointContainmentRoot(workspace),
    finalizationPath(workspace, validated.draftId),
    canonicalCheckpointJson(validated),
    'replace',
    options,
  );
  if (result !== 'replaced') throw new Error('checkpoint_internal_failure');
}

export async function readCheckpointFinalizationIntentUnlocked(
  workspace: Workspace,
  draftId: string,
): Promise<CheckpointFinalizationIntentV1 | undefined> {
  const paths = await ensureCheckpointStore(workspace);
  const file = finalizationPath(workspace, draftId);
  const raw = await readContainedFile(checkpointContainmentRoot(workspace), file, CHECKPOINT_ARTIFACT_MAX_BYTES * 2, 'checkpoint_finalization_intent_too_large').catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('checkpoint_finalization_intent_invalid'); }
  const intent = validateFinalizationIntent(parsed);
  if (intent.draftId !== draftId || raw !== canonicalCheckpointJson(intent)) throw new Error('checkpoint_finalization_intent_invalid');
  return intent;
}

export async function removeCheckpointFinalizationIntentUnlocked(workspace: Workspace, draftId: string): Promise<void> {
  const paths = await ensureCheckpointStore(workspace);
  const file = finalizationPath(workspace, draftId);
  await assertRealPathWithin(checkpointContainmentRoot(workspace), paths.finalizations);
  await fs.rm(file, { force: true });
}

export async function writeCheckpointDraftUnlocked(
  workspace: Workspace,
  draft: CheckpointDraftV1,
  options?: CheckpointFileWorkerTestOptions,
): Promise<void> {
  validateCheckpointDraft(draft);
  const paths = await ensureCheckpointStore(workspace);
  const result = await atomicWriteCheckpointFile(
    checkpointContainmentRoot(workspace),
    draftPath(workspace, draft.draftId),
    canonicalCheckpointJson(draft),
    'replace',
    options,
  );
  if (result !== 'replaced') throw new Error('checkpoint_internal_failure');
}

export async function readCheckpointDraftUnlocked(workspace: Workspace, draftId: string): Promise<CheckpointDraftV1> {
  const paths = await ensureCheckpointStore(workspace);
  const file = draftPath(workspace, draftId);
  const raw = await readContainedFile(checkpointContainmentRoot(workspace), file, CHECKPOINT_DRAFT_MAX_BYTES, 'checkpoint_draft_too_large').catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('checkpoint_draft_not_found');
    throw error;
  });
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('checkpoint_draft_schema_invalid'); }
  const validated = validateCheckpointDraft(parsed);
  if (raw !== canonicalCheckpointJson(validated)) throw new Error('checkpoint_draft_noncanonical');
  return validated;
}

async function readCheckpointDraftLocatorCandidate(
  workspace: Workspace,
  project: CheckpointProjectIdentity,
  session: CheckpointSessionIdentity,
): Promise<VerifiedCheckpointDraftLocator | undefined> {
  const identityKey = checkpointDraftIdentityKey(project, session);
  try {
    await ensureCheckpointPrivateIndexDirectory(workspace, 'draft-locators');
    const raw = await readContainedFile(
      checkpointContainmentRoot(workspace),
      checkpointDraftLocatorPath(workspace, identityKey),
      CHECKPOINT_DRAFT_LOCATOR_MAX_BYTES,
      'checkpoint_draft_locator_too_large',
    );
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new Error('checkpoint_draft_locator_invalid'); }
    const locator = validateCheckpointDraftLocator(parsed, identityKey);
    if (raw !== canonicalCheckpointJson(locator)) throw new Error('checkpoint_draft_locator_invalid');

    const open: VerifiedCheckpointDraftLocator['open'] = [];
    for (const ref of locator.open) {
      const draft = await readCheckpointDraftUnlocked(workspace, ref.draftId);
      if (
        !sameCheckpointDraftIdentity(draft, project, session)
        || draft.finalization !== undefined
        || checkpointDraftContentSha256(draft) !== ref.contentSha256
      ) throw new Error('checkpoint_draft_locator_invalid');
      open.push({ ref, draft });
    }
    open.sort((left, right) => (
      right.draft.updatedAt.localeCompare(left.draft.updatedAt)
      || left.draft.draftId.localeCompare(right.draft.draftId)
    ));
    if (open.some((entry, index) => entry.ref.draftId !== locator.open[index]?.draftId)) {
      throw new Error('checkpoint_draft_locator_invalid');
    }

    let recentFinalized: VerifiedCheckpointDraftLocator['recentFinalized'];
    if (locator.recentFinalized) {
      const draft = await readCheckpointDraftUnlocked(workspace, locator.recentFinalized.draftId);
      if (
        !sameCheckpointDraftIdentity(draft, project, session)
        || draft.finalization?.artifactId !== locator.recentFinalized.artifactId
        || checkpointDraftContentSha256(draft) !== locator.recentFinalized.contentSha256
      ) throw new Error('checkpoint_draft_locator_invalid');
      recentFinalized = { ref: locator.recentFinalized, draft };
    }
    return { locator, open, ...(recentFinalized ? { recentFinalized } : {}) };
  } catch {
    // Private indexes are hints, never authority. Missing, stale, non-canonical, oversized, aliased,
    // or otherwise invalid locators are ignored; the bounded fallback below can repair them without
    // making checkpoint creation permanently unavailable.
    return undefined;
  }
}

function sameCheckpointDraftRefSet(
  left: Array<{ ref: CheckpointDraftLocatorRefV1; draft: CheckpointDraftV1 }>,
  right: Array<{ ref: CheckpointDraftLocatorRefV1; draft: CheckpointDraftV1 }>,
): boolean {
  if (left.length !== right.length) return false;
  const leftById = new Map(left.map((entry) => [entry.ref.draftId, entry.ref.contentSha256]));
  return right.every((entry) => leftById.get(entry.ref.draftId) === entry.ref.contentSha256);
}

async function ensureCheckpointDraftOpenSetIdentityDirectory(
  workspace: Workspace,
  identityKey: string,
): Promise<string> {
  await ensureCheckpointPrivateIndexDirectory(workspace, 'draft-open-sets');
  const location = checkpointDraftOpenSetLocation(workspace, identityKey);
  const root = checkpointContainmentRoot(workspace);
  await ensureCheckpointDirectoryExact(root, location.first);
  await ensureCheckpointDirectoryExact(root, location.second);
  await ensureCheckpointDirectoryExact(root, location.directory);
  return location.directory;
}

async function removeCheckpointDraftOpenSetMember(
  workspace: Workspace,
  identityKey: string,
  draftId: string,
): Promise<void> {
  const location = checkpointDraftOpenSetLocation(workspace, identityKey);
  if (!await checkpointDirectoryExistsExact(workspace, location.directory)) return;
  const file = checkpointDraftOpenSetMemberPath(workspace, identityKey, draftId);
  const raw = await readContainedFile(
    checkpointContainmentRoot(workspace),
    file,
    CHECKPOINT_DRAFT_OPEN_SET_MEMBER_MAX_BYTES,
    'checkpoint_draft_locator_invalid',
  ).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (raw === undefined) return;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('checkpoint_draft_locator_invalid'); }
  const member = validateCheckpointDraftOpenSetMember(parsed, identityKey, draftId);
  if (raw !== canonicalCheckpointJson(member)) throw new Error('checkpoint_draft_locator_invalid');
  await fs.rm(file);
}

async function writeCheckpointDraftOpenSetMember(
  workspace: Workspace,
  project: CheckpointProjectIdentity,
  session: CheckpointSessionIdentity,
  draftId: string,
): Promise<void> {
  const identityKey = checkpointDraftIdentityKey(project, session);
  await ensureCheckpointDraftOpenSetIdentityDirectory(workspace, identityKey);
  const member: CheckpointDraftOpenSetMemberV1 = { schemaVersion: 1, identityKey, draftId };
  const raw = canonicalCheckpointJson(member);
  const file = checkpointDraftOpenSetMemberPath(workspace, identityKey, draftId);
  const result = await atomicWriteCheckpointFile(
    checkpointContainmentRoot(workspace),
    file,
    raw,
    'create',
  );
  if (result !== 'created' && result !== 'exists') throw new Error('checkpoint_internal_failure');
  if (result === 'exists') {
    const persisted = await readContainedFile(
      checkpointContainmentRoot(workspace),
      file,
      CHECKPOINT_DRAFT_OPEN_SET_MEMBER_MAX_BYTES,
      'checkpoint_draft_locator_invalid',
    );
    if (persisted !== raw) throw new Error('checkpoint_draft_locator_invalid');
  }
}

async function addCheckpointDraftOpenSetMembers(
  workspace: Workspace,
  project: CheckpointProjectIdentity,
  session: CheckpointSessionIdentity,
  open: CheckpointDraftLocatorState['open'],
): Promise<void> {
  if (await readCheckpointDraftOpenSetFormat(workspace) !== 'active') return;
  for (const entry of open) {
    await writeCheckpointDraftOpenSetMember(workspace, project, session, entry.draft.draftId);
  }
}

async function readCheckpointDraftOpenSet(
  workspace: Workspace,
  project: CheckpointProjectIdentity,
  session: CheckpointSessionIdentity,
): Promise<CheckpointDraftLocatorState | undefined> {
  if (await readCheckpointDraftOpenSetFormat(workspace) !== 'active') return undefined;
  const identityKey = checkpointDraftIdentityKey(project, session);
  const location = checkpointDraftOpenSetLocation(workspace, identityKey);
  if (!await checkpointDirectoryExistsExact(workspace, location.first)) return { complete: true, open: [] };
  if (!await checkpointDirectoryExistsExact(workspace, location.second)) return { complete: true, open: [] };
  if (!await checkpointDirectoryExistsExact(workspace, location.directory)) return { complete: true, open: [] };

  let directory: Awaited<ReturnType<typeof fs.opendir>>;
  try {
    directory = await fs.opendir(location.directory);
  } catch {
    throw new Error('checkpoint_draft_locator_incomplete');
  }
  const open: CheckpointDraftLocatorState['open'] = [];
  let recentFinalized: CheckpointDraftLocatorState['recentFinalized'];
  let visited = 0;
  try {
    for await (const entry of directory) {
      visited += 1;
      if (visited > CHECKPOINT_DRAFT_OPEN_SET_MAX_VISITS) {
        throw new Error('checkpoint_draft_locator_incomplete');
      }
      if (!CHECKPOINT_DRAFT_BASENAME_RE.test(entry.name) || !entry.isFile()) {
        throw new Error('checkpoint_draft_locator_incomplete');
      }
      const draftId = entry.name.slice(0, -'.json'.length);
      const file = checkpointDraftOpenSetMemberPath(workspace, identityKey, draftId);
      const raw = await readContainedFile(
        checkpointContainmentRoot(workspace),
        file,
        CHECKPOINT_DRAFT_OPEN_SET_MEMBER_MAX_BYTES,
        'checkpoint_draft_locator_invalid',
      );
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { throw new Error('checkpoint_draft_locator_incomplete'); }
      const member = validateCheckpointDraftOpenSetMember(parsed, identityKey, draftId);
      if (raw !== canonicalCheckpointJson(member)) throw new Error('checkpoint_draft_locator_incomplete');

      let draft: CheckpointDraftV1;
      try {
        draft = await readCheckpointDraftUnlocked(workspace, draftId);
      } catch (error) {
        if (error instanceof Error && error.message === 'checkpoint_draft_not_found') {
          // The same member+locator state is reachable both before a create's draft bytes land and
          // after an attacker deletes a once-durable canonical draft. With no durable phase proof we
          // must preserve the member and fail closed rather than turn ambiguity into an empty set.
          throw new Error('checkpoint_draft_locator_incomplete');
        }
        throw error;
      }
      if (!sameCheckpointDraftIdentity(draft, project, session)) {
        throw new Error('checkpoint_draft_locator_incomplete');
      }
      const contentSha256 = checkpointDraftContentSha256(draft);
      if (draft.finalization?.artifactId) {
        const finalized = {
          draft,
          ref: { draftId, artifactId: draft.finalization.artifactId, contentSha256 },
        };
        if (
          !recentFinalized
          || draft.updatedAt > recentFinalized.draft.updatedAt
          || (draft.updatedAt === recentFinalized.draft.updatedAt && draft.draftId < recentFinalized.draft.draftId)
        ) recentFinalized = finalized;
        await removeCheckpointDraftOpenSetMember(workspace, identityKey, draftId);
        continue;
      }
      open.push({ draft, ref: { draftId, contentSha256 } });
      if (open.length > CHECKPOINT_OPEN_DRAFT_MAX) throw new Error('checkpoint_draft_locator_incomplete');
    }
  } finally {
    await directory.close().catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ERR_DIR_CLOSED') throw error;
    });
  }
  open.sort((left, right) => (
    right.draft.updatedAt.localeCompare(left.draft.updatedAt)
    || left.draft.draftId.localeCompare(right.draft.draftId)
  ));
  return { complete: true, open, ...(recentFinalized ? { recentFinalized } : {}) };
}

async function scanCheckpointDraftIdentityBounded(
  workspace: Workspace,
  project: CheckpointProjectIdentity,
  session: CheckpointSessionIdentity,
): Promise<CheckpointDraftLocatorState> {
  const paths = await ensureCheckpointStore(workspace);
  const matches: CheckpointDraftV1[] = [];
  let complete = true;
  let directory: Awaited<ReturnType<typeof fs.opendir>>;
  try {
    directory = await fs.opendir(paths.drafts);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { complete: true, open: [] };
    throw error;
  }
  let visited = 0;
  try {
    for await (const entry of directory) {
      visited += 1;
      if (visited > CHECKPOINT_DRAFT_LOCATOR_FALLBACK_VISITS) {
        complete = false;
        break;
      }
      if (!CHECKPOINT_DRAFT_BASENAME_RE.test(entry.name)) continue;
      if (!entry.isFile()) {
        // A canonical basename can belong to the requested identity even when it has been replaced
        // with a symlink, directory, FIFO, or other non-file. Skipping it would turn an unreadable
        // candidate into a false proof of completeness.
        complete = false;
        continue;
      }
      const draftId = entry.name.slice(0, -'.json'.length);
      try {
        const draft = await readCheckpointDraftUnlocked(workspace, draftId);
        if (sameCheckpointDraftIdentity(draft, project, session)) matches.push(draft);
      } catch {
        // A canonical-looking but unreadable entry could belong to the requested identity. We do not
        // guess around it or claim the fallback is complete.
        complete = false;
      }
    }
  } finally {
    await directory.close().catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ERR_DIR_CLOSED') throw error;
    });
  }
  const sorted = matches.sort((left, right) => (
    right.updatedAt.localeCompare(left.updatedAt) || left.draftId.localeCompare(right.draftId)
  ));
  const allOpen = sorted.filter((draft) => !draft.finalization);
  if (allOpen.length > CHECKPOINT_OPEN_DRAFT_MAX) complete = false;
  const open = allOpen.map((draft) => ({
    draft,
    ref: { draftId: draft.draftId, contentSha256: checkpointDraftContentSha256(draft) },
  }));
  const recentDraft = sorted.find((draft) => !!draft.finalization?.artifactId);
  const recentFinalized = recentDraft?.finalization?.artifactId
    ? {
        draft: recentDraft,
        ref: {
          draftId: recentDraft.draftId,
          artifactId: recentDraft.finalization.artifactId,
          contentSha256: checkpointDraftContentSha256(recentDraft),
        },
      }
    : undefined;
  return { complete, open, ...(recentFinalized ? { recentFinalized } : {}) };
}

async function checkpointDraftLocatorStateForMutation(
  workspace: Workspace,
  project: CheckpointProjectIdentity,
  session: CheckpointSessionIdentity,
): Promise<CheckpointDraftLocatorState> {
  let externallyBound = await readCheckpointDraftOpenSet(workspace, project, session);
  if (!externallyBound && await tryInitializeCheckpointDraftOpenSetFormat(workspace)) {
    externallyBound = await readCheckpointDraftOpenSet(workspace, project, session);
  }
  if (externallyBound) {
    const candidate = await readCheckpointDraftLocatorCandidate(workspace, project, session);
    if (candidate && !candidate.locator.openSetComplete) {
      const fallback = await scanCheckpointDraftIdentityBounded(workspace, project, session);
      if (!fallback.complete) throw new Error('checkpoint_draft_locator_incomplete');
      await addCheckpointDraftOpenSetMembers(workspace, project, session, fallback.open);
      return fallback;
    }
    if (candidate && !sameCheckpointDraftRefSet(candidate.open, externallyBound.open)) {
      // The two independently maintained bounded indexes disagree. This may be a locator omission,
      // a removed open-set member, or another partial mutation. Neither side may silently overwrite
      // the other and claim completeness; mutation stays fail-closed until bounded recovery is possible.
      throw new Error('checkpoint_draft_locator_incomplete');
    }
    return {
      complete: true,
      open: externallyBound.open,
      ...(candidate?.recentFinalized
        ? { recentFinalized: candidate.recentFinalized }
        : externallyBound.recentFinalized
          ? { recentFinalized: externallyBound.recentFinalized }
          : {}),
    };
  }
  const fallback = await scanCheckpointDraftIdentityBounded(workspace, project, session);
  if (!fallback.complete) throw new Error('checkpoint_draft_locator_incomplete');
  return fallback;
}

async function writeCheckpointDraftLocator(
  workspace: Workspace,
  project: CheckpointProjectIdentity,
  session: CheckpointSessionIdentity,
  state: {
    complete: boolean;
    open: Array<{ ref: CheckpointDraftLocatorRefV1; draft: CheckpointDraftV1 }>;
    recentFinalized?: { ref: CheckpointDraftLocatorRecentV1; draft: CheckpointDraftV1 };
  },
): Promise<void> {
  if (!state.complete) throw new Error('checkpoint_draft_locator_incomplete');
  const identityKey = checkpointDraftIdentityKey(project, session);
  const ordered = [...state.open].sort((left, right) => (
    right.draft.updatedAt.localeCompare(left.draft.updatedAt)
    || left.draft.draftId.localeCompare(right.draft.draftId)
  ));
  if (ordered.length > CHECKPOINT_OPEN_DRAFT_MAX) throw new Error('checkpoint_open_draft_limit_exceeded');
  if (new Set(ordered.map((entry) => entry.draft.draftId)).size !== ordered.length) {
    throw new Error('checkpoint_draft_locator_invalid');
  }
  for (const entry of ordered) {
    if (
      entry.draft.finalization
      || !sameCheckpointDraftIdentity(entry.draft, project, session)
      || entry.ref.draftId !== entry.draft.draftId
      || entry.ref.contentSha256 !== checkpointDraftContentSha256(entry.draft)
    ) throw new Error('checkpoint_draft_locator_invalid');
  }
  if (state.recentFinalized && (
    !state.recentFinalized.draft.finalization?.artifactId
    || !sameCheckpointDraftIdentity(state.recentFinalized.draft, project, session)
    || state.recentFinalized.ref.draftId !== state.recentFinalized.draft.draftId
    || state.recentFinalized.ref.artifactId !== state.recentFinalized.draft.finalization.artifactId
    || state.recentFinalized.ref.contentSha256 !== checkpointDraftContentSha256(state.recentFinalized.draft)
  )) throw new Error('checkpoint_draft_locator_invalid');
  const locator: CheckpointDraftLocatorV1 = {
    schemaVersion: 1,
    identityKey,
    openSetComplete: true,
    open: ordered.map(({ ref }) => ref),
    ...(state.recentFinalized ? { recentFinalized: state.recentFinalized.ref } : {}),
  };
  const content = canonicalCheckpointJson(locator);
  if (Buffer.byteLength(content, 'utf8') > CHECKPOINT_DRAFT_LOCATOR_MAX_BYTES) {
    throw new Error('checkpoint_draft_locator_too_large');
  }
  const directory = await ensureCheckpointPrivateIndexDirectory(workspace, 'draft-locators');
  await ensureCheckpointDirectoryExact(checkpointContainmentRoot(workspace), directory);
  const result = await atomicWriteCheckpointFile(
    checkpointContainmentRoot(workspace),
    checkpointDraftLocatorPath(workspace, identityKey),
    content,
    'replace',
  );
  if (result !== 'replaced') throw new Error('checkpoint_internal_failure');
}

export async function stageCheckpointDraftLocatorCreateUnlocked(
  workspace: Workspace,
  draft: CheckpointDraftV1,
): Promise<void> {
  validateCheckpointDraft(draft);
  if (draft.finalization) throw new Error('checkpoint_draft_locator_invalid');
  const state = await checkpointDraftLocatorStateForMutation(workspace, draft.project, draft.session);
  if (state.open.length >= CHECKPOINT_OPEN_DRAFT_MAX) throw new Error('checkpoint_open_draft_limit_exceeded');
  const open = [
    { ref: { draftId: draft.draftId, contentSha256: checkpointDraftContentSha256(draft) }, draft },
    ...state.open.filter((entry) => entry.draft.draftId !== draft.draftId),
  ];
  // Publish independent open-set membership before the locator and draft. A crash before the draft
  // write leaves a bounded missing-target receipt that the next locked lookup safely reaps; there is
  // never a window where a newly open cooperative draft exists in the canonical namespace but in
  // neither bounded index.
  if (await readCheckpointDraftOpenSetFormat(workspace) === 'active') {
    await writeCheckpointDraftOpenSetMember(workspace, draft.project, draft.session, draft.draftId);
  }
  await writeCheckpointDraftLocator(workspace, draft.project, draft.session, { ...state, open });
}

export async function stageCheckpointDraftLocatorUpdateUnlocked(
  workspace: Workspace,
  current: CheckpointDraftV1,
  updated: CheckpointDraftV1,
): Promise<void> {
  validateCheckpointDraft(current);
  validateCheckpointDraft(updated);
  if (
    current.draftId !== updated.draftId
    || current.finalization
    || updated.finalization
    || !sameCheckpointDraftIdentity(updated, current.project, current.session)
  ) throw new Error('checkpoint_draft_locator_invalid');
  const state = await checkpointDraftLocatorStateForMutation(workspace, current.project, current.session);
  if (!state.open.some((entry) => (
    entry.draft.draftId === current.draftId
    && entry.ref.contentSha256 === checkpointDraftContentSha256(current)
  ))) throw new Error('checkpoint_draft_locator_incomplete');
  const open = [
    { ref: { draftId: updated.draftId, contentSha256: checkpointDraftContentSha256(updated) }, draft: updated },
    ...state.open.filter((entry) => entry.draft.draftId !== updated.draftId),
  ];
  await writeCheckpointDraftLocator(workspace, current.project, current.session, { ...state, open });
}

export async function stageCheckpointDraftLocatorFinalizedUnlocked(
  workspace: Workspace,
  current: CheckpointDraftV1,
  completed: CheckpointDraftV1,
): Promise<void> {
  validateCheckpointDraft(current);
  validateCheckpointDraft(completed);
  if (
    current.draftId !== completed.draftId
    || !completed.finalization?.artifactId
    || !sameCheckpointDraftIdentity(completed, current.project, current.session)
  ) throw new Error('checkpoint_draft_locator_invalid');
  const state = await checkpointDraftLocatorStateForMutation(workspace, current.project, current.session);
  if (!state.open.some((entry) => (
    entry.draft.draftId === current.draftId
    && entry.ref.contentSha256 === checkpointDraftContentSha256(current)
  ))) throw new Error('checkpoint_draft_locator_incomplete');
  await writeCheckpointDraftLocator(workspace, current.project, current.session, {
    ...state,
    open: state.open.filter((entry) => entry.draft.draftId !== completed.draftId),
    recentFinalized: {
      draft: completed,
      ref: {
        draftId: completed.draftId,
        artifactId: completed.finalization.artifactId,
        contentSha256: checkpointDraftContentSha256(completed),
      },
    },
  });
}

export async function commitCheckpointDraftLocatorFinalizedUnlocked(
  workspace: Workspace,
  completed: CheckpointDraftV1,
): Promise<void> {
  validateCheckpointDraft(completed);
  if (!completed.finalization?.artifactId) throw new Error('checkpoint_draft_locator_invalid');
  if (await readCheckpointDraftOpenSetFormat(workspace) !== 'active') return;
  const identityKey = checkpointDraftIdentityKey(completed.project, completed.session);
  await removeCheckpointDraftOpenSetMember(workspace, identityKey, completed.draftId);
}

export async function findCheckpointDraftsByLocatorUnlocked(
  workspace: Workspace,
  project: CheckpointProjectIdentity,
  session: CheckpointSessionIdentity,
): Promise<CheckpointDraftLocatorMatch> {
  try {
    const externallyBound = await readCheckpointDraftOpenSet(workspace, project, session);
    if (externallyBound) {
      const candidate = await readCheckpointDraftLocatorCandidate(workspace, project, session);
      if (candidate && !candidate.locator.openSetComplete) {
        const fallback = await scanCheckpointDraftIdentityBounded(workspace, project, session);
        if (!fallback.complete) {
          return { completeness: 'unknown', reasonCode: 'checkpoint_draft_locator_incomplete' };
        }
        await addCheckpointDraftOpenSetMembers(workspace, project, session, fallback.open);
        await writeCheckpointDraftLocator(workspace, project, session, fallback);
        return {
          completeness: 'complete',
          ...(fallback.open[0] ? { open: fallback.open[0].draft } : {}),
          ...(fallback.recentFinalized ? { recentFinalized: fallback.recentFinalized.draft } : {}),
        };
      }
      if (candidate && !sameCheckpointDraftRefSet(candidate.open, externallyBound.open)) {
        return { completeness: 'unknown', reasonCode: 'checkpoint_draft_locator_incomplete' };
      }
      // A missing/invalid locator can be repaired from the independently maintained open-set namespace.
      // A valid locator that disagrees is never healed in either direction: that is evidence of partial
      // corruption, and returning unknown prevents a shadow checkpoint from hiding cooperative state.
      if (!candidate) await writeCheckpointDraftLocator(workspace, project, session, externallyBound);
      return {
        completeness: 'complete',
        ...(externallyBound.open[0] ? { open: externallyBound.open[0].draft } : {}),
        ...(candidate?.recentFinalized
          ? { recentFinalized: candidate.recentFinalized.draft }
          : externallyBound.recentFinalized
            ? { recentFinalized: externallyBound.recentFinalized.draft }
            : {}),
      };
    }
    const fallback = await scanCheckpointDraftIdentityBounded(workspace, project, session);
    if (!fallback.complete) {
      return { completeness: 'unknown', reasonCode: 'checkpoint_draft_locator_incomplete' };
    }
    await writeCheckpointDraftLocator(workspace, project, session, fallback);
    return {
      completeness: 'complete',
      ...(fallback.open[0] ? { open: fallback.open[0].draft } : {}),
      ...(fallback.recentFinalized ? { recentFinalized: fallback.recentFinalized.draft } : {}),
    };
  } catch (error) {
    if (
      error instanceof Error
      && (error.message === 'checkpoint_draft_locator_incomplete' || error.message === 'checkpoint_path_outside_store')
    ) return { completeness: 'unknown', reasonCode: 'checkpoint_draft_locator_incomplete' };
    throw error;
  }
}

export async function readCheckpointSemanticArtifactIndexUnlocked(
  workspace: Workspace,
  candidate: CheckpointArtifactV1,
): Promise<CheckpointArtifactV1 | undefined> {
  validateCheckpointArtifact(candidate);
  const semanticSha256 = computeCheckpointSemanticSha256(candidate);
  try {
    await ensureCheckpointPrivateIndexDirectory(workspace, 'artifact-semantic');
    const raw = await readContainedFile(
      checkpointContainmentRoot(workspace),
      checkpointSemanticArtifactIndexPath(workspace, semanticSha256),
      1024,
      'checkpoint_semantic_index_too_large',
    );
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new Error('checkpoint_semantic_index_invalid'); }
    const index = validateCheckpointSemanticArtifactIndex(parsed, semanticSha256);
    if (raw !== canonicalCheckpointJson(index)) throw new Error('checkpoint_semantic_index_invalid');
    const existing = (await readCheckpointArtifactUnlocked(workspace, index.artifactId)).artifact;
    if (
      existing.integrity.contentSha256 !== index.artifactContentSha256
      || computeCheckpointSemanticSha256(existing) !== semanticSha256
    ) throw new Error('checkpoint_semantic_index_invalid');
    return existing;
  } catch {
    // Missing/early/stale/tampered pointers are never trusted and never block a new artifact. The
    // successful finalization path rewrites this exact fingerprint after durable completion.
    return undefined;
  }
}

export async function writeCheckpointSemanticArtifactIndexUnlocked(
  workspace: Workspace,
  artifact: CheckpointArtifactV1,
): Promise<void> {
  validateCheckpointArtifact(artifact);
  const semanticSha256 = computeCheckpointSemanticSha256(artifact);
  const index: CheckpointSemanticArtifactIndexV1 = {
    schemaVersion: 1,
    semanticSha256,
    artifactId: artifact.id,
    artifactContentSha256: artifact.integrity.contentSha256,
  };
  await ensureCheckpointPrivateIndexDirectory(workspace, 'artifact-semantic');
  const result = await atomicWriteCheckpointFile(
    checkpointContainmentRoot(workspace),
    checkpointSemanticArtifactIndexPath(workspace, semanticSha256),
    canonicalCheckpointJson(index),
    'replace',
  );
  if (result !== 'replaced') throw new Error('checkpoint_internal_failure');
}

// Private adapter receipt: it proves that a specific normalized delivery durably completed a specific
// draft/artifact pair without adding fields to either public checkpoint schema. It is written only after
// finalization, so a crash can cause a safe duplicate attempt but can never advertise a missing artifact.
export async function writeNativePreCompactReceipt(
  workspace: Workspace,
  receipt: NativePreCompactReceiptV1,
): Promise<void> {
  const validated = validateNativePreCompactReceipt(receipt);
  await ensureCheckpointStore(workspace);
  const directory = nativePreCompactReceiptDirectory(workspace);
  await ensureCheckpointDirectoryExact(checkpointContainmentRoot(workspace), directory);
  const result = await atomicWriteCheckpointFile(
    checkpointContainmentRoot(workspace),
    nativePreCompactReceiptPath(workspace, validated.dedupeKey),
    canonicalCheckpointJson(validated),
    'replace',
  );
  if (result !== 'replaced') throw new Error('checkpoint_internal_failure');
}

export async function readNativePreCompactReceipt(
  workspace: Workspace,
  dedupeKey: string,
): Promise<NativePreCompactReceiptV1 | undefined> {
  await ensureCheckpointStore(workspace);
  const directory = nativePreCompactReceiptDirectory(workspace);
  await ensureCheckpointDirectoryExact(checkpointContainmentRoot(workspace), directory);
  const raw = await readContainedFile(
    checkpointContainmentRoot(workspace),
    nativePreCompactReceiptPath(workspace, dedupeKey),
    1024,
    'checkpoint_native_precompact_receipt_too_large',
  ).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('checkpoint_native_precompact_receipt_invalid'); }
  const receipt = validateNativePreCompactReceipt(parsed);
  if (receipt.dedupeKey !== dedupeKey || raw !== canonicalCheckpointJson(receipt)) {
    throw new Error('checkpoint_native_precompact_receipt_invalid');
  }
  return receipt;
}

// Private adapter discovery surface. Public checkpoint API/schema deliberately remains unchanged.
// Only canonical draft basenames are returned; temp/dot files from interrupted atomic writes stay
// invisible. Directory iteration itself is bounded: every entry consumes the budget, so a directory
// flooded with non-canonical names also fails closed instead of forcing an unbounded readdir allocation.
export async function listCheckpointDraftFiles(workspace: Workspace, limit = 256): Promise<string[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new Error('checkpoint_draft_scan_limit_invalid');
  const paths = await ensureCheckpointStore(workspace);
  let directory: Awaited<ReturnType<typeof fs.opendir>>;
  try {
    directory = await fs.opendir(paths.drafts);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const ids: string[] = [];
  let visited = 0;
  try {
    for await (const entry of directory) {
      visited += 1;
      if (visited > limit) throw new Error('checkpoint_draft_scan_limit_exceeded');
      if (entry.isFile() && CHECKPOINT_DRAFT_BASENAME_RE.test(entry.name)) {
        ids.push(entry.name.slice(0, -'.json'.length));
      }
    }
  } finally {
    await directory.close().catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ERR_DIR_CLOSED') throw error;
    });
  }
  return ids.sort();
}

type PinnedCheckpointArtifactsDirectory = {
  paths: ReturnType<typeof checkpointStorePaths>;
  handle: fs.FileHandle;
  dev: bigint;
  ino: bigint;
  artifactsRealPath: string;
  rootRealPath: string;
};

type CheckpointClaimWorkerPhase =
  | 'after-empty-open-before-write'
  | 'after-write-before-final-check'
  | 'after-claim-verified-before-link'
  | 'after-link-before-final-check'
  | 'after-final-check-before-directory-sync';

type CheckpointClaimWorkerTestOptions = {
  testControlDirectory?: string;
  testPhase?: CheckpointClaimWorkerPhase;
  testFailAfterPhase?: boolean;
  testTimeoutMs?: number;
};

type CheckpointClaimWorkerRequest = {
  operation: 'prepare' | 'link';
  artifactId: string;
  writeClaimId: string;
  canonicalArtifact: string;
  expectedDirectoryDev: string;
  expectedDirectoryIno: string;
  expectedArtifactsRealPath: string;
  expectedRootRealPath: string;
  testControlDirectory?: string;
  testPhase?: CheckpointClaimWorkerPhase;
  testFailAfterPhase?: boolean;
};

type CheckpointClaimGuardSetup = {
  ok: true;
  event: 'guard-ready';
  claimDev: string;
  claimIno: string;
  claimCreated: boolean;
};

const CHECKPOINT_CLAIM_WORKER_TIMEOUT_MS = 20_000;
const CHECKPOINT_CLAIM_WORKER_OUTPUT_MAX_BYTES = 4 * 1024;

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function openPinnedCheckpointArtifactsDirectory(workspace: Workspace): Promise<PinnedCheckpointArtifactsDirectory> {
  const paths = await ensureCheckpointStore(workspace);
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(paths.artifacts, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'ENOTDIR') throw new Error('checkpoint_path_outside_store');
    throw error;
  }
  try {
    const [rootRealPath, artifactsRealPath, handleStat] = await Promise.all([
      fs.realpath(checkpointContainmentRoot(workspace)),
      assertRealPathWithin(checkpointContainmentRoot(workspace), paths.artifacts),
      handle.stat({ bigint: true }),
    ]);
    const realStat = await fs.stat(artifactsRealPath, { bigint: true });
    if (
      !isPathWithin(rootRealPath, artifactsRealPath)
      || !handleStat.isDirectory()
      || !realStat.isDirectory()
      || handleStat.ino !== realStat.ino
      || handleStat.dev !== realStat.dev
    ) throw new Error('checkpoint_path_outside_store');
    return {
      paths,
      handle,
      dev: handleStat.dev,
      ino: handleStat.ino,
      artifactsRealPath,
      rootRealPath,
    };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function assertPinnedCheckpointArtifactsDirectoryCurrent(
  pinned: PinnedCheckpointArtifactsDirectory,
): Promise<void> {
  let real: string;
  let current: Awaited<ReturnType<typeof fs.stat>>;
  let opened: Awaited<ReturnType<fs.FileHandle['stat']>>;
  try {
    [real, current, opened] = await Promise.all([
      fs.realpath(pinned.paths.artifacts),
      fs.stat(pinned.paths.artifacts, { bigint: true }),
      pinned.handle.stat({ bigint: true }),
    ]);
  } catch {
    throw new Error('checkpoint_path_outside_store');
  }
  if (
    real !== pinned.artifactsRealPath
    || !isPathWithin(pinned.rootRealPath, real)
    || !current.isDirectory()
    || !opened.isDirectory()
    || current.dev !== pinned.dev
    || current.ino !== pinned.ino
    || opened.dev !== pinned.dev
    || opened.ino !== pinned.ino
  ) throw new Error('checkpoint_path_outside_store');
}

async function verifyPinnedCheckpointArtifactFile(
  pinned: PinnedCheckpointArtifactsDirectory,
  name: string,
  expected: CheckpointFileIdentity,
  expectedContent: string,
): Promise<void> {
  await assertPinnedCheckpointArtifactsDirectoryCurrent(pinned);
  const file = path.join(pinned.artifactsRealPath, name);
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    throw new Error('checkpoint_artifact_write_claim_invalid');
  }
  try {
    const [opened, current] = await Promise.all([
      handle.stat({ bigint: true }),
      fs.lstat(file, { bigint: true }),
    ]);
    if (
      !opened.isFile()
      || !current.isFile()
      || !sameCheckpointFileIdentity({ dev: opened.dev, ino: opened.ino }, expected)
      || !sameCheckpointFileIdentity({ dev: current.dev, ino: current.ino }, expected)
      || await handle.readFile('utf8') !== expectedContent
    ) throw new Error('checkpoint_artifact_write_claim_invalid');
  } finally {
    await handle.close().catch(() => {});
  }
  await assertPinnedCheckpointArtifactsDirectoryCurrent(pinned);
}

function checkpointClaimWorkerInvocation(mode?: 'guard' | 'reaper'): { command: string; args: string[] } {
  const currentFile = fileURLToPath(import.meta.url);
  const sourceRuntime = currentFile.endsWith('.ts');
  const worker = fileURLToPath(new URL(sourceRuntime ? '../checkpoint-claim-worker.ts' : '../checkpoint-claim-worker.js', import.meta.url));
  return {
    command: process.execPath,
    args: [
      ...(sourceRuntime ? ['--no-warnings', '--experimental-strip-types'] : []),
      worker,
      ...(mode === 'guard' ? ['--guard'] : []),
      ...(mode === 'reaper' ? ['--reaper'] : []),
    ],
  };
}

function parseJsonObjectLine(line: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error('checkpoint_internal_failure');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('checkpoint_internal_failure');
  return parsed as Record<string, unknown>;
}

function childLineReader(child: ChildProcessWithoutNullStreams): () => Promise<string | undefined> {
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  return async () => {
    const next = await iterator.next();
    return next.done ? undefined : next.value;
  };
}

function childCompletion(child: ChildProcessWithoutNullStreams): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
  });
}

function writeChildLine(child: ChildProcessWithoutNullStreams, value: unknown): void {
  if (!child.stdin.writable || child.stdin.destroyed) throw new Error('checkpoint_internal_failure');
  const line = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(line, 'utf8') > CHECKPOINT_FILE_WORKER_INPUT_MAX_BYTES) {
    throw new Error('checkpoint_file_too_large');
  }
  child.stdin.write(line);
}

function parseCheckpointClaimWorkerResponse(
  line: string | undefined,
  stderr: Buffer,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  operation: 'prepare' | 'link',
): {
  result: 'prepared' | 'created' | 'owned' | 'unexpected-existing';
  targetDev: string;
  targetIno: string;
} {
  if (signal !== null || stderr.length !== 0 || line === undefined || Buffer.byteLength(line, 'utf8') > CHECKPOINT_CLAIM_WORKER_OUTPUT_MAX_BYTES) {
    throw new Error('checkpoint_internal_failure');
  }
  const item = parseJsonObjectLine(line);
  if (item.ok === false) {
    if (
      exitCode !== 1
      || Object.keys(item).sort().join(',') !== 'error,ok'
      || typeof item.error !== 'string'
      || !/^checkpoint_[a-z0-9_]+$/.test(item.error)
    ) throw new Error('checkpoint_internal_failure');
    throw new Error(item.error);
  }
  if (
    item.ok !== true
    || exitCode !== 0
    || Object.keys(item).sort().join(',') !== 'ok,result,targetDev,targetIno'
    || typeof item.result !== 'string'
    || typeof item.targetDev !== 'string'
    || typeof item.targetIno !== 'string'
    || !/^[0-9]+$/.test(item.targetDev)
    || !/^[0-9]+$/.test(item.targetIno)
  ) throw new Error('checkpoint_internal_failure');
  if (operation === 'prepare' && item.result === 'prepared') {
    return { result: 'prepared', targetDev: item.targetDev, targetIno: item.targetIno };
  }
  if (operation === 'link' && (item.result === 'created' || item.result === 'owned' || item.result === 'unexpected-existing')) {
    return { result: item.result, targetDev: item.targetDev, targetIno: item.targetIno };
  }
  throw new Error('checkpoint_internal_failure');
}

function parseGuardSetup(line: string | undefined): CheckpointClaimGuardSetup {
  if (line === undefined || Buffer.byteLength(line, 'utf8') > CHECKPOINT_CLAIM_WORKER_OUTPUT_MAX_BYTES) {
    throw new Error('checkpoint_internal_failure');
  }
  const item = parseJsonObjectLine(line);
  if (item.ok === false && typeof item.error === 'string' && /^checkpoint_[a-z0-9_]+$/.test(item.error)) {
    throw new Error(item.error);
  }
  if (
    item.ok !== true
    || item.event !== 'guard-ready'
    || Object.keys(item).sort().join(',') !== 'claimCreated,claimDev,claimIno,event,ok'
    || typeof item.claimDev !== 'string'
    || typeof item.claimIno !== 'string'
    || typeof item.claimCreated !== 'boolean'
    || !/^[0-9]+$/.test(item.claimDev)
    || !/^[0-9]+$/.test(item.claimIno)
  ) throw new Error('checkpoint_internal_failure');
  return item as CheckpointClaimGuardSetup;
}

async function runCheckpointClaimWorker(
  pinned: PinnedCheckpointArtifactsDirectory,
  operation: 'prepare' | 'link',
  artifact: CheckpointArtifactV1,
  writeClaimId: string,
  options?: CheckpointClaimWorkerTestOptions,
): Promise<'prepared' | 'created' | 'owned' | 'unexpected-existing'> {
  const baseRequest: CheckpointClaimWorkerRequest = {
    operation,
    artifactId: artifact.id,
    writeClaimId,
    canonicalArtifact: canonicalCheckpointJson(artifact),
    expectedDirectoryDev: pinned.dev.toString(),
    expectedDirectoryIno: pinned.ino.toString(),
    expectedArtifactsRealPath: pinned.artifactsRealPath,
    expectedRootRealPath: pinned.rootRealPath,
    ...(options?.testControlDirectory && options.testPhase
      ? {
          testControlDirectory: options.testControlDirectory,
          testPhase: options.testPhase,
          ...(options.testFailAfterPhase ? { testFailAfterPhase: true } : {}),
        }
      : {}),
  };
  const reaperInvocation = checkpointClaimWorkerInvocation('reaper');
  const reaper = spawn(reaperInvocation.command, reaperInvocation.args, {
    cwd: pinned.artifactsRealPath,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  reaper.stdin.on('error', () => {});
  const reaperCompletion = childCompletion(reaper);
  const readReaperLine = childLineReader(reaper);
  const reaperStderr: Buffer[] = [];
  let reaperStderrBytes = 0;
  reaper.stderr.on('data', (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    reaperStderrBytes += buffer.length;
    if (reaperStderrBytes <= CHECKPOINT_CLAIM_WORKER_OUTPUT_MAX_BYTES) reaperStderr.push(buffer);
    else reaper.kill('SIGKILL');
  });

  const guardInvocation = checkpointClaimWorkerInvocation('guard');
  const guard = spawn(guardInvocation.command, guardInvocation.args, {
    cwd: pinned.artifactsRealPath,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  guard.stdin.on('error', () => {});
  const guardCompletion = childCompletion(guard);
  const readGuardLine = childLineReader(guard);
  const guardStderr: Buffer[] = [];
  let guardStderrBytes = 0;
  guard.stderr.on('data', (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    guardStderrBytes += buffer.length;
    if (guardStderrBytes <= CHECKPOINT_CLAIM_WORKER_OUTPUT_MAX_BYTES) guardStderr.push(buffer);
  });

  let worker: ChildProcessWithoutNullStreams | undefined;
  let workerCompletion: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  let outputExceeded = false;
  let guardCommitted = false;
  let reaperArmed = false;
  let reaperCommitted = false;
  let discardClaimOnAbort = false;
  try {
    writeChildLine(reaper, baseRequest);
    const reaperReadyLine = await readReaperLine();
    if (reaperReadyLine === undefined) throw new Error('checkpoint_internal_failure');
    const reaperReady = parseJsonObjectLine(reaperReadyLine);
    if (reaperReady.ok !== true || reaperReady.event !== 'reaper-ready' || Object.keys(reaperReady).sort().join(',') !== 'event,ok') {
      throw new Error('checkpoint_internal_failure');
    }

    writeChildLine(guard, baseRequest);
    const setup = parseGuardSetup(await readGuardLine());
    if (operation === 'link' && setup.claimCreated) throw new Error('checkpoint_internal_failure');
    writeChildLine(reaper, {
      command: 'arm',
      claimDev: setup.claimDev,
      claimIno: setup.claimIno,
      claimCreated: setup.claimCreated,
    });
    const armedLine = await readReaperLine();
    if (armedLine === undefined) throw new Error('checkpoint_internal_failure');
    const armed = parseJsonObjectLine(armedLine);
    if (armed.ok !== true || armed.event !== 'armed' || Object.keys(armed).sort().join(',') !== 'event,ok') {
      throw new Error('checkpoint_internal_failure');
    }
    reaperArmed = true;

    const invocation = checkpointClaimWorkerInvocation();
    worker = spawn(invocation.command, invocation.args, {
      cwd: pinned.artifactsRealPath,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    worker.stdin.on('error', () => {});
    workerCompletion = childCompletion(worker);
    const readWorkerLine = childLineReader(worker);
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    worker.stdout.on('data', (chunk: Buffer | string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > CHECKPOINT_CLAIM_WORKER_OUTPUT_MAX_BYTES) {
        outputExceeded = true;
        worker?.kill('SIGKILL');
      }
    });
    worker.stderr.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrBytes += buffer.length;
      if (stderrBytes > CHECKPOINT_CLAIM_WORKER_OUTPUT_MAX_BYTES) {
        outputExceeded = true;
        worker?.kill('SIGKILL');
      } else {
        stderr.push(buffer);
      }
    });
    const timeoutMs = options?.testTimeoutMs ?? CHECKPOINT_CLAIM_WORKER_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > CHECKPOINT_CLAIM_WORKER_TIMEOUT_MS) {
      throw new Error('checkpoint_internal_failure');
    }
    timer = setTimeout(() => {
      timedOut = true;
      worker?.kill('SIGKILL');
    }, timeoutMs);
    writeChildLine(worker, {
      ...baseRequest,
      guardedClaimDev: setup.claimDev,
      guardedClaimIno: setup.claimIno,
      guardedClaimCreated: setup.claimCreated,
    });

    let finalLine: string | undefined;
    while (true) {
      const line = await readWorkerLine();
      if (line === undefined) break;
      const item = parseJsonObjectLine(line);
      if (item.event === 'link-request' && Object.keys(item).join(',') === 'event') {
        if (operation !== 'link') throw new Error('checkpoint_internal_failure');
        writeChildLine(guard, { command: 'link' });
        const guardLine = await readGuardLine();
        if (guardLine === undefined) throw new Error('checkpoint_internal_failure');
        const guardResult = parseJsonObjectLine(guardLine);
        if (
          guardResult.ok !== true
          || guardResult.event !== 'link-result'
          || Object.keys(guardResult).sort().join(',') !== 'event,ok,result'
          || (guardResult.result !== 'created' && guardResult.result !== 'unexpected-existing')
        ) throw new Error('checkpoint_internal_failure');
        writeChildLine(worker, { command: 'link-result', result: guardResult.result });
        continue;
      }
      if (finalLine !== undefined) throw new Error('checkpoint_internal_failure');
      finalLine = line;
    }

    const status = await workerCompletion;
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (timedOut || outputExceeded) throw new Error('checkpoint_internal_failure');
    const workerResult = parseCheckpointClaimWorkerResponse(
      finalLine,
      Buffer.concat(stderr),
      status.exitCode,
      status.signal,
      operation,
    );
    const result = workerResult.result;
    const claimIdentity = { dev: BigInt(setup.claimDev), ino: BigInt(setup.claimIno) };
    const targetIdentity = { dev: BigInt(workerResult.targetDev), ino: BigInt(workerResult.targetIno) };
    if (
      (operation === 'prepare' && (
        result !== 'prepared'
        || !sameCheckpointFileIdentity(targetIdentity, claimIdentity)
      ))
      || (operation === 'link' && (
        result === 'prepared'
        || (result === 'unexpected-existing'
          ? sameCheckpointFileIdentity(targetIdentity, claimIdentity)
          : !sameCheckpointFileIdentity(targetIdentity, claimIdentity))
      ))
    ) throw new Error('checkpoint_internal_failure');

    writeChildLine(reaper, {
      command: 'prepare-commit',
      result,
      targetDev: workerResult.targetDev,
      targetIno: workerResult.targetIno,
    });
    const preparedLine = await readReaperLine();
    if (preparedLine === undefined) throw new Error('checkpoint_internal_failure');
    const prepared = parseJsonObjectLine(preparedLine);
    if (prepared.ok !== true || prepared.event !== 'prepared' || Object.keys(prepared).sort().join(',') !== 'event,ok') {
      throw new Error('checkpoint_internal_failure');
    }
    writeChildLine(guard, {
      command: 'commit',
      result,
      targetDev: workerResult.targetDev,
      targetIno: workerResult.targetIno,
    });
    const committedLine = await readGuardLine();
    if (committedLine === undefined) throw new Error('checkpoint_internal_failure');
    const committed = parseJsonObjectLine(committedLine);
    if (committed.ok !== true || committed.event !== 'committed' || Object.keys(committed).sort().join(',') !== 'event,ok') {
      if (committed.ok === false && typeof committed.error === 'string' && /^checkpoint_[a-z0-9_]+$/.test(committed.error)) {
        throw new Error(committed.error);
      }
      throw new Error('checkpoint_internal_failure');
    }
    guardCommitted = true;
    guard.stdin.end();
    const guardStatus = await guardCompletion;
    if (
      guardStatus.exitCode !== 0
      || guardStatus.signal !== null
      || guardStderrBytes !== 0
      || Buffer.concat(guardStderr).length !== 0
    ) throw new Error('checkpoint_internal_failure');

    const claimName = `.${artifact.id}.claim-${writeClaimId}.tmp`;
    await verifyPinnedCheckpointArtifactFile(pinned, claimName, claimIdentity, baseRequest.canonicalArtifact);
    if (operation === 'link') {
      if (result === 'unexpected-existing') {
        await verifyPinnedCheckpointFile(
          {
            path: pinned.paths.artifacts,
            handle: pinned.handle,
            dev: pinned.dev,
            ino: pinned.ino,
            directoryRealPath: pinned.artifactsRealPath,
            rootRealPath: pinned.rootRealPath,
          },
          `${artifact.id}.json`,
          targetIdentity,
        );
      } else {
        await verifyPinnedCheckpointArtifactFile(
          pinned,
          `${artifact.id}.json`,
          claimIdentity,
          baseRequest.canonicalArtifact,
        );
      }
    }
    try {
      await verifyPinnedCheckpointOwnedAliasSet(
        {
          path: pinned.paths.artifacts,
          handle: pinned.handle,
          dev: pinned.dev,
          ino: pinned.ino,
          directoryRealPath: pinned.artifactsRealPath,
          rootRealPath: pinned.rootRealPath,
        },
        claimIdentity,
        operation === 'prepare' || result === 'unexpected-existing'
          ? [claimName]
          : [claimName, `${artifact.id}.json`],
      );
    } catch (error) {
      discardClaimOnAbort = true;
      throw error;
    }
    writeChildLine(reaper, { command: 'commit' });
    const reaperCommittedLine = await readReaperLine();
    if (reaperCommittedLine === undefined) throw new Error('checkpoint_internal_failure');
    const committedReaper = parseJsonObjectLine(reaperCommittedLine);
    if (
      committedReaper.ok !== true
      || committedReaper.event !== 'committed'
      || Object.keys(committedReaper).sort().join(',') !== 'event,ok'
    ) throw new Error('checkpoint_internal_failure');
    reaperCommitted = true;
    reaper.stdin.end();
    const reaperStatus = await reaperCompletion;
    if (
      reaperStatus.exitCode !== 0
      || reaperStatus.signal !== null
      || reaperStderrBytes !== 0
      || Buffer.concat(reaperStderr).length !== 0
    ) throw new Error('checkpoint_internal_failure');
    return result;
  } catch (error) {
    if (worker && worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL');
    if (workerCompletion) await workerCompletion.catch(() => {});
    let cleanupConfirmed = false;
    if (!reaperCommitted) {
      if (reaper.stdin.writable && !reaper.stdin.destroyed) {
        try { writeChildLine(reaper, { command: discardClaimOnAbort ? 'discard' : 'abort' }); } catch { /* handled by confirmation below */ }
        reaper.stdin.end();
      }
      const abortedLine = await readReaperLine().catch(() => undefined);
      const reaperStatus = await reaperCompletion.catch(() => ({ exitCode: null, signal: null }));
      if (abortedLine !== undefined) {
        const aborted = parseJsonObjectLine(abortedLine);
        cleanupConfirmed = (
          aborted.ok === true
          && aborted.event === 'aborted'
          && Object.keys(aborted).sort().join(',') === 'event,ok'
          && reaperStatus.exitCode === 0
          && reaperStatus.signal === null
          && reaperStderrBytes === 0
          && Buffer.concat(reaperStderr).length === 0
        );
      }
    }
    if (reaperArmed && !cleanupConfirmed) throw new Error('checkpoint_internal_failure');
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (!guardCommitted) {
      if (guard.stdin.writable && !guard.stdin.destroyed) {
        try { writeChildLine(guard, { command: 'abort' }); } catch { /* guard may already have exited */ }
        guard.stdin.end();
      }
      await guardCompletion.catch(() => {});
    }
    if (!reaperCommitted && reaper.exitCode === null && reaper.signalCode === null) reaper.kill('SIGKILL');
  }
}

// A durable private ownership claim is created before the corresponding finalization intent. A sibling
// guardian pins the same artifacts-directory inode before mutation, owns link creation, and does not commit
// until the worker has passed its final checks. Worker SIGKILL, timeout, output failure, or parent-pipe EOF
// therefore triggers identity-checked basename-relative rollback in the original inode, never path fallback.
export async function prepareCheckpointArtifactWriteClaimUnlocked(
  workspace: Workspace,
  artifact: CheckpointArtifactV1,
  writeClaimId: string,
  options?: CheckpointClaimWorkerTestOptions,
): Promise<void> {
  validateCheckpointArtifact(artifact);
  artifactWriteClaimPath(workspace, artifact.id, writeClaimId);
  const pinned = await openPinnedCheckpointArtifactsDirectory(workspace);
  try {
    const result = await runCheckpointClaimWorker(pinned, 'prepare', artifact, writeClaimId, options);
    if (result !== 'prepared') throw new Error('checkpoint_internal_failure');
  } finally {
    await pinned.handle.close().catch(() => {});
  }
}

export async function linkCheckpointArtifactWriteClaimUnlocked(
  workspace: Workspace,
  artifact: CheckpointArtifactV1,
  writeClaimId: string,
  options?: CheckpointClaimWorkerTestOptions,
): Promise<'created' | 'owned' | 'unexpected-existing'> {
  validateCheckpointArtifact(artifact);
  artifactWriteClaimPath(workspace, artifact.id, writeClaimId);
  const pinned = await openPinnedCheckpointArtifactsDirectory(workspace);
  try {
    const result = await runCheckpointClaimWorker(pinned, 'link', artifact, writeClaimId, options);
    if (result === 'prepared') throw new Error('checkpoint_internal_failure');
    return result;
  } finally {
    await pinned.handle.close().catch(() => {});
  }
}

export async function removeCheckpointArtifactWriteClaimUnlocked(
  workspace: Workspace,
  artifactId: string,
  writeClaimId: string,
): Promise<void> {
  // Successful claims intentionally remain as private dot-prefixed hardlink receipts. Retaining the
  // receipt closes the final path-based cleanup TOCTOU entirely, costs no additional artifact data
  // blocks, and keeps recovery provenance durable. Validate identifiers for callers, but do no I/O.
  artifactWriteClaimPath(workspace, artifactId, writeClaimId);
}

// Immutable artifact persistence: a same-directory temporary file is fully written, then linked into the
// content-addressed final name. link(2) is atomic and never replaces an existing target, unlike rename on
// POSIX. The temporary is always removed. Existing content is verified by the caller before dedup is claimed.
export async function writeCheckpointArtifactNewUnlocked(
  workspace: Workspace,
  artifact: CheckpointArtifactV1,
  options?: CheckpointFileWorkerTestOptions,
): Promise<'created' | 'exists'> {
  validateCheckpointArtifact(artifact);
  const paths = await ensureCheckpointStore(workspace);
  const finalPath = artifactPath(workspace, artifact.id);
  const result = await atomicWriteCheckpointFile(
    checkpointContainmentRoot(workspace),
    finalPath,
    canonicalCheckpointJson(artifact),
    'create',
    options,
  );
  if (result === 'created' || result === 'exists') return result;
  throw new Error('checkpoint_internal_failure');
}

export async function readCheckpointArtifactUnlocked(workspace: Workspace, artifactId: string): Promise<{ artifact: CheckpointArtifactV1; raw: string; sizeBytes: number }> {
  const paths = await ensureCheckpointStore(workspace);
  const file = artifactPath(workspace, artifactId);
  const raw = await readContainedFile(checkpointContainmentRoot(workspace), file, CHECKPOINT_ARTIFACT_MAX_BYTES, 'checkpoint_artifact_too_large').catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('checkpoint_artifact_not_found');
    throw error;
  });
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('checkpoint_artifact_schema_invalid'); }
  const artifact = validateCheckpointArtifact(parsed);
  if (artifact.id !== artifactId) throw new Error('checkpoint_integrity_filename_mismatch');
  if (raw !== canonicalCheckpointJson(artifact)) throw new Error('checkpoint_artifact_noncanonical');
  return { artifact, raw, sizeBytes: Buffer.byteLength(raw, 'utf8') };
}

export async function listCheckpointArtifactFiles(workspace: Workspace): Promise<string[]> {
  const paths = await ensureCheckpointStore(workspace);
  const entries = await fs.readdir(paths.artifacts, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  // Dot-prefixed and *.tmp files are deliberately ignored: a process killed before the atomic link may
  // leave a torn temp, but it can never become a readable/listed checkpoint.
  return entries
    .filter((entry) => entry.isFile() && /^cp_[a-f0-9]{64}\.json$/.test(entry.name))
    .map((entry) => entry.name.slice(0, -'.json'.length))
    .sort();
}

const AUDIT_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const AUDIT_REASON_RE = /^checkpoint_[a-z0-9_]{1,116}$/;
const AUDIT_SECRET_MARKER_RE = /(?:api_?key|access_?token|auth_?token|private_?key|password|passwd|client_?secret|bearer)/i;
const AUDIT_OPERATIONS = new Set<CheckpointAuditEvent['operation']>([
  'draft.create',
  'draft.update',
  'artifact.finalize',
  'artifact.read',
  'artifact.inspect',
  'artifact.list',
]);

function hasExactAuditKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key));
}

function validAuditAt(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function safeAuditString(value: unknown): value is string {
  return typeof value === 'string' && !containsSecretLikeContent(value);
}

function validateCheckpointAuditEvent(value: unknown): CheckpointAuditEvent | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (
    item.schemaVersion !== 1
    || typeof item.id !== 'string'
    || !AUDIT_ID_RE.test(item.id)
    || !validAuditAt(item.at)
    || !safeAuditString(item.type)
    || !safeAuditString(item.operation)
    || !AUDIT_OPERATIONS.has(item.operation as CheckpointAuditEvent['operation'])
  ) return undefined;

  const common = ['schemaVersion', 'id', 'at', 'type', 'operation'];
  if (item.type === 'checkpoint.draft.created' || item.type === 'checkpoint.draft.updated') {
    const expectedOperation = item.type === 'checkpoint.draft.created' ? 'draft.create' : 'draft.update';
    if (!hasExactAuditKeys(item, [...common, 'draftId']) || item.operation !== expectedOperation) return undefined;
    if (typeof item.draftId !== 'string' || !/^draft_[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(item.draftId)) return undefined;
    return {
      schemaVersion: 1,
      id: item.id,
      at: item.at,
      type: item.type,
      operation: expectedOperation,
      draftId: item.draftId,
    };
  }

  if (item.type === 'checkpoint.artifact.created' || item.type === 'checkpoint.artifact.deduplicated') {
    if (!hasExactAuditKeys(item, [...common, 'draftId', 'artifactId'], ['supersedes']) || item.operation !== 'artifact.finalize') return undefined;
    if (typeof item.draftId !== 'string' || !/^draft_[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(item.draftId)) return undefined;
    if (typeof item.artifactId !== 'string' || !/^cp_[a-f0-9]{64}$/.test(item.artifactId)) return undefined;
    if (item.supersedes !== undefined && (typeof item.supersedes !== 'string' || !/^cp_[a-f0-9]{64}$/.test(item.supersedes))) return undefined;
    return {
      schemaVersion: 1,
      id: item.id,
      at: item.at,
      type: item.type,
      operation: 'artifact.finalize',
      draftId: item.draftId,
      artifactId: item.artifactId,
      ...(typeof item.supersedes === 'string' ? { supersedes: item.supersedes } : {}),
    };
  }

  if (item.type === 'checkpoint.rejected') {
    if (!hasExactAuditKeys(item, [...common, 'reasonCode'])) return undefined;
    if (
      typeof item.reasonCode !== 'string'
      || !AUDIT_REASON_RE.test(item.reasonCode)
      || AUDIT_SECRET_MARKER_RE.test(item.reasonCode)
      || containsSecretLikeContent(item.reasonCode)
    ) return undefined;
    return {
      schemaVersion: 1,
      id: item.id,
      at: item.at,
      type: 'checkpoint.rejected',
      operation: item.operation as CheckpointAuditEvent['operation'],
      reasonCode: item.reasonCode,
    };
  }
  return undefined;
}

const CHECKPOINT_AUDIT_V2_CURRENT_MAX_BYTES = 256;
const CHECKPOINT_AUDIT_V2_CONTROL_MAX_BYTES = 16 * 1024;
const CHECKPOINT_AUDIT_V2_OUTCOME_MAX_BYTES = 4 * 1024;
const CHECKPOINT_AUDIT_V2_PUBLICATION_MAX_BYTES = 4 * 1024;
const CHECKPOINT_AUDIT_V2_RECORD_MAX_BYTES = 4 * 1024;
export const CHECKPOINT_AUDIT_V2_SEGMENT_MAX_BYTES = 512 * 1024;
export const CHECKPOINT_AUDIT_V2_SEGMENT_RECORDS = 512;
const CHECKPOINT_AUDIT_V2_SEGMENTS_PER_BLOCK = 1024;
export const CHECKPOINT_AUDIT_V2_MIGRATION_MAX_BYTES = 1024 * 1024;
export const CHECKPOINT_AUDIT_PAGE_DEFAULT_LIMIT = 100;
export const CHECKPOINT_AUDIT_PAGE_MAX_LIMIT = 512;
export const CHECKPOINT_AUDIT_COMPAT_MAX_EVENTS = 4096;

type CheckpointAuditCatalogEventRecordV2 = {
  schemaVersion: 2;
  sequence: number;
  previousRecordSha256: string | null;
  kind: 'event';
  event: CheckpointAuditEvent;
};

type CheckpointAuditCatalogFinalizationRecordV2 = {
  schemaVersion: 2;
  sequence: number;
  previousRecordSha256: string | null;
  kind: 'finalization-ref';
  draftId: string;
  eventId: string;
  outcomeSha256: string;
};

type CheckpointAuditCatalogRecordV2 = CheckpointAuditCatalogEventRecordV2 | CheckpointAuditCatalogFinalizationRecordV2;

type CheckpointAuditStateV2 = {
  schemaVersion: 2;
  nextSequence: number;
  headRecordSha256: string | null;
};

type CheckpointAuditPendingV2 =
  | { schemaVersion: 2; status: 'empty' }
  | {
      schemaVersion: 2;
      status: 'active';
      sequence: number;
      previousHeadRecordSha256: string | null;
      record: CheckpointAuditCatalogRecordV2;
    };

type CheckpointAuditOutcomeV2 = {
  schemaVersion: 2;
  draftId: string;
  event: CheckpointAuditEvent;
};

type CheckpointAuditPublicationV2 = {
  schemaVersion: 2;
  draftId: string;
  eventId: string;
  outcomeSha256: string;
  sequence: number;
  segmentId: number;
  recordIndex: number;
  recordSha256: string;
  segmentPrefixSha256: string;
};

type CheckpointAuditConflictV2 = {
  schemaVersion: 2;
  draftId: string;
  expectedOutcomeSha256: string;
  observedOutcomeSha256: string;
};

export type CheckpointAuditPage = {
  events: CheckpointAuditEvent[];
  nextCursor?: string;
};

export type CheckpointAuditV2FaultPhase =
  | 'before-outcome'
  | 'after-outcome'
  | 'after-pending'
  | 'after-segment'
  | 'after-state'
  | 'after-publication'
  | 'before-marker';

export type CheckpointAuditV2TestOptions = CheckpointFileWorkerTestOptions & {
  testAuditFailPhase?: CheckpointAuditV2FaultPhase;
};

const AUDIT_V2_CURRENT = { schemaVersion: 2, format: 'checkpoint-audit-v2' } as const;
const AUDIT_V2_EMPTY_PENDING: CheckpointAuditPendingV2 = { schemaVersion: 2, status: 'empty' };
const AUDIT_V2_EMPTY_STATE: CheckpointAuditStateV2 = { schemaVersion: 2, nextSequence: 0, headRecordSha256: null };

function auditSha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function auditFault(options: CheckpointAuditV2TestOptions | undefined, phase: CheckpointAuditV2FaultPhase): void {
  if (options?.testAuditFailPhase === phase || process.env.IHOW_CHECKPOINT_AUDIT_TEST_FAIL_PHASE === phase) {
    throw new Error('checkpoint_internal_failure');
  }
}

export function checkpointAuditV2MarkerFaultPoint(): void {
  auditFault(undefined, 'before-marker');
}

function auditRecordSha256(record: CheckpointAuditCatalogRecordV2): string {
  return auditSha256(canonicalCheckpointJson(record));
}

function auditSegmentPrefixSha256(records: readonly CheckpointAuditCatalogRecordV2[], endInclusive: number): string {
  return auditSha256(`${records.slice(0, endInclusive + 1).map((record) => canonicalCheckpointJson(record)).join('\n')}\n`);
}

function isFinalizationAuditEvent(event: CheckpointAuditEvent): event is CheckpointAuditEvent & {
  type: 'checkpoint.artifact.created' | 'checkpoint.artifact.deduplicated';
  operation: 'artifact.finalize';
  draftId: string;
  artifactId: string;
} {
  return (
    event.operation === 'artifact.finalize'
    && (event.type === 'checkpoint.artifact.created' || event.type === 'checkpoint.artifact.deduplicated')
    && typeof event.draftId === 'string'
    && typeof event.artifactId === 'string'
  );
}

function sameFinalizationOutcome(
  event: CheckpointAuditEvent,
  expected: Pick<CheckpointAuditEvent, 'type' | 'artifactId' | 'supersedes'>,
): boolean {
  return (
    isFinalizationAuditEvent(event)
    && event.type === expected.type
    && event.artifactId === expected.artifactId
    && event.supersedes === expected.supersedes
  );
}

function validateAuditV2Current(value: unknown): void {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value as Record<string, unknown>).sort().join(',') !== 'format,schemaVersion'
    || (value as Record<string, unknown>).schemaVersion !== 2
    || (value as Record<string, unknown>).format !== 'checkpoint-audit-v2'
  ) throw new Error('checkpoint_audit_state_invalid');
}

function validateAuditState(value: unknown): CheckpointAuditStateV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('checkpoint_audit_state_invalid');
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).sort().join(',') !== 'headRecordSha256,nextSequence,schemaVersion'
    || item.schemaVersion !== 2
    || !Number.isSafeInteger(item.nextSequence)
    || (item.nextSequence as number) < 0
    || (item.headRecordSha256 !== null && (typeof item.headRecordSha256 !== 'string' || !CHECKPOINT_SHA256_RE.test(item.headRecordSha256)))
    || ((item.nextSequence as number) === 0) !== (item.headRecordSha256 === null)
  ) throw new Error('checkpoint_audit_state_invalid');
  return item as CheckpointAuditStateV2;
}

function validateAuditCatalogRecord(value: unknown): CheckpointAuditCatalogRecordV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('checkpoint_audit_segment_invalid');
  const item = value as Record<string, unknown>;
  const commonValid = (
    item.schemaVersion === 2
    && Number.isSafeInteger(item.sequence)
    && (item.sequence as number) >= 0
    && (item.previousRecordSha256 === null || (typeof item.previousRecordSha256 === 'string' && CHECKPOINT_SHA256_RE.test(item.previousRecordSha256)))
  );
  if (!commonValid) throw new Error('checkpoint_audit_segment_invalid');
  if (item.kind === 'event') {
    if (Object.keys(item).sort().join(',') !== 'event,kind,previousRecordSha256,schemaVersion,sequence') {
      throw new Error('checkpoint_audit_segment_invalid');
    }
    const event = validateCheckpointAuditEvent(item.event);
    if (!event || isFinalizationAuditEvent(event)) throw new Error('checkpoint_audit_segment_invalid');
    const record: CheckpointAuditCatalogEventRecordV2 = {
      schemaVersion: 2,
      sequence: item.sequence as number,
      previousRecordSha256: item.previousRecordSha256 as string | null,
      kind: 'event',
      event,
    };
    if (Buffer.byteLength(canonicalCheckpointJson(record), 'utf8') > CHECKPOINT_AUDIT_V2_RECORD_MAX_BYTES) {
      throw new Error('checkpoint_audit_segment_invalid');
    }
    return record;
  }
  if (item.kind === 'finalization-ref') {
    if (Object.keys(item).sort().join(',') !== 'draftId,eventId,kind,outcomeSha256,previousRecordSha256,schemaVersion,sequence') {
      throw new Error('checkpoint_audit_segment_invalid');
    }
    if (
      typeof item.draftId !== 'string'
      || !CHECKPOINT_DRAFT_BASENAME_RE.test(`${item.draftId}.json`)
      || typeof item.eventId !== 'string'
      || !AUDIT_ID_RE.test(item.eventId)
      || typeof item.outcomeSha256 !== 'string'
      || !CHECKPOINT_SHA256_RE.test(item.outcomeSha256)
    ) throw new Error('checkpoint_audit_segment_invalid');
    return item as CheckpointAuditCatalogFinalizationRecordV2;
  }
  throw new Error('checkpoint_audit_segment_invalid');
}

function validateAuditPending(value: unknown): CheckpointAuditPendingV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('checkpoint_audit_pending_invalid');
  const item = value as Record<string, unknown>;
  if (item.status === 'empty') {
    if (Object.keys(item).sort().join(',') !== 'schemaVersion,status' || item.schemaVersion !== 2) {
      throw new Error('checkpoint_audit_pending_invalid');
    }
    return AUDIT_V2_EMPTY_PENDING;
  }
  if (
    item.status !== 'active'
    || Object.keys(item).sort().join(',') !== 'previousHeadRecordSha256,record,schemaVersion,sequence,status'
    || item.schemaVersion !== 2
    || !Number.isSafeInteger(item.sequence)
    || (item.sequence as number) < 0
    || (item.previousHeadRecordSha256 !== null
      && (typeof item.previousHeadRecordSha256 !== 'string' || !CHECKPOINT_SHA256_RE.test(item.previousHeadRecordSha256)))
  ) throw new Error('checkpoint_audit_pending_invalid');
  const record = validateAuditCatalogRecord(item.record);
  if (record.sequence !== item.sequence || record.previousRecordSha256 !== item.previousHeadRecordSha256) {
    throw new Error('checkpoint_audit_pending_invalid');
  }
  const pending: CheckpointAuditPendingV2 = {
    schemaVersion: 2,
    status: 'active',
    sequence: item.sequence as number,
    previousHeadRecordSha256: item.previousHeadRecordSha256 as string | null,
    record,
  };
  if (Buffer.byteLength(canonicalCheckpointJson(pending), 'utf8') > CHECKPOINT_AUDIT_V2_CONTROL_MAX_BYTES) {
    throw new Error('checkpoint_audit_pending_invalid');
  }
  return pending;
}

function validateAuditOutcome(value: unknown, draftId: string): CheckpointAuditOutcomeV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('checkpoint_finalization_audit_outcome_mismatch');
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).sort().join(',') !== 'draftId,event,schemaVersion'
    || item.schemaVersion !== 2
    || item.draftId !== draftId
  ) throw new Error('checkpoint_finalization_audit_outcome_mismatch');
  const event = validateCheckpointAuditEvent(item.event);
  if (!event || !isFinalizationAuditEvent(event) || event.draftId !== draftId) {
    throw new Error('checkpoint_finalization_audit_outcome_mismatch');
  }
  return { schemaVersion: 2, draftId, event };
}

function validateAuditPublication(value: unknown, draftId: string): CheckpointAuditPublicationV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('checkpoint_audit_publication_invalid');
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).sort().join(',') !== 'draftId,eventId,outcomeSha256,recordIndex,recordSha256,schemaVersion,segmentId,segmentPrefixSha256,sequence'
    || item.schemaVersion !== 2
    || item.draftId !== draftId
    || typeof item.eventId !== 'string'
    || !AUDIT_ID_RE.test(item.eventId)
    || typeof item.outcomeSha256 !== 'string'
    || !CHECKPOINT_SHA256_RE.test(item.outcomeSha256)
    || !Number.isSafeInteger(item.sequence)
    || (item.sequence as number) < 0
    || !Number.isSafeInteger(item.segmentId)
    || (item.segmentId as number) < 0
    || !Number.isSafeInteger(item.recordIndex)
    || (item.recordIndex as number) < 0
    || (item.recordIndex as number) >= CHECKPOINT_AUDIT_V2_SEGMENT_RECORDS
    || typeof item.recordSha256 !== 'string'
    || !CHECKPOINT_SHA256_RE.test(item.recordSha256)
    || typeof item.segmentPrefixSha256 !== 'string'
    || !CHECKPOINT_SHA256_RE.test(item.segmentPrefixSha256)
    || Math.floor((item.sequence as number) / CHECKPOINT_AUDIT_V2_SEGMENT_RECORDS) !== item.segmentId
    || (item.sequence as number) % CHECKPOINT_AUDIT_V2_SEGMENT_RECORDS !== item.recordIndex
  ) throw new Error('checkpoint_audit_publication_invalid');
  return item as CheckpointAuditPublicationV2;
}

function validateAuditConflict(value: unknown, draftId: string): CheckpointAuditConflictV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('checkpoint_audit_conflict_invalid');
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).sort().join(',') !== 'draftId,expectedOutcomeSha256,observedOutcomeSha256,schemaVersion'
    || item.schemaVersion !== 2
    || item.draftId !== draftId
    || typeof item.expectedOutcomeSha256 !== 'string'
    || !CHECKPOINT_SHA256_RE.test(item.expectedOutcomeSha256)
    || typeof item.observedOutcomeSha256 !== 'string'
    || !CHECKPOINT_SHA256_RE.test(item.observedOutcomeSha256)
  ) throw new Error('checkpoint_audit_conflict_invalid');
  return item as CheckpointAuditConflictV2;
}

async function ensureAuditV2BaseDirectories(workspace: Workspace): Promise<ReturnType<typeof checkpointAuditV2Paths>> {
  await ensureCheckpointStore(workspace);
  const paths = checkpointAuditV2Paths(workspace);
  const root = checkpointContainmentRoot(workspace);
  await ensureCheckpointDirectoryExact(root, paths.root);
  await ensureCheckpointDirectoryExact(root, paths.control);
  await ensureCheckpointDirectoryExact(root, paths.segments);
  await ensureCheckpointDirectoryExact(root, paths.finalizations);
  return paths;
}

function auditSegmentLocation(workspace: Workspace, segmentId: number): {
  first: string;
  second: string;
  block: string;
  file: string;
} {
  if (!Number.isSafeInteger(segmentId) || segmentId < 0) throw new Error('checkpoint_audit_segment_invalid');
  const paths = checkpointAuditV2Paths(workspace);
  const segmentHex = segmentId.toString(16).padStart(16, '0');
  const blockId = Math.floor(segmentId / CHECKPOINT_AUDIT_V2_SEGMENTS_PER_BLOCK);
  const blockHex = blockId.toString(16).padStart(16, '0');
  const first = path.join(paths.segments, blockHex.slice(0, 2));
  const second = path.join(first, blockHex.slice(2, 4));
  const block = path.join(second, `block-${blockHex}`);
  return { first, second, block, file: path.join(block, `segment-${segmentHex}.ndjson`) };
}

async function ensureAuditSegmentWriteDirectory(workspace: Workspace, segmentId: number): Promise<string> {
  const location = auditSegmentLocation(workspace, segmentId);
  const root = checkpointContainmentRoot(workspace);
  await ensureCheckpointDirectoryExact(root, location.first);
  await ensureCheckpointDirectoryExact(root, location.second);
  await ensureCheckpointDirectoryExact(root, location.block);
  return location.file;
}

async function assertAuditSegmentReadDirectory(workspace: Workspace, segmentId: number): Promise<string> {
  const location = auditSegmentLocation(workspace, segmentId);
  const root = checkpointContainmentRoot(workspace);
  await assertCheckpointDirectoryExact(root, location.first);
  await assertCheckpointDirectoryExact(root, location.second);
  await assertCheckpointDirectoryExact(root, location.block);
  return location.file;
}

function auditFinalizationLocation(workspace: Workspace, draftId: string): {
  first: string;
  second: string;
  third: string;
  directory: string;
  outcome: string;
  catalog: string;
  publication: string;
  conflict: string;
} {
  if (!CHECKPOINT_DRAFT_BASENAME_RE.test(`${draftId}.json`)) throw new Error('checkpoint_draft_id_invalid');
  const paths = checkpointAuditV2Paths(workspace);
  const bucket = auditSha256(draftId);
  const first = path.join(paths.finalizations, bucket.slice(0, 2));
  const second = path.join(first, bucket.slice(2, 4));
  const third = path.join(second, bucket.slice(4, 6));
  const directory = path.join(third, draftId);
  return {
    first,
    second,
    third,
    directory,
    outcome: path.join(directory, 'outcome.json'),
    catalog: path.join(directory, 'catalog.json'),
    publication: path.join(directory, 'publication.json'),
    conflict: path.join(directory, 'conflict.json'),
  };
}

async function ensureAuditFinalizationWriteDirectory(workspace: Workspace, draftId: string): Promise<ReturnType<typeof auditFinalizationLocation>> {
  const location = auditFinalizationLocation(workspace, draftId);
  const root = checkpointContainmentRoot(workspace);
  await ensureCheckpointDirectoryExact(root, location.first);
  await ensureCheckpointDirectoryExact(root, location.second);
  await ensureCheckpointDirectoryExact(root, location.third);
  await ensureCheckpointDirectoryExact(root, location.directory);
  return location;
}

async function auditFinalizationReadLocation(
  workspace: Workspace,
  draftId: string,
): Promise<ReturnType<typeof auditFinalizationLocation> | undefined> {
  const location = auditFinalizationLocation(workspace, draftId);
  try {
    await fs.lstat(location.directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const root = checkpointContainmentRoot(workspace);
  await assertCheckpointDirectoryExact(root, location.first);
  await assertCheckpointDirectoryExact(root, location.second);
  await assertCheckpointDirectoryExact(root, location.third);
  await assertCheckpointDirectoryExact(root, location.directory);
  return location;
}

async function readCanonicalAuditJson(
  workspace: Workspace,
  file: string,
  maxBytes: number,
  invalidCode: string,
): Promise<unknown | undefined> {
  const raw = await readContainedFile(checkpointContainmentRoot(workspace), file, maxBytes, invalidCode).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error(invalidCode); }
  if (raw !== canonicalCheckpointJson(parsed)) throw new Error(invalidCode);
  return parsed;
}

async function writeImmutableAuditFile(
  workspace: Workspace,
  file: string,
  content: string,
  invalidCode: string,
  options?: CheckpointFileWorkerTestOptions,
): Promise<void> {
  const result = await atomicWriteCheckpointFile(checkpointContainmentRoot(workspace), file, content, 'create', options);
  if (result === 'created') return;
  if (result !== 'exists') throw new Error('checkpoint_internal_failure');
  const existing = await readContainedFile(checkpointContainmentRoot(workspace), file, Buffer.byteLength(content, 'utf8'), invalidCode);
  if (existing !== content) throw new Error(invalidCode);
}

async function writeAuditControlFile(
  workspace: Workspace,
  file: string,
  value: CheckpointAuditStateV2 | CheckpointAuditPendingV2,
  options?: CheckpointFileWorkerTestOptions,
): Promise<void> {
  const content = canonicalCheckpointJson(value);
  if (Buffer.byteLength(content, 'utf8') > CHECKPOINT_AUDIT_V2_CONTROL_MAX_BYTES) {
    throw new Error('checkpoint_audit_state_invalid');
  }
  const result = await atomicWriteCheckpointFile(checkpointContainmentRoot(workspace), file, content, 'replace', options);
  if (result !== 'replaced') throw new Error('checkpoint_internal_failure');
}

async function readAuditSegmentFile(
  workspace: Workspace,
  segmentId: number,
  allowMissing = false,
): Promise<CheckpointAuditCatalogRecordV2[] | undefined> {
  let file: string;
  try {
    file = await assertAuditSegmentReadDirectory(workspace, segmentId);
  } catch (error) {
    if (allowMissing && error instanceof Error && error.message === 'checkpoint_audit_state_invalid') return undefined;
    throw error;
  }
  const raw = await readContainedFile(
    checkpointContainmentRoot(workspace),
    file,
    CHECKPOINT_AUDIT_V2_SEGMENT_MAX_BYTES,
    'checkpoint_audit_segment_invalid',
  ).catch((error: unknown) => {
    if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (raw === undefined) return undefined;
  if (!raw.endsWith('\n')) throw new Error('checkpoint_audit_segment_invalid');
  const lines = raw.slice(0, -1).split('\n');
  if (lines.length < 1 || lines.length > CHECKPOINT_AUDIT_V2_SEGMENT_RECORDS) throw new Error('checkpoint_audit_segment_invalid');
  const records: CheckpointAuditCatalogRecordV2[] = [];
  const firstSequence = segmentId * CHECKPOINT_AUDIT_V2_SEGMENT_RECORDS;
  for (let index = 0; index < lines.length; index += 1) {
    let parsed: unknown;
    try { parsed = JSON.parse(lines[index]); } catch { throw new Error('checkpoint_audit_segment_invalid'); }
    const record = validateAuditCatalogRecord(parsed);
    if (lines[index] !== canonicalCheckpointJson(record) || record.sequence !== firstSequence + index) {
      throw new Error('checkpoint_audit_segment_invalid');
    }
    if (index > 0 && record.previousRecordSha256 !== auditRecordSha256(records[index - 1])) {
      throw new Error('checkpoint_audit_segment_invalid');
    }
    records.push(record);
  }
  if (segmentId === 0) {
    if (records[0].previousRecordSha256 !== null) throw new Error('checkpoint_audit_segment_invalid');
  }
  return records;
}

async function readAuditSegment(
  workspace: Workspace,
  segmentId: number,
  allowMissing = false,
): Promise<CheckpointAuditCatalogRecordV2[] | undefined> {
  const records = await readAuditSegmentFile(workspace, segmentId, allowMissing);
  if (!records) return undefined;

  // Validate both adjacent boundaries with direct, non-recursive reads. This keeps every segment read
  // bounded to at most three segment files while preventing an old paged segment from being accepted
  // after its tail is changed without updating the next segment's first-record back-pointer.
  if (segmentId > 0) {
    const previous = await readAuditSegmentFile(workspace, segmentId - 1);
    if (
      !previous
      || previous.length !== CHECKPOINT_AUDIT_V2_SEGMENT_RECORDS
      || records[0].previousRecordSha256 !== auditRecordSha256(previous.at(-1)!)
    ) throw new Error('checkpoint_audit_segment_invalid');
  }
  const next = await readAuditSegmentFile(workspace, segmentId + 1, true);
  if (next && (
    records.length !== CHECKPOINT_AUDIT_V2_SEGMENT_RECORDS
    || next[0].previousRecordSha256 !== auditRecordSha256(records.at(-1)!)
  )) throw new Error('checkpoint_audit_segment_invalid');
  return records;
}

async function readAuditState(workspace: Workspace, allowPendingRecord = false): Promise<CheckpointAuditStateV2> {
  const paths = checkpointAuditV2Paths(workspace);
  const value = await readCanonicalAuditJson(workspace, paths.state, CHECKPOINT_AUDIT_V2_CONTROL_MAX_BYTES, 'checkpoint_audit_state_invalid');
  if (value === undefined) throw new Error('checkpoint_audit_state_invalid');
  const state = validateAuditState(value);
  if (state.nextSequence === 0) {
    const first = await readAuditSegment(workspace, 0, true);
    if ((!allowPendingRecord && first !== undefined) || (allowPendingRecord && first && first.length > 1)) {
      throw new Error('checkpoint_audit_state_invalid');
    }
  } else {
    const lastSequence = state.nextSequence - 1;
    const segmentId = Math.floor(lastSequence / CHECKPOINT_AUDIT_V2_SEGMENT_RECORDS);
    const recordIndex = lastSequence % CHECKPOINT_AUDIT_V2_SEGMENT_RECORDS;
    const segment = await readAuditSegment(workspace, segmentId);
    const record = segment?.[recordIndex];
    const maximumLength = recordIndex + 1 + (allowPendingRecord ? 1 : 0);
    if (
      !record
      || auditRecordSha256(record) !== state.headRecordSha256
      || !segment
      || segment.length < recordIndex + 1
      || segment.length > maximumLength
    ) throw new Error('checkpoint_audit_state_invalid');
    if (recordIndex === CHECKPOINT_AUDIT_V2_SEGMENT_RECORDS - 1) {
      const next = await readAuditSegment(workspace, segmentId + 1, true);
      if ((!allowPendingRecord && next !== undefined) || (allowPendingRecord && next && next.length > 1)) {
        throw new Error('checkpoint_audit_state_invalid');
      }
    }
  }
  return state;
}

async function readAuditPending(workspace: Workspace): Promise<CheckpointAuditPendingV2> {
  const paths = checkpointAuditV2Paths(workspace);
  const value = await readCanonicalAuditJson(workspace, paths.pending, CHECKPOINT_AUDIT_V2_CONTROL_MAX_BYTES, 'checkpoint_audit_pending_invalid');
  if (value === undefined) throw new Error('checkpoint_audit_pending_invalid');
  return validateAuditPending(value);
}

async function readAuditOutcomeFile(
  workspace: Workspace,
  draftId: string,
): Promise<{ outcome: CheckpointAuditOutcomeV2; raw: string; sha256: string; location: ReturnType<typeof auditFinalizationLocation> } | undefined> {
  const location = await auditFinalizationReadLocation(workspace, draftId);
  if (!location) return undefined;
  const conflictValue = await readCanonicalAuditJson(
    workspace,
    location.conflict,
    CHECKPOINT_AUDIT_V2_OUTCOME_MAX_BYTES,
    'checkpoint_audit_conflict_invalid',
  );
  if (conflictValue !== undefined) {
    validateAuditConflict(conflictValue, draftId);
    throw new Error('checkpoint_finalization_audit_outcome_mismatch');
  }
  const value = await readCanonicalAuditJson(
    workspace,
    location.outcome,
    CHECKPOINT_AUDIT_V2_OUTCOME_MAX_BYTES,
    'checkpoint_finalization_audit_outcome_mismatch',
  );
  if (value === undefined) {
    const [catalog, publication] = await Promise.all([
      readCanonicalAuditJson(
        workspace,
        location.catalog,
        CHECKPOINT_AUDIT_V2_PUBLICATION_MAX_BYTES,
        'checkpoint_audit_publication_invalid',
      ),
      readCanonicalAuditJson(
        workspace,
        location.publication,
        CHECKPOINT_AUDIT_V2_PUBLICATION_MAX_BYTES,
        'checkpoint_audit_publication_invalid',
      ),
    ]);
    if (catalog !== undefined || publication !== undefined) throw new Error('checkpoint_finalization_audit_outcome_mismatch');
    return undefined;
  }
  const outcome = validateAuditOutcome(value, draftId);
  const raw = canonicalCheckpointJson(outcome);
  return { outcome, raw, sha256: auditSha256(raw), location };
}

async function writeAuditConflict(
  workspace: Workspace,
  draftId: string,
  expectedOutcomeSha256: string,
  observedOutcomeSha256: string,
): Promise<void> {
  const location = await ensureAuditFinalizationWriteDirectory(workspace, draftId);
  const conflict: CheckpointAuditConflictV2 = {
    schemaVersion: 2,
    draftId,
    expectedOutcomeSha256,
    observedOutcomeSha256,
  };
  await writeImmutableAuditFile(
    workspace,
    location.conflict,
    canonicalCheckpointJson(conflict),
    'checkpoint_audit_conflict_invalid',
  ).catch(() => {});
}

async function writeAuditOutcomeImmutable(
  workspace: Workspace,
  event: CheckpointAuditEvent,
  options?: CheckpointFileWorkerTestOptions,
): Promise<{ outcome: CheckpointAuditOutcomeV2; raw: string; sha256: string; location: ReturnType<typeof auditFinalizationLocation> }> {
  if (!isFinalizationAuditEvent(event)) throw new Error('checkpoint_audit_schema_invalid');
  const location = await ensureAuditFinalizationWriteDirectory(workspace, event.draftId);
  const outcome: CheckpointAuditOutcomeV2 = { schemaVersion: 2, draftId: event.draftId, event };
  const raw = canonicalCheckpointJson(outcome);
  if (Buffer.byteLength(raw, 'utf8') > CHECKPOINT_AUDIT_V2_OUTCOME_MAX_BYTES) {
    throw new Error('checkpoint_finalization_audit_outcome_mismatch');
  }
  const sha256 = auditSha256(raw);
  const existing = await readAuditOutcomeFile(workspace, event.draftId);
  if (existing) {
    if (existing.raw !== raw) {
      await writeAuditConflict(workspace, event.draftId, sha256, existing.sha256);
      throw new Error('checkpoint_finalization_audit_outcome_mismatch');
    }
    return existing;
  }
  await writeImmutableAuditFile(
    workspace,
    location.outcome,
    raw,
    'checkpoint_finalization_audit_outcome_mismatch',
    options,
  );
  const written = await readAuditOutcomeFile(workspace, event.draftId);
  if (!written || written.raw !== raw) throw new Error('checkpoint_finalization_audit_outcome_mismatch');
  return written;
}

async function buildAuditPublication(
  workspace: Workspace,
  record: CheckpointAuditCatalogFinalizationRecordV2,
): Promise<CheckpointAuditPublicationV2> {
  const segmentId = Math.floor(record.sequence / CHECKPOINT_AUDIT_V2_SEGMENT_RECORDS);
  const recordIndex = record.sequence % CHECKPOINT_AUDIT_V2_SEGMENT_RECORDS;
  const segment = await readAuditSegment(workspace, segmentId);
  if (!segment || canonicalCheckpointJson(segment[recordIndex]) !== canonicalCheckpointJson(record)) {
    throw new Error('checkpoint_audit_segment_invalid');
  }
  return {
    schemaVersion: 2,
    draftId: record.draftId,
    eventId: record.eventId,
    outcomeSha256: record.outcomeSha256,
    sequence: record.sequence,
    segmentId,
    recordIndex,
    recordSha256: auditRecordSha256(record),
    segmentPrefixSha256: auditSegmentPrefixSha256(segment, recordIndex),
  };
}

async function writeAuditPublicationImmutable(
  workspace: Workspace,
  record: CheckpointAuditCatalogFinalizationRecordV2,
  options?: CheckpointFileWorkerTestOptions,
  prepared?: CheckpointAuditPublicationV2,
): Promise<CheckpointAuditPublicationV2> {
  const publication = prepared ?? await buildAuditPublication(workspace, record);
  const location = await ensureAuditFinalizationWriteDirectory(workspace, record.draftId);
  const raw = canonicalCheckpointJson(publication);
  if (Buffer.byteLength(raw, 'utf8') > CHECKPOINT_AUDIT_V2_PUBLICATION_MAX_BYTES) {
    throw new Error('checkpoint_audit_publication_invalid');
  }
  await writeImmutableAuditFile(workspace, location.publication, raw, 'checkpoint_audit_publication_invalid', options);
  return publication;
}

async function writeAuditCatalogReceiptImmutable(
  workspace: Workspace,
  record: CheckpointAuditCatalogFinalizationRecordV2,
  options?: CheckpointFileWorkerTestOptions,
): Promise<CheckpointAuditPublicationV2> {
  const publication = await buildAuditPublication(workspace, record);
  const location = await ensureAuditFinalizationWriteDirectory(workspace, record.draftId);
  const raw = canonicalCheckpointJson(publication);
  if (Buffer.byteLength(raw, 'utf8') > CHECKPOINT_AUDIT_V2_PUBLICATION_MAX_BYTES) {
    throw new Error('checkpoint_audit_publication_invalid');
  }
  // This immutable receipt closes the only ambiguous state in the protocol: outcome exists and
  // publication is absent. Without it, deletion of a committed publication is indistinguishable from
  // the recoverable after-outcome crash and a retry can append a second catalog reference.
  await writeImmutableAuditFile(workspace, location.catalog, raw, 'checkpoint_audit_publication_invalid', options);
  return publication;
}

async function verifyAuditPublication(
  workspace: Workspace,
  outcome: { outcome: CheckpointAuditOutcomeV2; sha256: string; location: ReturnType<typeof auditFinalizationLocation> },
  cachedSegment?: { segmentId: number; records: CheckpointAuditCatalogRecordV2[] },
): Promise<CheckpointAuditPublicationV2> {
  const [catalogValue, value] = await Promise.all([
    readCanonicalAuditJson(
      workspace,
      outcome.location.catalog,
      CHECKPOINT_AUDIT_V2_PUBLICATION_MAX_BYTES,
      'checkpoint_audit_publication_invalid',
    ),
    readCanonicalAuditJson(
      workspace,
      outcome.location.publication,
      CHECKPOINT_AUDIT_V2_PUBLICATION_MAX_BYTES,
      'checkpoint_audit_publication_invalid',
    ),
  ]);
  if (value === undefined) {
    if (catalogValue !== undefined) throw new Error('checkpoint_audit_publication_invalid');
    throw new Error('checkpoint_finalization_audit_missing');
  }
  if (catalogValue === undefined) throw new Error('checkpoint_audit_publication_invalid');
  const catalog = validateAuditPublication(catalogValue, outcome.outcome.draftId);
  const publication = validateAuditPublication(value, outcome.outcome.draftId);
  if (canonicalCheckpointJson(catalog) !== canonicalCheckpointJson(publication)) {
    throw new Error('checkpoint_audit_publication_invalid');
  }
  if (publication.eventId !== outcome.outcome.event.id || publication.outcomeSha256 !== outcome.sha256) {
    throw new Error('checkpoint_audit_publication_invalid');
  }
  const segment = cachedSegment?.segmentId === publication.segmentId
    ? cachedSegment.records
    : await readAuditSegment(workspace, publication.segmentId);
  const record = segment?.[publication.recordIndex];
  if (
    !record
    || record.kind !== 'finalization-ref'
    || record.sequence !== publication.sequence
    || record.draftId !== outcome.outcome.draftId
    || record.eventId !== outcome.outcome.event.id
    || record.outcomeSha256 !== outcome.sha256
    || auditRecordSha256(record) !== publication.recordSha256
    || auditSegmentPrefixSha256(segment, publication.recordIndex) !== publication.segmentPrefixSha256
  ) throw new Error('checkpoint_audit_publication_invalid');
  return publication;
}

async function recoverAuditPending(
  workspace: Workspace,
  options?: CheckpointAuditV2TestOptions,
): Promise<void> {
  const paths = checkpointAuditV2Paths(workspace);
  const pending = await readAuditPending(workspace);
  if (pending.status === 'empty') {
    // Empty pending is not permission to skip the committed head. Finalization recovery can otherwise
    // publish a draft marker from a valid per-draft outcome while a non-canonical or mismatched state
    // file is being ignored. Validate the bounded current head on every protocol entry.
    await readAuditState(workspace);
    return;
  }
  const state = await readAuditState(workspace, true);
  const recordHash = auditRecordSha256(pending.record);
  const segmentId = Math.floor(pending.sequence / CHECKPOINT_AUDIT_V2_SEGMENT_RECORDS);
  const recordIndex = pending.sequence % CHECKPOINT_AUDIT_V2_SEGMENT_RECORDS;
  let segment = await readAuditSegment(workspace, segmentId, true) ?? [];

  if (state.nextSequence === pending.sequence) {
    if (
      state.headRecordSha256 !== pending.previousHeadRecordSha256
      || segment.length < recordIndex
      || segment.length > recordIndex + 1
    ) throw new Error('checkpoint_audit_pending_invalid');
    if (segment.length === recordIndex) {
      if (recordIndex > 0 && auditRecordSha256(segment[recordIndex - 1]) !== pending.previousHeadRecordSha256) {
        throw new Error('checkpoint_audit_pending_invalid');
      }
      segment = [...segment, pending.record];
      const raw = `${segment.map((record) => canonicalCheckpointJson(record)).join('\n')}\n`;
      if (Buffer.byteLength(raw, 'utf8') > CHECKPOINT_AUDIT_V2_SEGMENT_MAX_BYTES) {
        throw new Error('checkpoint_audit_segment_invalid');
      }
      const file = await ensureAuditSegmentWriteDirectory(workspace, segmentId);
      const result = await atomicWriteCheckpointFile(
        checkpointContainmentRoot(workspace),
        file,
        raw,
        recordIndex === 0 ? 'create' : 'replace',
        options,
      );
      if ((recordIndex === 0 && result !== 'created') || (recordIndex > 0 && result !== 'replaced')) {
        throw new Error('checkpoint_audit_segment_invalid');
      }
    } else if (canonicalCheckpointJson(segment[recordIndex]) !== canonicalCheckpointJson(pending.record)) {
      throw new Error('checkpoint_audit_pending_invalid');
    }
    auditFault(options, 'after-segment');
    await writeAuditControlFile(workspace, paths.state, {
      schemaVersion: 2,
      nextSequence: pending.sequence + 1,
      headRecordSha256: recordHash,
    }, options);
    auditFault(options, 'after-state');
  } else if (state.nextSequence === pending.sequence + 1) {
    if (
      state.headRecordSha256 !== recordHash
      || !segment[recordIndex]
      || canonicalCheckpointJson(segment[recordIndex]) !== canonicalCheckpointJson(pending.record)
    ) throw new Error('checkpoint_audit_pending_invalid');
  } else {
    throw new Error('checkpoint_audit_pending_invalid');
  }

  if (pending.record.kind === 'finalization-ref') {
    const publication = await writeAuditCatalogReceiptImmutable(workspace, pending.record, options);
    await writeAuditPublicationImmutable(workspace, pending.record, options, publication);
    auditFault(options, 'after-publication');
  }
  // Never unlink pending. A canonical empty replacement is the commit acknowledgement, so a missing,
  // symlinked, oversized, or malformed pending file is always observable and fails closed.
  await writeAuditControlFile(workspace, paths.pending, AUDIT_V2_EMPTY_PENDING, options);
}

async function appendAuditCatalogRecord(
  workspace: Workspace,
  partial: Omit<CheckpointAuditCatalogEventRecordV2, 'schemaVersion' | 'sequence' | 'previousRecordSha256'>
    | Omit<CheckpointAuditCatalogFinalizationRecordV2, 'schemaVersion' | 'sequence' | 'previousRecordSha256'>,
  options?: CheckpointAuditV2TestOptions,
): Promise<CheckpointAuditCatalogRecordV2> {
  await recoverAuditPending(workspace, options);
  const state = await readAuditState(workspace);
  const existingPending = await readAuditPending(workspace);
  if (existingPending.status !== 'empty') throw new Error('checkpoint_audit_pending_invalid');
  const record = validateAuditCatalogRecord({
    schemaVersion: 2,
    sequence: state.nextSequence,
    previousRecordSha256: state.headRecordSha256,
    ...partial,
  });
  const pending: CheckpointAuditPendingV2 = {
    schemaVersion: 2,
    status: 'active',
    sequence: record.sequence,
    previousHeadRecordSha256: record.previousRecordSha256,
    record,
  };
  await writeAuditControlFile(workspace, checkpointAuditV2Paths(workspace).pending, pending, options);
  auditFault(options, 'after-pending');
  await recoverAuditPending(workspace, options);
  return record;
}

function legacyAuditEvents(raw: string): CheckpointAuditEvent[] {
  const out: CheckpointAuditEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const event = validateCheckpointAuditEvent(JSON.parse(line));
      if (event) out.push(event);
    } catch {
      // Legacy inspection remains best-effort, but migration is stat-bounded before this parser runs.
    }
  }
  return out;
}

async function bootstrapAuditV2(
  workspace: Workspace,
  events: readonly CheckpointAuditEvent[],
): Promise<void> {
  const paths = checkpointAuditV2Paths(workspace);
  const records: CheckpointAuditCatalogRecordV2[] = [];
  const finalizationOutcomes = new Map<string, { outcome: CheckpointAuditOutcomeV2; raw: string; sha256: string }>();
  let previousRecordSha256: string | null = null;
  for (const event of events) {
    let record: CheckpointAuditCatalogRecordV2;
    if (isFinalizationAuditEvent(event)) {
      const existing = finalizationOutcomes.get(event.draftId);
      if (existing) {
        if (!sameFinalizationOutcome(existing.outcome.event, event)) {
          throw new Error('checkpoint_finalization_audit_outcome_mismatch');
        }
        continue;
      }
      const outcome: CheckpointAuditOutcomeV2 = { schemaVersion: 2, draftId: event.draftId, event };
      const raw = canonicalCheckpointJson(outcome);
      if (Buffer.byteLength(raw, 'utf8') > CHECKPOINT_AUDIT_V2_OUTCOME_MAX_BYTES) {
        throw new Error('checkpoint_finalization_audit_outcome_mismatch');
      }
      const sha256 = auditSha256(raw);
      finalizationOutcomes.set(event.draftId, { outcome, raw, sha256 });
      record = {
        schemaVersion: 2,
        sequence: records.length,
        previousRecordSha256,
        kind: 'finalization-ref',
        draftId: event.draftId,
        eventId: event.id,
        outcomeSha256: sha256,
      };
    } else {
      record = {
        schemaVersion: 2,
        sequence: records.length,
        previousRecordSha256,
        kind: 'event',
        event,
      };
    }
    validateAuditCatalogRecord(record);
    records.push(record);
    previousRecordSha256 = auditRecordSha256(record);
  }

  for (const { outcome, raw } of finalizationOutcomes.values()) {
    const location = await ensureAuditFinalizationWriteDirectory(workspace, outcome.draftId);
    await writeImmutableAuditFile(workspace, location.outcome, raw, 'checkpoint_finalization_audit_outcome_mismatch');
  }
  for (let start = 0; start < records.length; start += CHECKPOINT_AUDIT_V2_SEGMENT_RECORDS) {
    const segmentId = Math.floor(start / CHECKPOINT_AUDIT_V2_SEGMENT_RECORDS);
    const segment = records.slice(start, start + CHECKPOINT_AUDIT_V2_SEGMENT_RECORDS);
    const raw = `${segment.map((record) => canonicalCheckpointJson(record)).join('\n')}\n`;
    if (Buffer.byteLength(raw, 'utf8') > CHECKPOINT_AUDIT_V2_SEGMENT_MAX_BYTES) throw new Error('checkpoint_audit_segment_invalid');
    const file = await ensureAuditSegmentWriteDirectory(workspace, segmentId);
    await writeImmutableAuditFile(workspace, file, raw, 'checkpoint_audit_segment_invalid');
  }
  for (const record of records) {
    if (record.kind === 'finalization-ref') {
      const publication = await writeAuditCatalogReceiptImmutable(workspace, record);
      await writeAuditPublicationImmutable(workspace, record, undefined, publication);
    }
  }

  const state: CheckpointAuditStateV2 = records.length === 0
    ? AUDIT_V2_EMPTY_STATE
    : { schemaVersion: 2, nextSequence: records.length, headRecordSha256: auditRecordSha256(records.at(-1)!) };
  const expectedState = canonicalCheckpointJson(state);
  const existingState = await readContainedFile(
    checkpointContainmentRoot(workspace),
    paths.state,
    CHECKPOINT_AUDIT_V2_CONTROL_MAX_BYTES,
    'checkpoint_audit_state_invalid',
  ).catch((error: unknown) => ((error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : Promise.reject(error)));
  if (existingState === undefined) await writeAuditControlFile(workspace, paths.state, state);
  else if (existingState !== expectedState) throw new Error('checkpoint_audit_state_invalid');

  const expectedPending = canonicalCheckpointJson(AUDIT_V2_EMPTY_PENDING);
  const existingPending = await readContainedFile(
    checkpointContainmentRoot(workspace),
    paths.pending,
    CHECKPOINT_AUDIT_V2_CONTROL_MAX_BYTES,
    'checkpoint_audit_pending_invalid',
  ).catch((error: unknown) => ((error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : Promise.reject(error)));
  if (existingPending === undefined) await writeAuditControlFile(workspace, paths.pending, AUDIT_V2_EMPTY_PENDING);
  else if (existingPending !== expectedPending) throw new Error('checkpoint_audit_pending_invalid');

  await writeImmutableAuditFile(
    workspace,
    paths.current,
    canonicalCheckpointJson(AUDIT_V2_CURRENT),
    'checkpoint_audit_state_invalid',
  );
}

async function ensureCheckpointAuditV2Unlocked(
  workspace: Workspace,
  options?: CheckpointAuditV2TestOptions,
): Promise<void> {
  const paths = await ensureAuditV2BaseDirectories(workspace);
  const current = await readCanonicalAuditJson(
    workspace,
    paths.current,
    CHECKPOINT_AUDIT_V2_CURRENT_MAX_BYTES,
    'checkpoint_audit_state_invalid',
  );
  if (current === undefined) {
    const legacy = checkpointStorePaths(workspace).audit;
    let legacyRaw = '';
    let legacyStat: Awaited<ReturnType<typeof fs.lstat>> | undefined;
    try {
      legacyStat = await fs.lstat(legacy);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (legacyStat) {
      if (!legacyStat.isFile() || legacyStat.isSymbolicLink()) throw new Error('checkpoint_path_outside_store');
      if (legacyStat.size > CHECKPOINT_AUDIT_V2_MIGRATION_MAX_BYTES) {
        throw new Error('checkpoint_audit_migration_required');
      }
      legacyRaw = await readContainedFile(
        checkpointContainmentRoot(workspace),
        legacy,
        CHECKPOINT_AUDIT_V2_MIGRATION_MAX_BYTES,
        'checkpoint_audit_migration_required',
      );
    }
    await bootstrapAuditV2(workspace, legacyAuditEvents(legacyRaw));
  } else {
    validateAuditV2Current(current);
  }
  await recoverAuditPending(workspace, options);
}

async function appendFinalizationAuditV2Unlocked(
  workspace: Workspace,
  requested: Omit<CheckpointAuditEvent, 'schemaVersion' | 'id' | 'at'>,
  options?: CheckpointAuditV2TestOptions,
): Promise<CheckpointAuditEvent> {
  if (
    requested.operation !== 'artifact.finalize'
    || (requested.type !== 'checkpoint.artifact.created' && requested.type !== 'checkpoint.artifact.deduplicated')
    || typeof requested.draftId !== 'string'
    || typeof requested.artifactId !== 'string'
  ) throw new Error('checkpoint_audit_schema_invalid');
  const existing = await readAuditOutcomeFile(workspace, requested.draftId);
  if (existing) {
    if (!sameFinalizationOutcome(existing.outcome.event, requested)) {
      const expected: CheckpointAuditOutcomeV2 = {
        schemaVersion: 2,
        draftId: requested.draftId,
        event: {
          schemaVersion: 1,
          id: crypto.randomUUID(),
          at: new Date().toISOString(),
          ...requested,
        } as CheckpointAuditEvent,
      };
      await writeAuditConflict(
        workspace,
        requested.draftId,
        auditSha256(canonicalCheckpointJson(expected)),
        existing.sha256,
      );
      throw new Error('checkpoint_finalization_audit_outcome_mismatch');
    }
    try {
      await verifyAuditPublication(workspace, existing);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'checkpoint_finalization_audit_missing') throw error;
      const record = await appendAuditCatalogRecord(workspace, {
        kind: 'finalization-ref',
        draftId: requested.draftId,
        eventId: existing.outcome.event.id,
        outcomeSha256: existing.sha256,
      }, options);
      if (record.kind !== 'finalization-ref') throw new Error('checkpoint_internal_failure');
    }
    await verifyAuditPublication(workspace, existing);
    return existing.outcome.event;
  }

  auditFault(options, 'before-outcome');
  const full = validateCheckpointAuditEvent({
    schemaVersion: 1,
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    ...requested,
  });
  if (!full || !isFinalizationAuditEvent(full)) throw new Error('checkpoint_audit_schema_invalid');
  const outcome = await writeAuditOutcomeImmutable(workspace, full, options);
  auditFault(options, 'after-outcome');
  const record = await appendAuditCatalogRecord(workspace, {
    kind: 'finalization-ref',
    draftId: full.draftId,
    eventId: full.id,
    outcomeSha256: outcome.sha256,
  }, options);
  if (record.kind !== 'finalization-ref') throw new Error('checkpoint_internal_failure');
  await verifyAuditPublication(workspace, outcome);
  return full;
}

export async function appendCheckpointAuditUnlocked(
  workspace: Workspace,
  event: Omit<CheckpointAuditEvent, 'schemaVersion' | 'id' | 'at'>,
  options?: CheckpointAuditV2TestOptions,
): Promise<CheckpointAuditEvent> {
  await ensureCheckpointAuditV2Unlocked(workspace, options);
  if (
    event.operation === 'artifact.finalize'
    && (event.type === 'checkpoint.artifact.created' || event.type === 'checkpoint.artifact.deduplicated')
  ) return await appendFinalizationAuditV2Unlocked(workspace, event, options);

  const full = validateCheckpointAuditEvent({
    schemaVersion: 1,
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    ...event,
  });
  if (!full || isFinalizationAuditEvent(full)) throw new Error('checkpoint_audit_schema_invalid');
  await appendAuditCatalogRecord(workspace, { kind: 'event', event: full }, options);
  return full;
}

export async function readCheckpointFinalizationAuditUnlocked(
  workspace: Workspace,
  draftId: string,
  requirePublished = false,
): Promise<CheckpointAuditEvent | undefined> {
  await ensureCheckpointAuditV2Unlocked(workspace);
  const outcome = await readAuditOutcomeFile(workspace, draftId);
  if (!outcome) return undefined;
  if (requirePublished) await verifyAuditPublication(workspace, outcome);
  return outcome.outcome.event;
}

function parseAuditCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const match = /^v2:([0-9]+)$/.exec(cursor);
  if (!match) throw new Error('checkpoint_audit_cursor_invalid');
  const sequence = Number(match[1]);
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('checkpoint_audit_cursor_invalid');
  return sequence;
}

export async function readCheckpointAuditPageUnlocked(
  workspace: Workspace,
  options: { limit?: number; cursor?: string } = {},
): Promise<CheckpointAuditPage> {
  const limit = options.limit ?? CHECKPOINT_AUDIT_PAGE_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > CHECKPOINT_AUDIT_PAGE_MAX_LIMIT) {
    throw new Error('checkpoint_audit_limit_invalid');
  }
  await ensureCheckpointAuditV2Unlocked(workspace);
  const state = await readAuditState(workspace);
  const start = parseAuditCursor(options.cursor);
  if (start > state.nextSequence) throw new Error('checkpoint_audit_cursor_invalid');
  const end = Math.min(state.nextSequence, start + limit);
  const events: CheckpointAuditEvent[] = [];
  let loadedSegmentId = -1;
  let loadedSegment: CheckpointAuditCatalogRecordV2[] | undefined;
  for (let sequence = start; sequence < end; sequence += 1) {
    const segmentId = Math.floor(sequence / CHECKPOINT_AUDIT_V2_SEGMENT_RECORDS);
    if (segmentId !== loadedSegmentId) {
      loadedSegment = await readAuditSegment(workspace, segmentId);
      loadedSegmentId = segmentId;
    }
    const record = loadedSegment?.[sequence % CHECKPOINT_AUDIT_V2_SEGMENT_RECORDS];
    if (!record || record.sequence !== sequence) throw new Error('checkpoint_audit_segment_invalid');
    if (record.kind === 'event') {
      events.push(record.event);
    } else {
      const outcome = await readAuditOutcomeFile(workspace, record.draftId);
      if (!outcome || outcome.sha256 !== record.outcomeSha256 || outcome.outcome.event.id !== record.eventId) {
        throw new Error('checkpoint_finalization_audit_outcome_mismatch');
      }
      await verifyAuditPublication(workspace, outcome, { segmentId: loadedSegmentId, records: loadedSegment ?? [] });
      events.push(outcome.outcome.event);
    }
  }
  return { events, ...(end < state.nextSequence ? { nextCursor: `v2:${end}` } : {}) };
}

// Compatibility aggregation is deliberately finite. Critical finalization/recovery paths use the
// per-draft outcome primitive above and never call this wrapper.
export async function readCheckpointAudit(workspace: Workspace): Promise<CheckpointAuditEvent[]> {
  await ensureCheckpointAuditV2Unlocked(workspace);
  const state = await readAuditState(workspace);
  if (state.nextSequence > CHECKPOINT_AUDIT_COMPAT_MAX_EVENTS) {
    throw new Error('checkpoint_audit_read_limit_exceeded');
  }
  const out: CheckpointAuditEvent[] = [];
  let cursor: string | undefined;
  do {
    const page = await readCheckpointAuditPageUnlocked(workspace, {
      limit: CHECKPOINT_AUDIT_PAGE_MAX_LIMIT,
      ...(cursor ? { cursor } : {}),
    });
    out.push(...page.events);
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}
