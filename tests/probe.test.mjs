// SPDX-License-Identifier: Apache-2.0
// Verify-after-connect probe: a runtime is reachable only when the configured server
// actually answers a memory.status round-trip — never on write-success alone. Guards
// against the "config written but unreachable" false-green (the first-user Hermes incident).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openCore } from '../src/core.ts';
import { probeMcpServer, verifyConnection } from '../src/mcp/probe.ts';

const SRC_SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'mcp', 'server.ts');
// Run the source server via type-stripping so the test needs no prior build and works on Node 22 + 24.
const specFor = (root, memoryRoot) => ({
  command: process.execPath,
  args: ['--experimental-strip-types', '--no-warnings', SRC_SERVER, '--memory-root', memoryRoot, '--state-root', root],
});

async function mkRoot(t, label) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `ihow-${label}-`)));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return root;
}

test('probeMcpServer round-trips a real server → reachable', async (t) => {
  const root = await mkRoot(t, 'probe');
  const core = await openCore({ root, space: 'ptest' });
  const r = await probeMcpServer(specFor(root, core.workspace.memoryDir), { timeoutMs: 12000 });
  assert.equal(r.ok, true, `should round-trip memory.status: ${r.detail}`);
});

test('probeMcpServer on a bad spec is not reachable (no false green)', async () => {
  const r = await probeMcpServer({ command: process.execPath, args: ['/nonexistent/server.js'] }, { timeoutMs: 5000 });
  assert.equal(r.ok, false);
});

test('verifyConnection: a no-CLI runtime with a working server is reachable (config written + round-trip)', async (t) => {
  const root = await mkRoot(t, 'probe2');
  const core = await openCore({ root, space: 'ptest2' });
  const v = await verifyConnection(specFor(root, core.workspace.memoryDir), 'cursor', { timeoutMs: 12000 });
  // Direct-write runtime: no CLI to confirm registration, but the server round-trips and the config
  // is written — the best install-time verification. Reported reachable, not stuck pending forever.
  assert.equal(v.reachable, true);
  assert.equal(v.status, 'reachable');
});

test('verifyConnection: a broken server (bad spec) is NOT reachable', async (t) => {
  const v = await verifyConnection({ command: process.execPath, args: ['/nonexistent/server.js'] }, 'cursor', { timeoutMs: 5000 });
  assert.equal(v.reachable, false, 'no false-green when the configured server cannot start');
  assert.equal(v.status, 'written');
});
