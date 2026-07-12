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
  type CheckpointArtifactV1,
  type CheckpointArtifactBuildV1,
  type CheckpointDraftV1,
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
  const entries = await fs.readdir(pinned.directoryRealPath, { withFileTypes: true });
  if (entries.length > 4096) throw new Error('checkpoint_cleanup_incomplete');
  const aliases: string[] = [];
  const linkCounts: bigint[] = [];
  for (const name of new Set(entries.map((entry) => entry.name))) {
    const stat = await fs.lstat(path.join(pinned.directoryRealPath, name), { bigint: true });
    if (!stat.isFile() || stat.dev !== expected.dev || stat.ino !== expected.ino) continue;
    aliases.push(name);
    linkCounts.push(stat.nlink);
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
  child.stdin.write(`${JSON.stringify(value)}\n`);
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

export async function appendCheckpointAuditUnlocked(
  workspace: Workspace,
  event: Omit<CheckpointAuditEvent, 'schemaVersion' | 'id' | 'at'>,
  options?: CheckpointFileWorkerTestOptions,
): Promise<CheckpointAuditEvent> {
  if (
    event.operation === 'artifact.finalize'
    && (event.type === 'checkpoint.artifact.created' || event.type === 'checkpoint.artifact.deduplicated')
    && event.draftId
  ) {
    const existingFinalizations = (await readCheckpointAudit(workspace)).filter((existing) => (
      existing.operation === 'artifact.finalize' && existing.draftId === event.draftId
    ));
    if (existingFinalizations.length > 0) {
      if (
        existingFinalizations.length === 1
        && existingFinalizations[0].type === event.type
        && existingFinalizations[0].artifactId === event.artifactId
        && existingFinalizations[0].supersedes === event.supersedes
      ) return existingFinalizations[0];
      throw new Error('checkpoint_finalization_audit_outcome_mismatch');
    }
  }
  const paths = await ensureCheckpointStore(workspace);
  const full: CheckpointAuditEvent = {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    ...event,
  };
  const validated = validateCheckpointAuditEvent(full);
  if (!validated) throw new Error('checkpoint_audit_schema_invalid');
  const existing = await readContainedFile(checkpointContainmentRoot(workspace), paths.audit).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  });
  const result = await atomicWriteCheckpointFile(
    checkpointContainmentRoot(workspace),
    paths.audit,
    `${existing}${canonicalCheckpointJson(validated)}\n`,
    'replace',
    options,
  );
  if (result !== 'replaced') throw new Error('checkpoint_internal_failure');
  return validated;
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

export async function readCheckpointAudit(workspace: Workspace): Promise<CheckpointAuditEvent[]> {
  const paths = await ensureCheckpointStore(workspace);
  const raw = await readContainedFile(checkpointContainmentRoot(workspace), paths.audit).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  });
  const out: CheckpointAuditEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const value = validateCheckpointAuditEvent(JSON.parse(line));
      if (value) out.push(value);
    } catch {
      // Audit inspection is best-effort; malformed lines never become checkpoint content.
    }
  }
  return out;
}
