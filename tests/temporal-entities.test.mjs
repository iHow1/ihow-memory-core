// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  canonicalTemporalEntityFactIdV1,
  currentTemporalEntityFactsV1,
  selectOneHopTemporalFactsV1,
  temporalEntityFactFromMemoryV1,
  validateTemporalEntityFactV1,
} from '../src/temporal-entities.ts';

function withId(fields) {
  return { ...fields, fact_id: canonicalTemporalEntityFactIdV1(fields) };
}

function baseFact(overrides = {}) {
  return {
    schema_version: 1,
    entity_id: 'project atlas',
    aliases: ['Project Atlas', 'project atlas'],
    relation: 'deployment region',
    value: 'us-west-2',
    valid_from: '2026-07-01T00:00:00.000Z',
    valid_to: null,
    observed_at: '2026-07-01T00:00:00.000Z',
    supersedes: [],
    source: { path: 'memory/scopes/atlas/region.md', proposal_id: null },
    confidence: 1,
    ...overrides,
  };
}

function frontmatter(entries, body = 'durable fact') {
  return `---\n${Object.entries(entries).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n\n${body}\n`;
}

test('validates the exact schema and computes a non-self-referential canonical fact id', () => {
  const input = baseFact();
  const first = canonicalTemporalEntityFactIdV1(input);
  const second = canonicalTemporalEntityFactIdV1({ ...input, fact_id: 'tef1_deadbeef' });
  assert.equal(first, second);
  assert.match(first, /^tef1_[0-9a-f]{64}$/);
  assert.deepEqual(validateTemporalEntityFactV1({ ...input, fact_id: first }), { ...input, fact_id: first });
  assert.throws(() => validateTemporalEntityFactV1({ ...input, fact_id: first, extra: true }), /unknown field/);
  assert.throws(() => validateTemporalEntityFactV1({ ...input, fact_id: 'tef1_deadbeef' }), /fact_id/);
  assert.throws(() => validateTemporalEntityFactV1(withId(baseFact({ valid_to: '2026-06-01T00:00:00.000Z' }))), /valid_to/);
});

test('rejects impossible calendar dates in parsed and directly validated facts', () => {
  const observedAt = '2026-02-30T00:00:00.000Z';
  const parsed = temporalEntityFactFromMemoryV1(frontmatter({
    temporal_entity_schema_version: 1,
    entity_id: 'service api',
    relation: 'owner',
    value: 'platform team',
    observed_at: observedAt,
  }), 'memory/projects/api/impossible-date.md');
  assert.equal(parsed, null);

  assert.throws(
    () => validateTemporalEntityFactV1({ ...baseFact({ observed_at: observedAt }), fact_id: 'tef1_deadbeef' }),
    /temporal_entity_fact_invalid:fact\.observed_at:must be an ISO timestamp/,
  );
});

test('derives proposal and explicit facts only from recognized strict frontmatter', async () => {
  const proposalId = `mp1_${'a'.repeat(64)}`;
  const proposal = temporalEntityFactFromMemoryV1(frontmatter({
    proposal_schema_version: 1,
    proposal_id: proposalId,
    proposal_subject: 'Project Atlas',
    proposal_key: 'deployment region',
    proposal_value: 'us-west-2',
    proposal_observed_at: '2026-07-01T00:00:00.000Z',
    proposal_explicit_supersedes: null,
    reviewed: false,
  }), 'memory/scopes/atlas/region.md');
  assert.ok(proposal);
  assert.equal(proposal.entity_id, 'project atlas');
  assert.deepEqual(proposal.aliases, ['Project Atlas', 'project atlas']);
  assert.equal(proposal.source.proposal_id, proposalId);
  assert.equal(proposal.confidence, 0.5);

  const explicit = temporalEntityFactFromMemoryV1(frontmatter({
    temporal_entity_schema_version: 1,
    entity_id: 'service api',
    entity_aliases: ['Service API', 'api'],
    relation: 'owner',
    value: 'platform team',
    observed_at: '2026-07-02T00:00:00.000Z',
    valid_to: null,
    supersedes: [],
    confidence: 0.75,
  }), 'memory/projects/api/owner.md');
  assert.ok(explicit);
  assert.deepEqual(explicit.aliases, ['service api', 'Service API', 'api']);
  assert.equal(explicit.source.path, 'memory/projects/api/owner.md');
  assert.equal(explicit.confidence, 0.75);

  assert.equal(temporalEntityFactFromMemoryV1(frontmatter({ relation: 'owner', value: 'nobody' }), 'memory/projects/api/plain.md'), null);
  assert.equal(temporalEntityFactFromMemoryV1(frontmatter({ temporal_entity_schema_version: 1, entity_id: 'api', entity_aliases: '["api"]', relation: 'owner', value: 'team', observed_at: '2026-07-02T00:00:00.000Z' }), 'memory/projects/api/bad-array.md'), null);
  assert.equal(temporalEntityFactFromMemoryV1('---\ntemporal_entity_schema_version: 1\nentity_id: "api"\nentity_id: "other"\nrelation: "owner"\nvalue: "team"\nobserved_at: "2026-07-02T00:00:00.000Z"\n---\n', 'memory/projects/api/duplicate.md'), null);
  assert.equal(temporalEntityFactFromMemoryV1(frontmatter({ temporal_entity_schema_version: 1, temporal_entity_extra: true, entity_id: 'api', relation: 'owner', value: 'team', observed_at: '2026-07-02T00:00:00.000Z' }), 'memory/projects/api/unknown.md'), null);
  assert.equal(temporalEntityFactFromMemoryV1(frontmatter({ temporal_entity_schema_version: 1, entity_id: 'api', relation: 'token', value: 'api_key: abcdefghijklmnop', observed_at: '2026-07-02T00:00:00.000Z' }), 'memory/projects/api/secret.md'), null);
  assert.equal(temporalEntityFactFromMemoryV1(frontmatter({ temporal_entity_schema_version: 1, entity_id: 'api', relation: 'owner', value: 'team', observed_at: '2026-07-02T00:00:00.000Z' }), 'memory/candidate/inbox/bad.md'), null);

  const moduleText = await fs.readFile(fileURLToPath(new URL('../src/temporal-entities.ts', import.meta.url)), 'utf8');
  assert.doesNotMatch(moduleText, /from ['"].*prompt-recall\.ts['"]/);
  assert.doesNotMatch(moduleText, /writeFile|appendFile|rename\(/);
});

test('classifies interval boundaries and applies only explicit current superseders', () => {
  const now = Date.parse('2026-07-10T00:00:00.000Z');
  const proposalA = `mp1_${'1'.repeat(64)}`;
  const proposalB = `mp1_${'2'.repeat(64)}`;
  const oldById = withId(baseFact({ source: { path: 'memory/scopes/atlas/old-id.md', proposal_id: proposalA } }));
  const oldByProposal = withId(baseFact({ source: { path: 'memory/scopes/atlas/old-proposal.md', proposal_id: proposalB }, value: 'old proposal value' }));
  const oldByPath = withId(baseFact({ source: { path: 'memory/scopes/atlas/old-path.md', proposal_id: null }, value: 'old path value' }));
  const newById = withId(baseFact({ source: { path: 'memory/scopes/atlas/new-id.md', proposal_id: null }, value: 'new id value', supersedes: [oldById.fact_id] }));
  const newByProposal = withId(baseFact({ source: { path: 'memory/scopes/atlas/new-proposal.md', proposal_id: null }, value: 'new proposal value', supersedes: [proposalB] }));
  const newByPath = withId(baseFact({ source: { path: 'memory/scopes/atlas/new-path.md', proposal_id: null }, value: 'new path value', supersedes: [oldByPath.source.path] }));
  const future = withId(baseFact({ source: { path: 'memory/scopes/atlas/future.md', proposal_id: null }, valid_from: '2026-07-10T00:00:00.001Z', supersedes: [newById.fact_id] }));
  const expired = withId(baseFact({ source: { path: 'memory/scopes/atlas/expired.md', proposal_id: null }, valid_to: '2026-07-10T00:00:00.000Z', supersedes: [newByProposal.fact_id] }));

  const result = currentTemporalEntityFactsV1([
    oldById, oldByProposal, oldByPath, newById, newByProposal, newByPath, future, expired,
  ], now);
  assert.deepEqual(new Set(result.superseded.map((fact) => fact.fact_id)), new Set([oldById.fact_id, oldByProposal.fact_id, oldByPath.fact_id]));
  assert.ok(result.current.some((fact) => fact.fact_id === newById.fact_id));
  assert.ok(result.current.some((fact) => fact.fact_id === newByProposal.fact_id));
  assert.deepEqual(result.future.map((fact) => fact.fact_id), [future.fact_id]);
  assert.deepEqual(result.expired.map((fact) => fact.fact_id), [expired.fact_id]);
});

test('keeps ambiguous conflicts and every explicit cycle member visible', () => {
  const now = Date.parse('2026-07-10T00:00:00.000Z');
  const ambiguousA = withId(baseFact({ source: { path: 'memory/projects/api/ambiguous-a.md', proposal_id: null }, value: 'team a' }));
  const ambiguousB = withId(baseFact({ source: { path: 'memory/projects/api/ambiguous-b.md', proposal_id: null }, value: 'team b' }));
  const outside = withId(baseFact({ source: { path: 'memory/projects/api/outside.md', proposal_id: null }, value: 'old outside' }));
  const cycleA = withId(baseFact({ source: { path: 'memory/projects/api/cycle-a.md', proposal_id: null }, value: 'cycle a', supersedes: ['memory/projects/api/cycle-b.md', outside.source.path] }));
  const cycleB = withId(baseFact({ source: { path: 'memory/projects/api/cycle-b.md', proposal_id: null }, value: 'cycle b', supersedes: ['memory/projects/api/cycle-a.md'] }));

  const first = currentTemporalEntityFactsV1([cycleB, ambiguousB, outside, cycleA, ambiguousA], now);
  const second = currentTemporalEntityFactsV1([ambiguousA, cycleA, outside, ambiguousB, cycleB], now);
  assert.deepEqual(first, second, 'collapse is deterministic independent of input order');
  assert.ok(first.current.some((fact) => fact.fact_id === ambiguousA.fact_id));
  assert.ok(first.current.some((fact) => fact.fact_id === ambiguousB.fact_id));
  assert.ok(first.current.some((fact) => fact.fact_id === cycleA.fact_id));
  assert.ok(first.current.some((fact) => fact.fact_id === cycleB.fact_id));
  assert.deepEqual(first.superseded.map((fact) => fact.fact_id), [outside.fact_id]);
});

test('selects only direct one-hop current facts with canonical citations and confidence-neutral order', () => {
  const now = Date.parse('2026-07-10T00:00:00.000Z');
  const direct = withId(baseFact({
    aliases: ['Project Atlas', 'project atlas'], relation: 'owner', value: 'platform team',
    source: { path: 'memory/projects/api/direct.md', proposal_id: null }, confidence: 0.1,
  }));
  const aliasOnly = withId(baseFact({
    aliases: ['Atlas'], relation: 'region', value: 'us-west-2',
    source: { path: 'memory/projects/api/alias.md', proposal_id: null }, confidence: 1,
  }));
  const relationOnly = withId(baseFact({
    entity_id: 'service api', aliases: ['Service API', 'service api'], relation: 'owner', value: 'team b',
    source: { path: 'memory/projects/api/relation.md', proposal_id: null }, confidence: 1,
  }));
  const lowConfidenceLexicalFirst = withId(baseFact({
    aliases: ['Atlas'], relation: 'region', value: 'a',
    source: { path: 'memory/projects/api/a-confidence.md', proposal_id: null }, confidence: 0,
  }));
  const highConfidenceLexicalLast = withId(baseFact({
    aliases: ['Atlas'], relation: 'region', value: 'z',
    source: { path: 'memory/projects/api/z-confidence.md', proposal_id: null }, confidence: 1,
  }));
  const firstHop = withId(baseFact({
    aliases: ['Atlas'], relation: 'dependency', value: 'Service Beta',
    source: { path: 'memory/projects/api/first-hop.md', proposal_id: null },
  }));
  const secondHop = withId(baseFact({
    entity_id: 'service beta', aliases: ['Service Beta', 'service beta'], relation: 'maintainer', value: 'other team',
    source: { path: 'memory/projects/api/second-hop.md', proposal_id: null },
  }));
  const future = withId(baseFact({
    aliases: ['Atlas'], relation: 'owner', value: 'future team', valid_from: '2026-07-11T00:00:00.000Z',
    source: { path: 'memory/projects/api/future-owner.md', proposal_id: null },
  }));

  const selected = selectOneHopTemporalFactsV1([
    secondHop, highConfidenceLexicalLast, future, relationOnly, aliasOnly,
    firstHop, lowConfidenceLexicalFirst, direct,
  ], ['ATLAS', 'owner', 'atlas'], 'temporal', now);
  assert.equal(selected[0].fact.fact_id, direct.fact_id, 'alias+relation match is first');
  assert.equal(selected[0].citationPath, direct.source.path);
  assert.deepEqual(selected[0].matchedAliases, ['Project Atlas', 'project atlas']);
  assert.equal(selected[0].matchedRelation, true);
  assert.ok(selected.some((entry) => entry.fact.fact_id === relationOnly.fact_id));
  assert.ok(selected.some((entry) => entry.fact.fact_id === firstHop.fact_id));
  assert.ok(!selected.some((entry) => entry.fact.fact_id === secondHop.fact_id), 'does not expand through a matched value');
  assert.ok(!selected.some((entry) => entry.fact.fact_id === future.fact_id));

  const confidencePair = selected.filter((entry) => [lowConfidenceLexicalFirst.fact_id, highConfidenceLexicalLast.fact_id].includes(entry.fact.fact_id));
  assert.deepEqual(confidencePair.map((entry) => entry.fact.fact_id), [lowConfidenceLexicalFirst.fact_id, highConfidenceLexicalLast.fact_id]);
  assert.deepEqual(selected, selectOneHopTemporalFactsV1([
    direct, lowConfidenceLexicalFirst, firstHop, aliasOnly, relationOnly,
    future, highConfidenceLexicalLast, secondHop,
  ], ['owner', 'atlas'], 'temporal', now));
});
