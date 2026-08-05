// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import crypto from 'node:crypto';
import { containsSecretLikeContent } from './governance.ts';
import { RECALL_QUERY_INTENTS_V1, type RecallQueryIntentV1 } from './query-intent.ts';
import { isCuratedMemoryPath } from './workspace.ts';

export type TemporalEntityFactV1 = {
  schema_version: 1;
  fact_id: string;
  entity_id: string;
  aliases: string[];
  relation: string;
  value: string;
  valid_from: string | null;
  valid_to: string | null;
  observed_at: string;
  supersedes: string[];
  source: {
    path: string;
    proposal_id: string | null;
  };
  confidence: number;
};

type UnknownRecord = Record<string, unknown>;
type FactProjection = Omit<TemporalEntityFactV1, 'fact_id'>;

const FACT_FIELDS = [
  'schema_version', 'fact_id', 'entity_id', 'aliases', 'relation', 'value',
  'valid_from', 'valid_to', 'observed_at', 'supersedes', 'source', 'confidence',
] as const;
const PROJECTION_FIELDS = FACT_FIELDS.filter((field) => field !== 'fact_id');
const EXPLICIT_FIELDS = new Set([
  'temporal_entity_schema_version', 'entity_id', 'entity_aliases', 'relation', 'value',
  'valid_from', 'valid_to', 'observed_at', 'supersedes', 'confidence',
]);
const MAX_FRONTMATTER_CHARS = 32_768;
const MAX_FRONTMATTER_LINES = 128;

function fail(path: string, reason: string): never {
  throw new Error(`temporal_entity_fact_invalid:${path}:${reason}`);
}

function exactRecord(value: unknown, allowed: readonly string[], path: string, required: readonly string[]): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'must be an object');
  const record = value as UnknownRecord;
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) fail(`${path}.${key}`, 'unknown field');
  }
  for (const key of required) {
    if (!Object.hasOwn(record, key)) fail(`${path}.${key}`, 'missing field');
  }
  return record;
}

function normalizedText(value: unknown, path: string, max: number): string {
  if (typeof value !== 'string') fail(path, 'must be a string');
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (!normalized || normalized.length > max) fail(path, 'out of bounds');
  if (normalized !== value) fail(path, 'must be normalized');
  if (containsSecretLikeContent(value)) fail(path, 'unsafe value');
  return value;
}

function entityId(value: unknown, path: string): string {
  const result = normalizedText(value, path, 120);
  if (result.toLowerCase() !== result) fail(path, 'must be canonical');
  return result;
}

function isoTimestamp(value: unknown, path: string, nullable: boolean): string | null {
  if (value === null && nullable) return null;
  if (typeof value !== 'string' || value.length > 40
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value)
    || !Number.isFinite(Date.parse(value))) fail(path, 'must be an ISO timestamp');
  const fraction = value.match(/\.(\d{1,3})Z$/u)?.[1] ?? '';
  const normalized = value.replace(/(?:\.\d{1,3})?Z$/u, `.${fraction.padEnd(3, '0')}Z`);
  if (new Date(Date.parse(value)).toISOString() !== normalized) fail(path, 'must be an ISO timestamp');
  return value;
}

function proposalId(value: unknown, path: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^mp1_[0-9a-f]{64}$/u.test(value)) fail(path, 'must be a proposal id');
  return value;
}

function canonicalCuratedPath(value: unknown, path: string): string {
  const result = normalizedText(value, path, 512);
  if (!result.startsWith('memory/') || result.includes('\\') || result.includes('//') || !result.endsWith('.md')) {
    fail(path, 'must be a canonical curated memory path');
  }
  const segments = result.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..') || !isCuratedMemoryPath(result)) {
    fail(path, 'must be a canonical curated memory path');
  }
  return result;
}

function supersedesHandle(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, 'must be a string');
  if (/^(?:tef1|mp1)_[0-9a-f]{64}$/u.test(value)) return value;
  return canonicalCuratedPath(value, path);
}

function uniqueStrings(
  value: unknown,
  path: string,
  validator: (item: unknown, itemPath: string) => string,
  max = 32,
): string[] {
  if (!Array.isArray(value) || value.length > max) fail(path, 'must be a bounded array');
  const result = value.map((item, index) => validator(item, `${path}[${index}]`));
  if (new Set(result).size !== result.length) fail(path, 'must not contain duplicates');
  return result;
}

function validateProjection(value: unknown): FactProjection {
  const item = exactRecord(value, FACT_FIELDS, 'fact', PROJECTION_FIELDS);
  if (item.schema_version !== 1) fail('fact.schema_version', 'must be 1');
  const aliases = uniqueStrings(item.aliases, 'fact.aliases', (alias, path) => normalizedText(alias, path, 120));
  if (aliases.length === 0) fail('fact.aliases', 'must not be empty');
  const validFrom = isoTimestamp(item.valid_from, 'fact.valid_from', true);
  const validTo = isoTimestamp(item.valid_to, 'fact.valid_to', true);
  const observedAt = isoTimestamp(item.observed_at, 'fact.observed_at', false)!;
  if (validFrom !== null && validTo !== null && Date.parse(validTo) <= Date.parse(validFrom)) {
    fail('fact.valid_to', 'must be after valid_from');
  }
  if (typeof item.confidence !== 'number' || !Number.isFinite(item.confidence)
    || item.confidence < 0 || item.confidence > 1) fail('fact.confidence', 'must be within [0,1]');

  const source = exactRecord(item.source, ['path', 'proposal_id'], 'fact.source', ['path', 'proposal_id']);
  return {
    schema_version: 1,
    entity_id: entityId(item.entity_id, 'fact.entity_id'),
    aliases,
    relation: normalizedText(item.relation, 'fact.relation', 120),
    value: normalizedText(item.value, 'fact.value', 2_000),
    valid_from: validFrom,
    valid_to: validTo,
    observed_at: observedAt,
    supersedes: uniqueStrings(item.supersedes, 'fact.supersedes', supersedesHandle),
    source: {
      path: canonicalCuratedPath(source.path, 'fact.source.path'),
      proposal_id: proposalId(source.proposal_id, 'fact.source.proposal_id'),
    },
    confidence: item.confidence,
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as UnknownRecord).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as UnknownRecord)[key])}`).join(',')}}`;
  }
  fail('fact', 'must be canonical JSON');
}

export function canonicalTemporalEntityFactIdV1(value: unknown): string {
  const projection = validateProjection(value);
  return `tef1_${crypto.createHash('sha256').update(canonicalJson(projection), 'utf8').digest('hex')}`;
}

export function validateTemporalEntityFactV1(value: unknown): TemporalEntityFactV1 {
  const item = exactRecord(value, FACT_FIELDS, 'fact', FACT_FIELDS);
  const projection = validateProjection(item);
  const expected = canonicalTemporalEntityFactIdV1(projection);
  if (typeof item.fact_id !== 'string' || item.fact_id !== expected) fail('fact.fact_id', 'must match canonical identity');
  return { ...projection, fact_id: item.fact_id };
}

function normalizedCasefold(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

function parseFrontmatter(content: string): { values: Map<string, unknown>; malformed: boolean } | null {
  const start = String(content ?? '').slice(0, MAX_FRONTMATTER_CHARS + 16);
  const match = start.match(/^\ufeff?\s*---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u);
  if (!match || match[1].length > MAX_FRONTMATTER_CHARS) return null;
  const lines = match[1].split(/\r?\n/u);
  if (lines.length > MAX_FRONTMATTER_LINES || lines.some((line) => line.length > 4_096)) return null;
  const values = new Map<string, unknown>();
  let malformed = false;
  for (const line of lines) {
    if (!line.trim() || /^\s*#/u.test(line)) continue;
    const index = line.indexOf(':');
    if (index <= 0) { malformed = true; continue; }
    const key = line.slice(0, index).trim();
    if (!/^[a-z][a-z0-9_]*$/u.test(key) || values.has(key)) { malformed = true; continue; }
    const raw = line.slice(index + 1).trim();
    try { values.set(key, JSON.parse(raw)); } catch { values.set(key, raw); }
  }
  return { values, malformed };
}

function aliasesFrom(values: Map<string, unknown>, original: string): string[] {
  const aliases: string[] = [];
  const add = (value: string): void => { if (!aliases.includes(value)) aliases.push(value); };
  add(normalizedText(original, 'frontmatter.entity', 120));
  add(normalizedCasefold(original));
  if (values.has('entity_aliases')) {
    const explicit = uniqueStrings(values.get('entity_aliases'), 'frontmatter.entity_aliases', (item, path) => normalizedText(item, path, 120));
    for (const alias of explicit) add(alias);
  }
  return aliases;
}

function frontString(values: Map<string, unknown>, key: string, fallback?: unknown): unknown {
  return values.has(key) ? values.get(key) : fallback;
}

export function temporalEntityFactFromMemoryV1(content: string, path: string): TemporalEntityFactV1 | null {
  try {
    canonicalCuratedPath(path, 'source.path');
    const parsed = parseFrontmatter(content);
    if (!parsed) return null;
    const { values } = parsed;
    const proposalMarked = values.get('proposal_schema_version') === 1;
    const explicitMarked = values.get('temporal_entity_schema_version') === 1;
    if (!proposalMarked && !explicitMarked) return null;
    if (parsed.malformed) return null;
    for (const key of values.keys()) {
      if ((key.startsWith('temporal_') || key.startsWith('entity_')) && !EXPLICIT_FIELDS.has(key)) return null;
    }

    const proposalRequired = ['proposal_id', 'proposal_subject', 'proposal_key', 'proposal_value'];
    if (proposalMarked && proposalRequired.some((key) => !values.has(key))) return null;
    if (containsSecretLikeContent(JSON.stringify(Object.fromEntries(values)))) return null;

    const proposalSubject = proposalMarked ? values.get('proposal_subject') : values.get('entity_id');
    const originalEntity = normalizedText(proposalSubject, 'frontmatter.entity', 120);
    const canonicalEntity = frontString(values, 'entity_id', normalizedCasefold(originalEntity));
    const relation = frontString(values, 'relation', proposalMarked ? values.get('proposal_key') : undefined);
    const factValue = frontString(values, 'value', proposalMarked ? values.get('proposal_value') : undefined);
    const observed = frontString(values, 'observed_at', frontString(values, 'proposal_observed_at', frontString(values, 'promoted_at', values.get('created_at'))));
    const validFrom = frontString(values, 'valid_from', observed);
    const rawSupersedes = frontString(values, 'supersedes', proposalMarked ? values.get('proposal_explicit_supersedes') : undefined);
    const supersedes = rawSupersedes === null || rawSupersedes === undefined
      ? []
      : Array.isArray(rawSupersedes) ? rawSupersedes : [rawSupersedes];
    const rawConfidence = frontString(values, 'confidence', values.get('reviewed') === false || values.get('tier') === 'auto-promoted' ? 0.5 : 1);
    const rawProposalId = proposalMarked ? values.get('proposal_id') : null;

    const projection: FactProjection = {
      schema_version: 1,
      entity_id: canonicalEntity as string,
      aliases: aliasesFrom(values, originalEntity),
      relation: relation as string,
      value: factValue as string,
      valid_from: validFrom as string | null,
      valid_to: frontString(values, 'valid_to', null) as string | null,
      observed_at: observed as string,
      supersedes: supersedes as string[],
      source: { path, proposal_id: rawProposalId as string | null },
      confidence: rawConfidence as number,
    };
    const factId = canonicalTemporalEntityFactIdV1(projection);
    return validateTemporalEntityFactV1({ ...projection, fact_id: factId });
  } catch {
    return null;
  }
}

export type CurrentTemporalEntityFactsV1 = {
  current: TemporalEntityFactV1[];
  future: TemporalEntityFactV1[];
  expired: TemporalEntityFactV1[];
  superseded: TemporalEntityFactV1[];
};

function factOrder(left: TemporalEntityFactV1, right: TemporalEntityFactV1): number {
  return left.source.path.localeCompare(right.source.path) || left.fact_id.localeCompare(right.fact_id);
}

function cycleParticipants(edges: readonly number[][]): Set<number> {
  let nextIndex = 0;
  const indexes = new Array<number>(edges.length).fill(-1);
  const lowLinks = new Array<number>(edges.length).fill(-1);
  const onStack = new Array<boolean>(edges.length).fill(false);
  const stack: number[] = [];
  const cycles = new Set<number>();

  const visit = (node: number): void => {
    indexes[node] = nextIndex;
    lowLinks[node] = nextIndex;
    nextIndex += 1;
    stack.push(node);
    onStack[node] = true;

    for (const target of edges[node]) {
      if (indexes[target] === -1) {
        visit(target);
        lowLinks[node] = Math.min(lowLinks[node], lowLinks[target]);
      } else if (onStack[target]) {
        lowLinks[node] = Math.min(lowLinks[node], indexes[target]);
      }
    }

    if (lowLinks[node] !== indexes[node]) return;
    const component: number[] = [];
    let member = -1;
    do {
      member = stack.pop()!;
      onStack[member] = false;
      component.push(member);
    } while (member !== node);
    if (component.length > 1 || edges[node].includes(node)) {
      for (const participant of component) cycles.add(participant);
    }
  };

  for (let node = 0; node < edges.length; node += 1) {
    if (indexes[node] === -1) visit(node);
  }
  return cycles;
}

export function currentTemporalEntityFactsV1(
  facts: readonly TemporalEntityFactV1[],
  nowMs: number,
): CurrentTemporalEntityFactsV1 {
  if (!Number.isFinite(nowMs)) fail('nowMs', 'must be finite');
  const validated = facts.map((fact) => validateTemporalEntityFactV1(fact)).sort(factOrder);
  const future: TemporalEntityFactV1[] = [];
  const expired: TemporalEntityFactV1[] = [];
  const eligible: TemporalEntityFactV1[] = [];
  for (const fact of validated) {
    if (fact.valid_from !== null && Date.parse(fact.valid_from) > nowMs) future.push(fact);
    else if (fact.valid_to !== null && Date.parse(fact.valid_to) <= nowMs) expired.push(fact);
    else eligible.push(fact);
  }

  const handles = eligible.map((fact) => new Set([
    fact.fact_id,
    fact.source.path,
    ...(fact.source.proposal_id === null ? [] : [fact.source.proposal_id]),
  ]));
  const edges = eligible.map((superseder) => {
    const targets: number[] = [];
    for (let targetIndex = 0; targetIndex < eligible.length; targetIndex += 1) {
      if (superseder.supersedes.some((handle) => handles[targetIndex].has(handle))) targets.push(targetIndex);
    }
    return [...new Set(targets)].sort((left, right) => left - right);
  });
  const cycleNodes = cycleParticipants(edges);
  const suppressed = new Set<number>();
  for (const targets of edges) {
    for (const target of targets) {
      if (!cycleNodes.has(target)) suppressed.add(target);
    }
  }

  return {
    current: eligible.filter((_, index) => !suppressed.has(index)),
    future,
    expired,
    superseded: eligible.filter((_, index) => suppressed.has(index)),
  };
}

export type OneHopTemporalFactV1 = {
  fact: TemporalEntityFactV1;
  citationPath: string;
  matchedAliases: string[];
  matchedRelation: boolean;
};

function boundedQueryTerms(queryTerms: readonly string[]): string[] {
  if (!Array.isArray(queryTerms) || queryTerms.length > 64) fail('queryTerms', 'must be a bounded array');
  const result: string[] = [];
  for (let index = 0; index < queryTerms.length; index += 1) {
    const term = normalizedText(queryTerms[index], `queryTerms[${index}]`, 120).toLowerCase();
    if (!result.includes(term)) result.push(term);
  }
  return result;
}

function fieldMatchesTerm(field: string, term: string): boolean {
  return field.normalize('NFKC').toLowerCase().includes(term);
}

function temporalRecency(fact: TemporalEntityFactV1): number {
  return Date.parse(fact.valid_from ?? fact.observed_at);
}

export function selectOneHopTemporalFactsV1(
  facts: readonly TemporalEntityFactV1[],
  queryTerms: readonly string[],
  intent: RecallQueryIntentV1,
  nowMs: number,
): OneHopTemporalFactV1[] {
  if (!RECALL_QUERY_INTENTS_V1.includes(intent)) fail('intent', 'must be a recall query intent');
  const terms = boundedQueryTerms(queryTerms);
  if (terms.length === 0) return [];
  const { current } = currentTemporalEntityFactsV1(facts, nowMs);
  const matches: Array<OneHopTemporalFactV1 & { matchClass: number }> = [];
  for (const fact of current) {
    const matchedAliases = fact.aliases.filter((alias) => terms.some((term) => fieldMatchesTerm(alias, term)));
    const matchedRelation = terms.some((term) => fieldMatchesTerm(fact.relation, term));
    const matchedValue = terms.some((term) => fieldMatchesTerm(fact.value, term));
    if (matchedAliases.length === 0 && !matchedRelation && !matchedValue) continue;
    matches.push({
      fact,
      citationPath: fact.source.path,
      matchedAliases,
      matchedRelation,
      matchClass: matchedAliases.length > 0 && matchedRelation ? 0 : 1,
    });
  }

  return matches.sort((left, right) => (
    left.matchClass - right.matchClass
    || temporalRecency(right.fact) - temporalRecency(left.fact)
    || factOrder(left.fact, right.fact)
  )).map(({ matchClass: _matchClass, ...result }) => result);
}
