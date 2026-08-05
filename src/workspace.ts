// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Workspace, WorkspaceOptions } from './types.ts';
import { defaultFtsManifest } from './engine/manifest.ts';

const DEFAULT_ROOT = path.join(os.homedir(), '.ihow-memory');

export function defaultRoot(): string {
  return process.env.IHOW_MEMORY_HOME || DEFAULT_ROOT;
}

export function defaultMemoryRoot(): string | undefined {
  return process.env.MEMORY_ROOT || process.env.IHOW_MEMORY_ROOT;
}

export function defaultStateRoot(): string {
  return process.env.IHOW_MEMORY_STATE_ROOT || path.join(process.cwd(), '.state');
}

export function slugifySpace(input: string): string {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/[/]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  if (normalized) return normalized.slice(0, 80);
  return `space-${crypto.createHash('sha256').update(input).digest('hex').slice(0, 12)}`;
}

export function resolveSpace(options: WorkspaceOptions = {}): string {
  if (options.space) return slugifySpace(options.space);
  const cwd = path.resolve(options.cwd || process.cwd());
  const base = path.basename(cwd) || 'workspace';
  const hash = crypto.createHash('sha256').update(cwd).digest('hex').slice(0, 8);
  return slugifySpace(`${base}-${hash}`);
}

export function resolveWorkspace(options: WorkspaceOptions = {}): Workspace {
  const memoryRoot = options.memoryRoot || (options.root ? undefined : defaultMemoryRoot());
  if (memoryRoot) return resolveExistingMemoryRootWorkspace(options, memoryRoot);

  const root = path.resolve(options.root || defaultRoot());
  const space = resolveSpace(options);
  const spaceDir = path.join(root, space);
  const memoryDir = path.join(spaceDir, 'memory');
  const mcpDir = path.join(memoryDir, '_mcp');
  const eventsDir = path.join(memoryDir, '_events');
  const historyDir = path.join(spaceDir, 'history');
  return {
    mode: 'managed-space',
    root,
    space,
    spaceDir,
    memoryDir,
    mcpDir,
    candidatesDir: path.join(memoryDir, 'candidate', 'inbox'),
    promotedDir: path.join(mcpDir, 'promoted'),
    eventsDir,
    historyDir,
    journalDir: path.join(memoryDir, 'journal'),
    indexPath: path.join(spaceDir, 'index.sqlite'),
    indexManifestPath: path.join(spaceDir, 'index-manifest.json'),
    lockPath: path.join(spaceDir, '.lock'),
  };
}

function resolveExistingMemoryRootWorkspace(options: WorkspaceOptions, memoryRoot: string): Workspace {
  // CONCURRENCY: in this mode the data (journal/events under memoryDir/_mcp) is SHARED across every
  // agent that points at the same --memory-root, but spaceDir lives under a per-cwd stateRoot. Anchoring
  // the lock to spaceDir would give two agents launched from different cwds two DIFFERENT lock files for
  // the SAME journal file → the whole-file read-modify-write in appendJournal loses updates. Anchor the
  // lock to mcpDir instead (= memoryDir/_mcp, identical for every cwd sharing the memory root) so all
  // writers to the same store contend on the same lock.
  const memoryDir = path.resolve(memoryRoot);
  const stateRoot = path.resolve(options.stateRoot || defaultStateRoot());
  const space = resolveSpace({
    space: options.space || path.basename(path.dirname(memoryDir)) || 'workspace-memory',
    cwd: options.cwd,
  });
  const spaceDir = path.join(stateRoot, space);
  const mcpDir = path.join(memoryDir, '_mcp');
  return {
    mode: 'existing-memory-root',
    root: stateRoot,
    space,
    spaceDir,
    memoryDir,
    mcpDir,
    candidatesDir: path.join(mcpDir, 'candidates'),
    promotedDir: path.join(mcpDir, 'promoted'),
    eventsDir: path.join(mcpDir, '_events'),
    historyDir: path.join(mcpDir, 'history'),
    journalDir: path.join(mcpDir, 'journal'),
    indexPath: path.join(spaceDir, 'index.sqlite'),
    indexManifestPath: path.join(spaceDir, 'index-manifest.json'),
    lockPath: path.join(mcpDir, '.lock'),
  };
}

export async function ensureWorkspace(workspace: Workspace): Promise<Workspace> {
  await fs.mkdir(workspace.candidatesDir, { recursive: true });
  await fs.mkdir(workspace.promotedDir, { recursive: true });
  if (workspace.mode === 'managed-space') {
    await fs.mkdir(path.join(workspace.memoryDir, 'scopes'), { recursive: true });
  }
  await fs.mkdir(workspace.eventsDir, { recursive: true });
  await fs.mkdir(workspace.historyDir, { recursive: true });
  await fs.mkdir(workspace.journalDir, { recursive: true });
  await fs.mkdir(path.dirname(workspace.indexPath), { recursive: true });
  await ensureIndexManifest(workspace);
  // Restrict the dirs WE own to the current user (0700) so the auto-capture lane + state (which hold
  // session-derived content) are not world-readable on a shared host, and a co-tenant cannot drop files
  // into our lanes. We do NOT chmod an existing user-provided --memory-root, only our own subtree.
  // Best-effort: ignore on platforms/filesystems without POSIX modes (e.g. Windows).
  for (const dir of new Set([workspace.mcpDir, workspace.spaceDir])) {
    try {
      await fs.chmod(dir, 0o700);
    } catch {
      // best-effort hardening — never fail workspace setup over a chmod
    }
  }
  return workspace;
}

export async function ensureIndexManifest(workspace: Workspace, status = 'ready'): Promise<void> {
  try {
    await fs.access(workspace.indexManifestPath);
    return;
  } catch {
    const manifest = defaultFtsManifest(status === 'ready' ? 'ready' : 'missing');
    await fs.writeFile(workspace.indexManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }
}

export function relativeToSpace(workspace: Workspace, absolutePath: string): string {
  const resolved = path.resolve(absolutePath);
  const memoryDir = path.resolve(workspace.memoryDir);
  if (resolved === memoryDir || resolved.startsWith(`${memoryDir}${path.sep}`)) {
    const rel = path.relative(memoryDir, resolved).split(path.sep).join('/');
    return rel ? `memory/${rel}` : 'memory';
  }
  return path.relative(workspace.spaceDir, resolved).split(path.sep).join('/');
}

export function absoluteFromMemoryPath(workspace: Workspace, ref: string): string {
  const normalized = ref.replace(/\\/g, '/').replace(/^\/+/, '');
  const withoutSpace = normalized.startsWith(`${workspace.space}/`)
    ? normalized.slice(workspace.space.length + 1)
    : normalized;
  let rel = withoutSpace;
  if (rel.startsWith('memory/')) {
    rel = rel.slice('memory/'.length);
  } else {
    const memoryDirRef = path.resolve(rel);
    const memoryDir = path.resolve(workspace.memoryDir);
    if (path.isAbsolute(rel) && (memoryDirRef === memoryDir || memoryDirRef.startsWith(`${memoryDir}${path.sep}`))) {
      rel = path.relative(memoryDir, memoryDirRef);
    }
  }
  const absolute = path.resolve(workspace.memoryDir, rel);
  const memoryDir = path.resolve(workspace.memoryDir);
  if (absolute !== memoryDir && !absolute.startsWith(`${memoryDir}${path.sep}`)) {
    throw new Error('path_outside_memory_workspace');
  }
  return absolute;
}

export function relativeToMemory(workspace: Workspace, absolutePath: string): string {
  return path.relative(workspace.memoryDir, absolutePath).split(path.sep).join('/');
}

export function isMcpSandboxPath(workspace: Workspace, absolutePath: string): boolean {
  const resolved = path.resolve(absolutePath);
  const sandbox = path.resolve(workspace.mcpDir);
  return resolved === sandbox || resolved.startsWith(`${sandbox}${path.sep}`);
}

// ALLOWLIST of CURATED/REVIEWED memory lanes — content that passed the promote / durable-promote gate.
// Used by recall to decide what may be read back into a session: it injects ONLY curated memory and
// rejects everything else BY DEFAULT (candidates, the auto-capture journal/floor lanes, _mcp internals,
// and any unknown future lane). This is an allowlist, not a denylist, precisely so a lane nobody
// remembered to exclude can never leak unreviewed content into the model's context (recall-safety review
// 2026-06-17 reproduced an unreviewed candidate leaking via a journal-only denylist in existing-memory-root
// mode). `relativePath` may be space-relative ("memory/...") or memory-relative.
export function isCuratedMemoryPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const mem = normalized.startsWith('memory/') ? normalized.slice('memory/'.length) : normalized;
  if (mem.startsWith('scopes/')) return true; // promoted (managed-space) + durable scope writes
  if (mem.startsWith('_mcp/promoted/')) return true; // promoted (existing-memory-root)
  if (mem.startsWith('inbox/')) return true; // durable inbox
  if (mem.startsWith('projects/') || normalized.startsWith('projects/')) return true; // durable projects
  if (/^\d{4}-\d{2}-\d{2}\.md$/.test(mem)) return true; // durable dated daily memory
  return false;
}
