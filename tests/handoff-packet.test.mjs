// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// buildHandoffPacket — the runtime-neutral handoff packet behind `memory.continue`. Locks the DESIGN
// (n=12 A/B, 2026-06-18): MACHINE ANCHORS are facts; the narrative is VERBATIM + UNVERIFIED and is
// NEVER parsed into authoritative "open loops / next action" fields (that structure+authority is what
// induces confident-wrong). Structure lives only in the machine layer (anchors/freshness/conflicts).
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
function editedTranscript(repo, marker, staleSha) {
  const u = (c) => JSON.stringify({ type: 'user', message: { content: c } });
  const asst = (blocks) => JSON.stringify({ type: 'assistant', message: { content: blocks } });
  const tool = (name, fp) => ({ type: 'tool_use', name, input: { file_path: fp } });
  const text = (t) => ({ type: 'text', text: t });
  return [
    u('继续干'),
    asst([tool('Edit', path.join(repo, 'a.js')), text('改了 a.js')]),
    asst([tool('Edit', path.join(repo, 'b.js')), text('又改了 b.js')]),
    asst([text(`交接：${marker} 上次在 ${staleSha} 完成了某事，下一步继续。`.repeat(2))]),
  ].join('\n') + '\n';
}

test('buildHandoffPacket: machine-structured, narrative verbatim+UNVERIFIED, conflicts computed, NO authoritative fields', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-home-'));
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-base-'));
  const origHome = process.env.HOME;
  t.after(async () => {
    process.env.HOME = origHome;
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(base, { recursive: true, force: true });
  });
  const repo = path.join(base, 'projPkt');
  await makeRepo(repo);
  const cwd = '/tmp/pkt-cwd';
  const encoded = path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
  const projDir = path.join(home, '.claude', 'projects', encoded);
  await fs.mkdir(projDir, { recursive: true });
  await fs.writeFile(path.join(projDir, 'sess.jsonl'), editedTranscript(repo, 'PKT-NARRATIVE-MARK', 'deadbee'), 'utf8');

  process.env.HOME = home; // os.homedir() honors $HOME on posix; discovery scans HOME/.claude/projects
  const pkt = await buildHandoffPacket({ cwd, limit: 5 });

  assert.ok(pkt.candidates.length >= 1, 'returns at least one candidate');
  const c = pkt.candidates.find((x) => x.project.basename === 'projPkt') ?? pkt.candidates[0];
  // machine layer = facts
  assert.equal(c.anchors.isRepo, true, 'anchors come from the inferred git project');
  assert.equal(typeof c.project.projectId, 'string', 'stable project id present');
  assert.ok(c.conflicts.staleShaRefs >= 1, 'a stale SHA in the narrative is counted (deadbee != HEAD)');
  assert.ok(typeof c.freshness.ageMs === 'number', 'freshness computed');
  assert.ok(c.verifyFirst.length >= 1, 'tells the receiver what to verify first');
  // narrative = verbatim + unverified, NOT parsed into authoritative fields
  assert.match(c.narrative.text, /PKT-NARRATIVE-MARK/, 'narrative carried verbatim');
  assert.equal(c.narrative.unverified, true, 'narrative flagged UNVERIFIED');
  assert.ok(!('openLoops' in c) && !('nextAction' in c) && !('blockers' in c), 'DESIGN LOCK: no LLM-parsed authoritative fields');
  assert.ok(pkt.receiverProtocol.length > 0, 'carries the verify-first receiver protocol');
});

test('buildHandoffPacket: projectHint filters candidates', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-home-'));
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-base-'));
  const origHome = process.env.HOME;
  t.after(async () => {
    process.env.HOME = origHome;
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(base, { recursive: true, force: true });
  });
  const repoA = path.join(base, 'alpha');
  const repoB = path.join(base, 'bravo');
  await makeRepo(repoA);
  await makeRepo(repoB);
  const cwd = '/tmp/pkt-hint-cwd';
  const encoded = path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
  const projDir = path.join(home, '.claude', 'projects', encoded);
  await fs.mkdir(projDir, { recursive: true });
  await fs.writeFile(path.join(projDir, 'a.jsonl'), editedTranscript(repoA, 'ALPHA-WORK', 'cafe123'), 'utf8');
  await new Promise((r) => setTimeout(r, 25));
  await fs.writeFile(path.join(projDir, 'b.jsonl'), editedTranscript(repoB, 'BRAVO-WORK', 'beef456'), 'utf8');

  process.env.HOME = home;
  const pkt = await buildHandoffPacket({ cwd, projectHint: 'alpha', limit: 5 });
  assert.ok(pkt.candidates.every((c) => c.project.basename === 'alpha'), 'hint narrows to the matching project');
});
