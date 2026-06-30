// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// The semantic-lane COMPARISON harness is the honesty artifact for the claim "the optional vector lane
// actually lifts the paraphrase/synonym recall that pure FTS5 misses." These tests pin it on the
// DETERMINISTIC, OFFLINE path: the controlled synonym-oracle sidecar (no Ollama, no model, no network),
// which proves the ARCHITECTURE — when a semantic lane genuinely captures a synonym relation, RRF
// fusion pulls the matching doc into top-K. They also pin the load-bearing HONESTY guards:
//   - the proofKind label is required and echoed (architecture-proof can never masquerade as a model
//     benchmark);
//   - if the provider never ran (fallback), `ran:false` and no gain is claimed;
//   - keyword/partial recall is NOT degraded by adding the lane (fusion is additive, not destructive).
// The REAL-MODEL number (ollama + nomic-embed-text) is intentionally NOT asserted here — it depends on
// a running local service and is documented/reproduced via the CLI, not the test suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSemanticComparison } from '../scripts/retrieval-bench.mjs';

const EXAMPLES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples');
const ORACLE_CMD = `node ${path.join(EXAMPLES, 'synonym-oracle-provider.mjs')}`;

test('semantic comparison: refuses to run without an honest proofKind label', async () => {
  await assert.rejects(
    () => runSemanticComparison({ vectorProviderCommand: ORACLE_CMD }),
    /proofKind must be/,
    'an unlabeled comparison (no real-model vs architecture-proof) must be rejected',
  );
  await assert.rejects(
    () => runSemanticComparison({ vectorProviderCommand: ORACLE_CMD, proofKind: 'totally-real-trust-me' }),
    /proofKind must be/,
    'a bogus proofKind must be rejected',
  );
});

test('semantic comparison: requires a provider command', async () => {
  await assert.rejects(
    () => runSemanticComparison({ proofKind: 'architecture-proof' }),
    /vectorProviderCommand is required/,
  );
});

test('ARCHITECTURE PROOF: the synonym-oracle lane lifts paraphrase recall via RRF (2/5 → 5/5)', async () => {
  const cmp = await runSemanticComparison({
    vectorProviderCommand: ORACLE_CMD,
    vectorModel: 'synonym-oracle-architecture-proof',
    proofKind: 'architecture-proof',
  });

  // The lane actually ran (semantic engine active, not a silent FTS fallback).
  assert.equal(cmp.ran, true, 'the oracle sidecar must actually run (semantic engine active)');
  assert.equal(cmp.proofKind, 'architecture-proof', 'the honesty label must be echoed back verbatim');
  assert.equal(cmp.semanticEngine.id, 'vector-gguf');

  // The FTS floor is the documented one: paraphrase 2/5.
  assert.equal(cmp.fts.byKind.paraphrase.hit5, 2, 'baseline FTS paraphrase recall@5 is the documented 2/5 floor');
  assert.equal(cmp.fts.byKind.paraphrase.n, 5);

  // THE PROOF: with the semantic lane fused in, every paraphrase query is recalled.
  assert.equal(cmp.fused.byKind.paraphrase.hit5, 5, 'fused paraphrase recall@5 reaches 5/5 — RRF pulled the synonym docs into top-K');
  assert.equal(cmp.paraphrase.delta_hit5, 3, 'the paraphrase delta is +3 (the three FTS-missed synonym queries)');
  assert.ok(cmp.delta.recall_at_5 > 0, 'overall recall@5 strictly improves');
});

test('ARCHITECTURE PROOF: adding the lane does NOT degrade keyword/partial recall (fusion is additive)', async () => {
  const cmp = await runSemanticComparison({
    vectorProviderCommand: ORACLE_CMD,
    proofKind: 'architecture-proof',
  });
  // The always-on FTS floor is preserved: strong-lexical queries keep recalling at top-5.
  assert.ok(cmp.byKindDelta.keyword.delta_hit5 >= 0, 'keyword recall@5 is never reduced by adding the semantic lane');
  assert.ok(cmp.byKindDelta.partial.delta_hit5 >= 0, 'partial recall@5 is never reduced by adding the semantic lane');
  assert.equal(cmp.fused.byKind.keyword.hit5, cmp.fts.byKind.keyword.hit5, 'keyword recall is identical (FTS already nailed it)');
});

test('HONESTY GUARD: a provider that falls back to FTS reports ran:false and claims no gain', async () => {
  // A command that exits non-zero / never returns a ready vector engine → the engine falls back to FTS.
  // The comparison must DETECT that and refuse to dress up the (identical) numbers as a semantic gain.
  const cmp = await runSemanticComparison({
    vectorProviderCommand: 'node -e "process.exit(1)"',
    proofKind: 'real-model',
    vectorTimeoutMs: 2000,
  });
  assert.equal(cmp.ran, false, 'a non-running provider must surface ran:false (no fake gain)');
  // and the would-be deltas, if anyone reads them, are zero — the two runs were the same FTS floor.
  assert.equal(cmp.delta.recall_at_5, 0, 'a fallback run shows zero delta — there is nothing to claim');
  assert.equal(cmp.paraphrase.delta_hit5, 0, 'paraphrase recall is unchanged when the lane never ran');
});
