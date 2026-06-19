// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// `continue --list` enumerates the most recent RESUMABLE sessions across EVERY recorded Claude Code
// project (not just the current cwd), newest activity first, so the user can pick which one to resume.
// It reuses the SAME primitives as the single-session `continue`, and these tests lock the four
// behaviours that matter: (1) newest-first ordering across multiple project dirs; (2) the live session
// excludes ITSELF (no self-replay at the top of the list); (3) project inference is EDITS-ONLY (a
// read-only session stays UNDETERMINED, never claims a repo it merely browsed); (4) every free-text
// field (summary snippet + git anchors) is redacted so a secret in a commit subject / narrative never
// leaks into the list.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/ihow-memory.mjs', import.meta.url));
const u = (c) => JSON.stringify({ type: 'user', message: { content: c } });
const a = (c) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: c }] } });
const asst = (blocks) => JSON.stringify({ type: 'assistant', message: { content: blocks } });
const tool = (name, fp) => ({ type: 'tool_use', name, input: { file_path: fp } });
const text = (t) => ({ type: 'text', text: t });
// a substantial text-only session (>= MIN_ENTRIES, a closing segment >= CLOSING_MIN_CHARS)
const big = (closing) => [u('开始任务'), a('第一步'), a('中间汇报'), a(closing)].join('\n') + '\n';

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
async function makeRepo(dir, subject = 'seed') {
  await fs.mkdir(dir, { recursive: true });
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 'T']);
  await fs.writeFile(path.join(dir, 'seed.txt'), 'x\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', subject]);
}
// place a transcript under HOME/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
async function writeSession(home, cwd, sessionId, transcript) {
  const encoded = path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
  const dir = path.join(home, '.claude', 'projects', encoded);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${sessionId}.jsonl`), transcript, 'utf8');
}
const run = (home, args, extraEnv = {}) =>
  execFileSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, ...extraEnv },
  });

test('continue --list: newest activity first across multiple projects, with project + branch + HEAD', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-listbase-'));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-home-'));
  t.after(async () => {
    await fs.rm(base, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });
  const repoOld = path.join(base, 'projOld');
  const repoNew = path.join(base, 'projNew');
  await makeRepo(repoOld);
  await makeRepo(repoNew);

  // OLDER session edited projOld...
  await writeSession(home, '/tmp/list-cwd-old', 'sessOld',
    [u('做 projOld'), asst([tool('Edit', path.join(repoOld, 'seed.txt')), text('改')]), a('中间'),
      asst([text('OLD-RECAP 这是较早的会话, 编辑了 projOld 的文件, 下一步继续。'.repeat(2))])].join('\n') + '\n');
  await new Promise((r) => setTimeout(r, 30));
  // ...NEWER session edited projNew (must list FIRST).
  await writeSession(home, '/tmp/list-cwd-new', 'sessNew',
    [u('做 projNew'), asst([tool('Edit', path.join(repoNew, 'seed.txt')), text('改')]), a('中间'),
      asst([text('NEW-RECAP 这是较新的会话, 编辑了 projNew 的文件, 下一步继续。'.repeat(2))])].join('\n') + '\n');

  const json = JSON.parse(run(home, ['continue', '--list', '--json'], { CLAUDE_CODE_SESSION_ID: 'irrelevant' }));
  assert.equal(json.sessions.length, 2, 'both substantial sessions are listed');
  assert.equal(json.sessions[0].sessionId, 'sessNew', 'newest activity is listed first');
  assert.equal(json.sessions[1].sessionId, 'sessOld', 'older session follows');
  assert.match(json.sessions[0].project, /projNew$/, 'project inferred from the EDITED file, not the session cwd');
  assert.match(json.sessions[1].project, /projOld$/, 'older session inferred its own project');
  assert.ok(json.sessions[0].branch && json.sessions[0].head, 'git branch + HEAD anchors carried for the inferred project');

  // text rendering shows the picker with both projects, numbered.
  const txt = run(home, ['continue', '--list'], { CLAUDE_CODE_SESSION_ID: 'irrelevant' });
  assert.match(txt, /Resumable sessions/, 'prints the picker header');
  assert.match(txt, /1\. .*projNew/, 'first row is the newest project');
  assert.match(txt, /2\. .*projOld/, 'second row is the older project');
});

test('continue --list: never lists the CURRENTLY-RUNNING session (no self-replay)', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-home-'));
  t.after(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });
  // prior real work (older)...
  await writeSession(home, '/tmp/list-self-cwd', 'priorsess', big('上一段真实工作 PRIOR-LIST-OK, 下一步继续。'.repeat(3)));
  await new Promise((r) => setTimeout(r, 30));
  // ...then THIS session's transcript — newest, would otherwise top the list.
  await writeSession(home, '/tmp/list-self-cwd', 'selfsess', big('本会话自己刚做的事 SELF-LIST-BAD, 不该出现在列表里。'.repeat(3)));

  const json = JSON.parse(run(home, ['continue', '--list', '--json'], { CLAUDE_CODE_SESSION_ID: 'selfsess' }));
  const ids = json.sessions.map((s) => s.sessionId);
  assert.ok(ids.includes('priorsess'), 'the prior session is listed');
  assert.ok(!ids.includes('selfsess'), 'the live session never lists itself');
  const txt = run(home, ['continue', '--list'], { CLAUDE_CODE_SESSION_ID: 'selfsess' });
  assert.doesNotMatch(txt, /SELF-LIST-BAD/, 'the live session narrative is not surfaced in the list');
  assert.match(txt, /PRIOR-LIST-OK/, 'the prior session narrative is shown');
});

test('continue --list: a READ-ONLY session stays UNDETERMINED (never infers a project from reads)', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-rolist-'));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-home-'));
  t.after(async () => {
    await fs.rm(base, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });
  const repoA = path.join(base, 'projReadOnly');
  await makeRepo(repoA);
  await writeSession(home, '/tmp/list-ro-cwd', 'rosess',
    [u('看一下'), asst([tool('Read', path.join(repoA, 'a.js')), text('读')]),
      asst([tool('Read', path.join(repoA, 'b.js')), text('读2')]),
      asst([text('RO-LIST-RECAP 只读了 projReadOnly 没有编辑任何东西。'.repeat(2))])].join('\n') + '\n');

  const json = JSON.parse(run(home, ['continue', '--list', '--json'], { CLAUDE_CODE_SESSION_ID: 'irrelevant' }));
  const row = json.sessions.find((s) => s.sessionId === 'rosess');
  assert.ok(row, 'the read-only session is still listed');
  assert.equal(row.project, null, 'a merely-READ repo never becomes the inferred project');
  assert.equal(row.branch, null, 'no git branch anchor is claimed for a read-only session');
  const txt = run(home, ['continue', '--list'], { CLAUDE_CODE_SESSION_ID: 'irrelevant' });
  assert.match(txt, /UNDETERMINED/, 'text rendering shows UNDETERMINED for the read-only session');
  // The project LINE (the inferred project + its git anchor) must never name the merely-read repo. The
  // summary snippet may quote a read file path verbatim (that is the prior agent's UNVERIFIED narrative),
  // so we assert against the project/git rows specifically, not the whole block.
  const projectLine = txt.split('\n').find((l) => /^\s*\d+\.\s/.test(l)) ?? '';
  const gitLine = txt.split('\n').find((l) => /^\s+git:/.test(l)) ?? '';
  assert.doesNotMatch(projectLine, /projReadOnly/, 'the read-only repo never appears as the inferred project');
  assert.doesNotMatch(gitLine, /projReadOnly/, 'no git anchor is claimed from a merely-read repo');
});

test('continue --list: redacts secret-like content in the summary snippet', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-home-'));
  t.after(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });
  // a closing narrative that embeds a fake token assignment — must be redacted out of the list snippet.
  const secret = 'sk-livesecrettoken1234567890ABCDEF';
  await writeSession(home, '/tmp/list-secret-cwd', 'secretsess',
    big(`下一步部署, token=${secret} 用这个连上去, REDACT-LIST-CHECK 继续工作。`.repeat(2)));

  const txt = run(home, ['continue', '--list'], { CLAUDE_CODE_SESSION_ID: 'irrelevant' });
  assert.doesNotMatch(txt, /sk-livesecrettoken/, 'the secret VALUE never leaks into the list snippet');
  assert.match(txt, /\[redacted\]/, 'the secret is replaced by a redaction marker');
  const json = JSON.parse(run(home, ['continue', '--list', '--json'], { CLAUDE_CODE_SESSION_ID: 'irrelevant' }));
  assert.doesNotMatch(JSON.stringify(json), /sk-livesecrettoken/, 'json output is redacted too');
});

test('continue --list: honest empty-state when no sessions are recorded', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-home-'));
  t.after(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });
  const txt = run(home, ['continue', '--list'], { CLAUDE_CODE_SESSION_ID: 'irrelevant' });
  assert.match(txt, /No resumable sessions found/, 'honest empty-state, no crash');
  const json = JSON.parse(run(home, ['continue', '--list', '--json'], { CLAUDE_CODE_SESSION_ID: 'irrelevant' }));
  assert.deepEqual(json, { sessions: [] }, 'json empty-state is an empty list');
});

test('continue --list: --limit bounds the number of rows', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-home-'));
  t.after(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });
  for (let i = 0; i < 4; i += 1) {
    await writeSession(home, `/tmp/list-limit-cwd-${i}`, `sess${i}`, big(`会话 ${i} 的工作 LIMIT-CHECK 下一步继续。`.repeat(3)));
    await new Promise((r) => setTimeout(r, 10));
  }
  const json = JSON.parse(run(home, ['continue', '--list', '--limit', '2', '--json'], { CLAUDE_CODE_SESSION_ID: 'irrelevant' }));
  assert.equal(json.sessions.length, 2, '--limit 2 returns exactly 2 rows');
});
