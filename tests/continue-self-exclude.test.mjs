// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// `continue` must NEVER hand the currently-running session back to itself. The live session's own
// transcript is the newest file on disk (it is being actively written), so without a guard `continue`
// would replay this very session as its own "prior handoff" — and infer the wrong project from
// whatever this session happened to touch. Claude Code exposes the live session via
// CLAUDE_CODE_SESSION_ID; the transcript filename is `<sessionId>.jsonl`, so we exclude that file.
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
const big = (closing) => [u('开始任务'), a('第一步'), a('中间汇报'), a(closing)].join('\n') + '\n';

test('continue: excludes THIS session and resumes the PRIOR one (no self-replay)', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-home-'));
  t.after(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });
  const cwd = '/tmp/self-exclude-cwd';
  const encoded = path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
  const projDir = path.join(home, '.claude', 'projects', encoded);
  await fs.mkdir(projDir, { recursive: true });

  // the real prior work, written first (older mtime)...
  await fs.writeFile(path.join(projDir, 'prevsess.jsonl'), big('上一段真实工作交接 PRIOR-WORK-OK, 下一步继续。'.repeat(3)), 'utf8');
  // ...then THIS session's own transcript — newest by mtime, substantial enough to otherwise win.
  await new Promise((r) => setTimeout(r, 25));
  await fs.writeFile(path.join(projDir, 'selfsess.jsonl'), big('本会话自己刚做的事 SELF-ECHO-BAD, 不该被当成交接。'.repeat(3)), 'utf8');

  const out = execFileSync(process.execPath, [CLI, 'continue', '--cwd', cwd], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, CLAUDE_CODE_SESSION_ID: 'selfsess' },
  });
  assert.match(out, /source_session: prevsess/, 'resumes the PRIOR session, not the live one');
  assert.match(out, /PRIOR-WORK-OK/, 'carries the prior session narrative');
  assert.doesNotMatch(out, /selfsess/, 'the live session id never appears as the source');
  assert.doesNotMatch(out, /SELF-ECHO-BAD/, 'the live session is not replayed back to itself');
});

test('continue: when only THIS session exists, reports an honest no-capture (never self-replays)', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-home-'));
  t.after(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });
  const cwd = '/tmp/self-only-cwd';
  const encoded = path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
  const projDir = path.join(home, '.claude', 'projects', encoded);
  await fs.mkdir(projDir, { recursive: true });
  await fs.writeFile(path.join(projDir, 'onlyme.jsonl'), big('只有本会话, 没有真正的上一段工作 ONLY-SELF。'.repeat(3)), 'utf8');

  const out = execFileSync(process.execPath, [CLI, 'continue', '--cwd', cwd], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, CLAUDE_CODE_SESSION_ID: 'onlyme' },
  });
  assert.match(out, /no captured prior session/i, 'honest about having no prior session to resume');
  assert.doesNotMatch(out, /source_session:/, 'no source session is claimed');
  assert.doesNotMatch(out, /ONLY-SELF/, 'the live session is not surfaced as a handoff');
});
