// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// OpenCode (SST) stores sessions in ~/.local/share/opencode/opencode.db (SQLite). A session row carries
// the cwd in `directory`; message role is in `message.data`; visible text is in `part` rows of type
// "text". This proves the reader: tool-tagged, project from the recorded cwd, scope-locked (first user
// topic + assistant text only — no reasoning/tool parts, no non-first user dump), and subagent sessions
// (parent_id set) excluded.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { buildHandoffPacket } from '../src/handoff.ts';

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
async function makeRepo(dir) {
  await fs.mkdir(dir, { recursive: true });
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 'T']);
  await fs.writeFile(path.join(dir, 'seed.txt'), 'x\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'seed']);
}

test('OpenCode opencode.db session surfaces (cwd project, text parts only, subagent + non-text excluded)', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-home-'));
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-base-'));
  const origHome = process.env.HOME;
  t.after(async () => {
    process.env.HOME = origHome;
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(base, { recursive: true, force: true });
  });

  const repo = path.join(base, 'ocodeproj');
  await makeRepo(repo);

  const dir = path.join(home, '.local', 'share', 'opencode');
  await fs.mkdir(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'opencode.db'));
  db.exec(
    'CREATE TABLE session (id TEXT, parent_id TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER);' +
      'CREATE TABLE message (id TEXT, session_id TEXT, data TEXT, time_created INTEGER);' +
      'CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, data TEXT, time_created INTEGER);',
  );
  const sid = 'ses_top';
  const sub = 'ses_sub';
  const sIns = db.prepare('INSERT INTO session (id, parent_id, directory, time_created, time_updated) VALUES (?, ?, ?, ?, ?)');
  sIns.run(sid, null, repo, 1000, 2000); // top-level thread (resumable)
  sIns.run(sub, sid, repo, 1000, 2001); // subagent run -> must NOT surface as a candidate
  const mIns = db.prepare('INSERT INTO message (id, session_id, data, time_created) VALUES (?, ?, ?, ?)');
  mIns.run('m1', sid, JSON.stringify({ role: 'user' }), 1001);
  mIns.run('m2', sid, JSON.stringify({ role: 'user' }), 1002);
  mIns.run('m3', sid, JSON.stringify({ role: 'assistant' }), 1003);
  mIns.run('ms', sub, JSON.stringify({ role: 'assistant' }), 1004);
  const pIns = db.prepare('INSERT INTO part (id, message_id, session_id, data, time_created) VALUES (?, ?, ?, ?, ?)');
  pIns.run('p1', 'm1', sid, JSON.stringify({ type: 'text', text: '继续做 ocodeproj，先接上。' }), 1001);
  pIns.run('p2', 'm2', sid, JSON.stringify({ type: 'text', text: 'SECRET-SECOND-USER 非首位用户消息不应进入接班包。'.repeat(2) }), 1002);
  pIns.run('p3', 'm3', sid, JSON.stringify({ type: 'reasoning', text: 'REASONING-SECRET 推理内容不应进入接班包' }), 1003);
  pIns.run('p4', 'm3', sid, JSON.stringify({ type: 'tool', tool: 'bash' }), 1003);
  pIns.run('p5', 'm3', sid, JSON.stringify({ type: 'text', text: 'OPENCODE-NARRATIVE 上一段 opencode 工作已就绪，下一步继续。'.repeat(3) }), 1003);
  pIns.run('psub', 'ms', sub, JSON.stringify({ type: 'text', text: 'SUBAGENT-SECRET 子agent内容不应作为顶层候选出现' }), 1004);
  db.close();

  process.env.HOME = home;
  const pkt = await buildHandoffPacket({ limit: 5 });
  const c = pkt.candidates.find((x) => x.tool === 'opencode');
  assert.ok(c, 'an opencode session appears in the packet');
  assert.equal(c.project.basename, 'ocodeproj', 'project mapped from the session.directory cwd');
  assert.equal(c.anchors.isRepo, true, 'git anchors resolved from the recorded cwd');
  assert.match(c.narrative.text, /OPENCODE-NARRATIVE/, 'carries the assistant text-part narrative');
  assert.equal(c.narrative.unverified, true, 'narrative flagged UNVERIFIED');
  assert.doesNotMatch(c.narrative.text, /SECRET-SECOND-USER/, 'non-first user turns stay scoped out');
  assert.doesNotMatch(c.narrative.text, /REASONING-SECRET/, 'reasoning parts are not captured');
  assert.doesNotMatch(c.narrative.text, /SUBAGENT-SECRET/, 'subagent sessions are excluded');
});
