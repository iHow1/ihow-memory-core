// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Non-Claude capture, proven on WorkBuddy (the real customer's tool): a WorkBuddy thread
// (~/.workbuddy/projects/<cwd>/<sessionId>.jsonl) is parsed by the unified SessionReader and surfaces in
// the same handoff packet — tool-tagged, cwd-derived project, narrative verbatim. agent-*.jsonl
// sub-agent files are excluded. This is the read+capture side of solving "WorkBuddy loses memory across
// threads": the prior thread is captured passively; a new thread calls memory.continue to resume.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildHandoffPacket } from '../src/handoff.ts';

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
// WorkBuddy record: top-level role + content list + inline cwd (NOT message.content).
const wbMsg = (role, text, cwd, sid) => JSON.stringify({ id: 'r', timestamp: '2026-06-19T00:00:01Z', type: 'message', role, content: [{ type: 'text', text }], cwd, sessionId: sid });

test('workbuddy thread surfaces in the handoff packet (tool-tagged, cwd project, agent-* excluded)', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-home-'));
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-base-'));
  const origHome = process.env.HOME;
  t.after(async () => {
    process.env.HOME = origHome;
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(base, { recursive: true, force: true });
  });
  const repo = path.join(base, 'wbproj');
  await makeRepo(repo);
  const sid = 'wb-sess-1';
  const projDir = path.join(home, '.workbuddy', 'projects', 'Users-zyh-wbproj-2026');
  await fs.mkdir(projDir, { recursive: true });
  const thread = [
    wbMsg('user', '继续做 WorkBuddy 这个项目。'.repeat(2), repo, sid),
    wbMsg('assistant', 'WB-RESUME-NARRATIVE 上一段 WorkBuddy 工作,下一步继续完善。'.repeat(2), repo, sid),
  ].join('\n') + '\n';
  await fs.writeFile(path.join(projDir, `${sid}.jsonl`), thread, 'utf8');
  // a sub-agent file in the same dir must NOT be surfaced as a resumable thread
  await fs.writeFile(path.join(projDir, 'agent-noise.jsonl'), wbMsg('assistant', 'SUBAGENT-NOISE 不该出现。'.repeat(3), repo, 'agent-x') + '\n', 'utf8');

  process.env.HOME = home;
  const pkt = await buildHandoffPacket({ limit: 5 });
  const c = pkt.candidates.find((x) => x.tool === 'workbuddy');
  assert.ok(c, 'a workbuddy thread appears in the packet');
  assert.equal(c.project.basename, 'wbproj', 'project mapped from the inline cwd');
  assert.equal(c.anchors.isRepo, true, 'git anchors resolved from the workbuddy cwd');
  assert.match(c.narrative.text, /WB-RESUME-NARRATIVE/, 'carries the thread narrative verbatim');
  assert.doesNotMatch(c.narrative.text, /SUBAGENT-NOISE/, 'agent-*.jsonl sub-agent noise is excluded');
  assert.equal(c.narrative.unverified, true, 'narrative flagged UNVERIFIED');
});
