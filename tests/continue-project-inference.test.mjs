// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Project-aware `continue`: when every session launches from one terminal cwd, the handoff must be
// keyed to the PROJECT the work landed in (the git repo of the files that were WRITTEN/EDITED), not
// the session cwd — and the anchors must come from that inferred project. Locks both the inference
// primitive and the end-to-end command behavior (edited project wins over an incidentally-read one).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inferProjectDir } from '../src/anchors.ts';

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

test('inferProjectDir returns the dominant git repo root, undefined for none', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-infer-'));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  await makeRepo(dir);
  const root = inferProjectDir([path.join(dir, 'a.js'), path.join(dir, 'b.js')]);
  assert.ok(root, 'found a repo root');
  assert.equal(path.basename(root), path.basename(dir));
  assert.equal(inferProjectDir([]), undefined, 'no files -> undefined');
  assert.equal(inferProjectDir(['/no/such/path/x.js']), undefined, 'non-repo file -> undefined');
});

test('continue infers the EDITED project (not an incidentally-read one) and uses its anchors', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-proj-'));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-home-'));
  t.after(async () => {
    await fs.rm(base, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });
  const repoA = path.join(base, 'projA'); // only READ from
  const repoB = path.join(base, 'projB'); // EDITED -> the active project
  await makeRepo(repoA);
  await makeRepo(repoB);

  const u = (c) => JSON.stringify({ type: 'user', message: { content: c } });
  const asst = (blocks) => JSON.stringify({ type: 'assistant', message: { content: blocks } });
  const tool = (name, fp) => ({ type: 'tool_use', name, input: { file_path: fp } });
  const text = (t2) => ({ type: 'text', text: t2 });
  const transcript =
    [
      u('做点事'),
      asst([tool('Read', path.join(repoA, 'a.js')), text('读 A')]),
      asst([tool('Read', path.join(repoA, 'b.js')), text('读 A2')]),
      asst([tool('Read', path.join(repoA, 'c.js')), text('读 A3')]),
      asst([tool('Edit', path.join(repoB, 'y.js')), text('改 B')]),
      asst([text('交接: 在 projB 改了 y.js, 下一步继续在 projB 完善功能, 跑测试确认。这是本次的实质工作落点。'.repeat(2))]),
    ].join('\n') + '\n';

  const cwd = '/tmp/some-session-cwd';
  const encoded = path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
  const projDir = path.join(home, '.claude', 'projects', encoded);
  await fs.mkdir(projDir, { recursive: true });
  await fs.writeFile(path.join(projDir, 'sess.jsonl'), transcript, 'utf8');

  const out = execFileSync(process.execPath, [CLI, 'continue', '--cwd', cwd], { encoding: 'utf8', env: { ...process.env, HOME: home } });
  assert.match(out, /repo: projB/, 'anchors come from the EDITED project (projB)');
  assert.doesNotMatch(out, /repo: projA/, 'the read-only project (projA) is not chosen');
  assert.match(out, /MACHINE ANCHORS/);
});
