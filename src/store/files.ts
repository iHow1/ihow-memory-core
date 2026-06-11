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
// Returns the resolved real path. Callers MUST operate on the returned path, not on the original
// `target`: reading/writing the original re-resolves symlinks a second time, opening a TOCTOU
// window where the link is swapped between this check and the use. Acting on the already-resolved
// real path closes that window.
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

export async function atomicWriteFile(filePath: string, content: string, containmentRoot?: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  // The parent dir now exists; if any of its components is a symlink that escapes the managed
  // root, reject before writing. (Renaming over a symlinked *file* replaces the link, so guarding
  // the parent directory is sufficient.)
  if (containmentRoot) await assertRealPathWithin(containmentRoot, dir);
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  await fs.writeFile(tmpPath, content, 'utf8');
  await fs.rename(tmpPath, filePath);
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
    let entries: Awaited<ReturnType<typeof fs.readdir>>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
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
