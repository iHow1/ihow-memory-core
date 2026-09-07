// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

export function validateEvidence(manifest, bytes, source) {
  assert.equal(manifest?.releaseEligible, true, 'release evidence must be eligible');
  assert.equal(manifest?.source?.dirtyBeforeEvidence, false, 'evidence source must be clean');
  assert.equal(manifest?.package?.name, 'ihow-memory');
  assert.match(manifest.package.version, /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/);
  assert.equal(manifest.package.filename, `ihow-memory-${manifest.package.version}.tgz`);
  assert.equal(manifest.package.sha256, sha(bytes), 'artifact hash mismatch');
  assert.equal(manifest.package.bytes, bytes.length, 'artifact size mismatch');
  assert.equal(source.dirty, false, 'current source must be clean');
  assert.equal(manifest.source.gitHead, source.head, 'source HEAD mismatch');
  assert.equal(manifest.source.gitTree, source.tree, 'source tree mismatch');
}

export function archiveFiles(listing) {
  const entries = listing.trim().split('\n').filter((name) => name && !name.endsWith('/'));
  assert.equal(new Set(entries).size, entries.length, 'duplicate archive member');
  for (const name of entries) {
    assert.ok(name.startsWith('package/') && !name.includes('\\')
      && name.split('/').every((part) => part && part !== '.' && part !== '..'), 'unsafe archive member');
  }
  return entries;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed: ${String(result.stderr || '').slice(-2000)}`);
  return result.stdout;
}

function startMcp(server, dataRoot, space, env) {
  const child = spawn(process.execPath, [server, '--root', dataRoot, '--space', space, '--engine', 'fts'],
    { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let counter = 0;
  child.stderr.resume();
  const lines = readline.createInterface({ input: child.stdout });
  const rejectPending = (error) => {
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(error); }
    pending.clear();
  };
  child.once('error', rejectPending);
  child.stdin.on('error', rejectPending);
  child.once('exit', () => rejectPending(new Error('artifact_mcp_exited')));
  lines.on('line', (line) => {
    try {
      const row = JSON.parse(line), request = pending.get(row.id);
      if (!request) return;
      pending.delete(row.id); clearTimeout(request.timer);
      if (row.error) request.reject(new Error(`artifact_mcp_error:${row.error.message}`));
      else request.resolve(row.result);
    } catch (error) { rejectPending(error); }
  });
  return {
    rpc(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++counter;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('artifact_mcp_timeout')); }, 15_000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise((resolve) => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.kill('SIGTERM');
      });
      lines.close();
    },
  };
}

export async function verifyArtifact(evidencePath) {
  const manifest = JSON.parse(await fs.readFile(evidencePath, 'utf8'));
  assert.equal(path.basename(manifest.package.filename), manifest.package.filename, 'unsafe artifact filename');
  const archive = path.join(path.dirname(evidencePath), manifest.package.filename);
  const bytes = await fs.readFile(archive);
  validateEvidence(manifest, bytes, {
    head: run('git', ['rev-parse', 'HEAD']).trim(), tree: run('git', ['rev-parse', 'HEAD^{tree}']).trim(),
    dirty: Boolean(run('git', ['status', '--porcelain']).trim()),
  });
  const members = archiveFiles(run('tar', ['-tzf', archive]));
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-exact-artifact-'));
  const clients = [];
  try {
    const env = Object.fromEntries(['PATH', 'SystemRoot', 'TMPDIR', 'LANG', 'LC_ALL'].filter((k) => process.env[k])
      .map((k) => [k, process.env[k]]));
    Object.assign(env, { HOME: temp, IHOW_CAPTURE_FLOOR: '0' });
    await fs.writeFile(path.join(temp, 'package.json'), JSON.stringify({ private: true, name: 'artifact-proof', version: '0.0.0' }));
    run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', archive], { cwd: temp, env });
    const installed = path.join(temp, 'node_modules', 'ihow-memory');
    for (const member of members) {
      const destination = path.join(installed, member.slice('package/'.length));
      assert.equal((await fs.lstat(destination)).isFile(), true, 'installed member must be a regular file');
      const expected = run('tar', ['-xOf', archive, member], { encoding: null });
      assert.equal(sha(await fs.readFile(destination)), sha(expected), `installed bytes mismatch: ${member}`);
    }
    const pkg = JSON.parse(await fs.readFile(path.join(installed, 'package.json'), 'utf8'));
    assert.equal(pkg.name, manifest.package.name); assert.equal(pkg.version, manifest.package.version);
    assert.deepEqual(pkg.dependencies ?? {}, {}, 'Core must have no runtime dependencies');
    assert.equal(run(process.execPath, [path.join(installed, 'bin/ihow-memory.mjs'), '--version'], { env }).trim(), pkg.version);
    const dataRoot = path.join(temp, 'data');
    const stale = path.join(dataRoot, 'first', '.lock');
    await fs.mkdir(path.dirname(stale), { recursive: true });
    await fs.writeFile(stale, ''); await fs.utimes(stale, new Date(0), new Date(0));
    const start = async (space) => {
      const client = startMcp(path.join(installed, 'dist/mcp/server.js'), dataRoot, space, env);
      clients.push(client);
      const init = await client.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'artifact-proof', version: '1' } });
      assert.equal(init.serverInfo.version, pkg.version);
      return client;
    };
    const call = async (client, name, args) => (await client.rpc('tools/call', { name, arguments: args })).structuredContent;
    const first = await start('first');
    const toolNames = (await first.rpc('tools/list')).tools.map((row) => row.name);
    for (const name of ['memory.search', 'memory.read', 'memory.write_candidate']) assert.ok(toolNames.includes(name));
    const marker = 'Quartzviolet observatory recorded twelve comets.';
    const written = await call(first, 'memory.write_candidate', { title: 'Synthetic observation', text: marker, sourceAgent: 'artifact-proof' });
    assert.equal(written.status, 'promoted');
    const hits = (await call(first, 'memory.search', { query: 'Quartzviolet' })).results;
    assert.ok(hits.length);
    assert.ok((await call(first, 'memory.read', { ref: hits[0].path, mode: 'full' })).content.includes(marker));
    const second = await start('second');
    assert.deepEqual((await call(second, 'memory.search', { query: 'Quartzviolet' })).results, []);
    await first.stop();
    const restarted = await start('first');
    assert.ok((await call(restarted, 'memory.search', { query: 'Quartzviolet' })).results.length);
    assert.equal(sha(await fs.readFile(archive)), manifest.package.sha256, 'artifact changed during verification');
    return { status: 'PASS', version: pkg.version, artifactSha256: manifest.package.sha256,
      gitHead: manifest.source.gitHead, gitTree: manifest.source.gitTree, installedFiles: members.length,
      tools: toolNames.length, checks: ['offline-fresh-install', 'installed-byte-integrity', 'cli-version',
        'mcp-initialize', 'aged-empty-lock-recovery', 'write-search-read', 'space-isolation', 'restart-persistence'], paidModelCalls: 0 };
  } finally {
    for (const client of clients) await client.stop();
    await fs.rm(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const evidencePath = path.resolve(ROOT, process.argv[2] || 'release-evidence/release-evidence.json');
  const report = await verifyArtifact(evidencePath);
  await fs.writeFile(path.join(path.dirname(evidencePath), 'artifact-verification.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
}
