// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Lock correctness for the multi-agent shared store:
//  (1) cross-cwd anchoring — in existing-memory-root mode every agent sharing a --memory-root must
//      contend on the SAME lock regardless of cwd/stateRoot (the lock follows the data, mcpDir/.lock),
//      otherwise the whole-file read-modify-write in appendJournal loses updates;
//  (2) stale-lock recovery — a lock orphaned by a crashed writer (dead PID, or held past the TTL) is
//      reclaimed instead of wedging every subsequent writer into workspace_lock_timeout forever.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveWorkspace } from '../src/workspace.ts';
import { withWorkspaceLock } from '../src/store/lock.ts';

async function mkdtempReal(prefix) {
  return await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

test('existing-memory-root: lock is shared across cwds (follows the data, not the per-cwd state)', async (t) => {
  const memoryRoot = await mkdtempReal('ihow-lock-mem-');
  t.after(async () => { await fs.rm(memoryRoot, { recursive: true, force: true }); });

  const a = resolveWorkspace({ memoryRoot, cwd: '/tmp/project-a', stateRoot: '/tmp/state-a' });
  const b = resolveWorkspace({ memoryRoot, cwd: '/tmp/project-b', stateRoot: '/tmp/state-b' });

  assert.equal(a.lockPath, b.lockPath, 'two agents with the same memory root must use the same lock file');
  assert.ok(a.lockPath.includes(`${path.sep}_mcp${path.sep}`), 'lock lives under the shared mcp dir');
  // and the lock is NOT under the per-cwd state dirs that used to fork it
  assert.ok(!a.lockPath.startsWith('/tmp/state-a'), 'lock is not anchored to the per-cwd state root');
});

test('stale lock with a dead PID is reclaimed (not a permanent wedge)', async (t) => {
  const memoryRoot = await mkdtempReal('ihow-lock-dead-');
  t.after(async () => { await fs.rm(memoryRoot, { recursive: true, force: true }); });
  const ws = resolveWorkspace({ memoryRoot, cwd: memoryRoot });

  await fs.mkdir(path.dirname(ws.lockPath), { recursive: true });
  // A crashed writer left this behind: an almost-certainly-dead PID + a recent timestamp.
  await fs.writeFile(ws.lockPath, `999999\n${new Date().toISOString()}\n`, 'utf8');

  let ran = false;
  await withWorkspaceLock(ws, async () => { ran = true; });
  assert.ok(ran, 'should steal the orphaned lock and run');
  await assert.rejects(fs.access(ws.lockPath), 'lock is released after the critical section');
});

test('stale lock held past the TTL is reclaimed even if the PID looks alive', async (t) => {
  const memoryRoot = await mkdtempReal('ihow-lock-ttl-');
  t.after(async () => { await fs.rm(memoryRoot, { recursive: true, force: true }); });
  const ws = resolveWorkspace({ memoryRoot, cwd: memoryRoot });

  await fs.mkdir(path.dirname(ws.lockPath), { recursive: true });
  // Our own (live) PID, but a timestamp far past the staleness TTL → reclaim via the TTL backstop.
  await fs.writeFile(ws.lockPath, `${process.pid}\n2000-01-01T00:00:00.000Z\n`, 'utf8');

  let ran = false;
  await withWorkspaceLock(ws, async () => { ran = true; });
  assert.ok(ran, 'a lock held past the TTL must be reclaimable');
});

test('a lock held by a LIVE foreign process is NOT stolen even past the TTL (no double critical section)', async (t) => {
  const memoryRoot = await mkdtempReal('ihow-lock-live-');
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  t.after(async () => { child.kill('SIGKILL'); await fs.rm(memoryRoot, { recursive: true, force: true }); });
  const ws = resolveWorkspace({ memoryRoot, cwd: memoryRoot });

  await fs.mkdir(path.dirname(ws.lockPath), { recursive: true });
  // Live foreign PID + an ancient timestamp: the TTL is exceeded, but the writer is demonstrably alive, so
  // stealing would put two processes in the critical section. It must wait and time out, not steal.
  await fs.writeFile(ws.lockPath, `${child.pid}\n2000-01-01T00:00:00.000Z\n`, 'utf8');
  await assert.rejects(withWorkspaceLock(ws, async () => {}), /workspace_lock_timeout/);
});

test('concurrent appends under one lock do not lose updates', async (t) => {
  const memoryRoot = await mkdtempReal('ihow-lock-conc-');
  t.after(async () => { await fs.rm(memoryRoot, { recursive: true, force: true }); });
  const ws = resolveWorkspace({ memoryRoot, cwd: memoryRoot });
  const file = path.join(memoryRoot, 'counter.txt');
  await fs.writeFile(file, '', 'utf8');

  // 40 racing read-modify-write appends serialized by the lock; all must survive.
  await Promise.all(
    Array.from({ length: 40 }, (_, i) =>
      withWorkspaceLock(ws, async () => {
        const cur = await fs.readFile(file, 'utf8');
        await fs.writeFile(file, `${cur}${i}\n`, 'utf8');
      }),
    ),
  );
  const lines = (await fs.readFile(file, 'utf8')).trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 40, 'no lost updates under contention');
  assert.equal(new Set(lines).size, 40, 'every writer landed exactly once');
});
