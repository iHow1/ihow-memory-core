// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// The current Hermes desktop build persists sessions in ~/.hermes/state.db (SQLite), NOT the legacy
// ~/.hermes/sessions/*.json files (which stop at the pre-migration session). Without a state.db reader a
// runtime's RECENT Hermes work never surfaces as resumable. This proves the state.db source: a session in
// the db is tool-tagged, its project is inferred from a terminal.workdir tool-call arg, and the shared
// scope lock still holds (no tool-result content, no non-first user dump).
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

test('Hermes state.db session surfaces in the handoff packet (tool-tagged, workdir project, scope-locked)', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-home-'));
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-base-'));
  const origHome = process.env.HOME;
  t.after(async () => {
    process.env.HOME = origHome;
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(base, { recursive: true, force: true });
  });

  const repo = path.join(base, 'hmdbproj');
  await makeRepo(repo);

  const dbDir = path.join(home, '.hermes');
  await fs.mkdir(dbDir, { recursive: true });
  const db = new DatabaseSync(path.join(dbDir, 'state.db'));
  db.exec(
    'CREATE TABLE sessions (id TEXT PRIMARY KEY, started_at REAL);' +
      'CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL);',
  );
  const sid = '20260620_hmdb_unit';
  db.prepare('INSERT INTO sessions (id, started_at) VALUES (?, ?)').run(sid, 1781950000);
  const ins = db.prepare('INSERT INTO messages (session_id, role, content, tool_calls, timestamp) VALUES (?, ?, ?, ?, ?)');
  ins.run(sid, 'user', '继续做 hmdbproj，先接上。', null, 1781950001);
  ins.run(sid, 'user', 'SECRET-SECOND-USER-TURN 这条非首位用户消息不应进入接班包。'.repeat(2), null, 1781950002);
  // assistant turn carrying a terminal tool-call (workdir => project) + a file write (editedList signal)
  ins.run(
    sid,
    'assistant',
    '',
    JSON.stringify([
      { type: 'function', function: { name: 'terminal', arguments: JSON.stringify({ command: 'git status --short', workdir: repo }) } },
      { type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: path.join(repo, 'src', 'x.ts'), content: 'x' }) } },
    ]),
    1781950003,
  );
  // tool-result row: MUST be excluded from the narrative (scope lock + secret safety)
  ins.run(sid, 'tool', 'TOOL-RESULT-SECRET should never be captured', null, 1781950004);
  ins.run(sid, 'assistant', 'HERMES-DB-NARRATIVE 这一段来自 state.db 的 Hermes 接班叙述，下一步继续补 reader。'.repeat(3), null, 1781950005);
  db.close();

  process.env.HOME = home;
  const pkt = await buildHandoffPacket({ limit: 5 });
  const c = pkt.candidates.find((x) => x.tool === 'hermes');
  assert.ok(c, 'a Hermes session from state.db appears in the packet');
  assert.equal(c.project.basename, 'hmdbproj', 'project inferred from terminal.workdir stored in the db');
  assert.equal(c.anchors.isRepo, true, 'git anchors resolved from the db-derived project');
  assert.match(c.narrative.text, /HERMES-DB-NARRATIVE/, 'carries the assistant narrative from state.db');
  assert.match(c.narrative.source, /hermes/, 'provenance is tool-correct');
  assert.equal(c.narrative.unverified, true, 'narrative flagged UNVERIFIED');
  assert.doesNotMatch(c.narrative.text, /SECRET-SECOND-USER-TURN/, 'non-first user turns stay scoped out');
  assert.doesNotMatch(c.narrative.text, /TOOL-RESULT-SECRET/, 'tool-role content is never captured');
});

test('Hermes state.db source is silent when no db exists (no throw, no candidate)', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-home-'));
  const origHome = process.env.HOME;
  t.after(async () => {
    process.env.HOME = origHome;
    await fs.rm(home, { recursive: true, force: true });
  });
  process.env.HOME = home; // no ~/.hermes/state.db here
  const pkt = await buildHandoffPacket({ limit: 5 });
  assert.equal(pkt.candidates.find((x) => x.tool === 'hermes'), undefined, 'no hermes candidate when there is no db');
});
