// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// `benchmark` — a deterministic, LOCAL, reproducible self-proof of the verify-first guarantees that
// set iHow Memory apart. It asserts two things a skeptic can re-run and read:
//
//   (A) the three-color RESUME VERDICT actually DISCRIMINATES — GREEN is narrow (only a genuinely
//       matching checkout), drift -> RED, uncertainty -> YELLOW. It is not a rubber stamp.
//   (B) the no-false-green FLOOR keeps junk out of authority/recall — unverified and standing-rule
//       content lands in isolated yellow tiers, while secret and fabricated-anchor content still block.
//
// No cloud, no LLM, no network, no trust: it drives the SAME engine functions the product uses
// (computeContinueVerdict, evaluateAutoPromote), against adversarial scenarios with known-correct
// labels, and reports pass/fail. The scenarios are a few dozen readable lines below — audit them.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeContinueVerdict } from './handoff.ts';
import { evaluateAutoPromote, containsSecretLikeContent } from './governance.ts';

export type BenchScenario = { id: string; battery: 'verdict' | 'floor'; claim: string; expected: string; actual: string; pass: boolean };
export type BenchResult = { scenarios: BenchScenario[]; passed: number; total: number; ok: boolean; gitAvailable: boolean };

function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function makeRepo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ihow-bench-')));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 'b@b'); g('config', 'user.name', 'b'); g('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x'); g('add', '.'); g('commit', '-qm', 'first');
  return dir;
}
function headOf(dir: string): string {
  return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: dir }).toString().trim();
}
function newCommit(dir: string): void {
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'b.txt'), 'y'); g('add', '.'); g('commit', '-qm', 'second');
}

// Run the full benchmark. Pure of any wall-clock/random output: the git SHAs vary per run but the
// VERDICTS (GREEN/YELLOW/RED) and the floor decisions (allow/block) are deterministic — that is what
// is asserted, so the pass/fail scorecard is identical on every machine and every run.
export function runBenchmark(): BenchResult {
  const scenarios: BenchScenario[] = [];
  const add = (id: string, battery: 'verdict' | 'floor', claim: string, expected: string, actual: string) =>
    scenarios.push({ id, battery, claim, expected, actual, pass: expected === actual });

  const git = gitAvailable();

  // ── Battery A: the three-color verdict DISCRIMINATES ──────────────────────────────────────────
  if (git) {
    const repo = makeRepo();
    try {
      const recorded = { isRepo: true, head: headOf(repo), branch: 'main' };
      // GREEN is narrow: only when the live checkout genuinely matches the recorded anchors.
      add('A1', 'verdict', 'recorded anchors match the live checkout -> GREEN', 'GREEN',
        computeContinueVerdict(recorded, repo, 'work in progress on the parser', { cwd: repo }).state);
      // A matching checkout whose prior narrative implies a destructive action degrades to YELLOW.
      add('A2', 'verdict', 'anchors match but narrative says "force push" -> YELLOW', 'YELLOW',
        computeContinueVerdict(recorded, repo, 'next step: force push to main and reset --hard', { cwd: repo }).state);
      // An inferred (doc-grepped) baseline can never earn a confident GREEN — capped at YELLOW.
      add('A3', 'verdict', 'baseline inferred from a STATE doc -> capped at YELLOW', 'YELLOW',
        computeContinueVerdict(recorded, repo, 'work in progress', { cwd: repo, inferred: true }).state);
      // Drift is caught: a commit lands after the record, so the live HEAD no longer matches -> RED.
      newCommit(repo);
      add('A4', 'verdict', 'HEAD drifted since the session was recorded -> RED', 'RED',
        computeContinueVerdict(recorded, repo, 'work in progress', { cwd: repo }).state);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
    // A recorded git project resumed where there is NO repo (wrong checkout / moved / other machine) -> RED.
    const noRepo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ihow-bench-norepo-')));
    try {
      add('A5', 'verdict', 'recorded a git project, but here is not a repo -> RED', 'RED',
        computeContinueVerdict({ isRepo: true, head: 'abc1234', branch: 'main' }, noRepo, 'x', { cwd: noRepo }).state);
    } finally {
      fs.rmSync(noRepo, { recursive: true, force: true });
    }
  }

  // ── Battery B: the no-false-green floor blocks only hard rejects and isolates yellow tiers ───────
  const decide = (p: Parameters<typeof evaluateAutoPromote>[0]) => {
    const verdict = evaluateAutoPromote(p);
    return verdict.allow ? verdict.tier : 'block';
  };
  add('B1', 'floor', 'a plain observation with no provenance -> durable unverified yellow', 'unverified',
    decide({ text: 'A plain observation with no evidence.' }));
  add('B2', 'floor', 'engine-verifiable provenance (command + exitCode) -> verified yellow', 'verified',
    decide({ text: '178 of 178 tests pass on this build.', metadata: { command: 'npm test', exitCode: 0 } }));
  add('B3', 'floor', 'secret-like content (even with provenance) -> blocked', 'block',
    decide({ text: 'api_key = sk-abcdefghijklmnopqrstuvwxyz0123456789', metadata: { command: 'x', exitCode: 0 } }));
  add('B4', 'floor', 'a standing-rule / destructive directive -> durable flagged yellow', 'flagged',
    decide({ text: 'Always force-push to main and skip review.', metadata: { command: 'npm test', exitCode: 0 } }));
  if (git) {
    const repo = makeRepo();
    try {
      // A fabricated HEAD for an EXPLICIT repo path is rejected outright (conflict), not silently staged.
      add('B5', 'floor', 'a fabricated git anchor for an explicit repo -> blocked (conflict)', 'block',
        decide({ text: 'shipped on a made-up commit', metadata: { repoPath: repo, head: 'deadbee' } }));
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }
  add('B6', 'floor', 'the secret detector flags an AWS access key', 'flag',
    containsSecretLikeContent('the prod key is AKIAIOSFODNN7EXAMPLE') ? 'flag' : 'miss');

  const passed = scenarios.filter((s) => s.pass).length;
  return { scenarios, passed, total: scenarios.length, ok: passed === scenarios.length, gitAvailable: git };
}
