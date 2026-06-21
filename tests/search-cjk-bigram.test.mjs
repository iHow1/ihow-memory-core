// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// The documented "dumb search": searching CJK split every Han run into single characters and OR-matched
// them, so "评价" (evaluation) matched "评分" (scoring) via the shared "评" and flooded the top results.
// We now index unigrams + overlapping BIGRAMS and query with bigrams, so "评价" matches the "评价" 2-gram
// only. This test pins that precision win + a clean (frontmatter-free) snippet.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/ihow-memory.mjs', import.meta.url));
function cli(args, root, space) {
  return execFileSync(process.execPath, [CLI, ...args, '--space', space, '--root', root], {
    encoding: 'utf8',
    env: { ...process.env, IHOW_HANDOFF_METRICS: '0' },
  });
}
const promote = (text, title, root, space) => {
  const cand = JSON.parse(cli(['write-candidate', text], root, space)).path;
  cli(['promote', cand, '--scope', 'team', '--title', title], root, space);
};

test('CJK search is bigram-precise: "评价" matches 评价, not 评分 (no character-soup)', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-cjk-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const space = 'cjk';
  cli(['init'], root, space);
  promote('团队评价流程:每月对成员做一次工作评价并记录。', 'pingjia', root, space);
  promote('比赛评分细则:裁判按统一口径打分评分。', 'pingfen', root, space);

  const hits = JSON.parse(cli(['search', '评价'], root, space));
  const paths = hits.map((h) => h.path).join('\n');
  assert.match(paths, /pingjia/, '"评价" surfaces the 评价 document');
  assert.doesNotMatch(paths, /pingfen/, '"评价" does NOT match the 评分 document (the old single-char bug)');

  // snippet is readable content, not YAML frontmatter
  const top = hits.find((h) => /pingjia/.test(h.path));
  assert.ok(top, 'got the 评价 hit');
  assert.match(top.snippet, /评价/, 'snippet shows the matched content');
  assert.doesNotMatch(top.snippet, /candidate_id|promoted_at:|source_agent:/, 'snippet has no frontmatter noise');
});

test('single CJK char still matches inside words (unigram fallback)', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-cjk-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const space = 'cjk1';
  cli(['init'], root, space);
  promote('部署手册:上线流程与回滚步骤。', 'deploy', root, space);
  const hits = JSON.parse(cli(['search', '部'], root, space));
  assert.match(hits.map((h) => h.path).join('\n'), /deploy/, 'a lone CJK char "部" still finds 部署 via the unigram');
});
