// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'src', 'cli.ts');

async function fixture(t, { addDelayMs = 0 } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-managed-root-')));
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-managed-home-')));
  const bin = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-managed-bin-')));
  const receipt = path.join(home, '.product', 'claude-code.json');
  const addMarker = path.join(home, '.product', 'add-entered');
  const shim = path.join(bin, 'claude');
  await fs.writeFile(shim, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
const configPath = path.join(process.env.HOME, '.claude.json');
const load = () => { try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { return {}; } };
const entry = () => load().mcpServers?.['ihow-memory'];
if (argv[0] !== 'mcp') process.exit(0);
if (argv[1] === 'get') {
  const current = entry();
  if (!current) { process.stderr.write('No MCP server found with name: "ihow-memory". No MCP servers are configured.\\n'); process.exit(1); }
  console.log('ihow-memory:'); console.log('  Scope: User config (available in all your projects)'); console.log('  Status: connected');
  process.exit(0);
}
if (argv[1] === 'list') { if (entry()) console.log('ihow-memory: connected'); process.exit(0); }
if (argv[1] === 'add-json') {
  const marker = process.env.IHOW_TEST_ADD_MARKER;
  if (marker) { fs.mkdirSync(path.dirname(marker), { recursive: true }); fs.writeFileSync(marker, 'entered'); }
  const delay = Number(process.env.IHOW_TEST_ADD_DELAY_MS || 0);
  if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
  if (entry()) { process.stderr.write('MCP server ihow-memory already exists in user config\\n'); process.exit(1); }
  const config = load(); config.mcpServers ||= {}; config.mcpServers['ihow-memory'] = JSON.parse(argv.at(-1));
  fs.mkdirSync(path.dirname(configPath), { recursive: true }); fs.writeFileSync(configPath, JSON.stringify(config)); process.exit(0);
}
if (argv[1] === 'remove') {
  const config = load(); delete config.mcpServers?.['ihow-memory'];
  fs.mkdirSync(path.dirname(configPath), { recursive: true }); fs.writeFileSync(configPath, JSON.stringify(config)); process.exit(0);
}
process.exit(0);
`, 'utf8');
  await fs.chmod(shim, 0o755);
  t.after(async () => {
    await Promise.all([root, home, bin].map((directory) => fs.rm(directory, { recursive: true, force: true })));
  });
  return { root, home, bin, receipt, addDelayMs, addMarker };
}

function runManaged(f, command, { allowFailure = false } = {}) {
  const args = [CLI, command, '--runtime', 'claude-code', '--managed', '--receipt', f.receipt, '--root', f.root, '--space', 'desktop', '--json'];
  try {
    return JSON.parse(execFileSync(process.execPath, args, {
      cwd: REPO,
      encoding: 'utf8',
      env: { ...process.env, HOME: f.home, PATH: `${f.bin}:/usr/bin:/bin`, IHOW_HANDOFF_METRICS: '0', IHOW_TEST_ADD_DELAY_MS: String(f.addDelayMs || 0), IHOW_TEST_ADD_MARKER: f.addMarker },
    }));
  } catch (error) {
    if (allowFailure) return { error: `${error.stderr || ''}${error.stdout || ''}` };
    throw error;
  }
}

async function claudeEntry(home) {
  const config = JSON.parse(await fs.readFile(path.join(home, '.claude.json'), 'utf8'));
  return config.mcpServers?.['ihow-memory'];
}

test('managed Claude connection writes a bound receipt and disconnect removes only that registration', async (t) => {
  const f = await fixture(t);
  const available = runManaged(f, 'connection-status');
  assert.equal(available.status, 'available');
  assert.equal(available.canConnect, true);
  const connected = runManaged(f, 'connect');
  assert.equal(connected.verified, true);
  assert.equal(connected.managed, true);
  assert.equal(connected.receipt.status, 'connected');
  assert.ok(await claudeEntry(f.home));
  const verified = runManaged(f, 'connection-status');
  assert.equal(verified.status, 'verified');
  assert.equal(verified.verified, true);
  assert.equal(verified.canDisconnect, true);

  const disconnected = runManaged(f, 'disconnect');
  assert.equal(disconnected.changed, true);
  assert.equal(disconnected.verified, true);
  assert.equal(await claudeEntry(f.home), undefined);
  assert.equal(JSON.parse(await fs.readFile(f.receipt, 'utf8')).status, 'disconnected');
  const closed = runManaged(f, 'connection-status');
  assert.equal(closed.status, 'disconnected');
  assert.equal(closed.verified, true);

  const repeated = runManaged(f, 'disconnect');
  assert.equal(repeated.changed, false);
  assert.equal(repeated.verified, true);
});

test('managed Claude connection can reconnect after its prior receipt is safely closed', async (t) => {
  const f = await fixture(t);
  const first = runManaged(f, 'connect');
  const firstReceiptId = first.receipt.receiptId;
  runManaged(f, 'disconnect');
  const closed = runManaged(f, 'connection-status');
  assert.equal(closed.status, 'disconnected');
  assert.equal(closed.canConnect, true);

  const second = runManaged(f, 'connect');
  assert.equal(second.verified, true);
  assert.notEqual(second.receipt.receiptId, firstReceiptId);
  assert.equal(JSON.parse(await fs.readFile(f.receipt, 'utf8')).status, 'connected');
});

test('managed receipt parser rejects extra authority fields without touching Claude config', async (t) => {
  const f = await fixture(t);
  runManaged(f, 'connect');
  const configPath = path.join(f.home, '.claude.json');
  const before = await fs.readFile(configPath, 'utf8');
  const receipt = JSON.parse(await fs.readFile(f.receipt, 'utf8'));
  await fs.writeFile(f.receipt, JSON.stringify({ ...receipt, authority: 'forged' }));

  const status = runManaged(f, 'connection-status', { allowFailure: true });
  assert.match(status.error, /managed_runtime_receipt_invalid/);
  const disconnect = runManaged(f, 'disconnect', { allowFailure: true });
  assert.match(disconnect.error, /managed_runtime_receipt_invalid/);
  assert.equal(await fs.readFile(configPath, 'utf8'), before);
});

test('managed connect rechecks for a racing registration before any replacement', async (t) => {
  const f = await fixture(t, { addDelayMs: 600 });
  const configPath = path.join(f.home, '.claude.json');
  const child = import('node:child_process').then(({ spawn }) => spawn(process.execPath, [
    CLI, 'connect', '--runtime', 'claude-code', '--managed', '--receipt', f.receipt,
    '--root', f.root, '--space', 'desktop', '--json',
  ], {
    cwd: REPO,
    env: { ...process.env, HOME: f.home, PATH: `${f.bin}:/usr/bin:/bin`, IHOW_HANDOFF_METRICS: '0', IHOW_TEST_ADD_DELAY_MS: String(f.addDelayMs), IHOW_TEST_ADD_MARKER: f.addMarker },
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  const markerDeadline = Date.now() + 5_000;
  while (!await fs.access(f.addMarker).then(() => true).catch(() => false)) {
    if (Date.now() >= markerDeadline) throw new Error('add marker not observed');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const userEntry = { type: 'stdio', command: '/user/node', args: ['/user/server.js'] };
  await fs.writeFile(configPath, JSON.stringify({ mcpServers: { 'ihow-memory': userEntry } }));
  const proc = await child;
  const stderr = [];
  proc.stderr.on('data', (chunk) => stderr.push(chunk));
  const exitCode = await new Promise((resolve) => proc.on('exit', resolve));

  assert.notEqual(exitCode, 0);
  assert.match(Buffer.concat(stderr).toString(), /claude_mcp_add_failed/);
  assert.deepEqual(await claudeEntry(f.home), userEntry);
  await assert.rejects(fs.access(f.receipt));
});

test('managed connect refuses to take over an existing iHow registration', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.home, '.claude.json'), JSON.stringify({
    mcpServers: { 'ihow-memory': { type: 'stdio', command: '/user/node', args: ['/user/server.js'] } },
  }));
  const before = await fs.readFile(path.join(f.home, '.claude.json'), 'utf8');
  const status = runManaged(f, 'connection-status');
  assert.equal(status.status, 'blocked-existing');
  assert.equal(status.canConnect, false);
  const result = runManaged(f, 'connect', { allowFailure: true });
  assert.match(result.error, /managed_connect_existing_user_entry_refusing_takeover/);
  assert.equal(await fs.readFile(path.join(f.home, '.claude.json'), 'utf8'), before);
  await assert.rejects(fs.access(f.receipt));
});

test('managed disconnect refuses configuration drift and leaves the receipt unconsumed', async (t) => {
  const f = await fixture(t);
  runManaged(f, 'connect');
  const configPath = path.join(f.home, '.claude.json');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  config.mcpServers['ihow-memory'].args = ['/user/changed-server.js'];
  await fs.writeFile(configPath, JSON.stringify(config));
  const conflict = runManaged(f, 'connection-status');
  assert.equal(conflict.status, 'conflict');
  assert.equal(conflict.canDisconnect, false);

  const result = runManaged(f, 'disconnect', { allowFailure: true });
  assert.match(result.error, /managed_runtime_current_configuration_mismatch/);
  assert.deepEqual((await claudeEntry(f.home)).args, ['/user/changed-server.js']);
  assert.equal(JSON.parse(await fs.readFile(f.receipt, 'utf8')).status, 'connected');
});
