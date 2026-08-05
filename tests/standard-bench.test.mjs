// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Standard-benchmark harness (LongMemEval oracle, MIT) — CI runs the VENDORED N=8 slice only (no network).
// Locks: (1) the download pin (sha256 + size) so a silent dataset swap is caught; (2) the adapter maps
// instances to our fixture shape with the official conventions — session-granularity docs from USER turns,
// abstention (_abs) instances skipped, gold = answer sessions with a has_answer user turn; (3) the harness
// runs end-to-end on the DEFAULT FTS5 engine (engine.id==='fts', cloud=false, model=null) and produces
// sane recall_any@k. The discriminating published figure comes from `--download` (full set); the slice is
// a smoke (tiny corpus → recall is trivially high and that is fine here).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  toFixture,
  loadInstances,
  isAbstention,
  ORACLE_SHA256,
  ORACLE_SIZE,
} from '../scripts/bench/longmemeval.mjs';
import { runStandardBench } from '../scripts/standard-bench.mjs';

const SLICE = fileURLToPath(new URL('./fixtures/longmemeval-slice-8.json', import.meta.url));

test('download pin is the verified oracle (sha256 + size) — a silent dataset swap is caught', () => {
  assert.equal(ORACLE_SIZE, 15388478);
  assert.match(ORACLE_SHA256, /^[0-9a-f]{64}$/);
  assert.equal(ORACLE_SHA256, '821a2034d219ab45846873dd14c14f12cfe7776e73527a483f9dac095d38620c');
});

test('adapter maps the vendored slice with official conventions (user-turn docs, abstention skipped, gold sessions)', async () => {
  const instances = await loadInstances(SLICE);
  assert.equal(instances.length, 8, 'vendored slice is N=8');
  const absCount = instances.filter(isAbstention).length;
  assert.ok(absCount >= 1, 'slice contains at least one abstention instance to exercise the skip');

  const fx = toFixture(instances);
  // abstention instances never become queries
  assert.equal(fx.meta.skippedAbstention, absCount);
  assert.equal(fx.queries.length, instances.length - absCount - fx.meta.skippedNoTarget);
  assert.ok(fx.queries.length >= 6, 'most non-abstention instances yield a query');

  // docs are session-granularity, ids are the (globally unique) session ids, text non-empty
  assert.ok(fx.docs.length >= fx.queries.length, 'at least one session-doc per query');
  for (const d of fx.docs) {
    assert.match(d.id, /answer/, 'oracle session ids contain "answer"');
    assert.ok(d.text.length > 0, 'doc text (concatenated user turns) is non-empty');
  }
  // every query's gold ids exist in the corpus, and at least one query is multi-gold (multi-session)
  const ids = new Set(fx.docs.map((d) => d.id));
  for (const q of fx.queries) {
    assert.ok(q.relevant.length >= 1 && q.relevant.every((r) => ids.has(r)), 'gold sessions are in the corpus');
    assert.ok(typeof q.kind === 'string' && q.kind, 'query kind = question_type');
  }
  assert.ok(fx.queries.some((q) => q.relevant.length >= 2), 'a multi-session query carries multiple gold sessions');
  assert.equal(fx.meta.granularity, 'session');
  assert.equal(fx.meta.metric, 'recall_any@k');
});

test('harness runs end-to-end on the DEFAULT FTS5 engine and reports sane recall_any@k', async () => {
  const { result, fixture } = await runStandardBench({ download: false, n: Infinity, json: true });
  // RED LINE: default zero-dependency engine, or the number is not a default-engine claim.
  assert.equal(result.engine.id, 'fts');
  assert.equal(result.engine.cloud, false);
  assert.equal(result.engine.model, null);

  const m = result.metrics;
  for (const v of [m.recall_at_5, m.recall_at_10, m.mrr]) {
    assert.ok(v >= 0 && v <= 1, `metric in [0,1]: ${v}`);
  }
  assert.ok(m.recall_at_10 >= m.recall_at_5, 'recall@10 >= recall@5');
  assert.equal(result.fixture.queries, fixture.queries.length);
  assert.ok(result.fixture.queries >= 6);
});
