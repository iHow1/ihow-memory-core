// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Non-git verify-first anchors: when a resumed project is not a git repo, the handoff falls back to
// file-fingerprint anchors (size + sha8 of the session's edited files) so a non-git resume still carries
// a machine-checkable drift signal, and the envelope tells the receiver to re-hash instead of comparing HEAD.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileAnchors, renderAnchors } from '../src/anchors.ts';
import { assembleEnvelope } from '../src/envelope.ts';

async function mkdtempReal(p) {
  return await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), p)));
}

test('fileAnchors fingerprints existing files, skips missing, caps at limit', async (t) => {
  const dir = await mkdtempReal('ihow-fa-');
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  const a = path.join(dir, 'a.ts');
  const b = path.join(dir, 'b.ts');
  await fs.writeFile(a, 'export const x = 1;\n');
  await fs.writeFile(b, 'export const y = 2;\n');

  const anchors = fileAnchors([a, b, path.join(dir, 'gone.ts')]);
  assert.equal(anchors.length, 2, 'missing file skipped');
  assert.equal(anchors[0].path, a);
  assert.ok(anchors[0].bytes > 0 && /^[0-9a-f]{8}$/.test(anchors[0].sha8), 'has bytes + sha8');

  // sha changes when content changes (drift detection works)
  await fs.writeFile(a, 'export const x = 999;\n');
  const after = fileAnchors([a]);
  assert.notEqual(after[0].sha8, anchors[0].sha8, 'sha8 reflects content drift');

  // cap
  const many = Array.from({ length: 20 }, (_, i) => b);
  assert.equal(fileAnchors(many, 5).length, 5, 'respects the limit');
});

test('renderAnchors shows file fingerprints for a non-git project', () => {
  const out = renderAnchors({ isRepo: false, files: [{ path: '/p/a.ts', bytes: 42, sha8: 'deadbeef' }] });
  assert.match(out, /file-fingerprint anchors/);
  assert.match(out, /\/p\/a\.ts — 42 bytes · sha deadbeef/);
  // no files + no repo => the plain "not a git repo" line
  assert.match(renderAnchors({ isRepo: false }), /not a git repository/);
});

test('envelope appends the file-anchor receiver note only for non-git + files', () => {
  const base = { cwd: '/p', producerAgent: 'x', createdAt: '2026-06-21T00:00:00.000Z', quotedBody: 'did some work' };
  const withFiles = assembleEnvelope({ ...base, anchors: { isRepo: false, files: [{ path: '/p/a.ts', bytes: 42, sha8: 'deadbeef' }] } });
  assert.match(withFiles, /NON-GIT PROJECT/);
  assert.match(withFiles, /re-hashing each listed file|re-hash/i);
  assert.match(withFiles, /deadbeef/);

  const gitEnv = assembleEnvelope({ ...base, anchors: { isRepo: true, repo: 'r', branch: 'main', head: 'abc1234' } });
  assert.ok(!/NON-GIT PROJECT/.test(gitEnv), 'git handoff does not get the file-anchor note');
});
