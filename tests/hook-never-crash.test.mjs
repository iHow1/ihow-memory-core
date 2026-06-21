// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// The never-crash-the-host contract: a Claude Code hook command must NEVER exit non-zero or write to
// stderr, even when the filesystem rejects the marker write — Claude surfaces a non-zero hook exit as
// a per-turn failure. Regression for the unguarded fs.mkdir/fs.writeFile in runStopHook.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts');

async function mkdtempReal(prefix) {
  return await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

test('hook-stop exits 0 and still nudges when the marker dir cannot be created', async (t) => {
  const root = await mkdtempReal('ihow-hook-crash-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });

  // Provision the workspace so ensureWorkspace succeeds…
  execFileSync(process.execPath, [CLI, 'init', '--root', root, '--space', 'h'], { encoding: 'utf8' });
  // …then sabotage the marker dir: put a FILE where `.hooks/` must be created, so mkdir/writeFile throw.
  await fs.writeFile(path.join(root, 'h', '.hooks'), 'x', 'utf8');

  const transcript = path.join(root, 't.jsonl');
  await fs.writeFile(
    transcript,
    ['{"role":"user"}', '{"role":"assistant"}', '{"role":"user"}', '{"role":"assistant"}', '{"role":"user"}'].join('\n') + '\n',
    'utf8',
  );

  const res = spawnSync(process.execPath, [CLI, 'hook-stop', '--root', root, '--space', 'h'], {
    input: JSON.stringify({ session_id: 'crash1', transcript_path: transcript }),
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, 'hook must exit 0 even when it cannot persist the marker');
  assert.equal(JSON.parse(res.stdout).decision, 'block', 'the capture nudge still fires');
});
