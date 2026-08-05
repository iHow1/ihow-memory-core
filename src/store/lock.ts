// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Workspace } from '../types.ts';

const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 5000;
// A lock held longer than this is treated as orphaned. Legitimate locked operations are sub-second;
// even the longest holder (an index rebuild) is far under this, so a lock older than the TTL almost
// certainly belongs to a process that crashed mid-write. The dead-PID probe below catches most crashes
// immediately; the TTL is the backstop for when the PID can't be determined.
const LOCK_STALE_MS = 60_000;

// File locks coordinate separate processes. Within one process, let callers wait on a per-path queue
// before starting the file-lock acquisition budget; otherwise a large local burst can spend the entire
// timeout polling a lock held by an earlier caller from this same process.
const localLockTails = new Map<string, Promise<void>>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Liveness probe: is the process that wrote this lock still running? signal 0 doesn't actually signal,
// it just checks existence/permission. true = alive, false = definitely gone, null = can't tell.
function pidAlive(pid: number): boolean | null {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false; // no such process — the writer is gone
    if (code === 'EPERM') return true; // exists but owned by another user — alive
    return null;
  }
}

// Decide whether an existing lock file is orphaned (safe to steal): either the process that wrote it is
// gone, or it has been held past the TTL. The file content is "<pid>\n<iso>\n" written right after the
// exclusive open — a holder may have created the file but not yet written it, so an unreadable/empty/
// unparseable lock is treated as NOT-yet-stale (let the normal retry handle a just-created lock).
async function lockIsStale(lockPath: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await fs.readFile(lockPath, 'utf8');
  } catch {
    return false;
  }
  const [pidLine, atLine] = raw.split('\n');
  const pid = Number.parseInt((pidLine || '').trim(), 10);
  if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
    const alive = pidAlive(pid);
    if (alive === false) return true; // the writer process is gone — orphaned, safe to steal
    if (alive === true) return false; // the writer is ALIVE — never steal, even past the TTL (it may be a
    // legitimately slow critical section: a big index rebuild, slow disk, a debugger pause). Stealing here
    // would put two processes in the critical section. alive === null (can't tell) falls through to the TTL.
  }
  const at = Date.parse((atLine || '').trim());
  // TTL backstop — only reached when the lock has no parseable foreign PID or liveness is unknowable.
  if (!Number.isNaN(at) && Date.now() - at > LOCK_STALE_MS) return true;
  return false;
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

async function withFileLock<T>(workspace: Workspace, fn: () => Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(workspace.lockPath), { recursive: true });
  const started = Date.now();
  let handle: fs.FileHandle | undefined;
  while (!handle) {
    try {
      handle = await fs.open(workspace.lockPath, 'wx');
      await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // Someone holds it. If it's orphaned (dead writer or held past the TTL), reclaim it; otherwise wait.
      if (await lockIsStale(workspace.lockPath)) {
        // Steal atomically via rename so two racers can't both "steal" the same lock and end up both
        // holding it: only one rename wins; the loser's rename throws and falls through to retry.
        const stealPath = `${workspace.lockPath}.stale-${process.pid}`;
        try {
          await fs.rename(workspace.lockPath, stealPath);
          await fs.rm(stealPath, { force: true });
        } catch {
          // another writer won the steal, or the lock was released meanwhile — just retry
        }
        continue;
      }
      if (Date.now() - started > LOCK_TIMEOUT_MS) throw new Error('workspace_lock_timeout');
      await sleep(LOCK_RETRY_MS);
    }
  }

  try {
    return await fn();
  } finally {
    try {
      await handle.close();
    } finally {
      await fs.rm(workspace.lockPath, { force: true });
    }
  }
}

export async function withWorkspaceLock<T>(workspace: Workspace, fn: () => Promise<T>): Promise<T> {
  const releaseLocalTurn = await waitForLocalLockTurn(workspace.lockPath);
  try {
    return await withFileLock(workspace, fn);
  } finally {
    releaseLocalTurn();
  }
}
