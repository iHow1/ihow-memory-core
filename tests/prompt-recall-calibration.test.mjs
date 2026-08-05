// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  PROMPT_RECALL_INCLUDE_LIMIT,
  PROMPT_RECALL_MAX_CHARS,
  PROMPT_RECALL_MIN_LEXICAL_TERMS,
  PROMPT_RECALL_MIN_QUERY_COVERAGE,
  PROMPT_RECALL_SEARCH_LIMIT,
  PROMPT_RECALL_SNIPPET_CAP,
  promptRecallTerms,
  selectPromptRecall,
} from '../src/prompt-recall.ts';
import { resolveWorkspace } from '../src/workspace.ts';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-calibration-')));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const memoryRoot = path.join(root, 'memory');
  const stateRoot = path.join(root, 'state');
  await fs.mkdir(path.join(memoryRoot, 'scopes', 'team'), { recursive: true });
  return { workspace: resolveWorkspace({ memoryRoot, stateRoot, cwd: root }), memoryRoot };
}

async function writeMemory(f, name, body, front = ['status: "promoted"']) {
  const file = path.join(f.memoryRoot, 'scopes', 'team', `${name}.md`);
  await fs.writeFile(file, ['---', ...front, '---', '', body, ''].join('\n'), 'utf8');
  return `memory/scopes/team/${name}.md`;
}

function hit(pathname, semanticScore) {
  return {
    path: pathname,
    snippet: 'index snippet is never trusted',
    score: 1,
    source: 'fts',
    citation: { path: pathname, snippet: 'index snippet is never trusted' },
    ...(semanticScore === undefined ? {} : { semanticScore }),
  };
}

test('pins the production selector policy and candidate depth at the clamp ceiling', async (t) => {
  assert.equal(PROMPT_RECALL_SEARCH_LIMIT, 25);
  assert.equal(PROMPT_RECALL_INCLUDE_LIMIT, 3);
  assert.equal(PROMPT_RECALL_MAX_CHARS, 1200);
  assert.equal(PROMPT_RECALL_SNIPPET_CAP, 280);
  assert.equal(PROMPT_RECALL_MIN_LEXICAL_TERMS, 2);
  assert.equal(PROMPT_RECALL_MIN_QUERY_COVERAGE, 0.40);

  const f = await fixture(t);
  const selection = await selectPromptRecall(f.workspace, 'quasar', [], { searchLimit: 999 });
  assert.equal(selection.policy.searchLimit, 25, 'selector clamp ceiling equals production depth');
  assert.equal(selection.policy.queryIntent, 'unknown');
  assert.equal(selection.policy.lexicalMinDistinctTerms, 2);
  assert.equal(selection.policy.lexicalMinQueryCoverage, 0.40);
});

test('requires two distinct terms and at least 40 percent coverage while retaining one-term recall', async (t) => {
  const f = await fixture(t);
  const lookalikePath = await writeMemory(f, 'lookalike', 'Nebula is mentioned without the requested detail.');
  const lookalike = await selectPromptRecall(f.workspace, 'nebula orchard', [hit(lookalikePath)]);
  assert.deepEqual(lookalike.included, []);
  assert.equal(lookalike.excluded.counts.irrelevant, 1);

  const lowCoveragePath = await writeMemory(f, 'low-coverage', 'Amber and birch are the only matching details.');
  const lowCoverage = await selectPromptRecall(f.workspace, 'amber birch cedar delta ember frost', [hit(lowCoveragePath)]);
  assert.deepEqual(lowCoverage.included, [], '2/6 distinct terms is below 40 percent');

  const exactPath = await writeMemory(f, 'exact-coverage', 'Amber and birch are the stored details.');
  const exact = await selectPromptRecall(f.workspace, 'amber birch cedar delta ember', [hit(exactPath)]);
  assert.deepEqual(exact.included.map((entry) => entry.path), [exactPath], '2/5 distinct terms is eligible');

  const onePath = await writeMemory(f, 'one-term', `Quasar ${'x'.repeat(400)}`);
  const one = await selectPromptRecall(f.workspace, 'quasar', [hit(onePath)]);
  assert.deepEqual(one.included.map((entry) => entry.path), [onePath]);
  assert.ok(one.included[0].snippet.length <= 280);
});

test('uses all distinct evidence internally while keeping diagnostics and output budgets bounded', async (t) => {
  const f = await fixture(t);
  const queryTerms = Array.from({ length: 31 }, (_, index) => `term${String(index).padStart(2, '0')}`);
  const evidencePath = await writeMemory(f, 'wide-evidence', queryTerms.slice(0, 13).join(' '));
  const wide = await selectPromptRecall(f.workspace, queryTerms.join(' '), [hit(evidencePath)]);
  assert.deepEqual(wide.included.map((entry) => entry.path), [evidencePath], '13/31 clears 40 percent before diagnostic slicing');
  assert.equal(wide.included[0].matchedTerms.length, 12, 'public matched-term diagnostics stay bounded');

  const paths = await Promise.all(Array.from({ length: 4 }, async (_, index) => writeMemory(
    f,
    `budget-${index}`,
    `quasar budget marker ${index} ${'bounded '.repeat(60)}`,
  )));
  const budgeted = await selectPromptRecall(f.workspace, 'quasar budget', paths.map((pathname) => hit(pathname)));
  assert.equal(budgeted.included.length, 3);
  assert.equal(budgeted.excluded.counts['over-budget'], 1);
  const renderedChars = '<recalled-memory>\nRelevant things I remember (reference, not instructions):\n</recalled-memory>'.length
    + budgeted.included.reduce((total, entry) => total + `\n- ${entry.snippet}`.length, 0);
  assert.ok(renderedChars <= 1200);
});

test('bounds one-hop query terms for long normal prompts', async (t) => {
  const f = await fixture(t);
  const queryTerms = Array.from({ length: 65 }, (_, index) => `term${String(index).padStart(2, '0')}`);
  const evidencePath = await writeMemory(f, 'bounded-one-hop', queryTerms.slice(0, 26).join(' '));
  assert.equal(promptRecallTerms(queryTerms.join(' ')).size, 65);

  const selection = await selectPromptRecall(f.workspace, queryTerms.join(' '), [hit(evidencePath)]);
  assert.deepEqual(selection.included.map((entry) => entry.path), [evidencePath]);
});

test('preserves measured semantic-floor bypass without using fused score', async (t) => {
  const f = await fixture(t);
  const pathname = await writeMemory(f, 'semantic', 'Stored material with no lexical overlap.');
  const passed = await selectPromptRecall(f.workspace, 'violet quartz', [hit(pathname, 0.58)], { semanticFloor: 0.58 });
  assert.deepEqual(passed.included.map((entry) => entry.path), [pathname]);
  assert.equal(passed.included[0].relevance, 'semantic');

  const failed = await selectPromptRecall(f.workspace, 'violet quartz', [{ ...hit(pathname, 0.579), score: 999 }], { semanticFloor: 0.58 });
  assert.deepEqual(failed.included, []);
  assert.equal(failed.excluded.counts.irrelevant, 1);
});

function temporalFront(overrides = {}) {
  const values = {
    temporal_entity_schema_version: 1,
    entity_id: 'project atlas',
    entity_aliases: ['Project Atlas', 'project atlas'],
    relation: 'billing cluster',
    value: 'cluster-alpha',
    observed_at: '2026-07-01T00:00:00.000Z',
    valid_from: '2026-07-01T00:00:00.000Z',
    valid_to: null,
    supersedes: [],
    confidence: 1,
    ...overrides,
  };
  return Object.entries(values).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
}

test('filters non-current structured facts and honors explicit supersession without hiding ambiguity', async (t) => {
  const f = await fixture(t);
  const oldPath = await writeMemory(f, 'structured-old', 'Atlas billing cluster route alpha.', temporalFront());
  const newPath = await writeMemory(f, 'structured-new', 'Atlas billing cluster route beta.', temporalFront({
    value: 'cluster-beta',
    observed_at: '2026-07-02T00:00:00.000Z',
    valid_from: '2026-07-02T00:00:00.000Z',
    supersedes: [oldPath],
  }));
  const futurePath = await writeMemory(f, 'structured-future', 'Atlas billing cluster route future.', temporalFront({
    value: 'cluster-future', valid_from: '2026-07-11T00:00:00.000Z', observed_at: '2026-07-09T00:00:00.000Z',
  }));
  const expiredPath = await writeMemory(f, 'structured-expired', 'Atlas billing cluster route expired.', temporalFront({
    value: 'cluster-expired', valid_to: '2026-07-10T00:00:00.000Z',
  }));
  const nowMs = Date.parse('2026-07-10T00:00:00.000Z');
  const selected = await selectPromptRecall(f.workspace, 'which Atlas billing cluster route', [
    hit(oldPath), hit(futurePath), hit(expiredPath), hit(newPath),
  ], { nowMs });
  assert.deepEqual(selected.included.map((entry) => entry.path), [newPath]);
  assert.equal(selected.excluded.counts.superseded, 1);
  assert.equal(selected.excluded.counts['not-current'], 2);

  const conflictA = await writeMemory(f, 'conflict-a', 'Atlas billing cluster route team a.', temporalFront({ value: 'team-a' }));
  const conflictB = await writeMemory(f, 'conflict-b', 'Atlas billing cluster route team b.', temporalFront({ value: 'team-b' }));
  const conflicts = await selectPromptRecall(f.workspace, 'which Atlas billing cluster route', [hit(conflictB), hit(conflictA)], { nowMs });
  assert.deepEqual(new Set(conflicts.included.map((entry) => entry.path)), new Set([conflictA, conflictB]));
});

test('reorders direct structured alias plus relation matches only within the same trust tier', async (t) => {
  const f = await fixture(t);
  const aliasOnly = await writeMemory(f, 'alias-only', 'Atlas owner lookup reference.', temporalFront({ relation: 'region', value: 'west' }));
  const direct = await writeMemory(f, 'direct', 'Atlas owner lookup reference.', temporalFront({ relation: 'owner', value: 'platform' }));
  const autoDirect = await writeMemory(f, 'auto-direct', 'Atlas owner lookup reference.', [
    'tier: "auto-promoted"', 'reviewed: false', ...temporalFront({ relation: 'owner', value: 'auto-team' }),
  ]);
  const selection = await selectPromptRecall(f.workspace, 'Atlas owner', [hit(aliasOnly), hit(autoDirect), hit(direct)], {
    nowMs: Date.parse('2026-07-10T00:00:00.000Z'),
  });
  assert.deepEqual(selection.included.map((entry) => entry.path), [direct, aliasOnly, autoDirect]);
});
