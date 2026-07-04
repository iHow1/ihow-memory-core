// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Productization of today's manual recipe: `connect --runtime openclaw` (nested mcp.servers in
// ~/.openclaw/openclaw.json) and `setup` auto-injecting proactive memory.continue guidance for the
// markdown/config runtimes (OpenClaw AGENTS.md, OpenCode opencode.json instructions). These cover the
// gaps an audit flagged: OpenClaw was a connect dead-end, and guidance was Claude/WorkBuddy-only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/ihow-memory.mjs', import.meta.url));
const run = (home, args) => execFileSync(process.execPath, [CLI, ...args], {
  encoding: 'utf8',
  env: { ...process.env, HOME: home, IHOW_HANDOFF_METRICS: '0' },
});

test('connect --runtime openclaw writes nested mcp.servers and preserves other keys', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-home-'));
  t.after(async () => { await fs.rm(home, { recursive: true, force: true }); });
  await fs.mkdir(path.join(home, '.openclaw'), { recursive: true });
  // a realistic openclaw.json: existing nested server + a secrets block that must survive
  await fs.writeFile(
    path.join(home, '.openclaw', 'openclaw.json'),
    JSON.stringify({ meta: { v: 1 }, mcp: { servers: { existing: { command: 'x' } } }, secrets: { k: 'KEEP_ME' } }),
    'utf8',
  );
  run(home, ['connect', '--runtime', 'openclaw']);
  const d = JSON.parse(await fs.readFile(path.join(home, '.openclaw', 'openclaw.json'), 'utf8'));
  assert.ok(d.mcp.servers['ihow-memory'], 'ihow-memory added under mcp.servers');
  assert.ok(d.mcp.servers.existing, 'pre-existing nested server preserved');
  assert.equal(d.secrets.k, 'KEEP_ME', 'unrelated keys (secrets) preserved by the nested write');
  assert.match(d.mcp.servers['ihow-memory'].args[0], /server\.js$/, 'points at the staged MCP server');
});

test('setup --runtime openclaw injects memory.continue guidance into AGENTS.md (idempotent, content kept)', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-home-'));
  t.after(async () => { await fs.rm(home, { recursive: true, force: true }); });
  await fs.mkdir(path.join(home, '.openclaw', 'workspace'), { recursive: true });
  await fs.writeFile(path.join(home, '.openclaw', 'openclaw.json'), JSON.stringify({ mcp: { servers: {} } }), 'utf8');
  const agents = path.join(home, '.openclaw', 'workspace', 'AGENTS.md');
  await fs.writeFile(agents, '# AGENTS\n\nPRE-EXISTING-OPENCLAW-CONTENT\n', 'utf8');

  run(home, ['setup', '--runtime', 'openclaw']);
  let body = await fs.readFile(agents, 'utf8');
  assert.match(body, /iHow Memory — resume across threads/, 'resume marker injected into AGENTS.md');
  assert.match(body, /memory\.continue/, 'guidance mentions memory.continue');
  assert.match(body, /PRE-EXISTING-OPENCLAW-CONTENT/, 'pre-existing AGENTS.md content preserved');

  // idempotent: a second setup must not double-inject
  run(home, ['setup', '--runtime', 'openclaw']);
  body = await fs.readFile(agents, 'utf8');
  assert.equal(body.match(/iHow Memory — resume across threads/g).length, 1, 'guidance injected exactly once');
});

test('setup --runtime opencode injects instructions + creates the resume guide file', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-home-'));
  t.after(async () => { await fs.rm(home, { recursive: true, force: true }); });
  await fs.mkdir(path.join(home, '.config', 'opencode'), { recursive: true });
  await fs.writeFile(path.join(home, '.config', 'opencode', 'opencode.json'), JSON.stringify({ $schema: 'x', mcp: {} }), 'utf8');

  run(home, ['setup', '--runtime', 'opencode']);
  const d = JSON.parse(await fs.readFile(path.join(home, '.config', 'opencode', 'opencode.json'), 'utf8'));
  const guide = path.join(home, '.config', 'opencode', 'ihow-resume.md');
  assert.ok(Array.isArray(d.instructions) && d.instructions.includes(guide), 'opencode.json instructions references the guide');
  const exists = await fs.access(guide).then(() => true, () => false);
  assert.ok(exists, 'ihow-resume.md guide file created');
  assert.match(await fs.readFile(guide, 'utf8'), /memory\.continue/, 'guide tells the agent to call memory.continue');
});

test('setup --runtime codex installs hooks + proactive AGENTS loop (idempotent, content kept)', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-home-'));
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-bin-'));
  t.after(async () => {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(bin, { recursive: true, force: true });
  });
  const codex = path.join(bin, 'codex');
  await fs.writeFile(codex, '#!/bin/sh\nif [ "$1" = "mcp" ] && [ "$2" = "get" ]; then exit 1; fi\nif [ "$1" = "mcp" ] && [ "$2" = "list" ]; then echo "ihow-memory"; exit 0; fi\nexit 0\n', 'utf8');
  await fs.chmod(codex, 0o755);
  await fs.mkdir(path.join(home, '.codex'), { recursive: true });
  const agents = path.join(home, '.codex', 'AGENTS.md');
  await fs.writeFile(agents, '# Existing Codex Rules\n\nKEEP-CODEX-CONTENT\n', 'utf8');

  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, IHOW_HANDOFF_METRICS: '0' };
  execFileSync(process.execPath, [CLI, 'setup', '--runtime', 'codex'], { encoding: 'utf8', env });
  let body = await fs.readFile(agents, 'utf8');
  assert.match(body, /iHow Memory — Codex proactive memory loop/, 'Codex memory loop injected');
  assert.match(body, /memory\.continue/, 'loop tells Codex to call memory.continue');
  assert.match(body, /memory\.search/, 'loop tells Codex to search memory proactively');
  assert.match(body, /memory\.write_candidate/, 'loop tells Codex to write durable facts');
  assert.match(body, /memory\.forget/, 'loop tells Codex how to correct wrong memories');
  assert.match(body, /KEEP-CODEX-CONTENT/, 'pre-existing AGENTS.md content preserved');
  let hooks = JSON.parse(await fs.readFile(path.join(home, '.codex', 'hooks.json'), 'utf8'));
  const startCmds = (hooks.hooks?.SessionStart ?? []).flatMap((g) => g.hooks ?? []).map((h) => h.command);
  const recallCmds = (hooks.hooks?.UserPromptSubmit ?? []).flatMap((g) => g.hooks ?? []).map((h) => h.command);
  assert.ok(startCmds.some((c) => c.includes('hook-session-start') && c.includes('--runtime') && c.includes('codex')), 'Codex SessionStart hook installed');
  assert.ok(recallCmds.some((c) => c.includes('hook-user-prompt-submit')), 'Codex UserPromptSubmit hook installed');

  execFileSync(process.execPath, [CLI, 'setup', '--runtime', 'codex'], { encoding: 'utf8', env });
  body = await fs.readFile(agents, 'utf8');
  assert.equal(body.match(/iHow Memory — Codex proactive memory loop/g).length, 1, 'loop injected exactly once');
  hooks = JSON.parse(await fs.readFile(path.join(home, '.codex', 'hooks.json'), 'utf8'));
  assert.equal(JSON.stringify(hooks).match(/hook-session-start/g).length, 1, 'SessionStart hook injected exactly once');
  assert.equal(JSON.stringify(hooks).match(/hook-user-prompt-submit/g).length, 1, 'UserPromptSubmit hook injected exactly once');
});
