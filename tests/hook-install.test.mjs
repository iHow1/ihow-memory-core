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
  const effectiveCwd = cwd ?? process.cwd();
  const isolatedHome = home ?? path.join(effectiveCwd, '.ihow-test-home');
  return execFileSync(process.execPath, [CLI, 'install-hook', ...args], {
    encoding: 'utf8',
    cwd: effectiveCwd,
    env: { ...process.env, HOME: isolatedHome },
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
function userPromptCommands(settings) {
  return (settings.hooks?.UserPromptSubmit ?? []).flatMap((g) => g.hooks ?? []).map((h) => h.command);
}

test('install-hook defaults to this project (.claude/settings.local.json), wiring BOTH capture hooks', async (t) => {
  const proj = await mkdtempReal('ihow-proj-');
  t.after(async () => { await fs.rm(proj, { recursive: true, force: true }); });
  assert.match(runInstallHook({ cwd: proj }), /installed Stop .* SessionStart/);
  const settings = await readJson(path.join(proj, '.claude', 'settings.local.json'));
  assert.ok(stopCommands(settings).some((c) => c.includes('hook-stop') && c.includes('ihow-memory')), 'project-local Stop hook present');
  assert.ok(sessionStartCommands(settings).some((c) => c.includes('hook-session-start') && c.includes('ihow-memory')), 'project-local SessionStart floor hook present');
  // recall (UserPromptSubmit, reviewed tier) is now wired by DEFAULT (2026-06-26 recall-quality eval); --no-recall opts out
  const recallCmds = (settings.hooks?.UserPromptSubmit ?? []).flatMap((g) => g.hooks ?? []).map((h) => h.command);
  assert.ok(recallCmds.some((c) => c.includes('hook-user-prompt-submit') && c.includes('ihow-memory')), 'recall hook wired by default');
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
  const root = path.join(proj, 'ihow-root');
  const args = ['--root', root, '--space', 'stable'];
  runInstallHook({ cwd: proj, args });
  const sentinel = path.join(root, 'stable', '.runtime', 'keep-existing-runtime.txt');
  await fs.writeFile(sentinel, 'KEEP', 'utf8');
  assert.match(runInstallHook({ cwd: proj, args }), /already present/);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'KEEP', 'idempotent hook reconcile does not recopy a healthy runtime bundle');
  const settings = await readJson(dest);
  assert.equal(settings.model, 'opus', 'unrelated keys preserved');
  const cmds = stopCommands(settings);
  assert.ok(cmds.some((c) => c.includes('echo unrelated')), 'existing hook preserved');
  assert.ok(cmds.some((c) => c.includes('hook-stop')), 'our hook added');
  assert.ok((await fs.readdir(path.dirname(dest))).some((f) => f.includes('.ihow-bak-')), 'existing settings backed up');
});

test('install-hook repairs a same-version but corrupted frozen runtime bundle', async (t) => {
  const proj = await mkdtempReal('ihow-proj-');
  t.after(async () => { await fs.rm(proj, { recursive: true, force: true }); });
  const root = path.join(proj, 'root');
  const args = ['--root', root, '--space', 'corrupt'];
  runInstallHook({ cwd: proj, args });
  const runtime = path.join(root, 'corrupt', '.runtime');
  await fs.writeFile(path.join(runtime, 'cli.js'), '', 'utf8');
  await fs.writeFile(path.join(runtime, 'mcp', 'server.js'), '', 'utf8');
  runInstallHook({ cwd: proj, args });
  assert.ok((await fs.stat(path.join(runtime, 'cli.js'))).size > 0, 'zero-byte CLI replaced');
  assert.ok((await fs.stat(path.join(runtime, 'mcp', 'server.js'))).size > 0, 'zero-byte server replaced');

  const originalCore = await fs.readFile(path.join(runtime, 'core.js'), 'utf8');
  await fs.writeFile(path.join(runtime, 'core.js'), '/* same-version tamper */', 'utf8');
  runInstallHook({ cwd: proj, args });
  assert.equal(await fs.readFile(path.join(runtime, 'core.js'), 'utf8'), originalCore, 'non-entry runtime dependency tamper is repaired');
  const repaired = JSON.parse(await fs.readFile(path.join(runtime, 'package.json'), 'utf8'));
  assert.equal(typeof repaired.integrity.files['cli.js'], 'string');
  assert.equal(typeof repaired.integrity.files['mcp/server.js'], 'string');
  assert.equal(typeof repaired.integrity.files['core.js'], 'string');
});

test('install-hook --no-recall removes only managed Claude recall and is idempotent', async (t) => {
  const proj = await mkdtempReal('ihow-proj-');
  t.after(async () => { await fs.rm(proj, { recursive: true, force: true }); });
  const dest = path.join(proj, '.claude', 'settings.local.json');
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo keep-third-party-recall' }] }] } }, null, 2), 'utf8');
  const root = path.join(proj, 'root');
  const args = ['--root', root, '--space', 'recall-off'];
  runInstallHook({ cwd: proj, args });
  assert.ok(userPromptCommands(await readJson(dest)).some((command) => command.includes('--hook-owner ihow-memory-v1')));

  const removed = runInstallHook({ cwd: proj, args: [...args, '--no-recall'] });
  assert.match(removed, /removed managed UserPromptSubmit \(recall OFF\)/);
  const after = await readJson(dest);
  assert.equal(userPromptCommands(after).some((command) => command.includes('--hook-owner ihow-memory-v1')), false);
  assert.ok(userPromptCommands(after).includes('echo keep-third-party-recall'), 'third-party recall hook preserved');
  assert.match(runInstallHook({ cwd: proj, args: [...args, '--no-recall'] }), /recall OFF.*already present/);
});

test('install-hook --no-recall removes an otherwise empty managed event/group completely', async (t) => {
  const proj = await mkdtempReal('ihow-proj-');
  t.after(async () => { await fs.rm(proj, { recursive: true, force: true }); });
  const root = path.join(proj, 'root');
  const args = ['--root', root, '--space', 'remove-empty'];
  runInstallHook({ cwd: proj, args });
  runInstallHook({ cwd: proj, args: [...args, '--no-recall'] });
  const settings = await readJson(path.join(proj, '.claude', 'settings.local.json'));
  assert.equal(settings.hooks.UserPromptSubmit, undefined, 'pure managed recall event is removed instead of leaving an empty group');
});

test('install-hook bakes the connect-time workspace into the hook command', async (t) => {
  const proj = await mkdtempReal('ihow-proj-');
  t.after(async () => { await fs.rm(proj, { recursive: true, force: true }); });
  const root = path.join(proj, 'ihow-custom-root');
  runInstallHook({ cwd: proj, args: ['--root', root, '--space', 'proj-x'] });
  const cmd = stopCommands(await readJson(path.join(proj, '.claude', 'settings.local.json'))).find((c) => c.includes('hook-stop'));
  assert.match(cmd, /--root/);
  assert.match(cmd, /ihow-custom-root/);
  assert.match(cmd, /proj-x/);
  assert.match(cmd, /\.runtime[\\/]cli\.js/, 'hook runs the frozen workspace CLI');
  assert.match(cmd, /--hook-owner ihow-memory-v1/, 'hook has an explicit iHow ownership marker');
  assert.doesNotMatch(cmd, /bin[\\/]ihow-memory\.mjs/, 'hook does not depend on the package install path');
  assert.ok(await fs.access(path.join(root, 'proj-x', '.runtime', 'cli.js')).then(() => true, () => false), 'standalone install-hook freezes the runtime CLI first');
});

test('installed POSIX hook commands execute safely from paths containing shell metacharacters', { skip: process.platform === 'win32' }, async (t) => {
  const proj = await mkdtempReal('ihow-proj-');
  t.after(async () => { await fs.rm(proj, { recursive: true, force: true }); });
  const root = path.join(proj, "root $IHOW_QUOTE_TEST ' quote `tick`");
  runInstallHook({ cwd: proj, args: ['--root', root, '--space', 'quoted'] });
  const cmd = stopCommands(await readJson(path.join(proj, '.claude', 'settings.local.json'))).find((value) => value.includes('hook-stop'));
  const transcript = path.join(proj, 'transcript.jsonl');
  await fs.writeFile(transcript, 'one\ntwo\nthree\nfour\n', 'utf8');
  const payload = JSON.stringify({ session_id: 'shell-quote', cwd: proj, transcript_path: transcript, hook_event_name: 'Stop' });
  const out = execFileSync('/bin/sh', ['-c', cmd], {
    input: payload,
    encoding: 'utf8',
    env: { ...process.env, IHOW_QUOTE_TEST: 'MUST_NOT_EXPAND' },
  });
  assert.equal(JSON.parse(out).decision, 'block');
  assert.ok(await fs.access(path.join(root, 'quoted', '.hooks', 'stop-shell-quote.json')).then(() => true, () => false), 'marker lands in the literal intended root');
});

test('install-hook --no-install-hook writes nothing', async (t) => {
  const proj = await mkdtempReal('ihow-proj-');
  t.after(async () => { await fs.rm(proj, { recursive: true, force: true }); });
  assert.match(runInstallHook({ cwd: proj, args: ['--no-install-hook'] }), /Skipped/);
  await assert.rejects(fs.readFile(path.join(proj, '.claude', 'settings.local.json'), 'utf8'));
});

test('Claude install-hook refuses malformed hooks shapes instead of replacing them', async (t) => {
  const proj = await mkdtempReal('ihow-proj-');
  t.after(async () => { await fs.rm(proj, { recursive: true, force: true }); });
  const dest = path.join(proj, '.claude', 'settings.local.json');
  await fs.mkdir(path.dirname(dest), { recursive: true });
  for (const hooks of [
    { Stop: { hooks: [] } },
    { Stop: [{ matcher: 'x', hooks: { bad: true } }] },
  ]) {
    const original = `${JSON.stringify({ hooks, keep: true }, null, 2)}\n`;
    await fs.writeFile(dest, original, 'utf8');
    assert.throws(() => runInstallHook({ cwd: proj }), /Command failed/);
    assert.equal(await fs.readFile(dest, 'utf8'), original, 'malformed shape is preserved for user repair');
  }
});

test('install-hook --runtime codex writes ~/.codex/hooks.json idempotently and preserves hooks', async (t) => {
  const home = await mkdtempReal('ihow-home-');
  const proj = await mkdtempReal('ihow-proj-');
  t.after(async () => { await fs.rm(home, { recursive: true, force: true }); await fs.rm(proj, { recursive: true, force: true }); });
  const hooksPath = path.join(home, '.codex', 'hooks.json');
  await fs.mkdir(path.dirname(hooksPath), { recursive: true });
  await fs.writeFile(
    hooksPath,
    JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo keep-me' }] }] }, other: 'KEEP' }, null, 2),
    'utf8',
  );

  const root = path.join(home, 'ihow-root');
  const out1 = runInstallHook({ cwd: proj, home, args: ['--runtime', 'codex', '--root', root, '--space', 'codex-space'] });
  assert.match(out1, /installed Codex SessionStart \+ UserPromptSubmit hooks/);
  const settings = await readJson(hooksPath);
  assert.equal(settings.other, 'KEEP', 'unrelated keys preserved');
  assert.ok(sessionStartCommands(settings).some((c) => c.includes('echo keep-me')), 'existing hook preserved');
  assert.ok(sessionStartCommands(settings).some((c) => c.includes('hook-session-start') && c.includes('--runtime') && c.includes('codex')), 'Codex SessionStart hook present');
  assert.ok(sessionStartCommands(settings).some((c) => c.includes(root) && c.includes('codex-space')), 'workspace binding baked in');
  assert.ok(sessionStartCommands(settings).some((c) => c.includes('--hook-owner ihow-memory-v1')), 'Codex hook has an explicit iHow ownership marker');
  assert.ok(userPromptCommands(settings).some((c) => c.includes('hook-user-prompt-submit')), 'Codex UserPromptSubmit recall hook present');

  const out2 = runInstallHook({ cwd: proj, home, args: ['--runtime', 'codex', '--root', root, '--space', 'codex-space'] });
  assert.match(out2, /Codex hooks already present/);
  const body = await fs.readFile(hooksPath, 'utf8');
  assert.equal(body.match(/hook-session-start/g).length, 1, 'SessionStart hook not duplicated');
  assert.equal(body.match(/hook-user-prompt-submit/g).length, 1, 'UserPromptSubmit hook not duplicated');
});

test('install-hook --runtime codex --no-recall removes managed recall but keeps SessionStart and third-party hooks', async (t) => {
  const home = await mkdtempReal('ihow-home-');
  const proj = await mkdtempReal('ihow-proj-');
  t.after(async () => { await fs.rm(home, { recursive: true, force: true }); await fs.rm(proj, { recursive: true, force: true }); });
  const hooksPath = path.join(home, '.codex', 'hooks.json');
  const root = path.join(home, 'root');
  const args = ['--runtime', 'codex', '--root', root, '--space', 'recall-off'];
  runInstallHook({ cwd: proj, home, args });
  const installed = await readJson(hooksPath);
  installed.hooks.UserPromptSubmit.push({ hooks: [{ type: 'command', command: 'echo keep-third-party-recall' }] });
  await fs.writeFile(hooksPath, `${JSON.stringify(installed, null, 2)}\n`, 'utf8');

  assert.match(runInstallHook({ cwd: proj, home, args: [...args, '--no-recall'] }), /managed UserPromptSubmit recall is OFF/);
  const after = await readJson(hooksPath);
  assert.equal(userPromptCommands(after).some((command) => command.includes('--hook-owner ihow-memory-v1')), false);
  assert.ok(userPromptCommands(after).includes('echo keep-third-party-recall'));
  assert.ok(sessionStartCommands(after).some((command) => command.includes('--hook-owner ihow-memory-v1')));
});

test('install-hook --runtime codex refuses malformed hooks shape instead of clobbering it', async (t) => {
  const home = await mkdtempReal('ihow-home-');
  const proj = await mkdtempReal('ihow-proj-');
  t.after(async () => { await fs.rm(home, { recursive: true, force: true }); await fs.rm(proj, { recursive: true, force: true }); });
  const hooksPath = path.join(home, '.codex', 'hooks.json');
  await fs.mkdir(path.dirname(hooksPath), { recursive: true });
  for (const hooks of [
    { SessionStart: { hooks: [] } },
    { SessionStart: [{ matcher: 'startup', hooks: { bad: true } }] },
  ]) {
    const original = `${JSON.stringify({ hooks }, null, 2)}\n`;
    await fs.writeFile(hooksPath, original, 'utf8');
    assert.throws(
      () => runInstallHook({ cwd: proj, home, args: ['--runtime', 'codex'] }),
      /refusing to modify/,
    );
    assert.equal(await fs.readFile(hooksPath, 'utf8'), original, 'bad shape preserved for user repair');
  }
});
