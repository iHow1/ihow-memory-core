// SPDX-License-Identifier: Apache-2.0
// B4: continue computes a GREEN/YELLOW/RED verdict by re-reading live git and comparing to the
// recorded anchors — instead of leaving the check to the receiving agent's prose-following. GREEN is
// narrow on purpose (OpenClaw: a confidently-wrong structured GREEN is worse than prose); any
// uncertainty is YELLOW, an actual mismatch is RED. Never a false GREEN.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { computeContinueVerdict, referencedHead } from '../src/handoff.ts';
import { gitAnchors } from '../src/anchors.ts';
import { assembleEnvelope } from '../src/envelope.ts';

async function tmpRepo(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-verdict-')));
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  const g = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(dir, 'a.txt'), 'one');
  g('add', '.'); g('commit', '-qm', 'first');
  return { dir, g };
}

test('GREEN when the live repo matches the recorded anchors', async (t) => {
  const { dir } = await tmpRepo(t);
  const recorded = gitAnchors(dir);
  const v = computeContinueVerdict(recorded, dir, 'fixed the parser, tests pass');
  assert.equal(v.state, 'GREEN', v.reason);
  assert.equal(v.liveHead, recorded.head);
});

test('RED when HEAD drifted (someone committed since)', async (t) => {
  const { dir, g } = await tmpRepo(t);
  const recorded = gitAnchors(dir);
  await fs.writeFile(path.join(dir, 'b.txt'), 'two');
  g('add', '.'); g('commit', '-qm', 'second');
  const v = computeContinueVerdict(recorded, dir, 'clean narrative');
  assert.equal(v.state, 'RED', v.reason);
  assert.match(v.reason, /drift/i);
});

test('YELLOW when the project is undetermined', () => {
  const v = computeContinueVerdict({ isRepo: false }, undefined, 'x');
  assert.equal(v.state, 'YELLOW');
});

test('RED when a git project was recorded but the path is not a repo now (wrong checkout / machine)', async (t) => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-norepo-')));
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  const v = computeContinueVerdict({ isRepo: true, head: 'abc1234', branch: 'main' }, dir, 'x');
  assert.equal(v.state, 'RED', v.reason);
});

test('YELLOW when anchors match but the narrative mentions a destructive action', async (t) => {
  const { dir } = await tmpRepo(t);
  const recorded = gitAnchors(dir);
  const v = computeContinueVerdict(recorded, dir, 'next step: force push to main and reset --hard');
  assert.equal(v.state, 'YELLOW', v.reason);
});

// ── C1: first-run handoff from a hand-written STATE doc ──────────────────────

test('referencedHead extracts a SHA near a git marker, not from emails / digests / ahead-words', () => {
  assert.equal(referencedHead('current baseline: HEAD d7fadb3 on main'), 'd7fadb3');
  assert.equal(referencedHead('基线 8797eb7c9f0a, 下一步: ...'), '8797eb7');
  assert.equal(referencedHead('commit abc1234 fixed it'), 'abc1234');
  assert.equal(referencedHead('no sha here at all'), undefined);
  // NOT a git baseline — these used to fabricate bogus anchors:
  assert.equal(referencedHead('email support@deadbeef0 thanks'), undefined, 'bare @ removed');
  assert.equal(referencedHead('pull image@sha256:abc1234def5 now'), undefined, 'docker digest excluded');
  assert.equal(referencedHead('look ahead to deadbee1 plans'), undefined, 'HEAD inside "ahead" needs \\b');
  assert.equal(referencedHead('a uuid 1a2b3c4d-5e6f unrelated'), undefined);
});

test('C1: an inferred (STATE-doc) baseline is capped at YELLOW, never a confident GREEN', async (t) => {
  const { dir } = await tmpRepo(t);
  const live = gitAnchors(dir);
  const stateDoc = `# project state\nbaseline: HEAD ${live.head}\nnext: ship it`;
  const recorded = { isRepo: true, head: referencedHead(stateDoc) };
  assert.equal(computeContinueVerdict(recorded, dir, stateDoc).state, 'GREEN', 'a real matching baseline is GREEN by default');
  assert.equal(computeContinueVerdict(recorded, dir, stateDoc, { inferred: true }).state, 'YELLOW', 'a doc-inferred baseline is never a confident GREEN');
});

test('HEAD comparison is prefix-aware (a full recorded SHA still matches the short live HEAD)', async (t) => {
  const { dir, g } = await tmpRepo(t);
  const live = gitAnchors(dir); // live.head is the 7-char `--short` form
  const full = g('rev-parse', 'HEAD').toString().trim(); // 40-char form, as a bigger repo / different git might record
  const recorded = { isRepo: true, head: full, branch: live.branch };
  const v = computeContinueVerdict(recorded, dir, 'clean'); // short live HEAD is a prefix of the full recorded → match, not drift
  assert.equal(v.state, 'GREEN', v.reason);
});

// ── go/no-go #4: a confident GREEN must mean the receiver is in the SAME checkout ──────────────────

test('YELLOW when the caller cwd is a DIFFERENT repo than the recorded project (no cross-repo false GREEN)', async (t) => {
  const a = await tmpRepo(t);
  const b = await tmpRepo(t); // an unrelated repo the receiver happens to be sitting in
  const recorded = gitAnchors(a.dir);
  const v = computeContinueVerdict(recorded, a.dir, 'fixed the parser, tests pass', { cwd: b.dir });
  assert.equal(v.state, 'YELLOW', v.reason);
  assert.match(v.reason, /different checkout|cd there|re-verify/i);
});

test('GREEN preserved when the caller cwd IS the recorded project', async (t) => {
  const { dir } = await tmpRepo(t);
  const recorded = gitAnchors(dir);
  const v = computeContinueVerdict(recorded, dir, 'fixed the parser, tests pass', { cwd: dir });
  assert.equal(v.state, 'GREEN', v.reason);
});

test('a BLANK cwd is not a falsy-bypass — "" cannot skip the gate into a confident GREEN', async (t) => {
  const { dir } = await tmpRepo(t);
  const recorded = gitAnchors(dir);
  // An empty-string cwd ("I don't know where I am") used to be falsy and skip the receiver-context gate,
  // letting an MCP client send {"cwd":""} and get a confident GREEN for a project they're not in.
  assert.equal(computeContinueVerdict(recorded, dir, 'clean', { cwd: '' }).state, 'YELLOW', 'blank cwd → YELLOW');
  assert.equal(computeContinueVerdict(recorded, dir, 'clean', { cwd: '   ' }).state, 'YELLOW', 'whitespace cwd → YELLOW');
  // Omitting cwd entirely keeps the back-compat path (direct callers / tests) able to reach GREEN.
  assert.equal(computeContinueVerdict(recorded, dir, 'clean').state, 'GREEN', 'omitted cwd stays GREEN-able');
});

test('YELLOW when matching anchors but the narrative asks for an outward-facing / irreversible action', async (t) => {
  const { dir } = await tmpRepo(t);
  const recorded = gitAnchors(dir);
  // Each of these used to slip past the narrow destructive regex into a confident GREEN.
  for (const narrative of [
    'all done — next: npm publish',
    'next step: publish the release with gh release create',
    'send a message to the customer about the fix',
    'rotate the API credential and move on',
    'change the default timeout for everyone',
  ]) {
    const v = computeContinueVerdict(recorded, dir, narrative);
    assert.equal(v.state, 'YELLOW', `expected YELLOW for: ${narrative} (got ${v.state}: ${v.reason})`);
  }
});

test('YELLOW (not GREEN, not RED) when the recorded HEAD anchor is too short to verify', async (t) => {
  const { dir } = await tmpRepo(t);
  const recorded = { isRepo: true, head: '6', branch: 'main' }; // a 1-char "anchor" prefix-matches almost anything
  const v = computeContinueVerdict(recorded, dir, 'clean');
  assert.equal(v.state, 'YELLOW', v.reason);
  assert.match(v.reason, /too short/i);
});

test('C1 honesty: a STATE-doc narrative is labeled PROJECT DOC, never "PREVIOUS AGENT SAID"', () => {
  const base = {
    cwd: '/tmp/x', producerAgent: 'ihow-continue', createdAt: '2026-07-02T00:00:00Z',
    anchors: { isRepo: false }, quotedBody: 'Project readme text.',
  };
  const doc = assembleEnvelope({ ...base, stateDocName: 'README.md' });
  assert.match(doc, /PROJECT DOC \(README\.md\)/, 'source is attributed truthfully');
  assert.ok(!doc.includes('PREVIOUS AGENT SAID'), 'a hand-written doc is never presented as a prior agent\'s words');
  const sess = assembleEnvelope({ ...base, sourceSessionId: 'abc12345' });
  assert.match(sess, /PREVIOUS AGENT SAID/, 'a real captured session keeps the original header');
});

test('C1 honesty (mixed path): doc attribution suppresses session metadata AND fixes the receiver line', () => {
  const doc = assembleEnvelope({
    cwd: '/tmp/x', producerAgent: 'ihow-continue', createdAt: '2026-07-02T00:00:00Z',
    anchors: { isRepo: false }, quotedBody: 'Doc text.',
    stateDocName: 'STATE.md',
    // a broken capture left these behind — the envelope must not render contradictory attribution
    sourceSessionId: 'deadbeef', transcriptRef: '/tmp/t.jsonl', sourceAgeMs: 1000,
  });
  assert.ok(!doc.includes('source_session'), 'no session line under doc attribution');
  assert.ok(!doc.includes('transcript_ref'), 'no transcript line under doc attribution');
  assert.ok(!doc.includes('source_freshness'), 'no session freshness under doc attribution');
  assert.match(doc, /quoted from a hand-written project doc/, 'receiver protocol names the true source');
  assert.ok(!doc.includes("previous agent's UNVERIFIED claim"), 'no residual previous-agent attribution');
});
