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
