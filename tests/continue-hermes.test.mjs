// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Hermes stores one JSON session file with OpenAI-like messages and tool_calls. Unlike Codex or
// WorkBuddy, it has no top-level cwd; project anchors must be inferred from tool-call args such as
// terminal.workdir while still keeping the global handoff scope lock (no tool-result content, no
// non-first user dump).
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
function run(args, home) {
  return execFileSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, CLAUDE_CODE_SESSION_ID: 'unrelated', IHOW_HANDOFF_METRICS: '0' },
  });
}

async function writeHermesSession(home, name, session) {
  const dir = path.join(home, '.hermes', 'sessions');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), JSON.stringify(session), 'utf8');
}

function hermesSession({ sessionId, firstUser, workdir, filePath, narrative }) {
  return {
    session_id: sessionId,
    session_start: '2026-06-20T00:00:00',
    last_updated: '2026-06-20T00:10:00',
    messages: [
      { role: 'user', content: firstUser },
      { role: 'user', content: 'SECRET-SECOND-USER-TURN 这条非首位用户消息不应该进入接班包。'.repeat(2) },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { type: 'function', function: { name: 'terminal', arguments: JSON.stringify({ command: 'git status --short && npm test', workdir }) } },
          { type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: filePath, content: 'x' }) } },
        ],
      },
      { role: 'tool', content: 'TOOL-RESULT-SECRET should never be captured' },
      { role: 'assistant', content: narrative.repeat(3) },
    ],
  };
}

test('continue <N> resumes a Hermes session and infers project from terminal.workdir', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-home-'));
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-base-'));
  t.after(async () => {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(base, { recursive: true, force: true });
  });
  const repo = path.join(base, 'hermesproj');
  await makeRepo(repo);
  await writeHermesSession(home, 'session_20260620_001000_unit.json', hermesSession({
    sessionId: 'hermes-unit-1',
    firstUser: '继续做 hermesproj, 先接上。',
    workdir: repo,
    filePath: path.join(repo, 'src', 'x.ts'),
    narrative: 'HERMES-XTOOL-NARRATIVE 上一段 Hermes 工作已经定位 reader, 下一步继续补测试并验证。',
  }));

  const list = run(['continue', '--list', '--cwd', '/tmp/x'], home);
  assert.match(list, /hermesproj/, '--list shows the project inferred from terminal.workdir');
  assert.match(list, /\[hermes\]/, '--list tags the tool');

  const out = run(['continue', '1', '--cwd', '/tmp/x'], home);
  assert.match(out, /HERMES-XTOOL-NARRATIVE/, 'Hermes narrative is present');
  assert.match(out, /producer_agent: hermes:/, 'producer is tool-correct');
  assert.match(out, /repo: hermesproj/, 'anchors come from terminal.workdir project');
  assert.doesNotMatch(out, /SECRET-SECOND-USER-TURN/, 'non-first user turns remain scoped out');
  assert.doesNotMatch(out, /TOOL-RESULT-SECRET/, 'tool-result content is never captured');
});

test('continue <N> leaves Hermes project UNDETERMINED when tool workdirs are not git repos', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-home-'));
  const nonRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-nonrepo-'));
  t.after(async () => {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(nonRepo, { recursive: true, force: true });
  });
  await writeHermesSession(home, 'session_20260620_001000_nonrepo.json', hermesSession({
    sessionId: 'hermes-unit-nonrepo',
    firstUser: '继续做一个没有仓库锚点的 Hermes 会话。',
    workdir: nonRepo,
    filePath: path.join(nonRepo, 'scratch.txt'),
    narrative: 'HERMES-NONREPO-NARRATIVE 这段会话只有 /tmp 类临时 workdir, 不应该冒充项目。',
  }));

  const list = run(['continue', '--list', '--cwd', '/tmp/x'], home);
  assert.match(list, /UNDETERMINED/, 'non-repo tool workdir is shown honestly as undetermined');
  assert.doesNotMatch(list.split('\n')[2], new RegExp(path.basename(nonRepo)), 'non-repo tool workdir is not promoted to the project label');

  const out = run(['continue', '1', '--cwd', '/tmp/x'], home);
  assert.match(out, /HERMES-NONREPO-NARRATIVE/, 'Hermes narrative is present');
  assert.match(out, /project: UNDETERMINED/, 'handoff packet remains project-undetermined');
  assert.doesNotMatch(out, new RegExp(`repo: ${path.basename(nonRepo)}`), 'non-repo workdir is not rendered as a repo anchor');
});
