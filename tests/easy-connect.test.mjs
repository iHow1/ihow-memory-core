// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// alpha.5 `connect --easy` (alias --yes): one command does the full Claude Code setup — MCP + skill
// + a project-local auto-capture hook — with NO per-step prompts (the flag is the consent, safe in
// non-TTY/agent use). Bare `connect` in non-TTY must still write neither (defaults unchanged). The
// `claude` CLI is stubbed with a tiny shim so the test is hermetic (no real CLI / no real config).
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

// Minimal `claude` stub modeling a SUCCESSFUL registration: `mcp get` -> not found (exit 1, pre-add);
// `mcp list` -> shows ihow-memory (so verify-after-connect's registration cross-check passes — this is
// what a real claude reports after add-json); everything else (add-json/remove) -> ok.
async function makeClaudeShim() {
  const bin = await mkdtempReal('ihow-bin-');
  const shim = path.join(bin, 'claude');
  await fs.writeFile(shim, '#!/bin/sh\nif [ "$1" = "mcp" ] && [ "$2" = "get" ]; then exit 1; fi\nif [ "$1" = "mcp" ] && [ "$2" = "list" ]; then echo "ihow-memory: connected"; exit 0; fi\nexit 0\n', 'utf8');
  await fs.chmod(shim, 0o755);
  return bin;
}

function runConnect({ cwd, home, bin, args = [] }) {
  return execFileSync(process.execPath, [CLI, 'connect', '--runtime', 'claude-code', ...args], {
    encoding: 'utf8',
    cwd,
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
  });
}

async function makeCodexShim() {
  const bin = await mkdtempReal('ihow-bin-');
  const shim = path.join(bin, 'codex');
  await fs.writeFile(shim, '#!/bin/sh\nif [ "$1" = "mcp" ] && [ "$2" = "get" ]; then exit 1; fi\nif [ "$1" = "mcp" ] && [ "$2" = "list" ]; then echo "ihow-memory"; exit 0; fi\nexit 0\n', 'utf8');
  await fs.chmod(shim, 0o755);
  return bin;
}

function runCodexConnect({ cwd, home, bin, args = [] }) {
  return execFileSync(process.execPath, [CLI, 'connect', '--runtime', 'codex', ...args], {
    encoding: 'utf8',
    cwd,
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
  });
}

function runCodexConnectWithEnv({ cwd, env, bin, args = [] }) {
  return execFileSync(process.execPath, [CLI, 'connect', '--runtime', 'codex', ...args], {
    encoding: 'utf8',
    cwd,
    env: { ...process.env, ...env, PATH: `${bin}:${process.env.PATH}` },
  });
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}
function stopCommands(settings) {
  return (settings.hooks?.Stop ?? []).flatMap((g) => g.hooks ?? []).map((h) => h.command);
}

test('connect --easy installs MCP + skill + project hook with no prompts', async (t) => {
  const proj = await mkdtempReal('ihow-proj-');
  const home = await mkdtempReal('ihow-home-');
  const bin = await makeClaudeShim();
  t.after(async () => { for (const d of [proj, home, bin]) await fs.rm(d, { recursive: true, force: true }); });

  const out = runConnect({ cwd: proj, home, bin, args: ['--easy'] });
  assert.match(out, /connected Claude Code/);

  // skill installed under HOME
  assert.ok(await exists(path.join(home, '.claude', 'skills', 'ihow-memory', 'SKILL.md')), 'skill should be installed');
  // project-local Stop hook installed
  const settingsPath = path.join(proj, '.claude', 'settings.local.json');
  assert.ok(await exists(settingsPath), 'project settings.local.json should exist');
  const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
  assert.ok(stopCommands(settings).some((c) => c.includes('hook-stop')), 'Stop hook should be wired');
});

test('--yes is an alias for --easy', async (t) => {
  const proj = await mkdtempReal('ihow-proj-');
  const home = await mkdtempReal('ihow-home-');
  const bin = await makeClaudeShim();
  t.after(async () => { for (const d of [proj, home, bin]) await fs.rm(d, { recursive: true, force: true }); });

  runConnect({ cwd: proj, home, bin, args: ['--yes'] });
  assert.ok(await exists(path.join(home, '.claude', 'skills', 'ihow-memory', 'SKILL.md')), 'skill installed via --yes');
  assert.ok(await exists(path.join(proj, '.claude', 'settings.local.json')), 'hook installed via --yes');
});

test('bare connect (no --easy) in non-TTY writes neither skill nor hook (defaults unchanged)', async (t) => {
  const proj = await mkdtempReal('ihow-proj-');
  const home = await mkdtempReal('ihow-home-');
  const bin = await makeClaudeShim();
  t.after(async () => { for (const d of [proj, home, bin]) await fs.rm(d, { recursive: true, force: true }); });

  runConnect({ cwd: proj, home, bin }); // no --easy
  assert.equal(await exists(path.join(home, '.claude', 'skills', 'ihow-memory', 'SKILL.md')), false, 'no skill without --easy');
  assert.equal(await exists(path.join(proj, '.claude', 'settings.local.json')), false, 'no hook without --easy');
});

test('--easy --no-install-hook respects the explicit opt-out (skill yes, hook no)', async (t) => {
  const proj = await mkdtempReal('ihow-proj-');
  const home = await mkdtempReal('ihow-home-');
  const bin = await makeClaudeShim();
  t.after(async () => { for (const d of [proj, home, bin]) await fs.rm(d, { recursive: true, force: true }); });

  runConnect({ cwd: proj, home, bin, args: ['--easy', '--no-install-hook'] });
  assert.ok(await exists(path.join(home, '.claude', 'skills', 'ihow-memory', 'SKILL.md')), 'skill still installed');
  assert.equal(await exists(path.join(proj, '.claude', 'settings.local.json')), false, 'hook opt-out respected');
});

test('connect --easy wires recall by default (reviewed tier); --no-recall opts out', async (t) => {
  // 2026-06-26 recall-quality eval (reviewed ~88% signal / 0 harmful) relaxed the 2026-06-17 default-off
  // guard: recall (UserPromptSubmit, reviewed tier only) now installs by default on the easy path, and
  // --no-recall skips it. The machine-judged auto tier still stays opt-in (IHOW_RECALL_INCLUDE_AUTO=1).
  const proj = await mkdtempReal('ihow-proj-');
  const home = await mkdtempReal('ihow-home-');
  const bin = await makeClaudeShim();
  t.after(async () => { for (const d of [proj, home, bin]) await fs.rm(d, { recursive: true, force: true }); });

  runConnect({ cwd: proj, home, bin, args: ['--easy'] });
  let settings = JSON.parse(await fs.readFile(path.join(proj, '.claude', 'settings.local.json'), 'utf8'));
  assert.ok(stopCommands(settings).some((c) => c.includes('hook-stop')), 'capture hook wired by --easy');
  const recallCmds = (settings.hooks?.UserPromptSubmit ?? []).flatMap((g) => g.hooks ?? []).map((h) => h.command);
  assert.ok(recallCmds.some((c) => c.includes('hook-user-prompt-submit')), 'connect --easy wires the recall hook by default');

  const proj2 = await mkdtempReal('ihow-proj-');
  t.after(async () => { await fs.rm(proj2, { recursive: true, force: true }); });
  runConnect({ cwd: proj2, home, bin, args: ['--easy', '--no-recall'] });
  settings = JSON.parse(await fs.readFile(path.join(proj2, '.claude', 'settings.local.json'), 'utf8'));
  assert.ok(stopCommands(settings).some((c) => c.includes('hook-stop')), '--no-recall still wires the capture hook');
  assert.equal((settings.hooks?.UserPromptSubmit ?? []).length, 0, 'connect --easy --no-recall skips the recall hook');
});

test('claude connect --easy --json stays parseable and still installs skill + hooks', async (t) => {
  const proj = await mkdtempReal('ihow-proj-');
  const home = await mkdtempReal('ihow-home-');
  const bin = await makeClaudeShim();
  t.after(async () => { for (const d of [proj, home, bin]) await fs.rm(d, { recursive: true, force: true }); });

  const out = runConnect({ cwd: proj, home, bin, args: ['--easy', '--json'] });
  const j = JSON.parse(out);
  assert.equal(j.runtime, 'claude-code');
  assert.ok(await exists(path.join(home, '.claude', 'skills', 'ihow-memory', 'SKILL.md')), 'json easy path installs the Claude skill');
  const settings = JSON.parse(await fs.readFile(path.join(proj, '.claude', 'settings.local.json'), 'utf8'));
  assert.ok(stopCommands(settings).some((c) => c.includes('hook-stop')), 'json easy path installs the Stop hook');
  const recallCmds = (settings.hooks?.UserPromptSubmit ?? []).flatMap((g) => g.hooks ?? []).map((h) => h.command);
  assert.ok(recallCmds.some((c) => c.includes('hook-user-prompt-submit')), 'json easy path installs the recall hook');
});

test('codex connect --easy installs hooks + proactive memory loop; bare connect does not', async (t) => {
  const proj = await mkdtempReal('ihow-proj-');
  const home = await mkdtempReal('ihow-home-');
  const bin = await makeCodexShim();
  t.after(async () => { for (const d of [proj, home, bin]) await fs.rm(d, { recursive: true, force: true }); });

  await fs.mkdir(path.join(home, '.codex'), { recursive: true });
  await fs.writeFile(path.join(home, '.codex', 'AGENTS.md'), '# Existing\n\nKEEP-ME\n', 'utf8');

  const bare = runCodexConnect({ cwd: proj, home, bin });
  assert.match(bare, /connected Codex/);
  let body = await fs.readFile(path.join(home, '.codex', 'AGENTS.md'), 'utf8');
  assert.doesNotMatch(body, /Codex proactive memory loop/, 'bare Codex connect does not alter AGENTS.md');
  assert.equal(await exists(path.join(home, '.codex', 'hooks.json')), false, 'bare Codex connect does not install hooks');

  const easy = runCodexConnect({ cwd: proj, home, bin, args: ['--easy'] });
  assert.match(easy, /Codex hooks \+ AGENTS\.md proactive memory loop/);
  assert.match(easy, /installed Codex SessionStart \+ UserPromptSubmit hooks/);
  body = await fs.readFile(path.join(home, '.codex', 'AGENTS.md'), 'utf8');
  assert.match(body, /iHow Memory — Codex proactive memory loop/, 'easy Codex connect installs the memory loop');
  assert.match(body, /memory\.search/, 'memory loop includes proactive search');
  assert.match(body, /memory\.write_candidate/, 'memory loop includes writeback');
  assert.match(body, /KEEP-ME/, 'existing Codex AGENTS content is preserved');
  const hooks = JSON.parse(await fs.readFile(path.join(home, '.codex', 'hooks.json'), 'utf8'));
  const startCmds = (hooks.hooks?.SessionStart ?? []).flatMap((g) => g.hooks ?? []).map((h) => h.command);
  const recallCmds = (hooks.hooks?.UserPromptSubmit ?? []).flatMap((g) => g.hooks ?? []).map((h) => h.command);
  assert.ok(startCmds.some((c) => c.includes('hook-session-start') && c.includes('--runtime') && c.includes('codex')), 'Codex SessionStart hook installed');
  assert.ok(recallCmds.some((c) => c.includes('hook-user-prompt-submit')), 'Codex UserPromptSubmit hook installed');
});

test('codex connect --easy --json still installs hooks + AGENTS loop and reports outcomes', async (t) => {
  const proj = await mkdtempReal('ihow-proj-');
  const home = await mkdtempReal('ihow-home-');
  const bin = await makeCodexShim();
  t.after(async () => { for (const d of [proj, home, bin]) await fs.rm(d, { recursive: true, force: true }); });

  const out = runCodexConnect({ cwd: proj, home, bin, args: ['--easy', '--json'] });
  const j = JSON.parse(out);
  assert.equal(j.runtime, 'codex');
  assert.equal(j.codexHooks, 'installed');
  assert.equal(j.codexGuidance, 'installed');
  assert.ok(await exists(path.join(home, '.codex', 'hooks.json')), 'json easy path installs hooks');
  assert.ok(await exists(path.join(home, '.codex', 'AGENTS.md')), 'json easy path installs AGENTS loop');
});

test('codex hook install respects CODEX_HOME instead of hard-coding ~/.codex', async (t) => {
  const proj = await mkdtempReal('ihow-proj-');
  const home = await mkdtempReal('ihow-home-');
  const codexHome = await mkdtempReal('ihow-codex-home-');
  const bin = await makeCodexShim();
  t.after(async () => { for (const d of [proj, home, codexHome, bin]) await fs.rm(d, { recursive: true, force: true }); });

  runCodexConnectWithEnv({ cwd: proj, bin, env: { HOME: home, CODEX_HOME: codexHome }, args: ['--easy'] });
  assert.ok(await exists(path.join(codexHome, 'hooks.json')), 'hooks written under CODEX_HOME');
  assert.ok(await exists(path.join(codexHome, 'AGENTS.md')), 'AGENTS written under CODEX_HOME');
  assert.equal(await exists(path.join(home, '.codex', 'hooks.json')), false, 'default ~/.codex not touched');
});
