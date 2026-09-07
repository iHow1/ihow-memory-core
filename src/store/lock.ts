// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Workspace } from '../types.ts';

type LockSnapshot = { stat: Stats; raw: string; pid: number | null };
type PreparedOwner = { path: string; stat: Stats };
type LockOptions = { retryMs?: number; timeoutMs?: number; staleMs?: number; timeoutError?: string; recoveryError?: string };
const localLockTails = new Map<string, Promise<void>>();
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function unchanged(a: LockSnapshot, b: LockSnapshot): boolean {
  return sameFile(a.stat, b.stat) && a.stat.size === b.stat.size && a.stat.mtimeMs === b.stat.mtimeMs
    && a.stat.ctimeMs === b.stat.ctimeMs && a.raw === b.raw;
}

// Read metadata and contents from one descriptor, then check that the pathname still names it.
async function snapshot(file: string): Promise<LockSnapshot | null> {
  let handle: fs.FileHandle | undefined;
  try {
    const named = await fs.lstat(file);
    if (!named.isFile() || named.size > 4096) return null;
    handle = await fs.open(file, 'r');
    const before = await handle.stat();
    const raw = await handle.readFile('utf8');
    const stat = await handle.stat();
    const after = await fs.lstat(file);
    if (!sameFile(named, stat) || !sameFile(stat, after) || before.size !== stat.size
      || before.mtimeMs !== stat.mtimeMs || before.ctimeMs !== stat.ctimeMs) return null;
    const line = (raw.split('\n')[0] || '').trim();
    const number = /^[1-9]\d*$/.test(line) ? Number(line) : NaN;
    return { stat, raw, pid: Number.isSafeInteger(number) && number <= 0x7fffffff ? number : null };
  } catch (error) {
    if (code(error) === 'ENOENT') return null;
    throw error;
  } finally {
    await handle?.close();
  }
}

function isStale(lock: LockSnapshot, staleMs: number): boolean {
  if (lock.pid !== null) {
    try {
      process.kill(lock.pid, 0);
      return false; // Includes our own PID: separate module instances can share one process.
    } catch (error) {
      if (code(error) === 'ESRCH') return true;
      return false; // EPERM or unknown liveness never grants permission to steal a lock.
    }
  }
  // A legacy writer may be between exclusive creation and writing its owner record. Filesystem age
  // supplies the missing timestamp, but a fresh/clock-skewed malformed record remains protected.
  return Date.now() - lock.stat.mtimeMs > staleMs;
}

// Initialize privately, then link atomically with no replacement. Contenders never see a new empty
// lock, and an initialization failure cannot leak the public lock or its descriptor. Same-directory
// hard links preserve the existing regular-file PID format used by older clients.
async function prepareOwner(file: string): Promise<PreparedOwner> {
  const temporary = `${file}.owner-${process.pid}-${crypto.randomUUID()}`;
  let handle: fs.FileHandle | undefined;
  let created = false;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    created = true;
    await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`, 'utf8');
    const stat = await handle.stat();
    await handle.close();
    handle = undefined;
    return { path: temporary, stat };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (created) await fs.rm(temporary, { force: true });
    throw error;
  }
}

async function unlinkOwned(file: string, owner: PreparedOwner): Promise<boolean> {
  try {
    const stat = await fs.lstat(file);
    if (!sameFile(stat, owner.stat)) return false;
    await fs.unlink(file);
    return true;
  } catch (error) {
    if (code(error) === 'ENOENT') return false;
    throw error;
  }
}

async function reclaim(file: string, observed: LockSnapshot, staleMs: number, recoveryError: string): Promise<boolean> {
  // Serialize reapers and revalidate after acquiring the guard. A stale observer must never rename
  // a replacement live lock. Normal publishers can still acquire after the stale lock is removed.
  const guard = `${file}.reclaim`;
  const owner = await prepareOwner(guard);
  let acquired = false;
  try {
    try {
      await fs.link(owner.path, guard);
      acquired = true;
    } catch (error) {
      if (code(error) !== 'EEXIST') throw error;
      const held = await snapshot(guard);
      // Do not recursively steal a recovery guard: racing recovery-of-recovery would recreate the
      // same unlink race. A crash during this tiny section fails explicitly for operator recovery.
      if (held && isStale(held, staleMs)) throw new Error(recoveryError);
      return false;
    }
    const current = await snapshot(file);
    if (!current || !unchanged(observed, current) || !isStale(current, staleMs)) return false;
    await fs.unlink(file);
    return true;
  } finally {
    try {
      if (acquired) await unlinkOwned(guard, owner);
    } finally {
      await fs.rm(owner.path, { force: true });
    }
  }
}

// Path-level lock also serves short-budget ledgers; it does not add a same-process queue.
export async function withPathLock<T>(file: string, fn: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const { retryMs = 25, timeoutMs = 5000, staleMs = 60_000,
    timeoutError = 'workspace_lock_timeout', recoveryError = 'workspace_lock_recovery_interrupted' } = options;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const started = Date.now();
  const owner = await prepareOwner(file);
  let acquired = false;
  try {
    while (!acquired) {
      try {
        await fs.link(owner.path, file);
        acquired = true;
      } catch (error) {
        if (code(error) !== 'EEXIST') throw error;
        if (Date.now() - started >= timeoutMs) throw new Error(timeoutError);
        const observed = await snapshot(file);
        if (observed && isStale(observed, staleMs)
          && await reclaim(file, observed, staleMs, recoveryError)) continue;
        await sleep(retryMs);
      }
    }
    await fs.rm(owner.path, { force: true });
    return await fn();
  } finally {
    try {
      if (acquired && !await unlinkOwned(file, owner)) throw new Error('workspace_lock_ownership_lost');
    } finally {
      await fs.rm(owner.path, { force: true });
    }
  }
}

async function waitForLocalLockTurn(lockPath: string): Promise<() => void> {
  const previous = localLockTails.get(lockPath);
  let releaseTurn!: () => void;
  const turn = new Promise<void>((resolve) => { releaseTurn = resolve; });
  localLockTails.set(lockPath, turn);
  if (previous) await previous;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseTurn();
    if (localLockTails.get(lockPath) === turn) localLockTails.delete(lockPath);
  };
}

export async function withWorkspaceLock<T>(workspace: Workspace, fn: () => Promise<T>): Promise<T> {
  const releaseLocalTurn = await waitForLocalLockTurn(workspace.lockPath);
  try {
    return await withPathLock(workspace.lockPath, fn);
  } finally {
    releaseLocalTurn();
  }
}
