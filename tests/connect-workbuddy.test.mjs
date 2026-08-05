// SPDX-License-Identifier: Apache-2.0
// Regression tests for `connect --runtime workbuddy`. WorkBuddy's official user-scope CLI writes
// ~/.workbuddy/.mcp.json, so these pin the safety contract: never clobber, always back up,
// only upsert the ihow-memory entry, and never touch WorkBuddy's runtime/connector files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ihow-memory.mjs');

function makeHome(t, slug) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `ihow-wb-${slug}-`));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
function run(home, args) {
  return execFileSync('node', [CLI, ...args], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
}
function init(home) {
  run(home, ['init', '--space', 'wb', '--root', path.join(home, '.ihow-memory')]);
}
function connectArgs(home, extra = []) {
  return ['connect', '--runtime', 'workbuddy', '--space', 'wb', '--root', path.join(home, '.ihow-memory'), ...extra];
}

test('workbuddy connect preserves existing servers, upserts ihow-memory as stdio, backs up', (t) => {
  const home = makeHome(t, 'merge');
  fs.mkdirSync(path.join(home, '.workbuddy'), { recursive: true });
  const cfg = path.join(home, '.workbuddy', '.mcp.json');
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { chrome: { command: '/x/node', args: ['c.js'] } } }, null, 2));
  init(home);
  run(home, connectArgs(home));

  const out = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  assert.ok(out.mcpServers.chrome, 'existing chrome server preserved');
  assert.equal(out.mcpServers.chrome.command, '/x/node', 'existing server untouched');
  assert.equal(out.mcpServers['ihow-memory'].type, 'stdio', 'ihow-memory written as stdio');
  assert.ok(path.isAbsolute(out.mcpServers['ihow-memory'].command), 'absolute node path (GUI PATH may be incomplete)');
  assert.ok(out.mcpServers['ihow-memory'].args.some((a) => a.includes('mcp/server.js')), 'points at the server entry');
  assert.ok(
    fs.readdirSync(path.join(home, '.workbuddy')).some((f) => f.includes('.ihow-bak-')),
    'backed up the existing config before writing',
  );
  // Never touch WorkBuddy's connector marketplace / approvals files.
  assert.ok(!fs.existsSync(path.join(home, '.workbuddy', 'mcp.json')), 'did not create the ineffective legacy path');
  assert.ok(!fs.existsSync(path.join(home, '.workbuddy', 'mcp-approvals.json')), 'did not forge approvals');
});

test('workbuddy connect refuses to clobber an unparseable config', (t) => {
  const home = makeHome(t, 'refuse');
  fs.mkdirSync(path.join(home, '.workbuddy'), { recursive: true });
  const cfg = path.join(home, '.workbuddy', '.mcp.json');
  fs.writeFileSync(cfg, '{ not valid json');
  init(home);
  assert.throws(() => run(home, connectArgs(home)), 'connect exits non-zero rather than overwrite');
  assert.equal(fs.readFileSync(cfg, 'utf8'), '{ not valid json', 'unparseable config left untouched');
});

test('workbuddy connect --dry-run writes nothing', (t) => {
  const home = makeHome(t, 'dryrun');
  init(home);
  run(home, connectArgs(home, ['--dry-run']));
  assert.ok(!fs.existsSync(path.join(home, '.workbuddy', '.mcp.json')), 'dry-run created no config file');
});

test('workbuddy connect creates a fresh config when none exists', (t) => {
  const home = makeHome(t, 'fresh');
  init(home);
  run(home, connectArgs(home));
  const cfg = path.join(home, '.workbuddy', '.mcp.json');
  assert.ok(fs.existsSync(cfg), 'created the config file');
  const out = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  assert.equal(out.mcpServers['ihow-memory'].type, 'stdio');
});
