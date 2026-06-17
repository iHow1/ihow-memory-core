// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// alpha.4 hook install scope + safety. `install-hook` (and connect --runtime claude-code) wires the
// session-end auto-capture Stop hook. Default scope = THIS project's gitignored
// `.claude/settings.local.json` (the command carries a machine-specific absolute path, and a Stop
// hook should not fire for unrelated repos); `--global-hook` opts into user-wide
// `~/.claude/settings.json`. Merge is safe: never drops other hooks/keys, backs up first, atomic,
// idempotent, refuses unparseable JSON. Isolated via temp cwd + temp HOME.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'src', 'cli.ts');

async function mkdtempReal(prefix) {
  return await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}
function runInstallHook({ cwd, home, args = [] }) {
  return execFileSync(process.execPath, [CLI, 'install-hook', ...args], {
    encoding: 'utf8',
    cwd: cwd ?? process.cwd(),
    env: { ...process.env, HOME: home ?? process.env.HOME },
  });
}
async function readJson(p) {
  return JSON.parse(await fs.readFile(p, 'utf8'));
}
function stopCommands(settings) {
  return (settings.hooks?.Stop ?? []).flatMap((g) => g.hooks ?? []).map((h) => h.command);
}
function sessionStartCommands(settings) {
  return (settings.hooks?.SessionStart ?? []).flatMap((g) => g.hooks ?? []).map((h) => h.command);
}

test('install-hook defaults to this project (.claude/settings.local.json), wiring BOTH capture hooks', async (t) => {
  const proj = await mkdtempReal('ihow-proj-');
  t.after(async () => { await fs.rm(proj, { recursive: true, force: true }); });
  assert.match(runInstallHook({ cwd: proj }), /installed auto-capture hooks/);
  const settings = await readJson(path.join(proj, '.claude', 'settings.local.json'));
  assert.ok(stopCommands(settings).some((c) => c.includes('hook-stop') && c.includes('ihow-memory')), 'project-local Stop hook present');
  assert.ok(sessionStartCommands(settings).some((c) => c.includes('hook-session-start') && c.includes('ihow-memory')), 'project-local SessionStart floor hook present');
});

test('install-hook --global-hook targets ~/.claude/settings.json and not the project', async (t) => {
  const home = await mkdtempReal('ihow-home-');
  const proj = await mkdtempReal('ihow-proj-');
  t.after(async () => { await fs.rm(home, { recursive: true, force: true }); await fs.rm(proj, { recursive: true, force: true }); });
  runInstallHook({ cwd: proj, home, args: ['--global-hook'] });
  const cmds = stopCommands(await readJson(path.join(home, '.claude', 'settings.json')));
  assert.ok(cmds.some((c) => c.includes('hook-stop')), 'global hook present');
  await assert.rejects(fs.readFile(path.join(proj, '.claude', 'settings.local.json'), 'utf8'), 'project file should not be written');
});

test('install-hook is idempotent and preserves existing hooks/keys', async (t) => {
  const proj = await mkdtempReal('ihow-proj-');
  t.after(async () => { await fs.rm(proj, { recursive: true, force: true }); });
  const dest = path.join(proj, '.claude', 'settings.local.json');
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo unrelated' }] }] } }, null, 2), 'utf8');
  runInstallHook({ cwd: proj });
  assert.match(runInstallHook({ cwd: proj }), /already present/);
  const settings = await readJson(dest);
  assert.equal(settings.model, 'opus', 'unrelated keys preserved');
  const cmds = stopCommands(settings);
  assert.ok(cmds.some((c) => c.includes('echo unrelated')), 'existing hook preserved');
  assert.ok(cmds.some((c) => c.includes('hook-stop')), 'our hook added');
  assert.ok((await fs.readdir(path.dirname(dest))).some((f) => f.includes('.ihow-bak-')), 'existing settings backed up');
});

test('install-hook bakes the connect-time workspace into the hook command', async (t) => {
  const proj = await mkdtempReal('ihow-proj-');
  t.after(async () => { await fs.rm(proj, { recursive: true, force: true }); });
  runInstallHook({ cwd: proj, args: ['--root', '/tmp/ihow-custom-root', '--space', 'proj-x'] });
  const cmd = stopCommands(await readJson(path.join(proj, '.claude', 'settings.local.json'))).find((c) => c.includes('hook-stop'));
  assert.match(cmd, /--root/);
  assert.match(cmd, /ihow-custom-root/);
  assert.match(cmd, /proj-x/);
});

test('install-hook --no-install-hook writes nothing', async (t) => {
  const proj = await mkdtempReal('ihow-proj-');
  t.after(async () => { await fs.rm(proj, { recursive: true, force: true }); });
  assert.match(runInstallHook({ cwd: proj, args: ['--no-install-hook'] }), /Skipped/);
  await assert.rejects(fs.readFile(path.join(proj, '.claude', 'settings.local.json'), 'utf8'));
});
