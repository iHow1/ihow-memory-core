// SPDX-License-Identifier: Apache-2.0
// B4: continue computes a GREEN/YELLOW/RED verdict by re-reading live git and comparing to the
// recorded anchors — instead of leaving the check to the receiving agent's prose-following. GREEN is
// narrow on purpose (OpenClaw: a confidently-wrong structured GREEN is worse than prose); any
// uncertainty is YELLOW, an actual mismatch is RED. Never a false GREEN.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { computeContinueVerdict } from '../src/handoff.ts';
import { gitAnchors } from '../src/anchors.ts';

async function tmpRepo(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-verdict-')));
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  const g = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(dir, 'a.txt'), 'one');
  g('add', '.'); g('commit', '-qm', 'first');
  return { dir, g };
}

test('GREEN when the live repo matches the recorded anchors', async (t) => {
  const { dir } = await tmpRepo(t);
  const recorded = gitAnchors(dir);
  const v = computeContinueVerdict(recorded, dir, 'fixed the parser, tests pass');
  assert.equal(v.state, 'GREEN', v.reason);
  assert.equal(v.liveHead, recorded.head);
});

test('RED when HEAD drifted (someone committed since)', async (t) => {
  const { dir, g } = await tmpRepo(t);
  const recorded = gitAnchors(dir);
  await fs.writeFile(path.join(dir, 'b.txt'), 'two');
  g('add', '.'); g('commit', '-qm', 'second');
  const v = computeContinueVerdict(recorded, dir, 'clean narrative');
  assert.equal(v.state, 'RED', v.reason);
  assert.match(v.reason, /drift/i);
});

test('YELLOW when the project is undetermined', () => {
  const v = computeContinueVerdict({ isRepo: false }, undefined, 'x');
  assert.equal(v.state, 'YELLOW');
});

test('RED when a git project was recorded but the path is not a repo now (wrong checkout / machine)', async (t) => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-norepo-')));
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  const v = computeContinueVerdict({ isRepo: true, head: 'abc1234', branch: 'main' }, dir, 'x');
  assert.equal(v.state, 'RED', v.reason);
});

test('YELLOW when anchors match but the narrative mentions a destructive action', async (t) => {
  const { dir } = await tmpRepo(t);
  const recorded = gitAnchors(dir);
  const v = computeContinueVerdict(recorded, dir, 'next step: force push to main and reset --hard');
  assert.equal(v.state, 'YELLOW', v.reason);
});
