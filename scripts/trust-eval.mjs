#!/usr/bin/env node --experimental-strip-types
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Trust Eval harness — the "should I believe this?" benchmark (design: docs/trust-eval-design.md).
//
// Measures the verify-first MOAT firing, NOT recall. Three deterministic, no-LLM-judge metrics:
//   1. staleness detection      — drifted git anchors get RED, never a false GREEN
//   2. contradiction win-rate   — stronger (engine-checkable) provenance wins; conflicts are REJECTED
//   3. confidence-tracks-evidence — self-asserted "verified:true" never reaches the high band
//
// Honest scope (see design doc): the moat is load-bearing only for CODE/COMMAND-anchored facts
// (Domain A). For non-code facts (Domain B) the correct behavior is calibrated ABSTENTION — degrade to
// YELLOW/unverified, never a false GREEN. We score the two domains separately and NEVER average them.
//
// Run:   node --experimental-strip-types scripts/trust-eval.mjs      (or: node scripts/trust-eval.mjs on Node ≥22.6 w/ the shebang)
// Deps:  none (node builtins + the project's own engine code). No network. No LLM.
//
// This is a standalone harness; it intentionally does NOT join `node --test`. Keeping it out of the
// suite means it can shell out to real `git` for the anchored fixtures without coupling the unit tests
// to a git-capable host. Where git is unavailable it degrades to pure-data STUB fixtures (labeled).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Real engine code — the eval exercises the SAME functions production uses, so a green eval means the
// shipped trust logic is green (not a re-implementation that could drift).
import { anchorConflicts } from '../src/handoff-metrics.ts';
import { computeContinueVerdict } from '../src/handoff.ts';
import { gitAnchors } from '../src/anchors.ts';
import { evaluateAutoPromote } from '../src/governance.ts';

// ── tiny git helper: a real throwaway repo so staleness/contradiction run against live gitAnchors ──────
let GIT_OK = true;
function git(dir, ...args) {
  return execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
}
function tmpRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ihow-trusteval-')));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'first');
  return dir;
}
function commitMore(dir, name) {
  fs.writeFileSync(path.join(dir, name), 'more');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', `add ${name}`);
}
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { GIT_OK = false; }

// ── result accounting ──────────────────────────────────────────────────────────────────────────────
const cleanup = [];
const rows = []; // { domain, metric, fixture, pass, detail, stub }
function record(domain, metric, fixture, pass, detail, stub = false) {
  rows.push({ domain, metric, fixture, pass, detail, stub });
}

// confidence band the engine's tier/verdict maps to (design doc table)
function bandOf({ verdict, tier }) {
  if (verdict === 'RED' || tier === 'conflict') return 0; // refused
  if (verdict === 'GREEN' || tier === 'verified-anchor') return 3; // high
  if (tier === 'verified-command') return 2; // medium
  return 1; // YELLOW / unverified → low
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// METRIC 1 — staleness detection (Domain A). Drifted HEAD ⇒ RED + anchorConflicts flags the stale sha.
//            Matching HEAD ⇒ GREEN + zero conflicts. A false GREEN on stale is the cardinal sin.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
function metricStaleness() {
  if (!GIT_OK) {
    // STUB: anchorConflicts is pure-data, so we can still demonstrate the stale-sha count with no git.
    const stale = anchorConflicts('picked up at HEAD 9cd4dc2, 16 commits to push', 'e1d482b');
    record('A', 'staleness', 'drift-stub', stale.stale === 1 && stale.referencesHead === false,
      `stale shas=${stale.stale} referencesHead=${stale.referencesHead}`, true);
    const fresh = anchorConflicts('at HEAD e1d482b, clean', 'e1d482b');
    record('A', 'staleness', 'fresh-stub', fresh.stale === 0 && fresh.referencesHead === true,
      `stale shas=${fresh.stale} referencesHead=${fresh.referencesHead}`, true);
    return;
  }
  const dir = tmpRepo();
  cleanup.push(dir);
  const recorded = gitAnchors(dir); // anchor captured "at session time"

  // FRESH: nothing moved → GREEN, no stale conflicts.
  const freshVerdict = computeContinueVerdict(recorded, dir, 'fixed the parser, tests pass');
  const freshConflicts = anchorConflicts(`work continued at HEAD ${recorded.head}`, gitAnchors(dir).head);
  record('A', 'staleness', 'fresh→GREEN', freshVerdict.state === 'GREEN' && freshConflicts.stale === 0,
    `verdict=${freshVerdict.state} staleShas=${freshConflicts.stale}`);

  // STALE: someone committed since → live HEAD drifted → must be RED, and a recorded sha the narrative
  // cites is now stale against the live HEAD. (We cite an explicit letter-bearing old sha so the
  // anchorConflicts count is deterministic — its hex-LETTER guard deliberately ignores all-digit tokens
  // like line counts / issue IDs, so a randomly all-numeric short HEAD wouldn't count and that's correct.)
  commitMore(dir, 'b.txt');
  const live = gitAnchors(dir);
  const oldSha = 'a1b2c3d'; // letter-bearing stand-in for the pre-drift HEAD the prior narrative cited
  const staleVerdict = computeContinueVerdict(recorded, dir, `resume at HEAD ${oldSha}, 1 commit to push`);
  const staleConflicts = anchorConflicts(`resume at HEAD ${oldSha}, 1 commit to push`, live.head);
  const caught = staleVerdict.state === 'RED' && staleConflicts.stale >= 1;
  record('A', 'staleness', 'drift→RED', caught,
    `verdict=${staleVerdict.state} staleShas=${staleConflicts.stale} (recorded ${recorded.head} ≠ live ${live.head})`);

  // CARDINAL: the stale fixture must NEVER read GREEN.
  record('A', 'false-green', 'drift', staleVerdict.state !== 'GREEN', `verdict=${staleVerdict.state} (must not be GREEN)`);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// METRIC 2 — contradiction win-rate. Two facts disagree; the stronger ENGINE-CHECKABLE provenance must
//            win, and a fabricated explicit anchor must be REJECTED (category: 'conflict'), not down-ranked.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
function provVerdict(payload) {
  const v = evaluateAutoPromote(payload);
  if (!v.allow) return { tier: v.category, allow: false }; // 'conflict' | 'secret'
  if (v.tier === 'verified') return { tier: v.provenanceKind === 'anchor' ? 'verified-anchor' : 'verified-command', allow: true };
  return { tier: v.tier, allow: true }; // unverified | flagged
}

function metricContradiction() {
  if (!GIT_OK) {
    // STUB: command+exitCode (checkable) beats a self-asserted "verified:true" (not checkable).
    const strong = provVerdict({ text: 'the build is green', metadata: { command: 'npm test', exitCode: 0 } });
    const weak = provVerdict({ text: 'the build is broken', metadata: { verified: true } });
    const win = bandOf({ tier: strong.tier }) > bandOf({ tier: weak.tier });
    record('A', 'contradiction', 'command>self-stub', win, `strong=${strong.tier} weak=${weak.tier}`, true);
    return;
  }
  const dir = tmpRepo();
  cleanup.push(dir);
  const live = gitAnchors(dir);

  // Pair A: a LIVE-MATCHED git anchor (engine re-checks it) vs a self-asserted contradicting claim.
  const anchored = provVerdict({ text: 'feature X landed', metadata: { head: live.head, repoPath: dir } });
  const selfAsserted = provVerdict({ text: 'feature X was reverted', metadata: { verified: true } });
  const win1 = bandOf({ tier: anchored.tier }) > bandOf({ tier: selfAsserted.tier });
  record('A', 'contradiction', 'live-anchor>self-asserted', win1,
    `anchor=${anchored.tier} self=${selfAsserted.tier}`);

  // Pair B: a FABRICATED explicit anchor (claims a sha that doesn't match live HEAD for an explicit repo
  // path) must be rejected OUTRIGHT — even though it is "more structured" than the plain truth.
  const fabricated = provVerdict({ text: 'shipped at deadbeefcafe', metadata: { head: 'deadbeefcafe1234', repoPath: dir } });
  const rejected = fabricated.allow === false && fabricated.tier === 'conflict';
  record('A', 'contradiction', 'fabricated-anchor-rejected', rejected,
    `fabricated verdict=${fabricated.tier} allow=${fabricated.allow} (must be conflict/rejected)`);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// METRIC 3 — confidence tracks evidence. Monotone: stronger evidence ⇒ ≥ band. Killer fixture: a fact
//            carrying ONLY self-asserted verified:true must NOT reach the high band.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
function metricConfidence() {
  const ladder = [];

  if (GIT_OK) {
    const dir = tmpRepo();
    cleanup.push(dir);
    const live = gitAnchors(dir);
    ladder.push({ label: 'live-anchor', band: bandOf({ tier: provVerdict({ text: 'x', metadata: { head: live.head, repoPath: dir } }).tier }) });
  } else {
    ladder.push({ label: 'live-anchor(stub-skipped)', band: 3, stub: true }); // documented expected band
  }
  ladder.push({ label: 'command+exitCode', band: bandOf({ tier: provVerdict({ text: 'x', metadata: { command: 'npm test', exitCode: 0 } }).tier }) });
  ladder.push({ label: 'self-asserted-only', band: bandOf({ tier: provVerdict({ text: 'x', metadata: { verified: true } }).tier }) });

  // Monotonicity: each rung's band ≥ the next weaker rung's band.
  let monotone = true;
  for (let i = 0; i < ladder.length - 1; i++) if (ladder[i].band < ladder[i + 1].band) monotone = false;
  const stub = ladder.some((r) => r.stub);
  record('A', 'confidence', 'evidence-monotone', monotone, ladder.map((r) => `${r.label}=${r.band}`).join(' ≥ '), stub);

  // KILLER: self-asserted-only must be strictly below high (band < 3).
  const selfBand = ladder.find((r) => r.label === 'self-asserted-only').band;
  record('A', 'confidence', 'self-asserted-not-high', selfBand < 3, `self-asserted band=${selfBand} (must be < 3 / high)`);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// DOMAIN B — non-code fact. The HONEST FLOOR: no oracle ⇒ calibrated abstention. A plain preference with
//            no provenance must land 'unverified' (never recall-eligible, never a false GREEN), and a
//            no-project resume verdict must be YELLOW. A Domain-B "win" is a correct I-can't-verify-this.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
function metricHonestFloor() {
  const pref = evaluateAutoPromote({ text: 'the user prefers terse summaries', metadata: {} });
  const abstainsWrite = pref.allow === true && pref.tier === 'unverified';
  record('B', 'calibrated-abstention', 'preference→unverified', abstainsWrite,
    `tier=${pref.allow ? pref.tier : pref.category} (no oracle ⇒ must be unverified, not verified)`);

  const noProject = computeContinueVerdict({ isRepo: false }, undefined, 'we decided to use Postgres');
  record('B', 'calibrated-abstention', 'no-project→YELLOW', noProject.state === 'YELLOW',
    `verdict=${noProject.state} (no anchor ⇒ must be YELLOW, never a false GREEN)`);
}

// ── run + report ─────────────────────────────────────────────────────────────────────────────────────
metricStaleness();
metricContradiction();
metricConfidence();
metricHonestFloor();
for (const dir of cleanup) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }

const byDomain = { A: rows.filter((r) => r.domain === 'A'), B: rows.filter((r) => r.domain === 'B') };
const allPass = rows.every((r) => r.pass);
const usedStub = rows.some((r) => r.stub);

console.log('\nTrust Eval — "should I believe this?"   (deterministic, no LLM judge)');
console.log(`mode: ${GIT_OK ? 'live git fixtures' : 'STUB (git unavailable — pure-data fixtures)'}`);
console.log('═'.repeat(74));
for (const [dom, label] of [['A', 'DOMAIN A — code/command-anchored (MOAT domain)'], ['B', 'DOMAIN B — non-code (HONEST-FLOOR domain: abstention is the win)']]) {
  console.log(`\n${label}`);
  for (const r of byDomain[dom]) {
    const mark = r.pass ? '✓' : '✗';
    const tag = r.stub ? ' [stub]' : '';
    console.log(`  ${mark} ${r.metric.padEnd(22)} ${r.fixture.padEnd(30)}${tag}  ${r.detail}`);
  }
}
// per-domain headline; NEVER a cross-domain average (design doc: that would launder the honest floor).
for (const dom of ['A', 'B']) {
  const d = byDomain[dom];
  const p = d.filter((r) => r.pass).length;
  console.log(`\nDOMAIN ${dom}: ${p}/${d.length} fixtures pass`);
}
console.log('═'.repeat(74));
console.log(allPass ? '✓ trust-eval GREEN — verify-first moat fires on anchored facts, abstains honestly elsewhere'
                    : '✗ trust-eval FAILED — a trust check regressed (see ✗ lines above)');
if (usedStub) console.log('  note: some fixtures ran as STUBS (git unavailable); install git for the full live-anchor eval.');
process.exit(allPass ? 0 : 1);
