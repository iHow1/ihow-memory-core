// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Recall CJK relevance-gate regression. The FTS index tokenizes CJK as BIGRAMS, so search FINDS a Chinese
// memory that shares a 2-char term — but the recall relevance gate used to keep the whole CJK run as ONE
// token and substring-match it, so a rephrased Chinese prompt ("配色偏好是什么" vs stored "配色…冷色调") was
// found by search yet DROPPED by the gate → Chinese recall silently failed. recallTerms now emits CJK
// bigrams (in sync with the index), skipping a few function-word bigrams. These lock: (1) a rephrased
// Chinese prompt now surfaces the reviewed memory; (2) an off-topic Chinese prompt still injects nothing
// (the more permissive gate did not start over-injecting).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts');
const cli = (args, root, space) => execFileSync(process.execPath, [CLI, ...args, '--root', root, '--space', space], { encoding: 'utf8' });
function recall(prompt, root, space) {
  const r = spawnSync(process.execPath, [CLI, 'hook-user-prompt-submit', '--root', root, '--space', space], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt, cwd: root }),
    encoding: 'utf8',
    env: { ...process.env },
  });
  const out = (r.stdout || '').trim();
  if (!out) return '';
  try { return JSON.parse(out).hookSpecificOutput?.additionalContext || ''; } catch { return ''; }
}
async function seedZhPref(root, space) {
  const cand = JSON.parse(cli(['write-candidate', '--no-auto-promote', '用户偏好：配色用低饱和冷色调，不要高对比荧光色。'], root, space)).path;
  cli(['promote', cand, '--scope', 'pref', '--title', '配色偏好'], root, space);
}

test('recall CJK gate: a rephrased Chinese prompt surfaces the reviewed memory', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-cjk-recall-')));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const space = 'h';
  await seedZhPref(root, space);
  const ctx = recall('配色偏好是什么', root, space);
  assert.match(ctx, /配色|冷色调/, 'the rephrased CJK query recalls the color-preference memory (gate no longer drops what search found)');
});

test('recall CJK gate: an off-topic Chinese prompt injects nothing (no over-permit)', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-cjk-recall-')));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const space = 'h';
  await seedZhPref(root, space);
  const ctx = recall('帮我写一首诗', root, space);
  assert.equal(ctx, '', 'off-topic Chinese prompt stays silent — the bigram gate did not start over-injecting');
});
