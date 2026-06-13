// SPDX-License-Identifier: Apache-2.0
// Regression tests for `connect --runtime claude-desktop|opencode`. Each writes a different
// config shape, so these pin: Claude Desktop = standard mcpServers/stdio; OpenCode = `mcp`
// container with { type: "local", command: [argv...], enabled: true }. Both preserve existing
// servers, back up, and never clobber an unparseable file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ihow-memory.mjs');

function makeHome(t, slug) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `ihow-${slug}-`));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
function run(home, args) {
  return execFileSync('node', [CLI, ...args], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
}
function init(home) {
  run(home, ['init', '--space', 't', '--root', path.join(home, '.ihow-memory')]);
}
function connect(home, runtime, extra = []) {
  return run(home, ['connect', '--runtime', runtime, '--space', 't', '--root', path.join(home, '.ihow-memory'), ...extra]);
}

function claudeDesktopPath(home) {
  return process.platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
    : path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
}

test('claude-desktop connect adds mcpServers/stdio, preserves existing keys, backs up', (t) => {
  const home = makeHome(t, 'cd');
  const cfg = claudeDesktopPath(home);
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, JSON.stringify({ preferences: { x: 1 }, mcpServers: { existing: { command: '/x', args: [] } } }, null, 2));
  init(home);
  connect(home, 'claude-desktop');

  const out = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  assert.ok(out.preferences, 'unrelated top-level key preserved');
  assert.ok(out.mcpServers.existing, 'existing server preserved');
  const e = out.mcpServers['ihow-memory'];
  // Claude Desktop schema is { command, args?, env? } — no `type` field.
  assert.equal(e.type, undefined, 'no type field (matches Claude Desktop schema)');
  assert.ok(path.isAbsolute(e.command), 'absolute node path (GUI app, no shell PATH)');
  assert.ok(Array.isArray(e.args) && e.args.some((a) => a.includes('mcp/server.js')), 'command string + args array with server entry');
  assert.ok(fs.readdirSync(path.dirname(cfg)).some((f) => f.includes('.ihow-bak-')), 'backed up');
});

test('claude-desktop connect creates config when none exists', (t) => {
  const home = makeHome(t, 'cd2');
  init(home);
  connect(home, 'claude-desktop');
  const out = JSON.parse(fs.readFileSync(claudeDesktopPath(home), 'utf8'));
  assert.ok(path.isAbsolute(out.mcpServers['ihow-memory'].command), 'created with absolute node command');
  assert.equal(out.mcpServers['ihow-memory'].type, undefined, 'no type field');
});

test('opencode connect uses the mcp container with a local array-command entry', (t) => {
  const home = makeHome(t, 'oc');
  const cfg = path.join(home, '.config', 'opencode', 'opencode.json');
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, JSON.stringify({ $schema: 'x', mcp: { playwright: { command: ['npx', '-y', '@playwright/mcp'], enabled: true, type: 'local' } } }, null, 2));
  init(home);
  connect(home, 'opencode');

  const out = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  assert.ok(out.mcp.playwright, 'existing mcp entry preserved');
  assert.equal(out.$schema, 'x', 'unrelated top-level key preserved');
  const e = out.mcp['ihow-memory'];
  assert.equal(e.type, 'local', 'OpenCode entry type is local');
  assert.equal(e.enabled, true, 'OpenCode entry uses enabled (not disabled)');
  assert.ok(Array.isArray(e.command), 'OpenCode command is an argv array');
  assert.ok(path.isAbsolute(e.command[0]), 'argv[0] is an absolute node path');
  assert.ok(e.command.some((a) => a.includes('mcp/server.js')), 'argv includes the server entry');
  assert.ok(!('mcpServers' in out), 'did not create a stray mcpServers key');
});

test('opencode connect refuses to clobber an unparseable config', (t) => {
  const home = makeHome(t, 'oc2');
  const cfg = path.join(home, '.config', 'opencode', 'opencode.json');
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, '{ broken');
  init(home);
  assert.throws(() => connect(home, 'opencode'));
  assert.equal(fs.readFileSync(cfg, 'utf8'), '{ broken', 'left untouched');
});

test('opencode connect --dry-run writes nothing', (t) => {
  const home = makeHome(t, 'oc3');
  init(home);
  connect(home, 'opencode', ['--dry-run']);
  assert.ok(!fs.existsSync(path.join(home, '.config', 'opencode', 'opencode.json')), 'dry-run wrote nothing');
});
