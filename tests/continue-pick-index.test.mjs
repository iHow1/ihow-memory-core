// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// `continue <N>` resumes the Nth row from `continue --list` (1-based) — pick the session you just SAW
// in the picker by its number, instead of retyping a keyword. Indexes the same newest-first list.
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

function run(args, home) {
  return execFileSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, CLAUDE_CODE_SESSION_ID: 'unrelated', IHOW_HANDOFF_METRICS: '0' },
  });
}

test('continue <N>: resumes the Nth most-recent session, and refuses an out-of-range index', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-home-'));
  t.after(async () => { await fs.rm(home, { recursive: true, force: true }); });
  const cwd = '/tmp/pick-index-cwd';
  const encoded = path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
  const projDir = path.join(home, '.claude', 'projects', encoded);
  await fs.mkdir(projDir, { recursive: true });

  await fs.writeFile(path.join(projDir, 'older.jsonl'), big('上一段更老的工作 PICK-OLDER。'.repeat(3)), 'utf8');
  await new Promise((r) => setTimeout(r, 25));
  await fs.writeFile(path.join(projDir, 'newer.jsonl'), big('上一段更新的工作 PICK-NEWER。'.repeat(3)), 'utf8');

  const one = run(['continue', '1', '--cwd', cwd], home);
  assert.match(one, /source_session: newer/, '#1 is the newest session');
  assert.match(one, /PICK-NEWER/, 'carries the newest narrative');

  const two = run(['continue', '2', '--cwd', cwd], home);
  assert.match(two, /source_session: older/, '#2 is the next-most-recent session');
  assert.match(two, /PICK-OLDER/, 'carries the older narrative');

  const oob = run(['continue', '9', '--cwd', cwd], home);
  assert.match(oob, /no resumable session #9/, 'an out-of-range index is refused honestly');
  assert.doesNotMatch(oob, /source_session:/, 'nothing is resumed for a bad index');
});
