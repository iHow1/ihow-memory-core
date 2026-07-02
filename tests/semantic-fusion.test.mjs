// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// alpha.16 semantic recall floor — the LOAD-BEARING invariant: the optional vector lane may only change
// RANKING, never recall-ELIGIBILITY. These lock it at the fusion boundary (fuseRrf is a pure function) so
// a future change can't silently let a vector hit smuggle in a result neither lane surfaced, and confirm
// the default zero-dependency binary stays lexical (no semantic engine constructed).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fuseRrf, isSemanticSourced, semanticRecallFloor } from '../src/engine/retrieval.ts';
import { openCore } from '../src/core.ts';

const hit = (p, snippet = p) => ({ path: p, score: 1, snippet, citation: { path: p, snippet } });

test('fusion is UNION-ONLY: no fused result is absent from both lanes (eligibility never expands)', () => {
  const fts = [hit('a'), hit('b')];
  const vec = [hit('c'), hit('d')];
  const fused = fuseRrf(fts, vec, 10).map((h) => h.path);
  const union = new Set(['a', 'b', 'c', 'd']);
  assert.ok(fused.every((p) => union.has(p)), 'every fused path was surfaced by FTS or vector — fusion adds nothing');
  // a path NEITHER lane returned can never appear
  assert.ok(!fused.includes('zzz'), 'a result no lane surfaced is never invented by fusion');
});

test('fusion is ADDITIVE: a doc only the vector lane surfaced still appears (paraphrase recall)', () => {
  const fts = [hit('a'), hit('b')];
  const vec = [hit('paraphrase-only')];
  const fused = fuseRrf(fts, vec, 10).map((h) => h.path);
  assert.ok(fused.includes('paraphrase-only'), 'vector-only hit (the synonym/paraphrase win) is included');
});

test('fusion RE-ORDERS: a doc ranked low by FTS but high by vector moves up', () => {
  // c is LAST in FTS but FIRST in vector → fused rank of c should beat its FTS-only rank.
  const fts = [hit('a'), hit('b'), hit('c')];
  const vec = [hit('c'), hit('x'), hit('y')];
  const fused = fuseRrf(fts, vec, 10).map((h) => h.path);
  assert.ok(fused.indexOf('c') < 2, 'c (low in FTS, high in vector) is pulled up by RRF');
});

test('fusion keeps the FTS-lane canonical shape on shared paths (audited lexical record wins ties)', () => {
  const fts = [hit('a', 'FTS-SNIPPET')];
  const vec = [hit('a', 'VECTOR-SNIPPET')];
  const fused = fuseRrf(fts, vec, 10);
  const a = fused.find((h) => h.path === 'a');
  assert.equal(a.snippet, 'FTS-SNIPPET', 'the always-on FTS lane owns the citation/snippet, not the vector lane');
});

test('default binary stays LEXICAL: no semantic engine is constructed without an opt-in provider', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-sem-')));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const core = await openCore({ root, space: 'semtest' }); // default engine — no provider requested
  const status = await core.status();
  assert.equal(status.provider.id, 'fts', 'default provider is the zero-dependency FTS lane');
  assert.equal(status.provider.model, null, 'no embedding model is loaded by default');
  // and search still works end-to-end on the lexical floor
  const j = await core.journal({ text: 'kafka consumer lag spike during the deploy window', sourceAgent: 't' });
  const hits = await core.search('kafka consumer lag deploy', { limit: 5 });
  assert.ok(hits.some((h) => h.path === j.path), 'lexical search returns the entry — the FTS floor is fully functional alone');
});

// --- C3: lane detection + cosine preservation + the per-model measured floor — the three pieces that
// make the recall lexical-gate bypass fail-closed. ---
test('isSemanticSourced: fail-closed — only vector/semantic sources qualify', () => {
  assert.ok(isSemanticSourced({ source: 'vector-gguf' }), 'the bundled sidecar id qualifies');
  assert.ok(isSemanticSourced({ source: 'vector' }), 'bare vector qualifies');
  assert.ok(isSemanticSourced({ source: 'semantic' }), 'semantic qualifies');
  assert.ok(isSemanticSourced({ source: 'Vector-GGUF' }), 'case-insensitive');
  assert.ok(!isSemanticSourced({ source: 'fts' }), 'the lexical lane does NOT qualify');
  assert.ok(!isSemanticSourced({}), 'a missing source does NOT qualify (fail-closed)');
  assert.ok(!isSemanticSourced(null), 'null hit does NOT qualify');
  assert.ok(!isSemanticSourced(undefined), 'undefined hit does NOT qualify');
  assert.ok(!isSemanticSourced({ source: 'lexical-ish' }), 'an unknown source does NOT qualify');
  assert.ok(!isSemanticSourced({ source: 42 }), 'a non-string source does NOT qualify');
});

test('fuseRrf preserves the semantic cosine as semanticScore — including on a path BOTH lanes surfaced', () => {
  const fts = [{ ...hit('shared'), source: 'fts' }, { ...hit('fts-only'), source: 'fts' }];
  const vec = [{ ...hit('shared'), score: 0.71, source: 'vector-gguf' }, { ...hit('sem-only'), score: 0.66, source: 'vector-gguf' }];
  const fused = fuseRrf(fts, vec, 10);
  const shared = fused.find((h) => h.path === 'shared');
  const semOnly = fused.find((h) => h.path === 'sem-only');
  const ftsOnly = fused.find((h) => h.path === 'fts-only');
  assert.equal(shared.source, 'fts', 'the FTS representation still wins the shared path (audited lexical record)');
  assert.equal(shared.semanticScore, 0.71, '…but the semantic cosine survives as semanticScore (evidence not erased)');
  assert.equal(semOnly.semanticScore, 0.66, 'a vector-only path carries its cosine');
  assert.notEqual(semOnly.score, 0.66, 'the fused rank score REPLACED hit.score — semanticScore is the only cosine left');
  assert.equal(ftsOnly.semanticScore, undefined, 'an FTS-only path never gains semantic evidence');
});

test('fuseRrf: a mislabeled vector-lane hit (source fts/unknown) stamps NO semanticScore (fail-closed)', () => {
  const fused = fuseRrf([], [{ ...hit('a'), score: 0.9, source: 'fts' }, { ...hit('b'), score: 0.9, source: 'weird' }], 10);
  assert.ok(fused.every((h) => h.semanticScore === undefined), 'only a semantic-sourced lane may stamp evidence');
});

test('semanticRecallFloor: measured models only; env override wins; unmeasured models fail closed', () => {
  assert.equal(semanticRecallFloor('bge-m3'), 0.58, 'bge-m3 is calibrated at 0.58 (18 pos / 144 neg ZH pairs: 0 leaks, 15/18 rescued)');
  assert.equal(semanticRecallFloor('bge-m3:latest'), 0.58, 'tag suffix still matches the family');
  assert.equal(semanticRecallFloor('nomic-embed-text'), null, 'nomic measured NON-separating on short CJK → bypass disabled');
  assert.equal(semanticRecallFloor('some-future-model'), null, 'unmeasured model → disabled (fail-closed)');
  assert.equal(semanticRecallFloor(null), null, 'no model → disabled');
  const prev = process.env.IHOW_RECALL_SEMANTIC_MIN;
  try {
    process.env.IHOW_RECALL_SEMANTIC_MIN = '0.42';
    assert.equal(semanticRecallFloor('some-future-model'), 0.42, 'an explicit local calibration beats the table');
    process.env.IHOW_RECALL_SEMANTIC_MIN = 'not-a-number';
    assert.equal(semanticRecallFloor('bge-m3'), 0.58, 'a malformed override is ignored, the table stands');
  } finally {
    if (prev === undefined) delete process.env.IHOW_RECALL_SEMANTIC_MIN;
    else process.env.IHOW_RECALL_SEMANTIC_MIN = prev;
  }
});
