// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Handoff "continue" tests: deterministic git anchors + the dumb transport envelope. These also
// ENCODE THE DESIGN LOCK (n=12 A/B + OpenClaw, 2026-06-18): the envelope must carry the previous
// agent's narrative under an UNVERIFIED banner and never assert it as fact — only the machine
// anchors are facts. A future change that re-introduces an authoritative "smart capsule" (which the
// A/B proved makes receivers confidently wrong) will fail these tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gitAnchors, renderAnchors } from '../src/anchors.ts';
import { assembleEnvelope, RECEIVER_INSTRUCTION, CAPSULE_VERSION } from '../src/envelope.ts';

function git(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

test('gitAnchors reads deterministic git facts on a real repo', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-anchors-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  await fs.writeFile(path.join(dir, 'a.txt'), 'hello\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'initial commit']);
  await fs.writeFile(path.join(dir, 'b.txt'), 'untracked\n'); // dirty the tree

  const a = gitAnchors(dir);
  assert.equal(a.isRepo, true);
  assert.equal(a.repo, path.basename(dir));
  assert.ok(a.head && a.head.length >= 4, 'has a short HEAD');
  assert.equal(a.headSubject, 'initial commit');
  assert.equal(a.dirtyCount, 1, 'one untracked file is dirty');

  const rendered = renderAnchors(a);
  assert.match(rendered, /repo:/);
  assert.match(rendered, /HEAD:/);
  assert.match(rendered, /initial commit/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('gitAnchors never throws on a non-git dir', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-nogit-'));
  const a = gitAnchors(dir);
  assert.equal(a.isRepo, false);
  assert.match(renderAnchors(a), /not a git repository/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('DESIGN LOCK: envelope carries the narrative UNVERIFIED, never as fact', () => {
  const env = assembleEnvelope({
    cwd: '/tmp/x',
    producerAgent: 'test',
    createdAt: '2026-06-18T00:00:00.000Z',
    anchors: { isRepo: true, repo: 'x', branch: 'main', head: 'abc1234', dirtyCount: 0, dirtyFiles: [] },
    quotedBody: 'Summary: build is green and the release shipped',
  });
  const unverifiedIdx = env.indexOf('UNVERIFIED');
  const bodyIdx = env.indexOf('build is green and the release shipped');
  assert.ok(unverifiedIdx >= 0, 'envelope has an UNVERIFIED banner');
  assert.ok(bodyIdx > unverifiedIdx, 'the narrative appears UNDER the UNVERIFIED banner (not asserted as fact)');
  assert.match(env, /MACHINE ANCHORS/);
  assert.match(env, /abc1234/);
  assert.ok(env.includes(RECEIVER_INSTRUCTION), 'the fixed verify-first receiver protocol is present');
  assert.match(env, new RegExp(`capsule_version: ${CAPSULE_VERSION}`));
});

test('envelope handles an empty narrative and a non-git cwd honestly', () => {
  const env = assembleEnvelope({
    cwd: '/tmp/x',
    producerAgent: 'test',
    createdAt: '2026-06-18T00:00:00.000Z',
    anchors: { isRepo: false },
    quotedBody: '',
  });
  assert.match(env, /no substantive prior-session summary/);
  assert.match(env, /not a git repository/);
});

test('envelope assembly is deterministic (pure string assembly, no LLM)', () => {
  const input = {
    cwd: '/tmp/x',
    producerAgent: 'test',
    createdAt: '2026-06-18T00:00:00.000Z',
    anchors: { isRepo: true, repo: 'x', branch: 'main', head: 'abc1234', dirtyCount: 0, dirtyFiles: [] },
    quotedBody: 'Topic: foo',
  };
  assert.equal(assembleEnvelope(input), assembleEnvelope(input));
});
