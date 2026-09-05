// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Recall quality evidence — seeds a realistic curated memory mix and runs the ACTUAL recall hook over a
// ground-truth-labeled prompt corpus. Run it:
//
//     node bench/recall-quality.mjs
//
// It asserts the deterministic safety guarantees that anyone can reproduce (these gate the exit code):
//   • off-topic prompts inject nothing (the relevance gate)
//   • a stale / superseded entry is never injected next to its current version (recency/dedup)
// Reviewed seeds explicitly opt out of default auto-promotion before their one manual promotion;
// clean unprovenanced auto seeds exercise the current durable-unverified contract.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openCore } from '../src/core.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'src', 'cli.ts');
const NODE_ARGS = ['--experimental-strip-types', CLI];
const originalCwd = process.cwd();
const tempParent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'recall-bench-')));
const home = path.join(tempParent, 'home');
const root = path.join(tempParent, 'workspace');
const cwd = path.join(tempParent, 'cwd');
const space = 'h';
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(root, { recursive: true });
fs.mkdirSync(cwd, { recursive: true });

const ambientKeys = new Set([
  'HOME', 'HERMES_HOME', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
  ...Object.keys(process.env).filter((key) => key.startsWith('IHOW_') || key.startsWith('MEMORY_')),
]);
const ambientSnapshot = new Map(ambientKeys.map((key) => [key, process.env[key]]));
for (const key of ambientKeys) delete process.env[key];
process.env.HOME = home;

const childEnv = (overrides = {}) => ({
  HOME: home,
  TMPDIR: tempParent,
  PATH: process.env.PATH || '',
  LANG: process.env.LANG || 'C.UTF-8',
  ...overrides,
});

const recall = (prompt, overrides) => {
  const child = spawnSync(process.execPath, [...NODE_ARGS, 'hook-user-prompt-submit', '--root', root, '--space', space], {
    cwd,
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt, cwd }),
    encoding: 'utf8',
    env: childEnv(overrides),
  });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(`recall hook exited ${child.status}: ${child.stderr.trim()}`);
  return child.stdout;
};

try {
  process.chdir(cwd);
  const core = await openCore({ root, space, engine: 'fts' });

  const seedReviewed = async (text, scope, title = scope) => {
    const staged = await core.write_candidate({ text, sourceAgent: 'recall-bench', autoPromote: false });
    if (staged.status !== 'candidate' || staged.autoPromote !== undefined) {
      throw new Error(`reviewed seed was not staged with autoPromote:false: ${JSON.stringify(staged)}`);
    }
    return await core.promote(staged.path, { scope, title });
  };

  // Reviewed (human-promoted) memory: exactly one manual promote per explicitly staged candidate.
  for (const [text, scope] of [
    ['Decision: adopt cursor-based pagination for the feed endpoint; offset drifts on inserts.', 'pagination'],
    ['Auth tokens expire after 15 minutes in staging.', 'auth'],
    ['Postgres timestamptz stores UTC internally; always convert at the application edge.', 'postgres'],
    ['We switched the message queue from Redis to SQS for at-least-once delivery.', 'queue'],
    ['Update: the vendor API now rate-limits at 500 requests per minute (raised from the old limit).', 'ratelimit-current'],
    ['The mobile app uses a 380px design breakpoint for the compact layout.', 'mobile'],
  ]) await seedReviewed(text, scope);

  // A superseded reviewed memory (stale) — must be dropped by recency, never injected.
  await seedReviewed(
    'The vendor API rate-limits at 100 requests per minute per key.',
    'ratelimit-stale',
    'ratelimit old',
  );

  // Current default auto-promote contract: clean entries without engine-verifiable provenance are
  // durable unverified memory, not candidates and never verified.
  for (const text of [
    'All 178 of 178 unit tests pass on the current build.',
    'The bundle size dropped to 142kb after tree-shaking the pagination module.',
    'CI now runs tsc --noEmit as a typecheck gate before merge.',
    'Migrated the build pipeline from TypeScript transpile to a single Rust binary.',
  ]) {
    const written = await core.write_candidate({ text, sourceAgent: 'recall-bench-auto' });
    if (written.status !== 'promoted' || written.autoPromote?.promoted !== true || written.autoPromote.tier !== 'unverified') {
      throw new Error(`unprovenanced auto seed did not become durable unverified: ${JSON.stringify(written)}`);
    }
  }

  // Ground-truth-labeled prompts: expect relevant reviewed memory, nothing (off-topic), or maybe (adjacent).
  const prompts = [
    ['P1', 'how should I paginate the feed endpoint', 'R'],
    ['P2', 'when do auth tokens expire in staging', 'R'],
    ['P3', 'how does postgres handle timezones', 'R'],
    ['P5', 'what is the current vendor api rate limit', 'R'],
    ['P6', 'what is the capital of France', 'nothing'],
    ['P7', 'write a haiku about the ocean', 'nothing'],
    ['P8', 'explain how quicksort works', 'nothing'],
    ['P16', 'how do I deploy to production', 'nothing'],
    ['P9', 'how do I write a unit test for the new parser', 'maybe'],
    ['P12', 'is our current bundle size acceptable', 'maybe'],
    ['P14', 'remind me the api rate limit number', 'R'],
    ['P15', 'what mobile breakpoint do we use', 'R'],
  ];
  const inject = (out) => {
    if (!out.trim()) return [];
    const parsed = JSON.parse(out);
    const context = parsed?.hookSpecificOutput?.additionalContext;
    if (typeof context !== 'string') throw new Error('recall hook emitted non-empty output without additionalContext');
    return context.split('\n').filter((line) => line.startsWith('- '));
  };

  let firedReviewed = 0;
  let firedDefault = 0;
  let offNoise = 0;
  let staleHit = 0;
  let autoDelta = 0;
  for (const [, prompt, expect] of prompts) {
    const reviewed = inject(recall(prompt, { IHOW_RECALL_AUTO_DEFAULT: '0', IHOW_RECALL_INCLUDE_AUTO: '0' }));
    const defaultRecall = inject(recall(prompt, { IHOW_RECALL_AUTO_DEFAULT: '1', IHOW_RECALL_INCLUDE_AUTO: '0' }));
    if (reviewed.length) firedReviewed++;
    if (defaultRecall.length) firedDefault++;
    autoDelta += Math.max(0, defaultRecall.length - reviewed.length);
    if (expect === 'nothing' && (reviewed.length || defaultRecall.length)) offNoise++;
    if ([...reviewed, ...defaultRecall].some((line) => /100 requests per minute/.test(line))) staleHit++;
  }
  const n = prompts.length;
  const off = prompts.filter((prompt) => prompt[2] === 'nothing').length;
  const ok = offNoise === 0 && staleHit === 0;

  console.log('iHow Memory — recall quality (deterministic safety guarantees; re-run to reproduce)');
  console.log('─'.repeat(76));
  console.log(`injection rate:   reviewed-only ${firedReviewed}/${n} (${Math.round(firedReviewed / n * 100)}%)   ·   current default ${firedDefault}/${n} (${Math.round(firedDefault / n * 100)}%)`);
  console.log(`durable auto tier adds: +${autoDelta} items across the corpus (measured here; no usefulness claim)`);
  console.log('');
  console.log(`SAFETY ① off-topic prompts inject nothing:   ${offNoise === 0 ? `✓ 0/${off} noisy` : `✗ ${offNoise}/${off} leaked`}`);
  console.log(`SAFETY ② stale "100 req/min" never injected:  ${staleHit === 0 ? '✓ held (recency/dedup)' : `✗ injected on ${staleHit} prompt(s)`}`);
  console.log('─'.repeat(76));
  console.log(ok ? '✓ PASS — both deterministic recall-safety guarantees held.' : '✗ FAIL — a recall-safety guarantee was violated.');
  process.exitCode = ok ? 0 : 1;
} finally {
  process.chdir(originalCwd);
  for (const key of ambientKeys) delete process.env[key];
  for (const [key, value] of ambientSnapshot) {
    if (value !== undefined) process.env[key] = value;
  }
  fs.rmSync(tempParent, { recursive: true, force: true });
}
