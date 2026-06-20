// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Cross-tool resume through the CLI — the gap that hid the critical empty-handoff bug. `continue <N>`
// must resume a NON-Claude row (WorkBuddy here = the customer's tool) using the session's own reader,
// not re-parse it with the Claude-only parser. Also locks the capture SCOPE: a non-first user turn must
// NOT be dumped verbatim (only a capped Topic + the closing assistant segment leave), same as Claude.
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
// REAL WorkBuddy block types: input_text (user) / output_text (assistant).
const wbMsg = (role, text, cwd, sid) => JSON.stringify({ id: 'r', timestamp: '2026-06-19T00:00:01Z', type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }], cwd, sessionId: sid });
function run(args, home) {
  return execFileSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, CLAUDE_CODE_SESSION_ID: 'unrelated', IHOW_HANDOFF_METRICS: '0' },
  });
}

test('continue <N> resumes a WorkBuddy (non-Claude) session — narrative present, no EMPTY banner, tool-correct producer', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-home-'));
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-base-'));
  t.after(async () => {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(base, { recursive: true, force: true });
  });
  const repo = path.join(base, 'wbxtool');
  await makeRepo(repo);
  const sid = 'wb-xtool-1';
  const dir = path.join(home, '.workbuddy', 'projects', 'Users-zyh-wbxtool');
  await fs.mkdir(dir, { recursive: true });
  const thread = [
    wbMsg('user', '继续做 wbxtool 这个项目,完善功能。', repo, sid), // first user prompt -> capped Topic
    wbMsg('user', 'SECRET-SECOND-USER-TURN 这条非首位用户消息绝不该进入接班包。'.repeat(2), repo, sid),
    wbMsg('assistant', 'WB-XTOOL-NARRATIVE 上一段 WorkBuddy 工作,下一步继续。'.repeat(2), repo, sid),
  ].join('\n') + '\n';
  await fs.writeFile(path.join(dir, `${sid}.jsonl`), thread, 'utf8');

  const list = run(['continue', '--list', '--cwd', '/tmp/x'], home);
  assert.match(list, /wbxtool/, '--list shows the workbuddy project');
  assert.match(list, /\[workbuddy\]/, '--list tags the tool');

  const out = run(['continue', '1', '--cwd', '/tmp/x'], home);
  assert.match(out, /WB-XTOOL-NARRATIVE/, 'continue 1 carries the WorkBuddy narrative (not re-parsed empty)');
  assert.doesNotMatch(out, /CAPTURE HEALTH: EMPTY/, 'no false empty-capture banner for a real non-Claude session');
  assert.match(out, /producer_agent: workbuddy:/, 'producer is tool-correct, not mislabeled claude-code');
  // capture SCOPE: a non-first user turn must not be dumped verbatim
  assert.doesNotMatch(out, /SECRET-SECOND-USER-TURN/, 'non-first user turns are scoped out, same lock as Claude');
});
