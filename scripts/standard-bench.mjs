// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Standard retrieval benchmark on a PUBLIC dataset (LongMemEval oracle, MIT) run on the DEFAULT
// zero-dependency FTS5 engine — the "don't just trust our own hand-authored fixture" number. It reuses
// the SAME scorer as scripts/retrieval-bench.mjs (runRetrievalBench: a real write -> promote -> search
// on the default engine, recall_any@5 / @10 + MRR, with the engine.id==='fts' / cloud=false / model=null
// guards), only swapping the in-repo fixture for a LongMemEval-derived one.
//
//   node scripts/standard-bench.mjs                  # vendored N=8 slice (NO network), default engine
//   node scripts/standard-bench.mjs --download       # download + sha256-verify the full oracle, run ALL
//   node scripts/standard-bench.mjs --download --n 50  # first N instances (quick; biased if type-grouped)
//   node scripts/standard-bench.mjs --json
//
// Honest read: this is GLOBAL-corpus retrieval (find the gold evidence session among ALL sampled
// instances' sessions) — HARDER than the paper's per-instance oracle (where k > #docs makes recall
// trivially 1.0). Recall@k is recall_any@k (the official reading). MRR is OUR metric — LongMemEval
// reports NDCG, not MRR — so MRR here is not directly comparable to published tables.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRetrievalBench } from './retrieval-bench.mjs';
import { toFixture, loadInstances, downloadOracle } from './bench/longmemeval.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SLICE = path.join(HERE, '..', 'tests', 'fixtures', 'longmemeval-slice-8.json');
const CACHE = path.join(HERE, 'bench', '.cache', 'longmemeval_oracle.json');

function parseArgs(argv) {
  const json = argv.includes('--json');
  const download = argv.includes('--download');
  const nIdx = argv.indexOf('--n');
  // Default: ALL instances (an unbiased number). --n takes the FIRST N — quick, but the oracle file is
  // grouped by question_type, so a small --n samples one type. Use the full run for the headline figure.
  const n = nIdx >= 0 ? Number(argv[nIdx + 1]) : Infinity;
  if (nIdx >= 0 && (!Number.isFinite(n) || n <= 0)) throw new Error('--n needs a positive integer');
  return { json, download, n };
}

async function loadFixture({ download, n }) {
  if (download) {
    const dl = await downloadOracle(CACHE);
    const instances = await loadInstances(dl.path);
    const label = `LongMemEval-oracle (full set, ${dl.cached ? 'cached' : 'downloaded + sha256-verified'}; pinned)`;
    return toFixture(instances, { limit: n, source: label });
  }
  const instances = await loadInstances(SLICE);
  return toFixture(instances, { limit: n, source: 'LongMemEval-oracle vendored N=8 slice (MIT, arXiv:2410.10813)' });
}

export async function runStandardBench(opts) {
  const fixture = await loadFixture(opts);
  if (fixture.queries.length === 0) throw new Error('no usable queries (every instance was abstention / no-target)');
  const result = await runRetrievalBench({ fixture });
  // RED LINE: this MUST be the default zero-dependency engine, or the number is meaningless as a default
  // claim. runRetrievalBench already guards internally; we re-assert here so a future refactor can't slip.
  if (result.engine.id !== 'fts' || result.engine.cloud !== false || result.engine.model !== null) {
    throw new Error(`refusing to report: not the default FTS5 engine — ${JSON.stringify(result.engine)}`);
  }
  return { result, fixture };
}

function render({ result, fixture }) {
  const m = result.metrics;
  const lines = [];
  lines.push('iHow Memory — STANDARD retrieval benchmark · LongMemEval (oracle, MIT) · DEFAULT FTS5 engine');
  lines.push('(deterministic · local · no cloud / no LLM / no third-party deps — re-run for the same numbers)');
  lines.push('─'.repeat(92));
  lines.push(`engine:   ${result.engine.id}  (cloud=${result.engine.cloud}, model=${result.engine.model})`);
  lines.push(`dataset:  ${fixture.source}`);
  lines.push(
    `mapping:  ${fixture.meta.granularity}-granularity · ${fixture.meta.corpus} corpus · ${fixture.meta.metric}` +
      `  (harder than per-instance oracle)`,
  );
  lines.push(
    `sampled:  ${fixture.meta.instances} instances → ${result.fixture.queries} queries · ${result.fixture.docs} session-docs` +
      `  (skipped: ${fixture.meta.skippedAbstention} abstention, ${fixture.meta.skippedNoTarget} no-target)`,
  );
  lines.push('');
  lines.push(`Recall@5  = ${m.recall_at_5.toFixed(3)}     Recall@10 = ${m.recall_at_10.toFixed(3)}`);
  lines.push(`MRR       = ${m.mrr.toFixed(3)}     tokens/query = ${m.tokens_per_query.toFixed(1)}`);
  lines.push('');
  lines.push('by question type (recall_any@5 / @10):');
  for (const [kind, k] of Object.entries(result.byKind).sort()) {
    lines.push(`  ${kind.padEnd(26)} ${k.hit5}/${k.n}  ·  ${k.hit10}/${k.n}`);
  }
  lines.push('─'.repeat(92));
  lines.push('Honest read: recall_any@k on a GLOBAL corpus of real LongMemEval sessions, DEFAULT lexical');
  lines.push('FTS5. Paraphrase / temporal-reasoning questions (little surface overlap with the evidence) are');
  lines.push('where pure lexical misses — a gap the OPTIONAL semantic provider is intended to address, but');
  lines.push('only a positive measured delta supports a lift claim. MRR is our own metric (LongMemEval reports');
  lines.push('NDCG), so it is not directly comparable to the paper tables.');
  lines.push('─'.repeat(92));
  return lines.join('\n');
}

// Run as a script (not when imported by the test).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opts = parseArgs(process.argv.slice(2));
  runStandardBench(opts)
    .then(({ result, fixture }) => {
      if (opts.json) console.log(JSON.stringify({ ...result, longmemeval: fixture.meta }, null, 2));
      else console.log(render({ result, fixture }));
    })
    .catch((e) => {
      console.error(e?.message || e);
      process.exitCode = 1;
    });
}
