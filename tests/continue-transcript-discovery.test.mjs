// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// `continue` discovers the latest SUBSTANTIAL transcript directly from ~/.claude/projects/<cwd>/*.jsonl
// by mtime — the primary source, robust to a frozen Stop marker or a workspace configured elsewhere.
// This is the real /clear-resume case: a freshly-cleared (tiny) session is skipped so we resume the
// real prior work. HOME is overridden to a temp dir so the test owns the ~/.claude/projects layout.
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
const tiny = () => u('继续') + '\n'; // a freshly /cleared session — below the substantive threshold

test('continue: resumes the latest SUBSTANTIAL transcript and skips a freshly-cleared tiny one', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-home-'));
  t.after(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });
  const cwd = '/tmp/myproj-xyz'; // synthetic; encodes to -tmp-myproj-xyz
  const encoded = path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
  const projDir = path.join(home, '.claude', 'projects', encoded);
  await fs.mkdir(projDir, { recursive: true });

  // the real prior work (substantial), written first...
  await fs.writeFile(path.join(projDir, 'prev-sess.jsonl'), big('这是上一段真实工作的交接 DISCOVER-XYZ, 完成了某模块, 下一步继续做某事。'.repeat(3)), 'utf8');
  // ...then a freshly /cleared session (tiny), newest by mtime
  await new Promise((r) => setTimeout(r, 25));
  await fs.writeFile(path.join(projDir, 'cleared-sess.jsonl'), tiny(), 'utf8');

  const out = execFileSync(process.execPath, [CLI, 'continue', '--cwd', cwd], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  });
  assert.match(out, /DISCOVER-XYZ/, 'resumes the substantial prior session');
  assert.match(out, /source_session: prev-sess/, 'session id derived from the transcript filename');
  assert.doesNotMatch(out, /cleared-sess/, 'the freshly-cleared tiny session is skipped');
});
