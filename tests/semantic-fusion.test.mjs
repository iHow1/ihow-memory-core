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
import { fuseRrf, isSemanticSourced, orderSupersededHits, semanticRecallFloor } from '../src/engine/retrieval.ts';
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

test('fuseRrf weights only the recognized semantic lane at frozen 1.25: vector-only rank3 enters top5', () => {
  const fts = ['f1', 'f2', 'f3', 'f4', 'f5'].map((p) => ({ ...hit(p), source: 'fts' }));
  const vec = ['v1', 'v2', 'semantic-rank3'].map((p, i) => ({ ...hit(p), score: 0.9 - i * 0.01, source: 'vector-gguf' }));
  assert.deepEqual(fuseRrf(fts, vec, 5).map((h) => h.path), ['v1', 'v2', 'semantic-rank3', 'f1', 'f2']);

  const mislabeled = vec.map((h) => ({ ...h, source: 'unknown' }));
  assert.deepEqual(fuseRrf(fts, mislabeled, 5).map((h) => h.path), ['f1', 'v1', 'f2', 'v2', 'f3']);
  assert.ok(fuseRrf(fts, mislabeled, 10).every((h) => h.semanticScore === undefined));
});

async function writeDoc(spaceDir, rel, frontmatter, body = 'body') {
  const abs = path.join(spaceDir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, `---\n${frontmatter}\n---\n\n${body}`);
}

test('orderSupersededHits moves an existing current document immediately before its stale document, stably', async (t) => {
  const spaceDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-supersession-')));
  t.after(() => fs.rm(spaceDir, { recursive: true, force: true }));
  await writeDoc(spaceDir, 'memory/stale.md', 'document_id: stale\nsuperseded_by: current');
  await writeDoc(spaceDir, 'memory/current.md', 'document_id: current');
  await writeDoc(spaceDir, 'memory/unrelated.md', 'document_id: unrelated');
  const hits = [hit('memory/stale.md'), hit('memory/unrelated.md'), hit('memory/current.md')];
  const ordered = await orderSupersededHits({ spaceDir }, hits, 3);
  assert.deepEqual(ordered.map((h) => h.path), ['memory/current.md', 'memory/stale.md', 'memory/unrelated.md']);
  assert.deepEqual(new Set(ordered), new Set(hits), 'no hit is introduced, removed, cloned, or mutated');
});

test('orderSupersededHits never demotes a current document that already ranks before stale', async (t) => {
  const spaceDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-supersession-current-first-')));
  t.after(() => fs.rm(spaceDir, { recursive: true, force: true }));
  await writeDoc(spaceDir, 'memory/current.md', 'document_id: current');
  await writeDoc(spaceDir, 'memory/stale.md', 'document_id: stale\nsuperseded_by: current');
  for (let i = 0; i < 8; i++) await writeDoc(spaceDir, `memory/unrelated-${i}.md`, `document_id: unrelated-${i}`);

  const current = hit('memory/current.md');
  const stale = hit('memory/stale.md');
  const unrelated = Array.from({ length: 8 }, (_, i) => hit(`memory/unrelated-${i}.md`));
  for (const original of [
    [current, unrelated[0], stale],
    [current, ...unrelated, stale],
    [current, stale, ...unrelated],
  ]) {
    const before = [...original];
    const ordered = await orderSupersededHits({ spaceDir }, original, original.length);
    assert.deepEqual(ordered, before, 'rank and object order must remain byte-for-byte/object-order identical');
    assert.deepEqual(original, before, 'input order must not be mutated');
  }
});

test('orderSupersededHits fails open on malformed/duplicate/self/cycle metadata and unsafe paths', async (t) => {
  const spaceDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-supersession-bad-')));
  t.after(() => fs.rm(spaceDir, { recursive: true, force: true }));
  await writeDoc(spaceDir, 'memory/a.md', 'document_id: a\nsuperseded_by: b');
  await writeDoc(spaceDir, 'memory/b.md', 'document_id: b\nsuperseded_by: a');
  const cyclic = [hit('memory/a.md'), hit('memory/b.md')];
  assert.deepEqual(await orderSupersededHits({ spaceDir }, cyclic, 2), cyclic);

  await writeDoc(spaceDir, 'memory/dup1.md', 'document_id: duplicate');
  await writeDoc(spaceDir, 'memory/dup2.md', 'document_id: duplicate');
  const duplicate = [hit('memory/dup1.md'), hit('memory/dup2.md')];
  assert.deepEqual(await orderSupersededHits({ spaceDir }, duplicate, 2), duplicate);

  await writeDoc(spaceDir, 'memory/self.md', 'document_id: self\nsuperseded_by: self');
  const self = [hit('memory/self.md')];
  assert.deepEqual(await orderSupersededHits({ spaceDir }, self, 1), self);

  const outside = path.join(spaceDir, '..', `ihow-supersession-outside-${path.basename(spaceDir)}.md`);
  await fs.writeFile(outside, '---\ndocument_id: outside\n---\n');
  t.after(() => fs.rm(outside, { force: true }));
  await fs.mkdir(path.join(spaceDir, 'memory', 'links'), { recursive: true });
  await fs.symlink(outside, path.join(spaceDir, 'memory', 'links', 'escape.md'));
  const symlinkEscape = [hit('memory/links/escape.md')];
  assert.deepEqual(await orderSupersededHits({ spaceDir }, symlinkEscape, 1), symlinkEscape);

  await fs.mkdir(path.join(spaceDir, 'memory', 'oversized'), { recursive: true });
  await fs.writeFile(
    path.join(spaceDir, 'memory', 'oversized', 'open.md'),
    `---\ndocument_id: oversized\n${'x'.repeat(17 * 1024)}`,
  );
  const oversized = [hit('memory/oversized/open.md')];
  assert.deepEqual(await orderSupersededHits({ spaceDir }, oversized, 1), oversized);

  const unsafe = [hit('../escape.md'), hit('/absolute.md'), hit('memory/missing.md')];
  assert.deepEqual(await orderSupersededHits({ spaceDir }, unsafe, 3), unsafe);
});

test('orderSupersededHits accepts only an exact frontmatter closing delimiter line', async (t) => {
  const spaceDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-supersession-delimiter-')));
  t.after(() => fs.rm(spaceDir, { recursive: true, force: true }));
  const current = hit('memory/current.md');
  await writeDoc(spaceDir, current.path, 'document_id: current');

  const malformedClosers = [
    '---invalid\n',
    '--- #comment\n',
    '--- trailing-characters\n',
    '---invalid\r\n',
    '--- #comment\r\n',
    '--- trailing-characters\r\n',
  ];
  for (const [index, closer] of malformedClosers.entries()) {
    const stale = hit(`memory/stale-${index}.md`);
    await fs.writeFile(
      path.join(spaceDir, stale.path),
      `---\r\ndocument_id: stale-${index}\r\nsuperseded_by: current\r\n${closer}\r\nbody`,
    );
    const original = [stale, current];
    assert.deepEqual(
      await orderSupersededHits({ spaceDir }, original, 2),
      original,
      `malformed closer ${JSON.stringify(closer)} must fail open`,
    );
  }

  for (const [index, closer] of ['---\n', '---\r\n', '---', '---\r'].entries()) {
    const stale = hit(`memory/valid-stale-${index}.md`);
    await fs.writeFile(
      path.join(spaceDir, stale.path),
      `---\r\ndocument_id: valid-stale-${index}\r\nsuperseded_by: current\r\n${closer}`,
    );
    assert.deepEqual(
      (await orderSupersededHits({ spaceDir }, [stale, current], 2)).map((item) => item.path),
      [current.path, stale.path],
      `exact closer ${JSON.stringify(closer)} must be accepted`,
    );
  }
});

test('default lexical search never reads supersession metadata', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-supersession-lexical-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const core = await openCore({ root, space: 'lexical' });
  await core.journal({ text: 'lexical-only relation metadata sentinel', sourceAgent: 'test' });
  await fs.symlink('/definitely/outside/ihow-memory', path.join(core.workspace.memoryDir, 'broken-link.md'));
  const hits = await core.search('relation metadata sentinel', { limit: 5 });
  assert.ok(hits.length > 0, 'pure FTS path remains available despite unrelated unreadable metadata');
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
