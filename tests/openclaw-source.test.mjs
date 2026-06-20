// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Non-Claude capture, OpenClaw: an OpenClaw trajectory
// (~/.openclaw/agents/<agent>/sessions/<id>.trajectory.jsonl, an event stream) is parsed by the unified
// SessionReader and surfaces in the same handoff packet — tool-tagged, workspaceDir-mapped project,
// narrative scoped through the shared summarizeTranscript (no full user dump).
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
const ev = (type, ws, sid, data) => JSON.stringify({ type, ts: '2026-06-19T00:00:01Z', sessionId: sid, workspaceDir: ws, data });

test('openclaw trajectory surfaces in the handoff packet (tool-tagged, workspaceDir project, scoped narrative)', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-home-'));
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-base-'));
  const origHome = process.env.HOME;
  t.after(async () => {
    process.env.HOME = origHome;
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(base, { recursive: true, force: true });
  });
  const repo = path.join(base, 'ocproj');
  await makeRepo(repo);
  const sid = 'oc-sess-1';
  const dir = path.join(home, '.openclaw', 'agents', 'main', 'sessions');
  await fs.mkdir(dir, { recursive: true });
  const traj = [
    ev('session.started', repo, sid, {}),
    ev('prompt.submitted', repo, sid, { prompt: '继续推进 ocproj 这个项目。' }),
    ev('model.completed', repo, sid, { assistantTexts: ['OC-NARRATIVE 上一段 OpenClaw 工作,下一步继续完善。'.repeat(2)] }),
    ev('session.ended', repo, sid, {}),
  ].join('\n') + '\n';
  await fs.writeFile(path.join(dir, `${sid}.trajectory.jsonl`), traj, 'utf8');

  process.env.HOME = home;
  const pkt = await buildHandoffPacket({ limit: 5 });
  const c = pkt.candidates.find((x) => x.tool === 'openclaw');
  assert.ok(c, 'an openclaw session appears in the packet');
  assert.equal(c.project.basename, 'ocproj', 'project mapped from workspaceDir');
  assert.equal(c.anchors.isRepo, true, 'git anchors resolved from workspaceDir');
  assert.match(c.narrative.text, /OC-NARRATIVE/, 'carries the assistant narrative');
  assert.match(c.narrative.source, /openclaw/, 'provenance is tool-correct');
  assert.equal(c.narrative.unverified, true, 'narrative flagged UNVERIFIED');
});
