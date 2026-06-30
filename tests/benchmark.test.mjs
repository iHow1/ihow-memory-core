// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// The `benchmark` command is the PUBLIC evidence artifact: a deterministic local proof of the
// verify-first guarantees. These tests assert it actually holds (and would FAIL loudly if a
// regression turned a discriminating verdict into a rubber stamp, or let the floor pass junk) — so the
// benchmark cannot quietly start lying about itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runBenchmark } from '../src/benchmark.ts';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts');

test('benchmark: every verify-first guarantee holds (deterministic)', () => {
  const r = runBenchmark();
  assert.equal(r.ok, true, `all scenarios must pass: ${r.scenarios.filter((s) => !s.pass).map((s) => s.id).join(',') || '(none failed)'}`);
  assert.equal(r.passed, r.total);
  assert.ok(r.total >= 6, 'runs the floor battery at minimum');
});

test('benchmark: the three-color verdict genuinely DISCRIMINATES (not a rubber stamp)', () => {
  const r = runBenchmark();
  if (!r.gitAvailable) return; // verdict battery needs git
  const by = (id) => r.scenarios.find((s) => s.id === id);
  assert.equal(by('A1').actual, 'GREEN', 'matching checkout is GREEN');
  assert.equal(by('A4').actual, 'RED', 'drifted HEAD is RED');
  assert.equal(by('A5').actual, 'RED', 'wrong checkout is RED');
  assert.equal(by('A2').actual, 'YELLOW', 'destructive narrative degrades to YELLOW');
  // The load-bearing property: not all three colors are the same value (it actually distinguishes).
  const colors = new Set(r.scenarios.filter((s) => s.battery === 'verdict').map((s) => s.actual));
  assert.ok(colors.has('GREEN') && colors.has('YELLOW') && colors.has('RED'), 'verdict spans all three colors');
});

test('benchmark: the floor blocks junk and allows only engine-verified provenance', () => {
  const r = runBenchmark();
  const by = (id) => r.scenarios.find((s) => s.id === id);
  assert.equal(by('B1').actual, 'unverified', 'no provenance -> durable unverified yellow');
  assert.equal(by('B2').actual, 'verified', 'command+exitCode -> verified yellow');
  assert.equal(by('B3').actual, 'block', 'secret -> blocked');
  assert.equal(by('B4').actual, 'flagged', 'standing-rule -> isolated flagged yellow');
});

test('benchmark: the CLI command exits 0 and prints a PASS scorecard', () => {
  const out = execFileSync(process.execPath, ['--experimental-strip-types', CLI, 'benchmark'], { encoding: 'utf8' });
  assert.match(out, /verify-first benchmark/);
  assert.match(out, /✓ PASS\s+\d+\/\d+ verify-first guarantees held/);
});
