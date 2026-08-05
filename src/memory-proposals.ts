// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { canonicalSha256V1 } from './evaluation.ts';
import { parseTranscript } from './transcript.ts';
import { runtimeEventToContextProbe, type RuntimeLifecycleEvent, type RuntimeLifecycleEventName } from './runtime-events.ts';
import {
  containsSecretLikeContent,
  durablePromoteCandidate,
  redactIngestBenign,
  redactSecretLikeContent,
  writeCandidate,
} from './governance.ts';
import type { Workspace } from './types.ts';
import { readEventsAllLanes, type MemoryEvent } from './store/events.ts';

export const MEMORY_PROPOSAL_KINDS_V1 = ['preference', 'fact', 'event', 'procedure'] as const;
export const MEMORY_PROPOSAL_VISIBILITIES_V1 = ['project', 'source-shared', 'source-local', 'private', 'audit-only'] as const;

export type MemoryProposalKindV1 = typeof MEMORY_PROPOSAL_KINDS_V1[number];
export type MemoryProposalVisibilityV1 = typeof MEMORY_PROPOSAL_VISIBILITIES_V1[number];
export type MemoryProposalRelationVerdictV1 = 'new' | 'duplicate' | 'conflict' | 'supersedes' | 'review_required';

export type MemoryProposalV1 = {
  schemaVersion: 1;
  proposalId: string;
  kind: MemoryProposalKindV1;
  text: string;
  subject: string;
  key: string;
  value: string;
  scope: {
    declaredVisibility: MemoryProposalVisibilityV1;
    effectiveVisibility: MemoryProposalVisibilityV1;
    projectScope: string;
    sourcePath: string | null;
    frontmatter: string | null;
  };
  provenance: {
    sourceKind: 'transcript' | 'runtime-event';
    sourceId: string;
    runtime: string;
    observedAt: string;
    sourceSha256: string;
    evidenceLocator: string;
  };
  relation: {
    verdict: MemoryProposalRelationVerdictV1;
    targetProposalIds: string[];
    targetPaths: string[];
    reviewRequired: true;
    destructive: false;
    reason: string;
  };
  review: {
    mode: 'review-first';
    state: 'pending';
  };
  safety: {
    outcome: 'candidate-only';
    directDurableWrite: false;
    indexWrite: false;
    destructive: false;
    autoPromote: false;
  };
};

export type MemoryProposalInputV1 = Omit<MemoryProposalV1, 'proposalId'>;

export type ExplicitMemorySignalV1 = {
  kind: MemoryProposalKindV1;
  subject: string;
  key: string;
  value: string;
  supersedes: string | null;
  evidenceLocator: string;
};

export type ExplicitMemorySignalExtractionV1 = {
  signals: ExplicitMemorySignalV1[];
  rejected: Array<{ evidenceLocator: string; reason: string }>;
};

export type MemoryProposalSourceEnvelopeV1 = {
  sourceId: string;
  runtime: string;
  observedAt: string;
  declaredVisibility: MemoryProposalVisibilityV1;
  projectScope: string;
  sourcePath: string | null;
  frontmatter: string | null;
};

export type TranscriptMemoryProposalRequestV1 = {
  schemaVersion: 1;
  sourceKind: 'transcript';
  source: MemoryProposalSourceEnvelopeV1;
  transcript: string;
};

export type RuntimeEventMemoryProposalRequestV1 = {
  schemaVersion: 1;
  sourceKind: 'runtime-event';
  source: MemoryProposalSourceEnvelopeV1;
  runtimeEvent: RuntimeLifecycleEvent;
  signalText: string;
};

export type MemoryProposalRequestV1 = TranscriptMemoryProposalRequestV1 | RuntimeEventMemoryProposalRequestV1;

export type MemoryProposalBlockedResultV1 = {
  schemaVersion: 1;
  status: 'blocked';
  reason: 'malformed_input' | 'malformed_signal' | 'secret' | 'private' | 'audit-only';
};

export type MemoryProposalIgnoredResultV1 = {
  schemaVersion: 1;
  status: 'ignored';
  reason: 'no_explicit_signal';
};

export type MemoryProposalFormationResultV1 = MemoryProposalBlockedResultV1 | MemoryProposalIgnoredResultV1;

export type MemoryProposalStagedResultV1 = {
  schemaVersion: 1;
  status: 'staged';
  proposal: MemoryProposalV1;
  candidate: {
    candidateId: string;
    path: string;
  };
  relationError: string | null;
};

export type MemoryProposalResultV1 = MemoryProposalFormationResultV1 | MemoryProposalStagedResultV1;

export type ProposalPersistenceSurfaceV1 = {
  fileCount: number;
  totalBytes: number;
  sha256: string;
  files: Array<{ path: string; bytes: number; sha256: string }>;
};

export type ProposalPersistenceCensusV1 = {
  candidates: ProposalPersistenceSurfaceV1;
  durable: ProposalPersistenceSurfaceV1;
  history: ProposalPersistenceSurfaceV1;
  events: ProposalPersistenceSurfaceV1 & { eventCount: number; eventTypes: string[] };
  fts: ProposalPersistenceSurfaceV1;
  indexManifest: ProposalPersistenceSurfaceV1;
};

export type MemoryFeedbackEvidenceV1 = {
  schemaVersion: 1;
  feedbackId: string;
  kind: 'negative-correction' | 'restoration';
  eventId: string;
  eventAt: string;
  targetPath: string;
  provenance: {
    eventType: 'memory.forgotten' | 'memory.remembered';
  };
  safety: {
    redacted: boolean;
    bounded: true;
    durableWrite: false;
  };
};

type UnknownRecord = Record<string, unknown>;

function fail(path: string, message: string): never {
  throw new Error(`${path}: ${message}`);
}

function exactRecord(
  value: unknown,
  allowed: readonly string[],
  path: string,
  required: readonly string[] = allowed,
): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'must be an object');
  const item = value as UnknownRecord;
  for (const key of Object.keys(item)) {
    if (!allowed.includes(key)) fail(`${path}.${key}`, 'unknown field');
  }
  for (const key of required) {
    if (!Object.hasOwn(item, key)) fail(`${path}.${key}`, 'missing field');
  }
  return item;
}

export function normalizeProposalTextV1(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

export function normalizeRelationTextV1(value: string): string {
  return normalizeProposalTextV1(value).toLowerCase();
}

function boundedString(value: unknown, path: string, max: number): string {
  if (typeof value !== 'string') fail(path, 'must be a string');
  const normalized = normalizeProposalTextV1(value);
  if (!normalized) fail(path, 'must be non-empty');
  if (normalized.length > max) fail(path, `must be at most ${max} characters`);
  if (normalized !== value) fail(path, 'must be NFKC-normalized, trimmed, and whitespace-collapsed');
  return value;
}

function nullableBoundedString(value: unknown, path: string, max: number): string | null {
  if (value === null) return null;
  return boundedString(value, path, max);
}

function exactLiteral<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) fail(path, `must be one of ${allowed.join('|')}`);
  return value as T;
}

function exactBoolean(value: unknown, expected: boolean, path: string): void {
  if (value !== expected) fail(path, `must be ${expected}`);
}

function sha256(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) fail(path, 'must be a lowercase SHA-256');
  return value;
}

function proposalId(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^mp1_[0-9a-f]{64}$/.test(value)) fail(path, 'must be a canonical proposal id');
  return value;
}

function canonicalMemoryPath(value: unknown, path: string): string {
  const item = boundedString(value, path, 512);
  if (!/^memory\/(?!.*(?:^|\/)\.\.?\/)[^\\\n]+\.md$/.test(item)) fail(path, 'must be a canonical memory path');
  return item;
}

function explicitSupersedesTarget(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, 'must be a string');
  if (/^mp1_[0-9a-f]{64}$/.test(value)) return value;
  return canonicalMemoryPath(value, path);
}

function uniqueArray(
  value: unknown,
  path: string,
  validate: (entry: unknown, entryPath: string) => string,
  max = 32,
): string[] {
  if (!Array.isArray(value)) fail(path, 'must be an array');
  if (value.length > max) fail(path, `must contain at most ${max} entries`);
  const out = value.map((entry, index) => validate(entry, `${path}[${index}]`));
  if (new Set(out).size !== out.length) fail(path, 'must not contain duplicates');
  return out;
}

function proposalIdentityProjection(value: MemoryProposalInputV1 | MemoryProposalV1): unknown {
  return {
    schemaVersion: 1,
    kind: value.kind,
    subject: normalizeRelationTextV1(value.subject),
    key: normalizeRelationTextV1(value.key),
    value: normalizeRelationTextV1(value.value),
    scope: {
      declaredVisibility: value.scope.declaredVisibility,
      effectiveVisibility: value.scope.effectiveVisibility,
      projectScope: normalizeRelationTextV1(value.scope.projectScope),
      sourcePath: value.scope.sourcePath === null ? null : normalizeProposalTextV1(value.scope.sourcePath),
      frontmatter: value.scope.frontmatter === null ? null : normalizeProposalTextV1(value.scope.frontmatter),
    },
    provenance: {
      sourceKind: value.provenance.sourceKind,
      sourceId: normalizeProposalTextV1(value.provenance.sourceId),
      runtime: normalizeRelationTextV1(value.provenance.runtime),
      observedAt: value.provenance.observedAt,
      sourceSha256: value.provenance.sourceSha256,
      evidenceLocator: normalizeProposalTextV1(value.provenance.evidenceLocator),
    },
  };
}

export function canonicalProposalIdV1(value: MemoryProposalInputV1 | MemoryProposalV1): string {
  return `mp1_${canonicalSha256V1(proposalIdentityProjection(value))}`;
}

function validateProposalInputV1(value: unknown, path: string): MemoryProposalInputV1 {
  const item = exactRecord(value, [
    'schemaVersion', 'kind', 'text', 'subject', 'key', 'value', 'scope', 'provenance', 'relation', 'review', 'safety',
  ], path);
  if (item.schemaVersion !== 1) fail(`${path}.schemaVersion`, 'must equal 1');
  exactLiteral(item.kind, MEMORY_PROPOSAL_KINDS_V1, `${path}.kind`);
  boundedString(item.text, `${path}.text`, 1600);
  boundedString(item.subject, `${path}.subject`, 120);
  boundedString(item.key, `${path}.key`, 120);
  boundedString(item.value, `${path}.value`, 1200);

  const scope = exactRecord(item.scope, [
    'declaredVisibility', 'effectiveVisibility', 'projectScope', 'sourcePath', 'frontmatter',
  ], `${path}.scope`);
  exactLiteral(scope.declaredVisibility, MEMORY_PROPOSAL_VISIBILITIES_V1, `${path}.scope.declaredVisibility`);
  exactLiteral(scope.effectiveVisibility, MEMORY_PROPOSAL_VISIBILITIES_V1, `${path}.scope.effectiveVisibility`);
  boundedString(scope.projectScope, `${path}.scope.projectScope`, 64);
  nullableBoundedString(scope.sourcePath, `${path}.scope.sourcePath`, 512);
  nullableBoundedString(scope.frontmatter, `${path}.scope.frontmatter`, 2048);

  const provenance = exactRecord(item.provenance, [
    'sourceKind', 'sourceId', 'runtime', 'observedAt', 'sourceSha256', 'evidenceLocator',
  ], `${path}.provenance`);
  exactLiteral(provenance.sourceKind, ['transcript', 'runtime-event'] as const, `${path}.provenance.sourceKind`);
  boundedString(provenance.sourceId, `${path}.provenance.sourceId`, 128);
  boundedString(provenance.runtime, `${path}.provenance.runtime`, 64);
  const observedAt = boundedString(provenance.observedAt, `${path}.provenance.observedAt`, 64);
  if (!Number.isFinite(Date.parse(observedAt))) fail(`${path}.provenance.observedAt`, 'must be a valid timestamp');
  sha256(provenance.sourceSha256, `${path}.provenance.sourceSha256`);
  boundedString(provenance.evidenceLocator, `${path}.provenance.evidenceLocator`, 256);

  const relation = exactRecord(item.relation, [
    'verdict', 'targetProposalIds', 'targetPaths', 'reviewRequired', 'destructive', 'reason',
  ], `${path}.relation`);
  exactLiteral(relation.verdict, ['new', 'duplicate', 'conflict', 'supersedes', 'review_required'] as const, `${path}.relation.verdict`);
  uniqueArray(relation.targetProposalIds, `${path}.relation.targetProposalIds`, proposalId);
  uniqueArray(relation.targetPaths, `${path}.relation.targetPaths`, canonicalMemoryPath);
  exactBoolean(relation.reviewRequired, true, `${path}.relation.reviewRequired`);
  exactBoolean(relation.destructive, false, `${path}.relation.destructive`);
  boundedString(relation.reason, `${path}.relation.reason`, 256);

  const review = exactRecord(item.review, ['mode', 'state'], `${path}.review`);
  exactLiteral(review.mode, ['review-first'] as const, `${path}.review.mode`);
  exactLiteral(review.state, ['pending'] as const, `${path}.review.state`);

  const safety = exactRecord(item.safety, [
    'outcome', 'directDurableWrite', 'indexWrite', 'destructive', 'autoPromote',
  ], `${path}.safety`);
  exactLiteral(safety.outcome, ['candidate-only'] as const, `${path}.safety.outcome`);
  exactBoolean(safety.directDurableWrite, false, `${path}.safety.directDurableWrite`);
  exactBoolean(safety.indexWrite, false, `${path}.safety.indexWrite`);
  exactBoolean(safety.destructive, false, `${path}.safety.destructive`);
  exactBoolean(safety.autoPromote, false, `${path}.safety.autoPromote`);
  return item as MemoryProposalInputV1;
}

export function createMemoryProposalV1(value: MemoryProposalInputV1): MemoryProposalV1 {
  const input = validateProposalInputV1(value, 'proposal');
  return validateMemoryProposalV1({ ...input, proposalId: canonicalProposalIdV1(input) });
}

export function validateMemoryProposalV1(value: unknown, path = 'proposal'): MemoryProposalV1 {
  const item = exactRecord(value, [
    'schemaVersion', 'proposalId', 'kind', 'text', 'subject', 'key', 'value', 'scope', 'provenance', 'relation', 'review', 'safety',
  ], path);
  const input = validateProposalInputV1(
    Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'proposalId')),
    path,
  );
  const id = proposalId(item.proposalId, `${path}.proposalId`);
  const expected = canonicalProposalIdV1(input);
  if (id !== expected) fail(`${path}.proposalId`, 'does not match the canonical proposal identity');
  return item as MemoryProposalV1;
}

const ENGLISH_SIGNAL_KINDS: Readonly<Record<string, MemoryProposalKindV1>> = Object.freeze({
  preference: 'preference',
  fact: 'fact',
  event: 'event',
  procedure: 'procedure',
});

const CHINESE_SIGNAL_KINDS: Readonly<Record<string, MemoryProposalKindV1>> = Object.freeze({
  '偏好': 'preference',
  '事实': 'fact',
  '事件': 'event',
  '流程': 'procedure',
});

type ParsedSignalLine =
  | { status: 'ignored' }
  | { status: 'rejected'; reason: string }
  | { status: 'accepted'; signal: Omit<ExplicitMemorySignalV1, 'evidenceLocator'> };

function normalizedField(raw: string, max: number): string | undefined {
  const value = normalizeProposalTextV1(raw);
  if (!value || value.length > max) return undefined;
  return value;
}

function parseSignalLineV1(rawLine: string): ParsedSignalLine {
  const line = rawLine.normalize('NFKC').trim();
  if (!line) return { status: 'ignored' };
  const english = line.match(/^\[memory:([^\]]+)\]\s*(.*)$/u);
  const chinese = line.match(/^\[记忆:([^\]]+)\]\s*(.*)$/u);
  if (!english && !chinese) {
    if (line.startsWith('[memory:') || line.startsWith('[记忆:')) return { status: 'rejected', reason: 'signal_malformed_marker' };
    return { status: 'ignored' };
  }
  const kindToken = (english ?? chinese)![1];
  const body = (english ?? chinese)![2];
  const kind = english ? ENGLISH_SIGNAL_KINDS[kindToken] : CHINESE_SIGNAL_KINDS[kindToken];
  if (!kind) return { status: 'rejected', reason: 'signal_unknown_kind' };
  const expected = english
    ? new Map([['subject', 'subject'], ['key', 'key'], ['value', 'value'], ['supersedes', 'supersedes']])
    : new Map([['主体', 'subject'], ['键', 'key'], ['值', 'value'], ['替代', 'supersedes']]);
  const fields = new Map<string, string>();
  for (const segment of body.split('|')) {
    const index = segment.indexOf('=');
    if (index <= 0) return { status: 'rejected', reason: 'signal_malformed_field' };
    const rawName = normalizeProposalTextV1(segment.slice(0, index));
    const name = expected.get(rawName);
    if (!name) return { status: 'rejected', reason: 'signal_unknown_field' };
    if (fields.has(name)) return { status: 'rejected', reason: 'signal_duplicate_field' };
    fields.set(name, segment.slice(index + 1));
  }
  if (!fields.has('subject') || !fields.has('key') || !fields.has('value')) {
    return { status: 'rejected', reason: 'signal_missing_field' };
  }
  const subject = normalizedField(fields.get('subject')!, 120);
  const key = normalizedField(fields.get('key')!, 120);
  const value = normalizedField(fields.get('value')!, 1200);
  if (!subject || !key || !value) return { status: 'rejected', reason: 'signal_field_out_of_bounds' };
  let supersedes: string | null = null;
  if (fields.has('supersedes')) {
    const normalized = normalizedField(fields.get('supersedes')!, 512);
    if (!normalized) return { status: 'rejected', reason: 'signal_field_out_of_bounds' };
    try {
      supersedes = explicitSupersedesTarget(normalized, 'signal.supersedes');
    } catch {
      return { status: 'rejected', reason: 'signal_supersedes_invalid' };
    }
  }
  return { status: 'accepted', signal: { kind, subject, key, value, supersedes } };
}

function transcriptTextBlocks(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content
    .filter((block): block is { type: 'text'; text: string } => (
      !!block && typeof block === 'object'
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string'
    ))
    .map((block) => block.text);
}

export function extractTranscriptMemorySignalsV1(raw: string): ExplicitMemorySignalExtractionV1 {
  if (typeof raw !== 'string') throw new Error('transcript_source_required');
  if (raw.length > 262_144) throw new Error('transcript_source_too_large');
  const signals: ExplicitMemorySignalV1[] = [];
  const rejected: ExplicitMemorySignalExtractionV1['rejected'] = [];
  const records = parseTranscript(raw);
  records.forEach((record, recordIndex) => {
    transcriptTextBlocks(record.message?.content).forEach((text, textIndex) => {
      text.split(/\r?\n/u).forEach((line, lineIndex) => {
        const evidenceLocator = `transcript:record:${recordIndex}:text:${textIndex}:line:${lineIndex + 1}`;
        const parsed = parseSignalLineV1(line);
        if (parsed.status === 'accepted') signals.push({ ...parsed.signal, evidenceLocator });
        else if (parsed.status === 'rejected') rejected.push({ evidenceLocator, reason: parsed.reason });
      });
    });
  });
  return { signals, rejected };
}

const RUNTIME_EVENT_NAMES_V1: readonly RuntimeLifecycleEventName[] = [
  'runtime.session_start',
  'runtime.session_reset',
  'runtime.before_prompt',
  'runtime.after_turn',
  'runtime.session_finalize',
  'runtime.session_end',
];

function normalizedRequestString(value: unknown, path: string, max: number): string {
  if (typeof value !== 'string') fail(path, 'must be a string');
  const normalized = normalizeProposalTextV1(value);
  if (!normalized) fail(path, 'must be non-empty');
  if (normalized.length > max) fail(path, `must be at most ${max} characters`);
  return normalized;
}

function normalizedNullableRequestString(value: unknown, path: string, max: number): string | null {
  if (value === null) return null;
  return normalizedRequestString(value, path, max);
}

function validateSourceEnvelopeV1(value: unknown, path: string): MemoryProposalSourceEnvelopeV1 {
  const item = exactRecord(value, [
    'sourceId', 'runtime', 'observedAt', 'declaredVisibility', 'projectScope', 'sourcePath', 'frontmatter',
  ], path);
  const sourceId = normalizedRequestString(item.sourceId, `${path}.sourceId`, 128);
  const runtime = normalizedRequestString(item.runtime, `${path}.runtime`, 64).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(runtime)) fail(`${path}.runtime`, 'must be slug-safe');
  const observedAt = normalizedRequestString(item.observedAt, `${path}.observedAt`, 64);
  if (!Number.isFinite(Date.parse(observedAt))) fail(`${path}.observedAt`, 'must be a valid timestamp');
  const declaredVisibility = exactLiteral(
    item.declaredVisibility,
    MEMORY_PROPOSAL_VISIBILITIES_V1,
    `${path}.declaredVisibility`,
  );
  const projectScope = normalizedRequestString(item.projectScope, `${path}.projectScope`, 64).toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(projectScope)) {
    fail(`${path}.projectScope`, 'must be explicit and slug-safe');
  }
  return {
    sourceId,
    runtime,
    observedAt,
    declaredVisibility,
    projectScope,
    sourcePath: normalizedNullableRequestString(item.sourcePath, `${path}.sourcePath`, 512),
    frontmatter: normalizedNullableRequestString(item.frontmatter, `${path}.frontmatter`, 2048),
  };
}

function validateRuntimeLifecycleEventV1(value: unknown, path: string): RuntimeLifecycleEvent {
  const item = exactRecord(
    value,
    ['schemaVersion', 'event', 'runtime', 'cwd', 'sessionId', 'platform', 'observedAt', 'promptDigest'],
    path,
    ['schemaVersion', 'event', 'runtime', 'cwd', 'observedAt'],
  );
  if (item.schemaVersion !== 1) fail(`${path}.schemaVersion`, 'must equal 1');
  const event = exactLiteral(item.event, RUNTIME_EVENT_NAMES_V1, `${path}.event`);
  const runtime = normalizedRequestString(item.runtime, `${path}.runtime`, 64);
  const cwd = normalizedRequestString(item.cwd, `${path}.cwd`, 4096);
  const observedAt = normalizedRequestString(item.observedAt, `${path}.observedAt`, 64);
  const result: RuntimeLifecycleEvent = {
    schemaVersion: 1,
    event,
    runtime,
    cwd,
    observedAt,
    ...(Object.hasOwn(item, 'sessionId') ? { sessionId: normalizedRequestString(item.sessionId, `${path}.sessionId`, 256) } : {}),
    ...(Object.hasOwn(item, 'platform') ? { platform: normalizedRequestString(item.platform, `${path}.platform`, 128) } : {}),
    ...(Object.hasOwn(item, 'promptDigest') ? { promptDigest: normalizedRequestString(item.promptDigest, `${path}.promptDigest`, 2000) } : {}),
  };
  try {
    runtimeEventToContextProbe(result);
  } catch (error) {
    fail(path, `failed runtime validation: ${error instanceof Error ? error.message : 'invalid'}`);
  }
  return result;
}

export function validateMemoryProposalRequestV1(value: unknown, path = 'request'): MemoryProposalRequestV1 {
  const base = exactRecord(value, ['schemaVersion', 'sourceKind', 'source', 'transcript', 'runtimeEvent', 'signalText'], path, [
    'schemaVersion', 'sourceKind', 'source',
  ]);
  if (base.schemaVersion !== 1) fail(`${path}.schemaVersion`, 'must equal 1');
  const sourceKind = exactLiteral(base.sourceKind, ['transcript', 'runtime-event'] as const, `${path}.sourceKind`);
  const source = validateSourceEnvelopeV1(base.source, `${path}.source`);
  if (sourceKind === 'transcript') {
    exactRecord(value, ['schemaVersion', 'sourceKind', 'source', 'transcript'], path);
    if (typeof base.transcript !== 'string') fail(`${path}.transcript`, 'must be a string');
    if (base.transcript.length > 262_144) fail(`${path}.transcript`, 'must be at most 262144 characters');
    return { schemaVersion: 1, sourceKind, source, transcript: base.transcript };
  }
  exactRecord(value, ['schemaVersion', 'sourceKind', 'source', 'runtimeEvent', 'signalText'], path);
  const runtimeEvent = validateRuntimeLifecycleEventV1(base.runtimeEvent, `${path}.runtimeEvent`);
  if (typeof base.signalText !== 'string') fail(`${path}.signalText`, 'must be a string');
  const signalText = base.signalText.normalize('NFKC').trim();
  if (!signalText) fail(`${path}.signalText`, 'must be non-empty');
  if (signalText.length > 4096) fail(`${path}.signalText`, 'must be at most 4096 characters');
  if (runtimeEvent.runtime.trim().toLowerCase() !== source.runtime) fail(`${path}.runtimeEvent.runtime`, 'must match source.runtime');
  if (Date.parse(runtimeEvent.observedAt) !== Date.parse(source.observedAt)) fail(`${path}.runtimeEvent.observedAt`, 'must match source.observedAt');
  if (runtimeEvent.sessionId && normalizeProposalTextV1(runtimeEvent.sessionId) !== source.sourceId) {
    fail(`${path}.runtimeEvent.sessionId`, 'must match source.sourceId when present');
  }
  return { schemaVersion: 1, sourceKind, source, runtimeEvent, signalText };
}

export function extractMemorySignalsV1(value: MemoryProposalRequestV1): ExplicitMemorySignalExtractionV1 {
  const request = validateMemoryProposalRequestV1(value);
  if (request.sourceKind === 'transcript') return extractTranscriptMemorySignalsV1(request.transcript);
  const signals: ExplicitMemorySignalV1[] = [];
  const rejected: ExplicitMemorySignalExtractionV1['rejected'] = [];
  request.signalText.split(/\r?\n/u).forEach((line, lineIndex) => {
    const evidenceLocator = `runtime-event:signal:line:${lineIndex + 1}`;
    const parsed = parseSignalLineV1(line);
    if (parsed.status === 'accepted') signals.push({ ...parsed.signal, evidenceLocator });
    else if (parsed.status === 'rejected') rejected.push({ evidenceLocator, reason: parsed.reason });
  });
  return { signals, rejected };
}

export function effectiveProposalVisibilityV1(source: MemoryProposalSourceEnvelopeV1): MemoryProposalVisibilityV1 {
  const pathEvidence = (source.sourcePath ?? '').normalize('NFKC').trim().toLowerCase().replace(/\\/g, '/');
  const frontmatter = (source.frontmatter ?? '').normalize('NFKC').trim().toLowerCase();
  const pathAudit = pathEvidence.startsWith('_events/')
    || pathEvidence.includes('/_events/')
    || pathEvidence.startsWith('audit/')
    || pathEvidence.includes('/audit/');
  const frontmatterAudit = /\b(visibility|scope)\s*:\s*["']?audit/u.test(frontmatter);
  if (source.declaredVisibility === 'audit-only' || pathAudit || frontmatterAudit) return 'audit-only';
  const pathPrivate = pathEvidence.startsWith('private/') || pathEvidence.includes('/private/');
  const frontmatterPrivate = /\b(visibility|scope)\s*:\s*["']?private/u.test(frontmatter);
  if (source.declaredVisibility === 'private' || pathPrivate || frontmatterPrivate) return 'private';
  const sourceLocal = pathEvidence.startsWith('sources/local/')
    || pathEvidence.includes('/source-local/')
    || /\b(source_visibility|visibility|scope)\s*:\s*["']?(source[-_ ]?local|local[-_ ]?source)/u.test(frontmatter);
  if (sourceLocal || source.declaredVisibility === 'source-local') return 'source-local';
  const sourceShared = pathEvidence.startsWith('sources/shared/')
    || pathEvidence.includes('/source-shared/')
    || /\b(source_visibility|visibility|scope)\s*:\s*["']?(source[-_ ]?shared|shared[-_ ]?source)/u.test(frontmatter);
  if (sourceShared || source.declaredVisibility === 'source-shared') return 'source-shared';
  return 'project';
}

function benignRedacted(value: string | null): string | null {
  return value === null ? null : normalizeProposalTextV1(redactIngestBenign(value));
}

export function safeProposalErrorMessageV1(error: unknown): string {
  const raw = String(error instanceof Error ? error.message : error);
  const redacted = redactSecretLikeContent(raw)
    .replace(/\b(?:\/[^\s:]+){2,}/g, '[path]')
    .replace(/\s+/gu, ' ')
    .trim();
  return (containsSecretLikeContent(redacted) ? '[redacted-error]' : redacted || 'proposal_error').slice(0, 240);
}

function sourceSha256(request: MemoryProposalRequestV1): string {
  if (request.sourceKind === 'transcript') {
    return crypto.createHash('sha256').update(request.transcript, 'utf8').digest('hex');
  }
  return canonicalSha256V1({ runtimeEvent: request.runtimeEvent, signalText: request.signalText });
}

function redactedSignal(signal: ExplicitMemorySignalV1): ExplicitMemorySignalV1 {
  return {
    ...signal,
    subject: benignRedacted(signal.subject)!,
    key: benignRedacted(signal.key)!,
    value: benignRedacted(signal.value)!,
    supersedes: benignRedacted(signal.supersedes),
  };
}

function renderedSignal(signal: ExplicitMemorySignalV1): string {
  return `[memory:${signal.kind}] subject=${signal.subject} | key=${signal.key} | value=${signal.value}${
    signal.supersedes ? ` | supersedes=${signal.supersedes}` : ''
  }`;
}

function proposalForSignal(
  request: MemoryProposalRequestV1,
  signal: ExplicitMemorySignalV1,
  effectiveVisibility: MemoryProposalVisibilityV1,
): MemoryProposalV1 {
  const safeSignal = redactedSignal(signal);
  return createMemoryProposalV1({
    schemaVersion: 1,
    kind: safeSignal.kind,
    text: renderedSignal(safeSignal),
    subject: safeSignal.subject,
    key: safeSignal.key,
    value: safeSignal.value,
    scope: {
      declaredVisibility: request.source.declaredVisibility,
      effectiveVisibility,
      projectScope: request.source.projectScope,
      sourcePath: benignRedacted(request.source.sourcePath),
      frontmatter: benignRedacted(request.source.frontmatter),
    },
    provenance: {
      sourceKind: request.sourceKind,
      sourceId: benignRedacted(request.source.sourceId)!,
      runtime: request.source.runtime,
      observedAt: request.source.observedAt,
      sourceSha256: sourceSha256(request),
      evidenceLocator: safeSignal.evidenceLocator,
    },
    relation: {
      verdict: 'new',
      targetProposalIds: [],
      targetPaths: [],
      reviewRequired: true,
      destructive: false,
      reason: 'no_existing_relation',
    },
    review: { mode: 'review-first', state: 'pending' },
    safety: {
      outcome: 'candidate-only',
      directDurableWrite: false,
      indexWrite: false,
      destructive: false,
      autoPromote: false,
    },
  });
}

function candidateMetadata(proposal: MemoryProposalV1, supersedes: string | null): Record<string, unknown> {
  return {
    proposal_schema_version: 1,
    proposal_id: proposal.proposalId,
    proposal_kind: proposal.kind,
    proposal_subject: proposal.subject,
    proposal_key: proposal.key,
    proposal_value: proposal.value,
    proposal_subject_normalized: normalizeRelationTextV1(proposal.subject),
    proposal_key_normalized: normalizeRelationTextV1(proposal.key),
    proposal_value_normalized: normalizeRelationTextV1(proposal.value),
    proposal_declared_visibility: proposal.scope.declaredVisibility,
    proposal_effective_visibility: proposal.scope.effectiveVisibility,
    proposal_project_scope: proposal.scope.projectScope,
    proposal_source_kind: proposal.provenance.sourceKind,
    proposal_source_id: proposal.provenance.sourceId,
    proposal_source_sha256: proposal.provenance.sourceSha256,
    proposal_observed_at: proposal.provenance.observedAt,
    proposal_evidence_locator: proposal.provenance.evidenceLocator,
    proposal_explicit_supersedes: supersedes,
    proposal_review_mode: 'review-first',
    proposal_review_state: 'pending',
    proposal_safety_outcome: 'candidate-only',
  };
}

type ExistingProposalEntryV1 = {
  proposalId: string;
  kind: MemoryProposalKindV1;
  subjectNormalized: string;
  keyNormalized: string;
  valueNormalized: string;
  path: string;
};

function frontmatterRecord(content: string): Record<string, unknown> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/u);
  if (!match) return {};
  const result: Record<string, unknown> = {};
  for (const line of match[1].split(/\r?\n/u)) {
    const index = line.indexOf(':');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    if (!key.startsWith('proposal_')) continue;
    const raw = line.slice(index + 1).trim();
    try {
      result[key] = JSON.parse(raw);
    } catch {
      result[key] = raw;
    }
  }
  return result;
}

async function existingProposalEntriesV1(
  workspace: Workspace,
  currentCandidatePath: string,
): Promise<ExistingProposalEntryV1[]> {
  const files = (await listFilesRecursive(workspace.memoryDir)).filter((file) => file.endsWith('.md'));
  const entries: ExistingProposalEntryV1[] = [];
  for (const file of files) {
    const relative = `memory/${path.relative(workspace.memoryDir, file).split(path.sep).join('/')}`;
    if (relative === currentCandidatePath) continue;
    let metadata: Record<string, unknown>;
    try {
      metadata = frontmatterRecord(await fs.readFile(file, 'utf8'));
    } catch {
      continue;
    }
    if (metadata.proposal_schema_version !== 1) continue;
    const id = metadata.proposal_id;
    const kind = metadata.proposal_kind;
    const subjectNormalized = metadata.proposal_subject_normalized;
    const keyNormalized = metadata.proposal_key_normalized;
    const valueNormalized = metadata.proposal_value_normalized;
    if (typeof id !== 'string' || !/^mp1_[0-9a-f]{64}$/.test(id)) continue;
    if (typeof kind !== 'string' || !MEMORY_PROPOSAL_KINDS_V1.includes(kind as MemoryProposalKindV1)) continue;
    if (typeof subjectNormalized !== 'string' || typeof keyNormalized !== 'string' || typeof valueNormalized !== 'string') continue;
    entries.push({
      proposalId: id,
      kind: kind as MemoryProposalKindV1,
      subjectNormalized,
      keyNormalized,
      valueNormalized,
      path: relative,
    });
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function relationResult(
  verdict: MemoryProposalRelationVerdictV1,
  entries: ExistingProposalEntryV1[],
  reason: string,
): MemoryProposalV1['relation'] {
  return {
    verdict,
    targetProposalIds: [...new Set(entries.map((entry) => entry.proposalId))].sort((a, b) => a.localeCompare(b)),
    targetPaths: [...new Set(entries.map((entry) => entry.path))].sort((a, b) => a.localeCompare(b)),
    reviewRequired: true,
    destructive: false,
    reason,
  };
}

function policyHasFlag(policy: unknown, kind: string): boolean {
  if (!policy || typeof policy !== 'object') return false;
  const flags = (policy as { flags?: unknown }).flags;
  return Array.isArray(flags) && flags.some((flag) => (
    !!flag && typeof flag === 'object' && (flag as { kind?: unknown }).kind === kind
  ));
}

export async function judgeProposalRelationV1(
  workspace: Workspace,
  proposal: MemoryProposalV1,
  currentCandidatePath: string,
  explicitSupersedes: string | null,
  durablePolicy?: unknown,
): Promise<MemoryProposalV1['relation']> {
  const entries = await existingProposalEntriesV1(workspace, currentCandidatePath);
  if (explicitSupersedes) {
    const explicitTargets = entries.filter((entry) => (
      entry.proposalId === explicitSupersedes || entry.path === explicitSupersedes
    ));
    if (explicitTargets.length > 0) return relationResult('supersedes', explicitTargets, 'explicit_existing_target');
    return relationResult('review_required', [], 'explicit_target_not_found');
  }
  const subject = normalizeRelationTextV1(proposal.subject);
  const key = normalizeRelationTextV1(proposal.key);
  const value = normalizeRelationTextV1(proposal.value);
  const sameKey = entries.filter((entry) => (
    entry.kind === proposal.kind
    && entry.subjectNormalized === subject
    && entry.keyNormalized === key
  ));
  const forgotten = await activeForgottenPathsV1(workspace);
  const forgottenTargets = sameKey.filter((entry) => forgotten.has(entry.path));
  if (forgottenTargets.length === 1) {
    return relationResult('supersedes', forgottenTargets, 'forgotten_correction_target');
  }
  if (forgottenTargets.length > 1) {
    return relationResult('review_required', forgottenTargets, 'ambiguous_forgotten_correction_targets');
  }
  if (policyHasFlag(durablePolicy, 'stale_candidate')) {
    return relationResult('review_required', [], 'stale_language_is_not_supersession');
  }
  const duplicates = sameKey.filter((entry) => entry.valueNormalized === value);
  const conflicts = sameKey.filter((entry) => entry.valueNormalized !== value);
  if (duplicates.length > 0 && conflicts.length > 0) {
    return relationResult('review_required', [...duplicates, ...conflicts], 'ambiguous_duplicate_and_conflict');
  }
  if (duplicates.length > 0) return relationResult('duplicate', duplicates, 'exact_normalized_duplicate');
  if (conflicts.length > 0) {
    const existingValues = new Set(conflicts.map((entry) => entry.valueNormalized));
    if (existingValues.size > 1) return relationResult('review_required', conflicts, 'ambiguous_multiple_conflicts');
    return relationResult('conflict', conflicts, 'same_key_different_value');
  }
  if (durablePolicy && typeof durablePolicy === 'object' && (durablePolicy as { reviewRequired?: unknown }).reviewRequired === true) {
    return relationResult('review_required', [], 'durable_policy_review_required');
  }
  return relationResult('new', [], 'no_existing_relation');
}

async function activeForgottenPathsV1(workspace: Workspace): Promise<Set<string>> {
  const forgotten = new Set<string>();
  let events: MemoryEvent[] = [];
  try {
    events = await readEventsAllLanes(workspace);
  } catch {
    return forgotten;
  }
  for (const event of events) {
    if (typeof event.path !== 'string') continue;
    if (event.type === 'memory.forgotten') forgotten.add(event.path);
    else if (event.type === 'memory.remembered') forgotten.delete(event.path);
  }
  return forgotten;
}

function boundedFeedbackString(value: string, max: number): { value: string; redacted: boolean } {
  const safe = redactSecretLikeContent(value);
  const clean = containsSecretLikeContent(safe) ? '[redacted]' : safe;
  const normalized = normalizeProposalTextV1(clean).slice(0, max) || '[redacted]';
  return { value: normalized, redacted: normalized !== value };
}

function feedbackIdentityProjection(value: Omit<MemoryFeedbackEvidenceV1, 'feedbackId'> | MemoryFeedbackEvidenceV1): unknown {
  return {
    schemaVersion: 1,
    kind: value.kind,
    eventId: value.eventId,
    eventAt: value.eventAt,
    targetPath: value.targetPath,
    provenance: value.provenance,
  };
}

function canonicalFeedbackIdV1(value: Omit<MemoryFeedbackEvidenceV1, 'feedbackId'> | MemoryFeedbackEvidenceV1): string {
  return `mfb1_${canonicalSha256V1(feedbackIdentityProjection(value))}`;
}

export function validateMemoryFeedbackEvidenceV1(value: unknown, path = 'feedback'): MemoryFeedbackEvidenceV1 {
  const item = exactRecord(value, [
    'schemaVersion', 'feedbackId', 'kind', 'eventId', 'eventAt', 'targetPath', 'provenance', 'safety',
  ], path);
  if (item.schemaVersion !== 1) fail(`${path}.schemaVersion`, 'must equal 1');
  if (typeof item.feedbackId !== 'string' || !/^mfb1_[0-9a-f]{64}$/.test(item.feedbackId)) {
    fail(`${path}.feedbackId`, 'must be a canonical feedback id');
  }
  exactLiteral(item.kind, ['negative-correction', 'restoration'] as const, `${path}.kind`);
  boundedString(item.eventId, `${path}.eventId`, 128);
  const eventAt = boundedString(item.eventAt, `${path}.eventAt`, 64);
  if (!Number.isFinite(Date.parse(eventAt))) fail(`${path}.eventAt`, 'must be a valid timestamp');
  boundedString(item.targetPath, `${path}.targetPath`, 512);
  const provenance = exactRecord(item.provenance, ['eventType'], `${path}.provenance`);
  exactLiteral(provenance.eventType, ['memory.forgotten', 'memory.remembered'] as const, `${path}.provenance.eventType`);
  const safety = exactRecord(item.safety, ['redacted', 'bounded', 'durableWrite'], `${path}.safety`);
  if (typeof safety.redacted !== 'boolean') fail(`${path}.safety.redacted`, 'must be a boolean');
  exactBoolean(safety.bounded, true, `${path}.safety.bounded`);
  exactBoolean(safety.durableWrite, false, `${path}.safety.durableWrite`);
  const expected = canonicalFeedbackIdV1(item as unknown as MemoryFeedbackEvidenceV1);
  if (item.feedbackId !== expected) fail(`${path}.feedbackId`, 'does not match canonical feedback identity');
  return item as MemoryFeedbackEvidenceV1;
}

export function feedbackEvidenceFromEventsV1(events: readonly unknown[]): MemoryFeedbackEvidenceV1[] {
  const evidence: MemoryFeedbackEvidenceV1[] = [];
  for (const raw of events) {
    if (!raw || typeof raw !== 'object') continue;
    const event = raw as { id?: unknown; type?: unknown; at?: unknown; path?: unknown };
    if (event.type !== 'memory.forgotten' && event.type !== 'memory.remembered') continue;
    if (typeof event.id !== 'string' || typeof event.at !== 'string' || typeof event.path !== 'string') continue;
    if (!Number.isFinite(Date.parse(event.at))) continue;
    const safeId = boundedFeedbackString(event.id, 128);
    const safeAt = boundedFeedbackString(event.at, 64);
    const safePath = boundedFeedbackString(event.path, 512);
    const input: Omit<MemoryFeedbackEvidenceV1, 'feedbackId'> = {
      schemaVersion: 1,
      kind: event.type === 'memory.forgotten' ? 'negative-correction' : 'restoration',
      eventId: safeId.value,
      eventAt: safeAt.value,
      targetPath: safePath.value,
      provenance: { eventType: event.type },
      safety: {
        redacted: safeId.redacted || safeAt.redacted || safePath.redacted,
        bounded: true,
        durableWrite: false,
      },
    };
    evidence.push(validateMemoryFeedbackEvidenceV1({ ...input, feedbackId: canonicalFeedbackIdV1(input) }));
  }
  return evidence;
}

function requestContainsResidualSecret(
  request: MemoryProposalRequestV1,
  signals: ExplicitMemorySignalV1[],
): boolean {
  const sourceValues = [
    request.source.sourceId,
    request.source.runtime,
    request.source.observedAt,
    request.source.projectScope,
    request.source.sourcePath ?? '',
    request.source.frontmatter ?? '',
  ];
  const signalValues = signals.flatMap((signal) => [
    signal.subject,
    signal.key,
    signal.value,
    signal.supersedes ?? '',
  ]);
  return [...sourceValues, ...signalValues]
    .map((value) => redactIngestBenign(value))
    .some((value) => containsSecretLikeContent(value));
}

export async function proposeMemoryV1(
  workspace: Workspace,
  rawRequest: unknown,
): Promise<MemoryProposalResultV1[]> {
  let request: MemoryProposalRequestV1;
  try {
    request = validateMemoryProposalRequestV1(rawRequest);
  } catch {
    return [{ schemaVersion: 1, status: 'blocked', reason: 'malformed_input' }];
  }
  const extraction = extractMemorySignalsV1(request);
  if (extraction.rejected.length > 0 && extraction.signals.length === 0) {
    return extraction.rejected.map(() => ({ schemaVersion: 1, status: 'blocked', reason: 'malformed_signal' }));
  }
  if (extraction.signals.length === 0) {
    return [{ schemaVersion: 1, status: 'ignored', reason: 'no_explicit_signal' }];
  }
  if (requestContainsResidualSecret(request, extraction.signals)) {
    return [{ schemaVersion: 1, status: 'blocked', reason: 'secret' }];
  }
  const visibility = effectiveProposalVisibilityV1(request.source);
  if (visibility === 'private' || visibility === 'audit-only') {
    return [{ schemaVersion: 1, status: 'blocked', reason: visibility }];
  }

  const results: MemoryProposalResultV1[] = [];
  for (const signal of extraction.signals) {
    let proposal = proposalForSignal(request, signal, visibility);
    const candidate = await writeCandidate(workspace, {
      text: proposal.text,
      title: `memory-proposal-${proposal.kind}-${proposal.proposalId.slice(4, 16)}`,
      sourceAgent: 'memory-proposals',
      autoPromote: false,
      metadata: candidateMetadata(proposal, signal.supersedes),
    });
    let relationError: string | null = null;
    try {
      const dryRun = await durablePromoteCandidate(workspace, candidate.path, {
        dryRun: true,
        actor: 'memory-proposals-review',
        target: {
          scope: proposal.scope.projectScope,
          title: `memory-proposal-${proposal.kind}`,
        },
      });
      const policy = dryRun.plan.auditEvent.metadata.durableWritePolicy;
      proposal = validateMemoryProposalV1({
        ...proposal,
        relation: await judgeProposalRelationV1(workspace, proposal, candidate.path, signal.supersedes, policy),
      });
    } catch (error) {
      relationError = safeProposalErrorMessageV1(error);
      proposal = validateMemoryProposalV1({
        ...proposal,
        relation: {
          ...proposal.relation,
          verdict: 'review_required',
          reason: 'relation_evaluation_failed',
        },
      });
    }
    results.push({
      schemaVersion: 1,
      status: 'staged',
      proposal,
      candidate: { candidateId: candidate.candidateId, path: candidate.path },
      relationError,
    });
  }
  if (extraction.rejected.length > 0) {
    results.push(...extraction.rejected.map(() => ({ schemaVersion: 1 as const, status: 'blocked' as const, reason: 'malformed_signal' as const })));
  }
  return results;
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function listFilesRecursive(root: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...await listFilesRecursive(absolute));
    else if (entry.isFile()) out.push(absolute);
  }
  return out;
}

async function persistenceSurface(
  files: string[],
  labels: Map<string, string> = new Map(),
): Promise<ProposalPersistenceSurfaceV1> {
  const unique = [...new Set(files.map((file) => path.resolve(file)))].sort((a, b) => a.localeCompare(b));
  const entries: ProposalPersistenceSurfaceV1['files'] = [];
  for (const file of unique) {
    const data = await fs.readFile(file);
    entries.push({
      path: labels.get(file) ?? path.basename(file),
      bytes: data.length,
      sha256: crypto.createHash('sha256').update(data).digest('hex'),
    });
  }
  return {
    fileCount: entries.length,
    totalBytes: entries.reduce((total, entry) => total + entry.bytes, 0),
    sha256: canonicalSha256V1(entries),
    files: entries,
  };
}

async function filesUnder(root: string, prefix: string): Promise<{ files: string[]; labels: Map<string, string> }> {
  const files = await listFilesRecursive(root);
  return {
    files,
    labels: new Map(files.map((file) => [path.resolve(file), `${prefix}/${path.relative(root, file).split(path.sep).join('/')}`])),
  };
}

export async function proposalPersistenceCensusV1(workspace: Workspace): Promise<ProposalPersistenceCensusV1> {
  const candidateTree = await filesUnder(workspace.candidatesDir, 'candidates');
  const historyTree = await filesUnder(workspace.historyDir, 'history');
  const eventRoots = [...new Set([workspace.eventsDir, path.join(workspace.mcpDir, '_events')].map((item) => path.resolve(item)))];
  const eventFiles: string[] = [];
  const eventLabels = new Map<string, string>();
  for (const [index, root] of eventRoots.entries()) {
    const tree = await filesUnder(root, `events-${index}`);
    eventFiles.push(...tree.files);
    for (const [key, value] of tree.labels) eventLabels.set(key, value);
  }
  const excludedDurableRoots = [
    workspace.candidatesDir,
    workspace.eventsDir,
    workspace.historyDir,
    workspace.journalDir,
    path.join(workspace.memoryDir, 'candidate'),
    path.join(workspace.memoryDir, '_events'),
    path.join(workspace.memoryDir, 'journal'),
    path.join(workspace.mcpDir, 'candidates'),
    path.join(workspace.mcpDir, '_events'),
    path.join(workspace.mcpDir, 'history'),
    path.join(workspace.mcpDir, 'journal'),
  ].map((item) => path.resolve(item));
  const memoryFiles = (await listFilesRecursive(workspace.memoryDir))
    .filter((file) => !excludedDurableRoots.some((root) => isInside(root, file)));
  const projectTree = await filesUnder(path.join(workspace.spaceDir, 'projects'), 'projects');
  const durableLabels = new Map<string, string>();
  for (const file of memoryFiles) durableLabels.set(path.resolve(file), `memory/${path.relative(workspace.memoryDir, file).split(path.sep).join('/')}`);
  for (const [key, value] of projectTree.labels) durableLabels.set(key, value);
  const indexFamily = (await listFilesRecursive(workspace.spaceDir)).filter((file) => (
    path.dirname(file) === path.resolve(workspace.spaceDir)
    && path.basename(file).startsWith(path.basename(workspace.indexPath))
  ));
  const ftsLabels = new Map(indexFamily.map((file) => [path.resolve(file), path.basename(file)]));
  const manifestFiles = await fs.access(workspace.indexManifestPath).then(() => [workspace.indexManifestPath], () => [] as string[]);
  const indexLabels = new Map(manifestFiles.map((file) => [path.resolve(file), path.basename(file)]));
  const eventSurface = await persistenceSurface(eventFiles, eventLabels);
  const eventTypes: string[] = [];
  for (const file of [...new Set(eventFiles)].sort((a, b) => a.localeCompare(b))) {
    const raw = await fs.readFile(file, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as { type?: unknown };
        if (typeof event.type === 'string') eventTypes.push(event.type);
      } catch {
        eventTypes.push('malformed');
      }
    }
  }
  return {
    candidates: await persistenceSurface(candidateTree.files, candidateTree.labels),
    durable: await persistenceSurface([...memoryFiles, ...projectTree.files], durableLabels),
    history: await persistenceSurface(historyTree.files, historyTree.labels),
    events: { ...eventSurface, eventCount: eventTypes.length, eventTypes },
    fts: await persistenceSurface(indexFamily, ftsLabels),
    indexManifest: await persistenceSurface(manifestFiles, indexLabels),
  };
}
