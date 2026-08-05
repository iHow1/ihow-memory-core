// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Hypothesis ② (grooming decay) measurement lane. The PRIMARY signal anchorConflictCount is computed
// deterministically — git-SHA-shaped tokens the narrative cites that don't match live HEAD — so the
// trend ("do handoffs get less wrong over time?") needs no LLM. Also locks the privacy contract: the
// appended row carries DERIVED counts + a narrative HASH only, never raw narrative; and the lane is
// fully opt-out (IHOW_HANDOFF_METRICS=0) and fault-tolerant.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { anchorConflicts } from '../src/handoff-metrics.ts';

const CLI = fileURLToPath(new URL('../bin/ihow-memory.mjs', import.meta.url));
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

// --- pure metric logic (no disk) ---
test('anchorConflicts: counts stale SHA refs and recognizes the live HEAD', () => {
  // narrative cites an old sha 9cd4dc2 while HEAD is really e1d482b -> one stale conflict
  const a = anchorConflicts('上次在 9cd4dc2，要推 16 个提交', 'e1d482baaaa');
  assert.equal(a.stale, 1, 'the stale sha is counted as a conflict');
  assert.equal(a.referencesHead, false, 'it does not reference the live head');
  // narrative cites the live HEAD (prefix) -> no conflict, references head
  const b = anchorConflicts('当前 HEAD e1d482b，干净', 'e1d482baaaa');
  assert.equal(b.stale, 0, 'a matching head prefix is not a conflict');
  assert.equal(b.referencesHead, true, 'recognizes the narrative cites the live head');
  // no sha-shaped tokens at all
  assert.deepEqual(anchorConflicts('没有任何提交哈希', 'e1d482b'), { total: 0, stale: 0, referencesHead: false });
  // pure-decimal runs (line counts, durations, issue IDs) must NOT be mistaken for commit SHAs
  assert.deepEqual(anchorConflicts('处理了 12345678 行，耗时 9876543 毫秒，issue 1234567', 'e1d482b'), { total: 0, stale: 0, referencesHead: false });
});

async function makeRepo(dir) {
  await fs.mkdir(dir, { recursive: true });
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 'T']);
  await fs.writeFile(path.join(dir, 'seed.txt'), 'x\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'seed']);
  return git(dir, ['rev-parse', '--short', 'HEAD']).trim();
}

// build a transcript whose narrative edits `repo` (so it is the inferred project) and cites a fake
// stale sha that won't match the repo's real HEAD.
function transcriptEditing(repo, staleSha) {
  const u = (c) => JSON.stringify({ type: 'user', message: { content: c } });
  const asst = (blocks) => JSON.stringify({ type: 'assistant', message: { content: blocks } });
  const tool = (name, fp) => ({ type: 'tool_use', name, input: { file_path: fp } });
  const text = (t) => ({ type: 'text', text: t });
  return [
    u('继续干'),
    asst([tool('Edit', path.join(repo, 'a.js')), text('改了 a.js')]),
    asst([tool('Edit', path.join(repo, 'b.js')), text('又改了 b.js')]),
    asst([text(`交接：上次在 ${staleSha} 完成了某事，下一步继续。`.repeat(2))]),
  ].join('\n') + '\n';
}

test('continue: appends a content-free handoff-metrics row with the deterministic conflict count', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hm-'));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-home-'));
  t.after(async () => {
    await fs.rm(base, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });
  const repo = path.join(base, 'projHM');
  await makeRepo(repo);
  const staleSha = 'deadbee'; // 7-hex, won't match the repo's real HEAD
  const cwd = '/tmp/hm-session-cwd';
  const encoded = path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
  const projDir = path.join(home, '.claude', 'projects', encoded);
  await fs.mkdir(projDir, { recursive: true });
  await fs.writeFile(path.join(projDir, 'sess.jsonl'), transcriptEditing(repo, staleSha), 'utf8');

  const out = execFileSync(process.execPath, [CLI, 'continue', '--cwd', cwd], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, CLAUDE_CODE_SESSION_ID: 'unrelated' }, // metrics ON (default)
  });
  assert.match(out, /repo: projHM/, 'sanity: anchors came from the edited project');

  const raw = await fs.readFile(path.join(home, '.ihow-memory', 'handoff-metrics.jsonl'), 'utf8');
  const rows = raw.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 1, 'exactly one metric row was appended');
  const row = rows[0];
  assert.equal(row.project, 'projHM', 'buckets by project basename');
  assert.ok(row.anchorConflictCount >= 1, 'the stale sha is counted as an anchor conflict');
  assert.equal(typeof row.narrativeHash, 'string', 'stores a narrative hash, not the narrative');
  // privacy: no raw narrative / file paths leaked into the row
  const blob = JSON.stringify(row);
  assert.doesNotMatch(blob, /交接/, 'no raw narrative text in the row');
  assert.doesNotMatch(blob, /a\.js/, 'no edited file paths in the row');
});

test('continue: IHOW_HANDOFF_METRICS=0 writes no metrics row (opt-out honored)', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-home-'));
  t.after(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });
  const cwd = '/tmp/hm-optout-cwd';
  const encoded = path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
  const projDir = path.join(home, '.claude', 'projects', encoded);
  await fs.mkdir(projDir, { recursive: true });
  const u = (c) => JSON.stringify({ type: 'user', message: { content: c } });
  const a = (c) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: c }] } });
  await fs.writeFile(path.join(projDir, 's.jsonl'), [u('开始'), a('一'), a('二'), a('三 OPTOUT')].join('\n') + '\n', 'utf8');

  execFileSync(process.execPath, [CLI, 'continue', '--cwd', cwd], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, CLAUDE_CODE_SESSION_ID: 'unrelated', IHOW_HANDOFF_METRICS: '0' },
  });
  await assert.rejects(fs.readFile(path.join(home, '.ihow-memory', 'handoff-metrics.jsonl'), 'utf8'), 'no metrics file is created when opted out');
});
