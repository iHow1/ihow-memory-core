// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Regression tests for `connect --runtime vscode|gemini` — the two NON-transcript-capture
// (receiver-only) runtimes added to close the runtime-breadth gap. They are wired so VS Code
// Copilot and the Gemini CLI can reach memory.search / memory.read / memory.continue (the
// verify-first handoff) over the shared MCP server, even though neither has a readable local
// session store to resume FROM. Each writes a different config shape, so these pin:
//   VS Code = USER-level mcp.json, container key `servers`, stdio entry with `type: "stdio"`.
//   Gemini  = ~/.gemini/settings.json, container key `mcpServers`, implicit-stdio { command, args }.
// Both preserve existing entries, back up, never clobber an unparseable file, and respect --dry-run.
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
  return execFileSync('node', [CLI, ...args], {
    env: { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming') },
    encoding: 'utf8',
  });
}
function init(home, runtime) {
  return run(home, ['init', '--space', 't', '--root', path.join(home, '.ihow-memory'), ...(runtime ? ['--runtime', runtime] : [])]);
}
function connect(home, runtime, extra = []) {
  return run(home, ['connect', '--runtime', runtime, '--space', 't', '--root', path.join(home, '.ihow-memory'), ...extra]);
}

// VS Code keeps the user mcp.json under the standard Electron user-data dir; on Linux/macOS-CI the
// test runs cross-platform, so resolve the path the same way connectRuntime does.
function vscodePath(home) {
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
  if (process.platform === 'win32') return path.join(home, 'AppData', 'Roaming', 'Code', 'User', 'mcp.json');
  return path.join(home, '.config', 'Code', 'User', 'mcp.json');
}

test('vscode connect uses the `servers` container with a stdio entry, preserves existing, backs up', (t) => {
  const home = makeHome(t, 'vsc');
  const cfg = vscodePath(home);
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  // a realistic VS Code mcp.json: top-level `inputs` + an existing server that must survive
  fs.writeFileSync(cfg, JSON.stringify({ inputs: [{ id: 'tok' }], servers: { existing: { type: 'stdio', command: '/x', args: [] } } }, null, 2));
  init(home);
  connect(home, 'vscode');

  const out = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  assert.ok(out.inputs, 'unrelated top-level key (inputs) preserved');
  assert.ok(out.servers.existing, 'existing server preserved');
  assert.ok(!('mcpServers' in out), 'did not create a stray mcpServers key (VS Code uses `servers`)');
  const e = out.servers['ihow-memory'];
  assert.equal(e.type, 'stdio', 'VS Code stdio entry carries an explicit type');
  assert.ok(path.isAbsolute(e.command), 'absolute node path (GUI app, no shell PATH)');
  assert.ok(Array.isArray(e.args) && e.args.some((a) => a.replace(/\\/g, '/').includes('mcp/server.js')), 'args array includes the server entry');
  assert.ok(fs.readdirSync(path.dirname(cfg)).some((f) => f.includes('.ihow-bak-')), 'backed up');
});

test('vscode connect creates the user mcp.json when none exists', (t) => {
  const home = makeHome(t, 'vsc2');
  init(home);
  connect(home, 'vscode');
  const out = JSON.parse(fs.readFileSync(vscodePath(home), 'utf8'));
  assert.equal(out.servers['ihow-memory'].type, 'stdio', 'created with a stdio entry');
  assert.ok(path.isAbsolute(out.servers['ihow-memory'].command), 'absolute node command');
});

test('vscode connect refuses to clobber an unparseable config', (t) => {
  const home = makeHome(t, 'vsc3');
  const cfg = vscodePath(home);
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, '{ not json');
  init(home);
  assert.throws(() => connect(home, 'vscode'));
  assert.equal(fs.readFileSync(cfg, 'utf8'), '{ not json', 'left untouched');
});

test('vscode connect --dry-run writes nothing', (t) => {
  const home = makeHome(t, 'vsc4');
  init(home);
  connect(home, 'vscode', ['--dry-run']);
  assert.ok(!fs.existsSync(vscodePath(home)), 'dry-run wrote nothing');
});

test('gemini connect adds mcpServers/implicit-stdio, preserves existing keys, backs up', (t) => {
  const home = makeHome(t, 'gem');
  const cfg = path.join(home, '.gemini', 'settings.json');
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  // realistic Gemini settings.json: a theme pref + an existing mcp server, both must survive
  fs.writeFileSync(cfg, JSON.stringify({ theme: 'Default', mcpServers: { existing: { command: 'x', args: [] } } }, null, 2));
  init(home);
  connect(home, 'gemini');

  const out = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  assert.equal(out.theme, 'Default', 'unrelated top-level key (theme) preserved');
  assert.ok(out.mcpServers.existing, 'existing server preserved');
  const e = out.mcpServers['ihow-memory'];
  assert.equal(e.type, undefined, 'Gemini implicit-stdio entry has no type field');
  assert.ok(path.isAbsolute(e.command), 'absolute node path');
  assert.ok(Array.isArray(e.args) && e.args.some((a) => a.replace(/\\/g, '/').includes('mcp/server.js')), 'args array includes the server entry');
  assert.ok(fs.readdirSync(path.dirname(cfg)).some((f) => f.includes('.ihow-bak-')), 'backed up');
});

test('gemini connect creates settings.json when none exists', (t) => {
  const home = makeHome(t, 'gem2');
  init(home);
  connect(home, 'gemini');
  const out = JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'settings.json'), 'utf8'));
  assert.ok(path.isAbsolute(out.mcpServers['ihow-memory'].command), 'created with absolute node command');
  assert.equal(out.mcpServers['ihow-memory'].type, undefined, 'no type field');
});

test('gemini connect refuses to clobber an unparseable config', (t) => {
  const home = makeHome(t, 'gem3');
  const cfg = path.join(home, '.gemini', 'settings.json');
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, '{ broken');
  init(home);
  assert.throws(() => connect(home, 'gemini'));
  assert.equal(fs.readFileSync(cfg, 'utf8'), '{ broken', 'left untouched');
});

test('gemini connect --dry-run writes nothing', (t) => {
  const home = makeHome(t, 'gem4');
  init(home);
  connect(home, 'gemini', ['--dry-run']);
  assert.ok(!fs.existsSync(path.join(home, '.gemini', 'settings.json')), 'dry-run wrote nothing');
});

// init --runtime prints a paste-able snippet (the manual path for users who would rather edit config
// by hand). For these JSON runtimes the snippet is the standard mcpServers shape; the point of the test
// is that init recognizes the runtime (no unsupported_runtime throw) and emits the server entry.
test('init --runtime vscode and gemini print a runtime snippet without erroring', (t) => {
  const home = makeHome(t, 'snip');
  const vs = init(home, 'vscode');
  assert.match(vs, /mcp\/server\.js/, 'vscode init snippet references the server entry');
  const gm = init(home, 'gemini');
  assert.match(gm, /mcp\/server\.js/, 'gemini init snippet references the server entry');
});

// An unknown runtime is still rejected — the allowlist widened by exactly two, not to "anything".
test('connect rejects an unknown runtime', (t) => {
  const home = makeHome(t, 'unk');
  init(home);
  assert.throws(() => connect(home, 'notarealruntime'), /unsupported_runtime/);
});
