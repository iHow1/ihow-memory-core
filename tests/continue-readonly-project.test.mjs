// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Project inference must come ONLY from files this session WROTE/EDITED — never from incidental reads.
// A read-only session (e.g. one that only read memory/docs) must not claim a project it merely browsed,
// because that yields a confidently WRONG set of git anchors pointing at an unrelated repo. With no
// edits, `continue` leaves the project UNDETERMINED and says so honestly instead of guessing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/ihow-memory.mjs', import.meta.url));
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

test('continue: a READ-ONLY session leaves the project UNDETERMINED (never infers a project from reads)', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-ro-'));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-home-'));
  t.after(async () => {
    await fs.rm(base, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });
  const repoA = path.join(base, 'projA'); // only READ from — must NOT become the inferred project
  await makeRepo(repoA);

  const u = (c) => JSON.stringify({ type: 'user', message: { content: c } });
  const asst = (blocks) => JSON.stringify({ type: 'assistant', message: { content: blocks } });
  const tool = (name, fp) => ({ type: 'tool_use', name, input: { file_path: fp } });
  const text = (t2) => ({ type: 'text', text: t2 });
  const transcript =
    [
      u('看一下情况'),
      asst([tool('Read', path.join(repoA, 'a.js')), text('读 A')]),
      asst([tool('Read', path.join(repoA, 'b.js')), text('读 A2')]),
      asst([tool('Read', path.join(repoA, 'c.js')), text('读 A3')]),
      asst([text('只读了 projA 的文件, 没有编辑任何东西。READONLY-RECAP 下一步看用户要做什么。'.repeat(2))]),
    ].join('\n') + '\n';

  const cwd = '/tmp/readonly-session-cwd'; // synthetic, non-git
  const encoded = path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
  const projDir = path.join(home, '.claude', 'projects', encoded);
  await fs.mkdir(projDir, { recursive: true });
  await fs.writeFile(path.join(projDir, 'rosess.jsonl'), transcript, 'utf8');

  const out = execFileSync(process.execPath, [CLI, 'continue', '--cwd', cwd], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, CLAUDE_CODE_SESSION_ID: 'unrelated' },
  });
  assert.match(out, /project: UNDETERMINED/, 'honest that no project could be inferred');
  assert.doesNotMatch(out, /repo: projA/, 'the merely-READ repo never becomes the inferred project anchors');
  assert.match(out, /READONLY-RECAP/, 'still carries the prior narrative');
});
