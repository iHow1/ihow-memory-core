// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Regression locks for two issues a code review found in the continue MVP:
//  (1) the machine-anchor block is git-derived "facts", but its FREE-TEXT fields (commit subject,
//      branch, dirty filenames) are author-controlled and can carry secret values — they must be
//      redacted like the narrative, or a secret in a commit message leaks through the "facts" block.
//  (2) a Stop marker with a null/empty cwd must NOT be matched to a specific cwd, or an unrelated
//      session's narrative would surface in a different project's handoff.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/ihow-memory.mjs', import.meta.url));
const iso = (agoMs = 0) => new Date(Date.now() - agoMs).toISOString();
const transcriptWith = (closing) =>
  [
    JSON.stringify({ type: 'user', message: { content: '继续' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: closing }] } }),
  ].join('\n') + '\n';

test('continue: a secret in the git commit subject does not leak through the anchor block', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-anchor-redact-'));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const repo = path.join(root, 'repo');
  await fs.mkdir(repo, { recursive: true });
  const g = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  g(['init', '-q']);
  g(['config', 'user.email', 't@example.com']);
  g(['config', 'user.name', 'T']);
  await fs.writeFile(path.join(repo, 'a.txt'), 'x\n');
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'wire token sk-ABCDEFGH12345678ZZ into build']);

  const out = execFileSync(process.execPath, [CLI, 'continue', '--root', root, '--space', 'h', '--cwd', repo], { encoding: 'utf8' });
  assert.match(out, /MACHINE ANCHORS/);
  assert.doesNotMatch(out, /sk-ABCDEFGH12345678ZZ/, 'secret in the commit subject must not leak through anchors');
  assert.match(out, /\[redacted\]/, 'the secret degrades to [redacted] in the anchor block');
});

test('continue: a Stop marker with null cwd is not matched to a specific cwd', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-nullcwd-'));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const space = 'h';
  const cwd = path.join(root, 'work');
  await fs.mkdir(cwd, { recursive: true });
  const transcript = path.join(root, 'p.jsonl');
  await fs.writeFile(transcript, transcriptWith('某个无归属会话的交接内容 xyz, 完成了某事, 下一步做某事。'.repeat(6)), 'utf8');
  const hooksDir = path.join(root, space, '.hooks');
  await fs.mkdir(hooksDir, { recursive: true });
  await fs.writeFile(
    path.join(hooksDir, 'stop-null.json'),
    JSON.stringify({ schemaVersion: 2, processed: false, sessionId: 'n', cwd: null, transcriptPath: transcript, hookLastAt: iso(1000), markerCreatedAt: iso(1000) }),
    'utf8',
  );

  const out = execFileSync(process.execPath, [CLI, 'continue', '--root', root, '--space', space, '--cwd', cwd], { encoding: 'utf8' });
  assert.doesNotMatch(out, /无归属会话的交接内容/, 'a null-cwd marker must not be served for a specific cwd');
  assert.match(out, /no captured prior session/i, 'with no attributable marker -> honest refusal');
});
