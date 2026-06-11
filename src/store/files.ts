// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Workspace } from '../types.ts';
import { absoluteFromMemoryPath, relativeToSpace } from '../workspace.ts';

export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = path.join(
    path.dirname(filePath),
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
  const content = await fs.readFile(absolutePath, 'utf8');
  return {
    path: relativeToSpace(workspace, absolutePath),
    content,
  };
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
