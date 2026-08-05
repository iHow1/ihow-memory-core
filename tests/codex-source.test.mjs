// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Non-Claude capture, proven on Codex: a Codex rollout (~/.codex/.../rollout-*.jsonl) is parsed by the
// unified SessionReader and surfaces in the SAME handoff packet as Claude — tool tagged, cwd-derived
// project, narrative verbatim. Locks the multi-session split (one file holds many sessions delimited by
// session_meta; we surface the LATEST). Proof that "make non-Claude capture solid" is real, per-tool.
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
const meta = (id, cwd) => JSON.stringify({ timestamp: '2026-06-19T00:00:00Z', type: 'session_meta', payload: { id, cwd, git: {} } });
const msg = (role, text) => JSON.stringify({ timestamp: '2026-06-19T00:00:01Z', type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });

test('codex rollout surfaces in the handoff packet (tool-tagged, cwd project, latest session of a multi-session file)', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-home-'));
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-base-'));
  const origHome = process.env.HOME;
  t.after(async () => {
    process.env.HOME = origHome;
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(base, { recursive: true, force: true });
  });
  const repo = path.join(base, 'codexproj');
  await makeRepo(repo);
  const dir = path.join(home, '.codex', 'sessions', '2026', '06', '19');
  await fs.mkdir(dir, { recursive: true });
  // one file, TWO sessions — only the LATEST should surface
  const rollout = [
    meta('codex-old', repo),
    msg('user', 'OLD-CODEX-SESSION 第一段,不该出现在接班里。'.repeat(2)),
    msg('assistant', 'OLD 回复。'.repeat(3)),
    meta('codex-latest', repo),
    msg('user', '继续做这个项目。'.repeat(2)),
    msg('assistant', 'LATEST-CODEX-NARRATIVE 这是最近一段 codex 工作,下一步继续。'.repeat(2)),
  ].join('\n') + '\n';
  await fs.writeFile(path.join(dir, 'rollout-2026-06-19T00-00-00-codex.jsonl'), rollout, 'utf8');

  process.env.HOME = home;
  const pkt = await buildHandoffPacket({ limit: 5 });
  const c = pkt.candidates.find((x) => x.tool === 'codex');
  assert.ok(c, 'a codex session appears in the packet');
  assert.equal(c.project.basename, 'codexproj', 'project mapped from session_meta cwd');
  assert.equal(c.anchors.isRepo, true, 'git anchors resolved from the codex cwd');
  assert.match(c.narrative.text, /LATEST-CODEX-NARRATIVE/, 'carries the LATEST session narrative');
  assert.doesNotMatch(c.narrative.text, /OLD-CODEX-SESSION/, 'older session in the same file is not surfaced');
  assert.equal(c.narrative.unverified, true, 'narrative still flagged UNVERIFIED');
  assert.match(c.narrative.source, /codex/, 'provenance is tool-correct (not hardcoded claude-transcript)');
});
