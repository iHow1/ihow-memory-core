// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { withWorkspaceLock, withPathLock } from '../src/store/lock.ts';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-lock-recovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, lockPath: path.join(root, '.lock') };
}

for (const [label, content] of [['empty', ''], ['malformed', 'interrupted owner record'], ['out-of-range PID', '9007199254740000\n']]) {
  test(`an old ${label} lock recovers using filesystem age`, async (t) => {
    const ws = await fixture(t);
    await fs.writeFile(ws.lockPath, content);
    const old = new Date(Date.now() - 120_000);
    await fs.utimes(ws.lockPath, old, old);
    let entered = false;
    await withWorkspaceLock(ws, async () => { entered = true; });
    assert.equal(entered, true);
    await assert.rejects(fs.access(ws.lockPath), { code: 'ENOENT' });
  });
}

test('a fresh empty legacy lock is allowed to finish initialization', async (t) => {
  const ws = await fixture(t);
  await fs.writeFile(ws.lockPath, '');
  let released = false;
  const holder = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
    await fs.writeFile(ws.lockPath, `${process.pid}\n${new Date().toISOString()}\n`);
    await new Promise((resolve) => setTimeout(resolve, 80));
    released = true;
    await fs.rm(ws.lockPath);
  })();
  await withWorkspaceLock(ws, async () => assert.equal(released, true));
  await holder;
});

test('owner-record write failure never publishes or leaks a lock', async (t) => {
  const ws = await fixture(t);
  const original = fs.open;
  let failedHandle;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await original(...args);
    if (String(args[0]).startsWith(ws.root) && args[1] === 'wx') {
      failedHandle = handle;
      handle.writeFile = async () => { throw Object.assign(new Error('injected_disk_failure'), { code: 'ENOSPC' }); };
    }
    return handle;
  });
  t.after(async () => { await failedHandle?.close().catch(() => {}); });
  await assert.rejects(withWorkspaceLock(ws, async () => assert.fail('must not enter')), /injected_disk_failure/);
  assert.deepEqual(await fs.readdir(ws.root), [], 'failed initialization must leave no published or temporary lock');
});

test('publication exposes a complete legacy-compatible owner record atomically', async (t) => {
  const ws = await fixture(t);
  const link = fs.link;
  let observed = false;
  t.mock.method(fs, 'link', async (from, to) => {
    if (to === ws.lockPath) {
      assert.match(await fs.readFile(from, 'utf8'), new RegExp(`^${process.pid}\\n\\d{4}-.*Z\\n$`));
      await assert.rejects(fs.access(to), { code: 'ENOENT' });
      observed = true;
    }
    return link(from, to);
  });
  await withWorkspaceLock(ws, async () => assert.equal(observed, true));
  assert.deepEqual(await fs.readdir(ws.root), []);
});

test('unsupported atomic publication fails without entering or leaking files', async (t) => {
  const ws = await fixture(t);
  t.mock.method(fs, 'link', async () => { throw Object.assign(new Error('unsupported_hard_links'), { code: 'ENOTSUP' }); });
  await assert.rejects(withWorkspaceLock(ws, async () => assert.fail('must not enter')), { code: 'ENOTSUP' });
  assert.deepEqual(await fs.readdir(ws.root), []);
});

test('an ancient lock with our own live PID is not stolen by another local caller', async (t) => {
  const ws = await fixture(t);
  const record = `${process.pid}\n2000-01-01T00:00:00.000Z\n`;
  await fs.writeFile(ws.lockPath, record);
  const old = new Date(Date.now() - 120_000);
  await fs.utimes(ws.lockPath, old, old);
  await assert.rejects(withPathLock(ws.lockPath, async () => assert.fail('must not enter'),
    { timeoutMs: 70, retryMs: 5 }), /workspace_lock_timeout/);
  assert.equal(await fs.readFile(ws.lockPath, 'utf8'), record);
});

for (const errorCode of ['EPERM', 'EIO']) {
  test(`uncertain or permission-denied owner liveness is protected (${errorCode})`, async (t) => {
    const ws = await fixture(t);
    await fs.writeFile(ws.lockPath, '999998\n2000-01-01T00:00:00.000Z\n');
    const old = new Date(Date.now() - 120_000);
    await fs.utimes(ws.lockPath, old, old);
    t.mock.method(process, 'kill', () => { throw Object.assign(new Error('injected_probe_error'), { code: errorCode }); });
    await assert.rejects(withPathLock(ws.lockPath, async () => assert.fail('must not enter'),
      { timeoutMs: 70, retryMs: 5 }), /workspace_lock_timeout/);
  });
}

test('a fresh malformed lock cannot be stolen using an ancient embedded date', async (t) => {
  const ws = await fixture(t);
  await fs.writeFile(ws.lockPath, 'unknown\n2000-01-01T00:00:00.000Z\n');
  await assert.rejects(withPathLock(ws.lockPath, async () => assert.fail('must not enter'),
    { timeoutMs: 70, retryMs: 5 }), /workspace_lock_timeout/);
});

test('an interrupted recovery guard fails explicitly instead of recursively stealing', async (t) => {
  const ws = await fixture(t);
  await fs.writeFile(ws.lockPath, '999999\n2000-01-01T00:00:00.000Z\n');
  await fs.writeFile(`${ws.lockPath}.reclaim`, '999999\n2000-01-01T00:00:00.000Z\n');
  await assert.rejects(withWorkspaceLock(ws, async () => assert.fail('must not enter')), /workspace_lock_recovery_interrupted/);
  assert.deepEqual((await fs.readdir(ws.root)).sort(), ['.lock', '.lock.reclaim']);
});

test('a paused stale observer cannot remove a replacement live lock', { timeout: 10_000 }, async (t) => {
  const ws = await fixture(t);
  await fs.writeFile(ws.lockPath, '999999\n2000-01-01T00:00:00.000Z\n');
  const link = fs.link;
  let resume, observed, enteredSecond, releaseSecond;
  const paused = new Promise((resolve) => { observed = resolve; });
  const secondEntered = new Promise((resolve) => { enteredSecond = resolve; });
  let firstGate = true, firstEntered = false;
  t.mock.method(fs, 'link', async (from, to) => {
    if (to === `${ws.lockPath}.reclaim` && firstGate) {
      firstGate = false;
      observed();
      await new Promise((resolve) => { resume = resolve; });
    }
    return link(from, to);
  });
  t.after(() => { resume?.(); releaseSecond?.(); });
  const first = withPathLock(ws.lockPath, async () => { firstEntered = true; });
  await paused;
  const second = withPathLock(ws.lockPath, async () => {
    enteredSecond();
    await new Promise((resolve) => { releaseSecond = resolve; });
  });
  await secondEntered;
  const heldInode = (await fs.stat(ws.lockPath)).ino;
  resume();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(firstEntered, false);
  assert.equal((await fs.stat(ws.lockPath)).ino, heldInode);
  releaseSecond();
  await Promise.all([first, second]);
  assert.equal(firstEntered, true);
  assert.deepEqual(await fs.readdir(ws.root), []);
});

function child(t, source, args) {
  const processChild = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '--eval', source, ...args],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  processChild.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => {
    processChild.once('error', reject);
    processChild.once('exit', (code, signal) => resolve({ code, signal, stderr }));
  });
  t.after(async () => { if (processChild.exitCode === null && processChild.signalCode === null) processChild.kill('SIGKILL'); await exited; });
  return { processChild, exited };
}

test('a writer killed before legacy initialization leaves a recoverable empty lock', { timeout: 10_000 }, async (t) => {
  const ws = await fixture(t);
  const run = child(t, `import fs from 'node:fs/promises';
    await fs.open(process.argv[1], 'wx'); process.send('ready'); setInterval(() => {}, 1000);`, [ws.lockPath]);
  await new Promise((resolve) => run.processChild.once('message', resolve));
  run.processChild.kill('SIGKILL');
  await run.exited;
  assert.equal((await fs.stat(ws.lockPath)).size, 0);
  const old = new Date(Date.now() - 120_000);
  await fs.utimes(ws.lockPath, old, old);
  await withWorkspaceLock(ws, async () => {});
});

test('a writer killed inside the new critical section is recovered by dead PID', { timeout: 10_000 }, async (t) => {
  const ws = await fixture(t);
  const moduleUrl = new URL('../src/store/lock.ts', import.meta.url).href;
  const run = child(t, `import { withPathLock } from ${JSON.stringify(moduleUrl)};
    await withPathLock(process.argv[1], async () => { process.send('ready'); await new Promise(() => { setInterval(() => {}, 1000); }); });`, [ws.lockPath]);
  await new Promise((resolve) => run.processChild.once('message', resolve));
  assert.match(await fs.readFile(ws.lockPath, 'utf8'), new RegExp(`^${run.processChild.pid}\\n`));
  run.processChild.kill('SIGKILL');
  assert.equal((await run.exited).signal, 'SIGKILL');
  await withWorkspaceLock(ws, async () => {});
  assert.deepEqual(await fs.readdir(ws.root), []);
});

test('six processes recover one empty lock and preserve every read-modify-write', { timeout: 20_000 }, async (t) => {
  const ws = await fixture(t);
  await fs.writeFile(ws.lockPath, '');
  const old = new Date(Date.now() - 120_000);
  await fs.utimes(ws.lockPath, old, old);
  const counter = path.join(ws.root, 'counter');
  const inside = path.join(ws.root, 'critical-section');
  await fs.writeFile(counter, '0');
  const moduleUrl = new URL('../src/store/lock.ts', import.meta.url).href;
  const source = `import fs from 'node:fs/promises';
    import { withPathLock } from ${JSON.stringify(moduleUrl)};
    const [lock, counter, inside] = process.argv.slice(1);
    await new Promise(resolve => { process.once('message', resolve); process.send('ready'); });
    for (let i=0; i<12; i++) await withPathLock(lock, async () => {
      const marker = await fs.open(inside, 'wx');
      const n = Number(await fs.readFile(counter, 'utf8'));
      await new Promise(resolve => setTimeout(resolve, 4));
      await fs.writeFile(counter, String(n+1));
      await marker.close(); await fs.unlink(inside);
    }); process.disconnect();`;
  const runs = Array.from({ length: 6 }, () => child(t, source, [ws.lockPath, counter, inside]));
  await Promise.all(runs.map(({ processChild }) => new Promise((resolve) => processChild.once('message', resolve))));
  runs.forEach(({ processChild }) => processChild.send('start'));
  const results = await Promise.all(runs.map(({ exited }) => exited));
  assert.ok(results.every((r) => r.code === 0), JSON.stringify(results));
  assert.equal(await fs.readFile(counter, 'utf8'), '72');
  assert.deepEqual(await fs.readdir(ws.root), ['counter']);
});
