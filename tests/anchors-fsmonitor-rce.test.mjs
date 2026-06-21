// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Security regression: gitAnchors runs git in directories mined VERBATIM from other tools' session
// stores. A repo-local `.git/config` `core.fsmonitor = <command>` is executed by `git status` — an RCE
// triggered merely by running memory.continue against an attacker-plantable session path. gitAnchors must
// neutralize it (command-line `-c core.fsmonitor=` overrides the repo config) while still working normally.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { gitAnchors } from '../src/anchors.ts';

async function mkdtempReal(prefix) {
  return await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

test('gitAnchors does NOT execute a repo-local core.fsmonitor command, but still reads anchors', async (t) => {
  const dir = await mkdtempReal('ihow-fsmon-');
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  const marker = path.join(dir, 'PWNED');
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });

  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  await fs.writeFile(path.join(dir, 'f.txt'), 'hi');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  // Plant the attack AFTER setup, then clear any marker, so only gitAnchors' own git calls can create it.
  // (An unhardened `git add`/`status` would have fired the hook during setup — exactly the RCE we block.)
  git('config', 'core.fsmonitor', `touch ${marker}`);
  await fs.rm(marker, { force: true });

  const anchors = gitAnchors(dir);

  // the hardening must not break normal anchor computation
  assert.equal(anchors.isRepo, true, 'still detected as a repo');
  assert.ok(anchors.head, 'HEAD anchor still computed');
  assert.equal(anchors.branch && typeof anchors.branch, 'string', 'branch still computed');
  // and the fsmonitor payload must never have run
  await assert.rejects(fs.access(marker), 'core.fsmonitor command must NOT have executed under gitAnchors');
});
