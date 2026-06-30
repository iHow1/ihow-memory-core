// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Gemini CLI as a PASSIVE resume reader. ~/.gemini/tmp/<projectKey>/logs.json is an append-only ARRAY of
// {sessionId, messageId, type, message, timestamp}; the sibling .project_root holds the absolute project
// path. Gemini persists ONLY user prompts to disk (no assistant turns), so the honest handoff is the
// session's topic/intent + git anchors. These tests lock: (1) a gemini session surfaces in the unified
// resumable list, tool-tagged, with the .project_root cwd; (2) one file holds many sessions and we surface
// the LATEST; (3) the launch-mode marker (messageId 0 = "cli"/"tui") is dropped from the topic;
// (4) RED LINE — the body goes through the SAME redaction as every other runtime (a secret in a prompt
// never leaks into the snippet); (5) a trivial freshly-started session is skipped.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { listResumableSessions } from '../src/handoff.ts';

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
const entry = (sessionId, messageId, message, timestamp) => ({ sessionId, messageId, type: 'user', message, timestamp });
// Write ~/.gemini/tmp/<key>/logs.json + .project_root pointing at projectDir.
async function writeGemini(home, key, projectDir, log) {
  const dir = path.join(home, '.gemini', 'tmp', key);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'logs.json'), JSON.stringify(log, null, 2), 'utf8');
  await fs.writeFile(path.join(dir, '.project_root'), projectDir, 'utf8');
}

async function setup(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-gem-home-'));
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-gem-base-'));
  const origHome = process.env.HOME;
  t.after(async () => {
    process.env.HOME = origHome;
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(base, { recursive: true, force: true });
  });
  process.env.HOME = home;
  return { home, base };
}
const gemini = (list) => list.find((s) => s.tool === 'gemini');

test('a gemini session surfaces in the resumable list — tool-tagged, .project_root cwd, latest session', async (t) => {
  const { home, base } = await setup(t);
  const repo = path.join(base, 'geminiproj');
  await makeRepo(repo);
  await writeGemini(home, 'geminiproj', repo, [
    entry('sess-OLD', 0, 'tui', '2026-06-01T00:00:00.000Z'),
    entry('sess-OLD', 1, 'an older question about widgets', '2026-06-01T00:01:00.000Z'),
    entry('sess-OLD', 2, 'follow-up on widgets', '2026-06-01T00:02:00.000Z'),
    entry('sess-NEW', 0, 'cli', '2026-06-20T00:00:00.000Z'),
    entry('sess-NEW', 1, 'refactor the auth module', '2026-06-20T00:01:00.000Z'),
    entry('sess-NEW', 2, 'add tests for the auth module', '2026-06-20T00:02:00.000Z'),
  ]);

  const all = await listResumableSessions(50, undefined);
  const g = gemini(all);
  assert.ok(g, 'gemini session present');
  assert.equal(g.tool, 'gemini');
  assert.equal(g.projectDir, repo, 'projectDir comes from .project_root');
  assert.equal(g.sessionId, 'sess-NEW', 'surfaces the LATEST session of a multi-session log');
  assert.match(g.body, /refactor the auth module/, 'topic is the latest session\'s first real prompt');
  assert.doesNotMatch(g.body, /widgets/, 'older session content does not leak in');
  assert.ok(g.anchors.isRepo, 'git anchors computed for the .project_root repo');
});

test('the launch-mode marker (messageId 0) is never the topic', async (t) => {
  const { home, base } = await setup(t);
  const repo = path.join(base, 'modeproj');
  await makeRepo(repo);
  await writeGemini(home, 'modeproj', repo, [
    entry('s', 0, 'tui', '2026-06-20T00:00:00.000Z'),
    entry('s', 1, 'the real first prompt', '2026-06-20T00:01:00.000Z'),
    entry('s', 2, 'second prompt', '2026-06-20T00:02:00.000Z'),
  ]);
  const g = gemini(await listResumableSessions(50, undefined));
  assert.ok(g);
  assert.match(g.body, /Topic: the real first prompt/, 'mode marker dropped; topic is the first real prompt');
  assert.doesNotMatch(g.body, /Topic: tui/);
});

test('RED LINE: a secret in a gemini prompt is redacted in the surfaced body (shared redaction path)', async (t) => {
  const { home, base } = await setup(t);
  const repo = path.join(base, 'secretproj');
  await makeRepo(repo);
  await writeGemini(home, 'secretproj', repo, [
    entry('s', 0, 'cli', '2026-06-20T00:00:00.000Z'),
    entry('s', 1, 'deploy with AKIAIOSFODNN7EXAMPLE please', '2026-06-20T00:01:00.000Z'),
    entry('s', 2, 'and restart', '2026-06-20T00:02:00.000Z'),
  ]);
  const g = gemini(await listResumableSessions(50, undefined));
  assert.ok(g);
  assert.doesNotMatch(g.body, /AKIAIOSFODNN7EXAMPLE/, 'AWS-key-shaped secret is redacted from the body');
  assert.doesNotMatch(g.snippet, /AKIAIOSFODNN7EXAMPLE/, 'and from the snippet');
});

test('a trivial freshly-started gemini session (only the mode marker / one prompt) is skipped', async (t) => {
  const { home, base } = await setup(t);
  const repo = path.join(base, 'trivialproj');
  await makeRepo(repo);
  await writeGemini(home, 'trivialproj', repo, [
    entry('s', 0, 'cli', '2026-06-20T00:00:00.000Z'),
    entry('s', 1, 'hi', '2026-06-20T00:01:00.000Z'),
  ]);
  const g = gemini(await listResumableSessions(50, undefined));
  assert.equal(g, undefined, 'a single real prompt is below the trivial floor — contributes nothing');
});
