// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Workspace } from '../types.ts';
import { absoluteFromMemoryPath, relativeToSpace } from '../workspace.ts';

// Defense-in-depth against symlink escapes. absoluteFromMemoryPath() only performs a *lexical*
// containment check, which cannot see through symlinks: a symlink that lives inside the managed
// root but points outside passes the lexical check yet escapes on the real filesystem. Resolve
// real paths and re-verify the target is still inside the managed root before any read/write.
//
// Returns the resolved real path. This proves static containment at the instant of the check; it is
// not a general replacement for fd-relative openat()/renameat(), which Node does not expose. Readers
// pair it with O_NOFOLLOW + inode checks. Private writers additionally pin/check the directory and
// define an owner-private containment root as their mutation boundary.
export async function assertRealPathWithin(rootDir: string, target: string): Promise<string> {
  const realRoot = await fs.realpath(rootDir);
  let realTarget: string;
  try {
    realTarget = await fs.realpath(target);
  } catch (error) {
    // A missing target is fine here: the caller's read/write surfaces the real ENOENT instead.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return target;
    throw error;
  }
  if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error('path_outside_memory_workspace');
  }
  return realTarget;
}

export type AtomicWriteFileOptions = {
  directoryMode?: number;
  fileMode?: number;
  durable?: boolean;
  // Use one deterministic temp name. The caller MUST serialize writers (turn receipts use the
  // workspace lock); in exchange, crash debris is bounded to one private file and cleaned next time.
  boundedTemp?: boolean;
};

function directorySyncUnsupported(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EINVAL'
    || code === 'ENOTSUP'
    || code === 'EOPNOTSUPP'
    || (process.platform === 'win32' && code === 'EPERM');
}

async function syncDirectory(handle: fs.FileHandle): Promise<void> {
  try {
    await handle.sync();
  } catch (error) {
    if (!directorySyncUnsupported(error)) throw error;
  }
}

async function removeBoundedStaleTemp(tmpPath: string): Promise<void> {
  let entry: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    entry = await fs.lstat(tmpPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (entry.isDirectory()) throw new Error('atomic_write_temp_invalid');
  await fs.unlink(tmpPath);
}

export async function atomicWriteFile(
  filePath: string,
  content: string,
  containmentRoot?: string,
  options: AtomicWriteFileOptions = {},
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, {
    recursive: true,
    ...(options.directoryMode === undefined ? {} : { mode: options.directoryMode }),
  });
  // Reject static parent-directory symlinks that escape the managed root. Secure callers below also
  // require an exact non-symlink directory and compare its pinned inode immediately before rename.
  // Node still lacks renameat/openat: a malicious same-UID process allowed to mutate the owner-private
  // containment root is outside this helper's threat boundary, and this code does not claim otherwise.
  if (containmentRoot) await assertRealPathWithin(containmentRoot, dir);
  let directoryHandle: fs.FileHandle | undefined;
  let expectedDirectory: { dev: number; ino: number; real: string } | undefined;
  if (options.directoryMode !== undefined || options.durable || options.boundedTemp) {
    const entry = await fs.lstat(dir);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('path_outside_memory_workspace');
    const real = await fs.realpath(dir);
    directoryHandle = await fs.open(dir, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_DIRECTORY);
    try {
      if (options.directoryMode !== undefined) await directoryHandle.chmod(options.directoryMode);
      const [opened, current] = await Promise.all([directoryHandle.stat(), fs.stat(real)]);
      if (
        !opened.isDirectory()
        || !current.isDirectory()
        || opened.dev !== current.dev
        || opened.ino !== current.ino
        || (options.directoryMode !== undefined
          && process.platform !== 'win32'
          && (opened.mode & 0o777) !== options.directoryMode)
      ) throw new Error('path_outside_memory_workspace');
      expectedDirectory = { dev: opened.dev, ino: opened.ino, real };
    } catch (error) {
      await directoryHandle.close();
      directoryHandle = undefined;
      throw error;
    }
  }

  const assertDirectoryStillPinned = async (): Promise<void> => {
    if (!directoryHandle || !expectedDirectory) return;
    const [opened, current, real] = await Promise.all([
      directoryHandle.stat(),
      fs.stat(dir),
      fs.realpath(dir),
    ]);
    if (
      !opened.isDirectory()
      || !current.isDirectory()
      || opened.dev !== expectedDirectory.dev
      || opened.ino !== expectedDirectory.ino
      || current.dev !== expectedDirectory.dev
      || current.ino !== expectedDirectory.ino
      || real !== expectedDirectory.real
    ) throw new Error('path_outside_memory_workspace');
  };

  const tmpPath = path.join(
    dir,
    options.boundedTemp
      ? `.${path.basename(filePath)}.tmp`
      : `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let tempHandle: fs.FileHandle | undefined;
  let tempCreated = false;
  let committed = false;
  let tempIdentity: { dev: number; ino: number } | undefined;
  try {
    if (options.boundedTemp) await removeBoundedStaleTemp(tmpPath);
    await assertDirectoryStillPinned();
    const fileMode = options.fileMode ?? 0o666;
    tempHandle = await fs.open(
      tmpPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      fileMode,
    );
    tempCreated = true;
    // Creation mode is already no broader than requested (umask can only remove bits). chmod here
    // restores an exact private mode before content is written, never after broader exposure.
    if (options.fileMode !== undefined) await tempHandle.chmod(options.fileMode);
    const tempStat = await tempHandle.stat();
    if (
      !tempStat.isFile()
      || tempStat.size !== 0
      || tempStat.nlink !== 1
      || (options.fileMode !== undefined
        && process.platform !== 'win32'
        && (tempStat.mode & 0o777) !== options.fileMode)
    ) throw new Error('atomic_write_temp_invalid');
    tempIdentity = { dev: tempStat.dev, ino: tempStat.ino };
    await tempHandle.writeFile(content, 'utf8');
    if (options.durable) await tempHandle.sync();
    await tempHandle.close();
    tempHandle = undefined;
    await assertDirectoryStillPinned();
    await fs.rename(tmpPath, filePath);
    committed = true;
    if (options.fileMode !== undefined && process.platform !== 'win32') {
      const finalStat = await fs.lstat(filePath);
      if (
        !finalStat.isFile()
        || finalStat.isSymbolicLink()
        || finalStat.nlink !== 1
        || !tempIdentity
        || finalStat.dev !== tempIdentity.dev
        || finalStat.ino !== tempIdentity.ino
        || (finalStat.mode & 0o777) !== options.fileMode
      ) {
        throw new Error('atomic_write_final_invalid');
      }
    }
    if (options.durable && directoryHandle) await syncDirectory(directoryHandle);
  } catch (error) {
    const failures: unknown[] = [error];
    if (tempHandle) {
      try {
        await tempHandle.close();
      } catch (closeError) {
        failures.push(closeError);
      } finally {
        tempHandle = undefined;
      }
    }
    if (tempCreated && !committed) {
      try {
        await fs.unlink(tmpPath);
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
          failures.push(cleanupError);
        }
      }
    }
    if (failures.length > 1) throw new AggregateError(failures, 'atomic_write_cleanup_failed');
    throw error;
  } finally {
    if (directoryHandle) await directoryHandle.close();
  }
}

export async function appendFileAtomic(filePath: string, line: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, line, 'utf8');
}

export async function readMemoryFile(workspace: Workspace, ref: string): Promise<{ path: string; content: string }> {
  const absolutePath = absoluteFromMemoryPath(workspace, ref);
  // TOCTOU-safe read.
  // 1) O_NOFOLLOW: refuse a symlink as the final path segment. Memory files are real files (the
  //    index ignores symlinks too), so a symlinked leaf can only be an escape attempt. This alone
  //    closes the read race for the common case, since the fd can never be pinned to an outside
  //    file reached through a swapped leaf symlink.
  // 2) Open pins the fd to one inode; swapping any intermediate-directory symlink afterwards
  //    cannot change what the fd refers to. We then containment-check the resolved real path and
  //    confirm the pinned inode matches it — covering symlinked intermediate directories too.
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(absolutePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error('path_outside_memory_workspace');
    }
    throw error;
  }
  try {
    const realPath = await assertRealPathWithin(workspace.memoryDir, absolutePath);
    const [fdStat, realStat] = await Promise.all([handle.stat(), fs.stat(realPath)]);
    if (fdStat.ino !== realStat.ino || fdStat.dev !== realStat.dev) {
      throw new Error('path_outside_memory_workspace');
    }
    const content = await handle.readFile('utf8');
    return {
      path: relativeToSpace(workspace, absolutePath),
      content,
    };
  } finally {
    await handle.close();
  }
}

export async function listMarkdownFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  async function visit(dir: string): Promise<void> {
    // No explicit `Awaited<ReturnType<typeof fs.readdir>>` annotation: that picks the wrong (Buffer)
    // overload, so entry.name typed as a Buffer. Inferring from the call resolves the string overload.
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '_events') continue;
        await visit(absolute);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(absolute);
      }
    }
  }
  await visit(root);
  return results.sort();
}

export function nowCompact(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function safeFileSlug(input: string, fallback = 'memory'): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return (slug || fallback).slice(0, 80);
}
