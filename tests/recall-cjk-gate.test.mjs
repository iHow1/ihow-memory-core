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

// red-team r-cjk-1: generic bigrams (现在 / 问题) must not ALONE satisfy the relevance gate, or an
// off-topic prompt sharing only a filler word injects unrelated reviewed memory.
test('recall CJK gate: a generic shared bigram (现在) does NOT surface an unrelated reviewed memory', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-cjk-recall-')));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const space = 'h';
  const cand = JSON.parse(cli(['write-candidate', '--no-auto-promote', '现在状态：数据库迁移方案采用蓝绿发布，负责人是 DBA 小组。'], root, space)).path;
  cli(['promote', cand, '--scope', 'team', '--title', '数据库迁移状态'], root, space);
  assert.equal(recall('现在几点了', root, space), '', '"现在几点了" shares only the filler bigram 现在 → stays silent');
});

test('recall CJK gate: a generic shared bigram (问题) does NOT surface an unrelated reviewed memory', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-cjk-recall-')));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const space = 'h';
  const cand = JSON.parse(cli(['write-candidate', '--no-auto-promote', '问题记录：支付网关限流阈值已经改为 500 req/s。'], root, space)).path;
  cli(['promote', cand, '--scope', 'team', '--title', '支付问题记录'], root, space);
  assert.equal(recall('这个问题怎么翻译成英文', root, space), '', '"…这个问题…" shares only the filler bigram 问题 → stays silent');
  // but an on-topic query (shares the CONTENT bigram 支付) still surfaces it — the fix didn't break recall.
  assert.match(recall('支付网关的限流阈值是多少', root, space), /支付|限流|500/, 'on-topic content bigram 支付 still recalls it');
});

// red-team r-cjk-2: the denylist must cover the long tail of discourse/connective bigrams, not just
// 现在/问题. Each case: an off-topic meta prompt shares ONLY a generic connective/modifier with the memory.
test('recall CJK gate: long-tail generic discourse bigrams do NOT over-inject', async (t) => {
  const cases = [
    ['关于数据库迁移的状态已经确认，负责人是 DBA 小组。', '关于这个词怎么造句'],
    ['对于支付网关限流策略，当前阈值是 500 req/s。', '对于这句话你怎么看'],
    ['通过蓝绿发布完成数据库迁移，回滚窗口为两小时。', '通过这个方法能学英语吗'],
    ['使用低饱和冷色调作为默认配色方案。', '使用这个词怎么写句子'],
    ['进行订单服务灰度发布时需要先冻结配置。', '进行是什么意思'],
    ['因此支付网关必须先启用限流。', '因此和所以有什么区别'],
    ['所有发布都需要回滚预案。', '所有这个词怎么用'],
    ['实际阈值是 500 req/s。', '实际是什么意思'],
  ];
  for (const [mem, q] of cases) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-cjk-tail-')));
    t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
    const space = 'h';
    const cand = JSON.parse(cli(['write-candidate', '--no-auto-promote', mem], root, space)).path;
    cli(['promote', cand, '--scope', 'team', '--title', 't'], root, space);
    assert.equal(recall(q, root, space), '', `off-topic "${q}" shares only a generic bigram with the memory → stays silent`);
  }
});
