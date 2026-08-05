// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Coverage locks for two behaviors verified live during review but not yet pinned by a test:
// detached-HEAD anchor rendering, and most-recent-marker-wins selection in `continue`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gitAnchors, renderAnchors } from '../src/anchors.ts';

const CLI = fileURLToPath(new URL('../bin/ihow-memory.mjs', import.meta.url));
const iso = (agoMs = 0) => new Date(Date.now() - agoMs).toISOString();
const tx = (closing) =>
  [
    JSON.stringify({ type: 'user', message: { content: '继续' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: closing }] } }),
  ].join('\n') + '\n';

test('gitAnchors renders detached HEAD as (detached), not a branch named HEAD', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-detached-'));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  const g = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  g(['init', '-q']);
  g(['config', 'user.email', 't@example.com']);
  g(['config', 'user.name', 'T']);
  await fs.writeFile(path.join(dir, 'a.txt'), '1\n');
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'c1']);
  const head = g(['rev-parse', 'HEAD']).trim();
  g(['checkout', '-q', head]); // detached HEAD

  const a = gitAnchors(dir);
  assert.equal(a.branch, '(detached)');
  assert.match(renderAnchors(a), /branch: \(detached\)/);
});

test('continue: the most recent Stop marker for a cwd wins', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-recent-'));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const space = 'h';
  const cwd = path.join(root, 'work');
  await fs.mkdir(cwd, { recursive: true });
  const older = path.join(root, 'older.jsonl');
  const newer = path.join(root, 'newer.jsonl');
  await fs.writeFile(older, tx('这是较早会话的交接 OLDER-XYZ, 完成了旧任务, 下一步做旧的事。'.repeat(5)), 'utf8');
  await fs.writeFile(newer, tx('这是较新会话的交接 NEWER-XYZ, 完成了新任务, 下一步做新的事。'.repeat(5)), 'utf8');
  const hooksDir = path.join(root, space, '.hooks');
  await fs.mkdir(hooksDir, { recursive: true });
  const mk = (name, transcript, agoMs) =>
    fs.writeFile(
      path.join(hooksDir, `stop-${name}.json`),
      JSON.stringify({ schemaVersion: 2, processed: false, sessionId: name, cwd, transcriptPath: transcript, hookLastAt: iso(agoMs), markerCreatedAt: iso(agoMs) }),
      'utf8',
    );
  await mk('older', older, 60000);
  await mk('newer', newer, 1000);

  const out = execFileSync(process.execPath, [CLI, 'continue', '--root', root, '--space', space, '--cwd', cwd], { encoding: 'utf8' });
  assert.match(out, /NEWER-XYZ/, 'the most recent marker is used');
  assert.doesNotMatch(out, /OLDER-XYZ/, 'the older marker is not used');
});
