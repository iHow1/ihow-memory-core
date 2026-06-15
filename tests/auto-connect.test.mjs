// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// alpha.5 `connect --auto`: detect installed AI runtimes and (only with --write) connect them all to
// one shared workspace. Default is detect-and-report — no surprise writes to up to 7 user configs.
// Hermetic: a temp HOME holds simulated runtime config dirs; PATH is reduced to /usr/bin:/bin so the
// CLI-on-PATH detectors (claude/codex/hermes) find nothing and detection is deterministic.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'src', 'cli.ts');
const CLEAN_PATH = '/usr/bin:/bin'; // has `which` (for commandExists) but no claude/codex/hermes

async function mkdtempReal(prefix) {
  return await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}
function runConnectAuto({ cwd, home, args = [] }) {
  return execFileSync(process.execPath, [CLI, 'connect', '--auto', ...args], {
    encoding: 'utf8',
    cwd,
    env: { ...process.env, HOME: home, PATH: CLEAN_PATH },
  });
}
async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

test('connect --auto detects config-dir runtimes and, without --write, writes nothing', async (t) => {
  const home = await mkdtempReal('ihow-home-');
  const cwd = await mkdtempReal('ihow-proj-');
  t.after(async () => { for (const d of [home, cwd]) await fs.rm(d, { recursive: true, force: true }); });
  await fs.mkdir(path.join(home, '.cursor'), { recursive: true });
  await fs.mkdir(path.join(home, '.config', 'opencode'), { recursive: true });

  const out = runConnectAuto({ cwd, home });
  assert.match(out, /✓ cursor/);
  assert.match(out, /✓ opencode/);
  assert.match(out, /detect-only/);
  // nothing written
  assert.equal(await exists(path.join(home, '.cursor', 'mcp.json')), false, 'no cursor write without --write');
  assert.equal(await exists(path.join(home, '.config', 'opencode', 'opencode.json')), false, 'no opencode write without --write');
});

test('connect --auto --write connects every detected runtime to one shared workspace', async (t) => {
  const home = await mkdtempReal('ihow-home-');
  const cwd = await mkdtempReal('ihow-proj-');
  t.after(async () => { for (const d of [home, cwd]) await fs.rm(d, { recursive: true, force: true }); });
  await fs.mkdir(path.join(home, '.cursor'), { recursive: true });
  await fs.mkdir(path.join(home, '.config', 'opencode'), { recursive: true });

  const out = runConnectAuto({ cwd, home, args: ['--write'] });
  assert.match(out, /connecting 2 runtime\(s\)/);
  const cursorCfg = path.join(home, '.cursor', 'mcp.json');
  const opencodeCfg = path.join(home, '.config', 'opencode', 'opencode.json');
  assert.ok(await exists(cursorCfg), 'cursor config written');
  assert.ok(await exists(opencodeCfg), 'opencode config written');
  assert.match(await fs.readFile(cursorCfg, 'utf8'), /ihow-memory/);
  assert.match(await fs.readFile(opencodeCfg, 'utf8'), /ihow-memory/);
});

test('connect --auto reports nothing to do when no runtime is detected', async (t) => {
  const home = await mkdtempReal('ihow-home-');
  const cwd = await mkdtempReal('ihow-proj-');
  t.after(async () => { for (const d of [home, cwd]) await fs.rm(d, { recursive: true, force: true }); });

  const out = runConnectAuto({ cwd, home });
  assert.match(out, /No known runtimes detected/);
});
