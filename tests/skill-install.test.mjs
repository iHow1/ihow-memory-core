// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// alpha.4 one-click Claude Code skill install: `ihow-memory install-skill` copies the bundled
// SKILL.md into ~/.claude/skills/ihow-memory/ with the same safety as connect's MCP writes —
// never clobbers a user-modified file (backs it up), atomic, idempotent. HOME is redirected to a
// temp dir so no real ~/.claude is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'src', 'cli.ts');
const SKILL_SOURCE = path.join(REPO, 'skills', 'ihow-memory', 'SKILL.md');

async function mkdtempReal(prefix) {
  return await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

function runInstallSkill(home, extraArgs = []) {
  return execFileSync(process.execPath, [CLI, 'install-skill', ...extraArgs], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  });
}

test('install-skill copies the bundled SKILL.md into ~/.claude/skills', async (t) => {
  const home = await mkdtempReal('ihow-skill-home-');
  t.after(async () => { await fs.rm(home, { recursive: true, force: true }); });
  const out = runInstallSkill(home);
  assert.match(out, /installed memory skill/);
  const dest = path.join(home, '.claude', 'skills', 'ihow-memory', 'SKILL.md');
  assert.equal(await fs.readFile(dest, 'utf8'), await fs.readFile(SKILL_SOURCE, 'utf8'));
});

test('install-skill is idempotent and backs up a user-modified file', async (t) => {
  const home = await mkdtempReal('ihow-skill-home-');
  t.after(async () => { await fs.rm(home, { recursive: true, force: true }); });
  runInstallSkill(home);
  assert.match(runInstallSkill(home), /already current/);

  const dest = path.join(home, '.claude', 'skills', 'ihow-memory', 'SKILL.md');
  await fs.writeFile(dest, 'user edited content\n', 'utf8');
  const out3 = runInstallSkill(home);
  assert.match(out3, /backup:/);
  assert.equal(await fs.readFile(dest, 'utf8'), await fs.readFile(SKILL_SOURCE, 'utf8'));
  const files = await fs.readdir(path.dirname(dest));
  assert.ok(files.some((f) => f.includes('.ihow-bak-')), 'a backup of the modified file should exist');
});

test('install-skill --no-install-skill writes nothing', async (t) => {
  const home = await mkdtempReal('ihow-skill-home-');
  t.after(async () => { await fs.rm(home, { recursive: true, force: true }); });
  assert.match(runInstallSkill(home, ['--no-install-skill']), /Skipped/);
  const dest = path.join(home, '.claude', 'skills', 'ihow-memory', 'SKILL.md');
  await assert.rejects(fs.readFile(dest, 'utf8'));
});
