// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Cline (VS Code ext, saoudrizwan.claude-dev) as a PASSIVE resume reader. Each task is
// <root>/tasks/<taskId>/api_conversation_history.json (Anthropic MessageParam[]). Discovery is BOUNDED to
// VS Code-family globalStorage roots + the SDK data dir ($CLINE_DATA_DIR / ~/.cline/data) — never a
// home-wide scan. These tests lock: (1) a cline task surfaces tool-tagged with the cwd from Cline's
// environment_details header; (2) environment_details is stripped and <task> unwrapped so the topic is
// clean; (3) RED LINE — the body goes through the SAME redaction as every runtime; (4) a trivial task is
// skipped. Discovery is pinned via $CLINE_DATA_DIR so the test never depends on a real install.
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
const userMsg = (blocks) => ({ role: 'user', content: blocks });
const asstMsg = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] });
const envDetails = (cwd, extra = '') =>
  `<environment_details>\n# VSCode Visible Files\nsrc/server.ts\n${extra}# Current Working Directory (${cwd}) Files\nsrc/\n  server.ts\n# Current Mode\nACT MODE\n</environment_details>`;

async function writeClineTask(dataDir, taskId, history) {
  const dir = path.join(dataDir, 'tasks', taskId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'api_conversation_history.json'), JSON.stringify(history, null, 2), 'utf8');
}

async function setup(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-cline-home-'));
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-cline-base-'));
  const dataDir = path.join(home, 'clinedata');
  const orig = { HOME: process.env.HOME, CLINE_DATA_DIR: process.env.CLINE_DATA_DIR };
  t.after(async () => {
    process.env.HOME = orig.HOME;
    if (orig.CLINE_DATA_DIR === undefined) delete process.env.CLINE_DATA_DIR;
    else process.env.CLINE_DATA_DIR = orig.CLINE_DATA_DIR;
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(base, { recursive: true, force: true });
  });
  process.env.HOME = home;
  process.env.CLINE_DATA_DIR = dataDir;
  return { home, base, dataDir };
}
const cline = (list) => list.find((s) => s.tool === 'cline');
const LONG_ASST = 'I added a GET /health route to src/server.ts that returns 200 with a JSON status payload, wired it into the router, and added a unit test covering the happy path and a 503 when the DB ping fails.';

test('a cline task surfaces — tool-tagged, cwd from environment_details, clean topic', async (t) => {
  const { base, dataDir } = await setup(t);
  const repo = path.join(base, 'clineproj');
  await makeRepo(repo);
  await writeClineTask(dataDir, '1751304000000', [
    userMsg([
      { type: 'text', text: '<task>\nAdd a health check endpoint\n</task>' },
      { type: 'text', text: envDetails(repo) },
    ]),
    asstMsg(LONG_ASST),
  ]);

  const g = cline(await listResumableSessions(50, undefined));
  assert.ok(g, 'cline session present');
  assert.equal(g.tool, 'cline');
  assert.equal(g.projectDir, repo, 'cwd parsed from environment_details');
  assert.equal(g.sessionId, '1751304000000', 'sessionId = taskId (dir name)');
  assert.match(g.body, /Add a health check endpoint/, 'topic = the task text');
  assert.doesNotMatch(g.body, /<task>|<environment_details>/, 'wrappers stripped');
  assert.doesNotMatch(g.body, /VSCode Visible Files|ACT MODE/, 'environment_details body not leaked into the handoff');
  assert.ok(g.anchors.isRepo, 'git anchors computed for the cwd repo');
});

test('RED LINE: a secret in a cline message is redacted in the surfaced body (shared redaction path)', async (t) => {
  const { base, dataDir } = await setup(t);
  const repo = path.join(base, 'secretproj');
  await makeRepo(repo);
  await writeClineTask(dataDir, '1751304999999', [
    userMsg([
      { type: 'text', text: '<task>\ndeploy using AKIAIOSFODNN7EXAMPLE now\n</task>' },
      { type: 'text', text: envDetails(repo) },
    ]),
    asstMsg(LONG_ASST),
  ]);
  const g = cline(await listResumableSessions(50, undefined));
  assert.ok(g);
  assert.doesNotMatch(g.body, /AKIAIOSFODNN7EXAMPLE/, 'AWS-key-shaped secret redacted from body');
  assert.doesNotMatch(g.snippet, /AKIAIOSFODNN7EXAMPLE/, 'and from snippet');
});

test('a trivial cline task (a single message) is skipped', async (t) => {
  const { base, dataDir } = await setup(t);
  const repo = path.join(base, 'trivialproj');
  await makeRepo(repo);
  await writeClineTask(dataDir, '1751305000000', [
    userMsg([
      { type: 'text', text: '<task>\nhi\n</task>' },
      { type: 'text', text: envDetails(repo) },
    ]),
  ]);
  const g = cline(await listResumableSessions(50, undefined));
  assert.equal(g, undefined, 'one message is below the trivial floor');
});
