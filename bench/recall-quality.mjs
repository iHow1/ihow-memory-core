// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Recall quality evidence — seeds a realistic curated memory mix and runs the ACTUAL recall hook over a
// ground-truth-labeled prompt corpus, in both modes (reviewed-only default; --include-auto). Run it:
//
//     node bench/recall-quality.mjs
//
// It asserts the DETERMINISTIC SAFETY guarantees that anyone can reproduce (these gate the exit code):
//   • off-topic prompts inject NOTHING (the relevance gate)
//   • a stale / superseded entry is NEVER injected next to its current version (recency/dedup)
// and reports the injection rates + the reviewed-vs-auto delta. The "signal vs noise" usefulness split
// (reviewed ~88% / auto ~25%, in docs/verify-benchmark.md §2.2) is judged by an LLM panel — not rerun
// here, because it is not deterministic; the safety guarantees below are.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'src', 'cli.ts');
const NODE_ARGS = ['--experimental-strip-types', CLI];
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'recall-bench-')));
const space = 'h';
const cli = (args) => execFileSync(process.execPath, [...NODE_ARGS, ...args, '--root', root, '--space', space], { encoding: 'utf8' });
const recall = (prompt, env = {}) => spawnSync(process.execPath, [...NODE_ARGS, 'hook-user-prompt-submit', '--root', root, '--space', space], {
  input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt, cwd: root }), encoding: 'utf8', env: { ...process.env, ...env },
}).stdout;

// reviewed (human-promoted) memory
for (const [text, scope] of [
  ['Decision: adopt cursor-based pagination for the feed endpoint; offset drifts on inserts.', 'pagination'],
  ['Auth tokens expire after 15 minutes in staging.', 'auth'],
  ['Postgres timestamptz stores UTC internally; always convert at the application edge.', 'postgres'],
  ['We switched the message queue from Redis to SQS for at-least-once delivery.', 'queue'],
  ['Update: the vendor API now rate-limits at 500 requests per minute (raised from the old limit).', 'ratelimit-current'],
  ['The mobile app uses a 380px design breakpoint for the compact layout.', 'mobile'],
]) {
  const cand = JSON.parse(cli(['write-candidate', text])).path;
  cli(['promote', cand, '--scope', scope, '--title', scope]);
}
// a SUPERSEDED reviewed memory (stale) — must be dropped by recency, never injected
{
  const cand = JSON.parse(cli(['write-candidate', 'The vendor API rate-limits at 100 requests per minute per key.'])).path;
  cli(['promote', cand, '--scope', 'ratelimit-stale', '--title', 'ratelimit old']);
}
// auto-promoted memory (reviewed:false + provenance), mostly ephemeral status
const autoDir = path.join(root, space, 'memory', 'scopes', 'general');
fs.mkdirSync(autoDir, { recursive: true });
for (const [id, text, command] of [
  ['A1', 'All 178 of 178 unit tests pass on the current build.', 'npm test'],
  ['A2', 'The bundle size dropped to 142kb after tree-shaking the pagination module.', 'npm run build'],
  ['A3', 'CI now runs tsc --noEmit as a typecheck gate before merge.', 'npm run typecheck'],
  ['A4', 'Migrated the build pipeline from TypeScript transpile to a single Rust binary.', 'cargo build'],
]) {
  fs.writeFileSync(path.join(autoDir, `${id}.md`), [
    '---', `candidate_id: "${id}"`, 'status: "promoted"', 'type: "memory"', 'source_agent: "agent-auto"',
    'promoted_at: "2026-06-26T00:00:00Z"', 'tier: "auto-promoted"', 'reviewed: false', `command: "${command}"`, 'exitCode: 0', '---', '', text, '',
  ].join('\n'));
}
cli(['reindex']);

// ground-truth-labeled prompts: expect a specific memory, or 'nothing' (off-topic), or 'maybe' (adjacent)
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
  let ctx; try { ctx = JSON.parse(out).hookSpecificOutput.additionalContext; } catch { return []; }
  return ctx.split('\n').filter((l) => l.startsWith('- ['));
};

let firedRO = 0, firedIA = 0, offNoise = 0, staleHit = 0, autoDelta = 0;
for (const [, prompt, expect] of prompts) {
  const ro = inject(recall(prompt));
  const ia = inject(recall(prompt, { IHOW_RECALL_INCLUDE_AUTO: '1' }));
  if (ro.length) firedRO++;
  if (ia.length) firedIA++;
  autoDelta += Math.max(0, ia.length - ro.length);
  if (expect === 'nothing' && (ro.length || ia.length)) offNoise++;
  if ([...ro, ...ia].some((l) => /100 requests per minute/.test(l))) staleHit++;
}
const n = prompts.length;

console.log('iHow Memory — recall quality (deterministic safety guarantees; re-run to reproduce)');
console.log('─'.repeat(76));
console.log(`injection rate:   reviewed-only ${firedRO}/${n} (${Math.round(firedRO / n * 100)}%)   ·   include-auto ${firedIA}/${n} (${Math.round(firedIA / n * 100)}%)`);
console.log(`auto tier adds:   +${autoDelta} items across the corpus (mostly ephemeral status — judged ~25% useful, hence opt-in)`);
console.log('');
const off = prompts.filter((p) => p[2] === 'nothing').length;
console.log(`SAFETY ① off-topic prompts inject nothing:   ${offNoise === 0 ? `✓ 0/${off} noisy` : `✗ ${offNoise}/${off} leaked`}`);
console.log(`SAFETY ② stale "100 req/min" never injected:  ${staleHit === 0 ? '✓ held (recency/dedup)' : `✗ injected on ${staleHit} prompt(s)`}`);
console.log('');
console.log('Note: the reviewed ~88% / auto ~25% "useful vs noise" split is LLM-judged (see docs/verify-benchmark.md §2.2),');
console.log('      not deterministic, so it is not rerun here. The two SAFETY guarantees above are deterministic and gate this exit.');

fs.rmSync(root, { recursive: true, force: true });
const ok = offNoise === 0 && staleHit === 0;
console.log('─'.repeat(76));
console.log(ok ? '✓ PASS — both deterministic recall-safety guarantees held.' : '✗ FAIL — a recall-safety guarantee was violated.');
process.exitCode = ok ? 0 : 1;
