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
//   - neutral measured lift, real-model quality evidence, and architecture-proof success are separate;
//   - running zero/negative lanes never receive positive prose, regardless of proof kind;
//   - keyword/partial recall is NOT degraded by adding the lane (fusion is additive, not destructive).
// A live REAL-MODEL run (ollama + nomic-embed-text) is intentionally NOT asserted here — it depends on
// a running local service. A deterministic ready-provider double pins ran:true + zero-delta behavior.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderComparison, runSemanticComparison } from '../scripts/retrieval-bench.mjs';

const EXAMPLES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples');
const ORACLE_CMD = `node ${path.join(EXAMPLES, 'synonym-oracle-provider.mjs')}`;
const ZERO_DELTA_CMD = `node ${path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ready-zero-delta-provider.mjs')}`;
const NEGATIVE_DELTA_CMD = `node ${path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ready-negative-delta-provider.mjs')}`;

// Purpose-built fusion-regression fixture. The target is inserted first and all six documents have
// the same lexical match, so FTS recalls it in top-5. The negative provider boosts only the five wrong
// documents; deterministic RRF then moves the target to rank 6. `kind: paraphrase` selects the claim-
// honesty metric bucket — this synthetic ranking fixture is not presented as a linguistic benchmark.
const NEGATIVE_DELTA_FIXTURE = {
  source: 'deterministic semantic claim-honesty negative-delta fixture',
  docs: [
    { id: 'target', text: 'shared collision marker target evidence' },
    { id: 'wrong_1', text: 'shared collision marker wrong evidence one' },
    { id: 'wrong_2', text: 'shared collision marker wrong evidence two' },
    { id: 'wrong_3', text: 'shared collision marker wrong evidence three' },
    { id: 'wrong_4', text: 'shared collision marker wrong evidence four' },
    { id: 'wrong_5', text: 'shared collision marker wrong evidence five' },
  ],
  queries: [
    { q: 'shared collision marker', relevant: ['target'], kind: 'paraphrase' },
  ],
};

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
  assert.equal(cmp.observedParaphraseLift, true, 'the neutral observed-delta field records positive paraphrase lift');
  assert.equal(cmp.architectureProofPassed, true, 'positive architecture-oracle delta passes the wiring proof');
  assert.equal(cmp.observedQualityLift, false, 'architecture proof can never masquerade as learned-model quality evidence');
  assert.ok(cmp.delta.recall_at_5 > 0, 'overall recall@5 strictly improves');
  const output = renderComparison(cmp);
  assert.match(output, /pulls the true-synonym doc/i);
  assert.match(output, /proves wiring only/i);
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
  assert.equal(cmp.observedParaphraseLift, false, 'fallback cannot establish a measured paraphrase lift');
  assert.equal(cmp.observedQualityLift, false, 'fallback can never count as observed quality lift');
  assert.equal(cmp.architectureProofPassed, false, 'a real-model fallback cannot pass architecture proof');
  // and the would-be deltas, if anyone reads them, are zero — the two runs were the same FTS floor.
  assert.equal(cmp.delta.recall_at_5, 0, 'a fallback run shows zero delta — there is nothing to claim');
  assert.equal(cmp.paraphrase.delta_hit5, 0, 'paraphrase recall is unchanged when the lane never ran');
});

test('HONESTY GUARD: a real-model lane can run with zero delta without a false quality claim', async () => {
  // This deterministic provider double is ready, indexes successfully, and returns no semantic hits.
  // It exercises the real-model claim branch without Ollama/network/model downloads.
  const cmp = await runSemanticComparison({
    vectorProviderCommand: ZERO_DELTA_CMD,
    vectorModel: 'deterministic-zero-delta-model',
    proofKind: 'real-model',
  });

  assert.equal(cmp.ran, true, 'the provider is ready/running rather than a fallback');
  assert.equal(cmp.semanticEngine.fallback, false);
  assert.equal(cmp.paraphrase.delta_hit5, 0, 'the running lane produces no paraphrase improvement');
  assert.equal(cmp.observedParaphraseLift, false, 'zero delta is not a neutral observed lift');
  assert.equal(cmp.observedQualityLift, false, 'zero paraphrase delta must be false');
  assert.equal(cmp.architectureProofPassed, false, 'real-model output cannot pass architecture proof');
  const output = renderComparison(cmp);
  assert.match(output, /no observed lift/i);
  assert.doesNotMatch(output, /quality gain|recovers paraphrase/i);
});

test('HONESTY GUARD: a real-model lane with negative delta reports no quality lift', async () => {
  const cmp = await runSemanticComparison({
    fixture: NEGATIVE_DELTA_FIXTURE,
    vectorProviderCommand: NEGATIVE_DELTA_CMD,
    vectorModel: 'deterministic-negative-delta-model',
    proofKind: 'real-model',
  });

  assert.equal(cmp.ran, true);
  assert.equal(cmp.paraphrase.delta_hit5, -1, 'the running lane deterministically moves the target below top-5');
  assert.equal(cmp.observedParaphraseLift, false, 'negative delta is not observed lift');
  assert.equal(cmp.observedQualityLift, false, 'negative real-model delta cannot become quality evidence');
  assert.equal(cmp.architectureProofPassed, false, 'real-model output cannot pass architecture proof');
  const output = renderComparison(cmp);
  assert.match(output, /no observed lift/i);
  assert.doesNotMatch(output, /quality gain|recovers paraphrase/i);
});

test('HONESTY GUARD: an architecture-proof lane with zero delta does not claim proof success', async () => {
  const cmp = await runSemanticComparison({
    vectorProviderCommand: ZERO_DELTA_CMD,
    vectorModel: 'deterministic-zero-delta-architecture',
    proofKind: 'architecture-proof',
  });

  assert.equal(cmp.ran, true);
  assert.equal(cmp.paraphrase.delta_hit5, 0);
  assert.equal(cmp.observedParaphraseLift, false);
  assert.equal(cmp.observedQualityLift, false, 'architecture output is never learned-model quality evidence');
  assert.equal(cmp.architectureProofPassed, false, 'zero architecture delta does not pass the wiring proof');
  const output = renderComparison(cmp);
  assert.match(output, /no observed architecture lift/i);
  assert.doesNotMatch(output, /pulls the true-synonym doc|proves wiring only/i);
});

test('HONESTY GUARD: an architecture-proof lane with negative delta does not claim proof success', async () => {
  const cmp = await runSemanticComparison({
    fixture: NEGATIVE_DELTA_FIXTURE,
    vectorProviderCommand: NEGATIVE_DELTA_CMD,
    vectorModel: 'deterministic-negative-delta-architecture',
    proofKind: 'architecture-proof',
  });

  assert.equal(cmp.ran, true);
  assert.equal(cmp.paraphrase.delta_hit5, -1);
  assert.equal(cmp.observedParaphraseLift, false);
  assert.equal(cmp.observedQualityLift, false, 'architecture output is never learned-model quality evidence');
  assert.equal(cmp.architectureProofPassed, false, 'negative architecture delta does not pass the wiring proof');
  const output = renderComparison(cmp);
  assert.match(output, /no observed architecture lift/i);
  assert.doesNotMatch(output, /pulls the true-synonym doc|proves wiring only/i);
});
