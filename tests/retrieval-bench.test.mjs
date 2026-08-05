// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// The retrieval-bench harness is the PUBLIC honesty artifact for the DEFAULT FTS5 engine: a
// deterministic, stranger-reproducible measurement of R@5 / R@10 / MRR + tokens-per-query on a
// labeled in-repo fixture. These tests pin that it (a) actually drives the default fts engine,
// (b) is deterministic across runs, and (c) reports the honest lexical shape (keyword strong,
// paraphrase weak) — so the published default-engine numbers cannot quietly drift or start lying.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runRetrievalBench, FIXTURE } from '../scripts/retrieval-bench.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'retrieval-bench.mjs');

test('retrieval-bench: runs the DEFAULT zero-dependency FTS5 engine (no cloud, no model)', async () => {
  const r = await runRetrievalBench();
  assert.equal(r.engine.id, 'fts', 'must measure the default fts engine');
  assert.equal(r.engine.cloud, false, 'default engine is local / no-cloud');
  assert.equal(r.engine.model, null, 'default engine uses no embedding model');
});

test('retrieval-bench: metrics are well-formed and within [0,1]; fixture scale is reported honestly', async () => {
  const r = await runRetrievalBench();
  for (const key of ['recall_at_5', 'recall_at_10', 'mrr']) {
    const v = r.metrics[key];
    assert.ok(Number.isFinite(v) && v >= 0 && v <= 1, `${key} must be a fraction in [0,1], got ${v}`);
  }
  assert.ok(r.metrics.tokens_per_query > 0, 'tokens-per-query must be positive');
  // R@10 >= R@5 always (a larger window can only recall at least as much).
  assert.ok(r.metrics.recall_at_10 >= r.metrics.recall_at_5, 'R@10 cannot be below R@5');
  // The fixture must honestly report its (modest, non-LongMemEval) scale.
  assert.equal(r.fixture.docs, FIXTURE.docs.length);
  assert.equal(r.fixture.queries, FIXTURE.queries.length);
  assert.match(r.fixture.source, /NOT LongMemEval/i, 'fixture source must disclose it is not LongMemEval_S');
});

test('retrieval-bench: deterministic — identical metrics across independent runs', async () => {
  const a = await runRetrievalBench();
  const b = await runRetrievalBench();
  assert.deepEqual(a.metrics, b.metrics, 'metrics must be identical run-to-run (deterministic)');
  assert.deepEqual(a.byKind, b.byKind, 'per-kind breakdown must be identical run-to-run');
});

test('retrieval-bench: reports the honest lexical shape — keyword strong, paraphrase is the weak floor', async () => {
  const r = await runRetrievalBench();
  // Exact / strong-keyword queries should recall their target on a lexical engine.
  assert.equal(r.byKind.keyword.hit10, r.byKind.keyword.n, 'every keyword query recalls its target within top-10');
  // The paraphrase battery exists and is genuinely harder for pure FTS5: at least one paraphrase
  // query MISSES (no shared surface tokens). If this ever becomes perfect on the default engine, the
  // fixture stopped being honest about lexical retrieval — fail loudly so someone re-checks.
  assert.ok(r.byKind.paraphrase.n >= 3, 'fixture must include a paraphrase battery');
  assert.ok(r.byKind.paraphrase.hit10 < r.byKind.paraphrase.n,
    'pure FTS5 is expected to miss at least one paraphrase query — that gap is the honest finding');
});

test('retrieval-bench: the CLI prints a scorecard with the four headline metrics', () => {
  const out = execFileSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.match(out, /DEFAULT zero-dependency FTS5 engine/);
  assert.match(out, /R@5\s*=/);
  assert.match(out, /R@10\s*=/);
  assert.match(out, /MRR\s*=/);
  assert.match(out, /tokens\/query\s*=/);
});
