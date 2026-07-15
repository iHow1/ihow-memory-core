// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import crypto from 'node:crypto';
import { containsSecretLikeContent, redactIngestBenign, redactSecretLikeContent } from './governance.ts';

export const CHECKPOINT_ARTIFACT_MAX_BYTES = 32 * 1024;
export const CHECKPOINT_DRAFT_MAX_BYTES = 32 * 1024;
const CHECKPOINT_DRAFT_ARTIFACT_RESERVE_BYTES = 2 * 1024;
export const CHECKPOINT_DEFAULT_LIST_LIMIT = 20;
export const CHECKPOINT_TEXT_MAX_CHARS = 512;
export const CHECKPOINT_EVIDENCE_MAX_ITEMS = 24;
export const CHECKPOINT_FILE_ANCHOR_MAX_ITEMS = 32;

const STATE_LIST_MAX_ITEMS = 20;
const COMMAND_ANCHOR_MAX_ITEMS = 20;
const SHA256_RE = /^[a-f0-9]{64}$/;
const CHECKPOINT_ID_RE = /^cp_[a-f0-9]{64}$/;
const DRAFT_ID_RE = /^draft_[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const OMITTED_COUNT_KEY_RE = /^[A-Za-z][A-Za-z0-9_.]{0,127}$/;
const CHECKPOINT_ANCHOR_OMISSION_KEYS = new Set([
  'anchors.git.repo.characters',
  'anchors.git.branch.characters',
  'anchors.files.items',
  'anchors.files.path.characters',
  'anchors.commands.items',
  'anchors.commands.label.characters',
]);
const TRIGGER_KINDS = new Set(['pre_compact', 'phase_boundary', 'session_end', 'explicit', 'rolling', 'crash_floor']);
const TRIGGER_SIGNALS = new Set(['native', 'estimated', 'shadow']);
const CHECKPOINT_NATURAL_SECRET_RE = /\b(?:the\s+)?(?:api[\s_-]*key|password|passwd|passphrase|secret|passcode|credential|access[\s_-]*token|refresh[\s_-]*token|client[\s_-]*secret)s?\s+(?:is|was|are|were)\s*(?::|=)?\s*((?:"[^"\r\n]+"|'[^'\r\n]+'|`[^`\r\n]+`)|[^\s]+)/gi;
const CHECKPOINT_SAFE_SECRET_STATUS_WORDS = new Set([
  'absent', 'compromised', 'configured', 'disclosed', 'expired', 'exposed', 'invalid', 'leaked',
  'managed', 'masked', 'missing', 'omitted', 'placeholder', 'protected', 'redacted', 'removed',
  'required', 'revealed', 'revoked', 'rotated', 'stored', 'unknown', 'unavailable', 'unset', 'valid',
]);

export type CheckpointTriggerKind = 'pre_compact' | 'phase_boundary' | 'session_end' | 'explicit' | 'rolling' | 'crash_floor';
export type CheckpointTriggerSignal = 'native' | 'estimated' | 'shadow';

export type CheckpointProjectIdentity = {
  cwdHash: string;
  workspaceId?: string;
  projectId?: string;
};

export type CheckpointSessionIdentity = {
  runtime: string;
  sessionIdHash?: string;
};

export type CheckpointClaims = {
  objective?: string;
  completed: string[];
  pending: string[];
  decisions: string[];
  blockers: string[];
  nextActions: string[];
};

export type CheckpointEvidence = { kind: string; ref: string; sha256?: string };

export type CheckpointMachineAnchors = {
  git?: { repo: string; branch?: string; head?: string; dirty?: boolean; statusHash?: string };
  files: Array<{ path: string; sha256?: string; mtime?: string }>;
  commands: Array<{ label: string; exitCode?: number; outputHash?: string }>;
};

export type CheckpointCoverage = {
  complete: boolean;
  fromCheckpointId?: string;
  eventCount?: number;
  omittedCounts: Record<string, number>;
};

export type CheckpointArtifactV1 = {
  schemaVersion: 1;
  id: string;
  project: CheckpointProjectIdentity;
  session: CheckpointSessionIdentity;
  createdAt: string;
  trigger: {
    kind: CheckpointTriggerKind;
    signal: CheckpointTriggerSignal;
    sourceEvent?: string;
    reasonCode: string;
  };
  state: CheckpointClaims;
  anchors: CheckpointMachineAnchors;
  evidence: CheckpointEvidence[];
  coverage: CheckpointCoverage;
  redaction: { applied: boolean; count: number };
  supersedes?: string;
  integrity: { contentSha256: string };
};

export type CheckpointDraftV1 = {
  schemaVersion: 1;
  draftId: string;
  project: CheckpointProjectIdentity;
  session: CheckpointSessionIdentity;
  createdAt: string;
  updatedAt: string;
  claims: CheckpointClaims;
  evidence: CheckpointEvidence[];
  coverage: Omit<CheckpointCoverage, 'omittedCounts'> & { omittedCounts: Record<string, number> };
  redaction: { applied: boolean; count: number };
  finalization?: { artifactId: string };
};

export type CheckpointClaimsInput = {
  objective?: string;
  completed?: string[];
  pending?: string[];
  decisions?: string[];
  blockers?: string[];
  nextActions?: string[];
  evidence?: CheckpointEvidence[];
  coverage?: { complete?: boolean; fromCheckpointId?: string; eventCount?: number };
};

export type CheckpointFinalizeRequest = {
  trigger: {
    kind: CheckpointTriggerKind;
    signal: CheckpointTriggerSignal;
    sourceEvent?: string;
    reasonCode: string;
  };
  supersedes?: string;
};

// Private deterministic construction inputs persisted by the checkpoint store while finalization is
// in flight. They are deliberately separate from the public CheckpointArtifactV1 schema.
export type CheckpointArtifactBuildV1 = {
  createdAt: string;
  trigger: CheckpointArtifactV1['trigger'];
  anchors: CheckpointMachineAnchors;
  anchorOmittedCounts: Record<string, number>;
  anchorRedaction: { applied: boolean; count: number };
  supersedes?: string;
};

export function isCheckpointAnchorOmissionKey(key: string): boolean {
  return CHECKPOINT_ANCHOR_OMISSION_KEYS.has(key);
}

export class CheckpointValidationError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'CheckpointValidationError';
    this.code = code;
  }
}

function fail(code: string): never {
  throw new CheckpointValidationError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: unknown, allowed: readonly string[], at: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`checkpoint_schema_${at}_object_required`);
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) fail(`checkpoint_schema_${at}_unknown_field`);
  }
  return value;
}

function requiredString(value: unknown, at: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(`checkpoint_schema_${at}_string_required`);
  return value;
}

function optionalString(value: unknown, at: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, at);
}

function bool(value: unknown, at: string): boolean {
  if (typeof value !== 'boolean') fail(`checkpoint_schema_${at}_boolean_required`);
  return value;
}

function integer(value: unknown, at: string): number {
  if (!Number.isSafeInteger(value)) fail(`checkpoint_schema_${at}_integer_required`);
  return value as number;
}

function iso(value: unknown, at: string): string {
  const text = requiredString(value, at);
  if (Number.isNaN(Date.parse(text)) || new Date(text).toISOString() !== text) fail(`checkpoint_schema_${at}_iso_required`);
  return text;
}

function sha256(value: unknown, at: string): string {
  const text = requiredString(value, at);
  if (!SHA256_RE.test(text)) fail(`checkpoint_schema_${at}_sha256_required`);
  return text;
}

function checkpointId(value: unknown, at: string): string {
  const text = requiredString(value, at);
  if (!CHECKPOINT_ID_RE.test(text)) fail(`checkpoint_schema_${at}_id_required`);
  return text;
}

function stringArray(value: unknown, at: string): string[] {
  if (!Array.isArray(value)) fail(`checkpoint_schema_${at}_array_required`);
  return value.map((entry, index) => requiredString(entry, `${at}_${index}`));
}

function codePoints(value: string): string[] {
  return Array.from(value);
}

function containsCheckpointNaturalLanguageSecret(text: string): boolean {
  CHECKPOINT_NATURAL_SECRET_RE.lastIndex = 0;
  for (const match of text.matchAll(CHECKPOINT_NATURAL_SECRET_RE)) {
    const rawValue = match[1] ?? '';
    const quoted = /^(["'`]).*\1$/s.test(rawValue);
    const value = rawValue
      .replace(/^["'`]|["'`]$/g, '')
      .replace(/[:.!?),;]*$/g, '')
      .toLowerCase();
    if (!value) return true;
    if (/^\[?redacted\]?$/.test(value) || /^<redacted>$/.test(value)) continue;
    const after = text.slice((match.index ?? 0) + match[0].length);
    // Status prose is allowed only when the status word is followed by explicit context. A terminal
    // `password is valid` remains secret-like: `valid` can itself be the credential value.
    if (
      !quoted
      && CHECKPOINT_SAFE_SECRET_STATUS_WORDS.has(value)
      && /^[\s,;:()\-]*(?:before|after|during|in|inside|on|at|by|for|to|until|within|outside|from)\b/i.test(after)
    ) continue;
    return true;
  }
  return false;
}

function containsCheckpointSecretLikeContent(text: string): boolean {
  return containsSecretLikeContent(text) || containsCheckpointNaturalLanguageSecret(text);
}

function truncateText(value: string, max: number, omitted: Record<string, number>, key: string): string {
  const chars = codePoints(value.trim());
  if (!chars.length) fail(`checkpoint_schema_${key.replace(/[^a-z0-9]+/gi, '_')}_string_required`);
  if (chars.length <= max) return chars.join('');
  omitted[key] = (omitted[key] ?? 0) + chars.length - max;
  return chars.slice(0, max).join('');
}

function sanitizeText(value: unknown, at: string, omitted: Record<string, number>, omittedKey: string, redaction: { count: number }, max = CHECKPOINT_TEXT_MAX_CHARS): string {
  const raw = requiredString(value, at).trim();
  let sanitized: string;
  try {
    // Checkpoint persistence is intentionally stricter than general memory ingest. Direct natural-language
    // credential assignments are rejected before benign PII redaction can mask an email-shaped value.
    if (containsCheckpointNaturalLanguageSecret(raw)) fail('checkpoint_secret_rejected');
    const benign = redactIngestBenign(raw);
    if (containsCheckpointSecretLikeContent(benign)) fail('checkpoint_secret_rejected');
    sanitized = redactSecretLikeContent(benign);
    if (containsCheckpointSecretLikeContent(sanitized)) fail('checkpoint_sanitizer_residual_secret');
  } catch (error) {
    if (error instanceof CheckpointValidationError) throw error;
    fail('checkpoint_sanitizer_failed');
  }
  if (sanitized !== raw) redaction.count += 1;
  return truncateText(sanitized, max, omitted, omittedKey);
}

function sanitizeOptionalText(value: unknown, at: string, omitted: Record<string, number>, omittedKey: string, redaction: { count: number }, max = CHECKPOINT_TEXT_MAX_CHARS): string | undefined {
  if (value === undefined) return undefined;
  return sanitizeText(value, at, omitted, omittedKey, redaction, max);
}

function boundedArray<T>(items: T[], max: number, omitted: Record<string, number>, key: string): T[] {
  if (items.length <= max) return items;
  omitted[key] = (omitted[key] ?? 0) + items.length - max;
  return items.slice(0, max);
}

function sanitizeStringList(value: unknown, at: string, omitted: Record<string, number>, redaction: { count: number }): string[] {
  const raw = value === undefined ? [] : stringArray(value, at);
  const bounded = boundedArray(raw, STATE_LIST_MAX_ITEMS, omitted, `${at}.items`);
  return bounded.map((entry, index) => sanitizeText(entry, `${at}_${index}`, omitted, `${at}.characters`, redaction));
}

function normalizeEvidence(value: unknown, omitted: Record<string, number>, redaction: { count: number }): CheckpointEvidence[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail('checkpoint_schema_evidence_array_required');
  const bounded = boundedArray(value, CHECKPOINT_EVIDENCE_MAX_ITEMS, omitted, 'evidence.items');
  return bounded.map((entry, index) => {
    const item = exactKeys(entry, ['kind', 'ref', 'sha256'], `evidence_${index}`);
    return {
      kind: sanitizeText(item.kind, `evidence_${index}_kind`, omitted, 'evidence.kind.characters', redaction),
      ref: sanitizeText(item.ref, `evidence_${index}_ref`, omitted, 'evidence.ref.characters', redaction),
      ...(item.sha256 === undefined ? {} : { sha256: sha256(item.sha256, `evidence_${index}_sha256`) }),
    };
  });
}

function normalizeCoverageInput(value: unknown): { complete: boolean; fromCheckpointId?: string; eventCount?: number } {
  if (value === undefined) return { complete: false };
  const item = exactKeys(value, ['complete', 'fromCheckpointId', 'eventCount'], 'coverage');
  const complete = item.complete === undefined ? false : bool(item.complete, 'coverage_complete');
  const fromCheckpointId = item.fromCheckpointId === undefined ? undefined : checkpointId(item.fromCheckpointId, 'coverage_from_checkpoint_id');
  const eventCount = item.eventCount === undefined ? undefined : integer(item.eventCount, 'coverage_event_count');
  if (eventCount !== undefined && eventCount < 0) fail('checkpoint_schema_coverage_event_count_range');
  return { complete, ...(fromCheckpointId ? { fromCheckpointId } : {}), ...(eventCount !== undefined ? { eventCount } : {}) };
}

export function normalizeCheckpointClaimsInput(value: unknown): {
  claims: CheckpointClaims;
  evidence: CheckpointEvidence[];
  coverage: { complete: boolean; fromCheckpointId?: string; eventCount?: number; omittedCounts: Record<string, number> };
  redaction: { applied: boolean; count: number };
} {
  const input = exactKeys(value ?? {}, ['objective', 'completed', 'pending', 'decisions', 'blockers', 'nextActions', 'evidence', 'coverage'], 'claims_input');
  const omittedCounts: Record<string, number> = {};
  const redaction = { count: 0 };
  const objective = sanitizeOptionalText(input.objective, 'state_objective', omittedCounts, 'state.objective.characters', redaction);
  const claims: CheckpointClaims = {
    ...(objective ? { objective } : {}),
    completed: sanitizeStringList(input.completed, 'state.completed', omittedCounts, redaction),
    pending: sanitizeStringList(input.pending, 'state.pending', omittedCounts, redaction),
    decisions: sanitizeStringList(input.decisions, 'state.decisions', omittedCounts, redaction),
    blockers: sanitizeStringList(input.blockers, 'state.blockers', omittedCounts, redaction),
    nextActions: sanitizeStringList(input.nextActions, 'state.nextActions', omittedCounts, redaction),
  };
  const evidence = normalizeEvidence(input.evidence, omittedCounts, redaction);
  const coverage = normalizeCoverageInput(input.coverage);
  return {
    claims,
    evidence,
    coverage: {
      ...coverage,
      complete: coverage.complete && Object.keys(omittedCounts).length === 0,
      omittedCounts,
    },
    redaction: { applied: redaction.count > 0, count: redaction.count },
  };
}

export function normalizeCheckpointSession(runtime: unknown, sessionId: unknown): CheckpointSessionIdentity {
  const omitted: Record<string, number> = {};
  const redaction = { count: 0 };
  const safeRuntime = sanitizeText(runtime, 'session_runtime', omitted, 'session.runtime.characters', redaction, 128);
  if (redaction.count || Object.keys(omitted).length) fail('checkpoint_schema_session_runtime_requires_non_sensitive_code');
  if (sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId)) fail('checkpoint_schema_session_id_string_required');
  return {
    runtime: safeRuntime,
    ...(typeof sessionId === 'string' ? { sessionIdHash: crypto.createHash('sha256').update(sessionId).digest('hex') } : {}),
  };
}

export function validateDraftCreateInput(value: unknown): { runtime: string; sessionId?: string; claims: unknown } {
  const input = exactKeys(value, ['runtime', 'sessionId', 'claims'], 'draft_create');
  return {
    runtime: requiredString(input.runtime, 'draft_runtime'),
    ...(input.sessionId === undefined ? {} : { sessionId: requiredString(input.sessionId, 'draft_session_id') }),
    claims: input.claims ?? {},
  };
}

export function validateDraftUpdateInput(value: unknown): unknown {
  const input = exactKeys(value, ['claims'], 'draft_update');
  return input.claims ?? {};
}

export function validateFinalizeRequest(value: unknown): CheckpointFinalizeRequest {
  const input = exactKeys(value, ['trigger', 'supersedes'], 'finalize');
  const trigger = exactKeys(input.trigger, ['kind', 'signal', 'sourceEvent', 'reasonCode'], 'trigger');
  const kind = requiredString(trigger.kind, 'trigger_kind');
  const signal = requiredString(trigger.signal, 'trigger_signal');
  if (!TRIGGER_KINDS.has(kind)) fail('checkpoint_schema_trigger_kind_invalid');
  if (!TRIGGER_SIGNALS.has(signal)) fail('checkpoint_schema_trigger_signal_invalid');
  const omitted: Record<string, number> = {};
  const redaction = { count: 0 };
  const sourceEvent = sanitizeOptionalText(trigger.sourceEvent, 'trigger_source_event', omitted, 'trigger.sourceEvent.characters', redaction, 128);
  const reasonCode = sanitizeText(trigger.reasonCode, 'trigger_reason_code', omitted, 'trigger.reasonCode.characters', redaction, 128);
  if (redaction.count) fail('checkpoint_schema_trigger_requires_non_sensitive_codes');
  return {
    trigger: { kind: kind as CheckpointTriggerKind, signal: signal as CheckpointTriggerSignal, ...(sourceEvent ? { sourceEvent } : {}), reasonCode },
    ...(input.supersedes === undefined ? {} : { supersedes: checkpointId(input.supersedes, 'supersedes') }),
  };
}

export function normalizeMachineAnchors(value: unknown): { anchors: CheckpointMachineAnchors; omittedCounts: Record<string, number>; redaction: { applied: boolean; count: number } } {
  const input = exactKeys(value, ['git', 'files', 'commands'], 'machine_anchors');
  const omittedCounts: Record<string, number> = {};
  const redaction = { count: 0 };
  let git: CheckpointMachineAnchors['git'];
  if (input.git !== undefined) {
    const item = exactKeys(input.git, ['repo', 'branch', 'head', 'dirty', 'statusHash'], 'anchor_git');
    git = {
      repo: sanitizeText(item.repo, 'anchor_git_repo', omittedCounts, 'anchors.git.repo.characters', redaction),
      ...(item.branch === undefined ? {} : { branch: sanitizeText(item.branch, 'anchor_git_branch', omittedCounts, 'anchors.git.branch.characters', redaction) }),
      ...(item.head === undefined ? {} : { head: sanitizeText(item.head, 'anchor_git_head', omittedCounts, 'anchors.git.head.characters', redaction, 128) }),
      ...(item.dirty === undefined ? {} : { dirty: bool(item.dirty, 'anchor_git_dirty') }),
      ...(item.statusHash === undefined ? {} : { statusHash: sha256(item.statusHash, 'anchor_git_status_hash') }),
    };
  }
  const rawFiles = input.files === undefined ? [] : input.files;
  if (!Array.isArray(rawFiles)) fail('checkpoint_schema_anchor_files_array_required');
  const files = boundedArray(rawFiles, CHECKPOINT_FILE_ANCHOR_MAX_ITEMS, omittedCounts, 'anchors.files.items').map((entry, index) => {
    const item = exactKeys(entry, ['path', 'sha256', 'mtime'], `anchor_file_${index}`);
    return {
      path: sanitizeText(item.path, `anchor_file_${index}_path`, omittedCounts, 'anchors.files.path.characters', redaction),
      ...(item.sha256 === undefined ? {} : { sha256: sha256(item.sha256, `anchor_file_${index}_sha256`) }),
      ...(item.mtime === undefined ? {} : { mtime: iso(item.mtime, `anchor_file_${index}_mtime`) }),
    };
  });
  const rawCommands = input.commands === undefined ? [] : input.commands;
  if (!Array.isArray(rawCommands)) fail('checkpoint_schema_anchor_commands_array_required');
  const commands = boundedArray(rawCommands, COMMAND_ANCHOR_MAX_ITEMS, omittedCounts, 'anchors.commands.items').map((entry, index) => {
    const item = exactKeys(entry, ['label', 'exitCode', 'outputHash'], `anchor_command_${index}`);
    return {
      label: sanitizeText(item.label, `anchor_command_${index}_label`, omittedCounts, 'anchors.commands.label.characters', redaction),
      ...(item.exitCode === undefined ? {} : { exitCode: integer(item.exitCode, `anchor_command_${index}_exit_code`) }),
      ...(item.outputHash === undefined ? {} : { outputHash: sha256(item.outputHash, `anchor_command_${index}_output_hash`) }),
    };
  });
  return { anchors: { ...(git ? { git } : {}), files, commands }, omittedCounts, redaction: { applied: redaction.count > 0, count: redaction.count } };
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) out[key] = canonicalValue(entry);
    }
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) fail('checkpoint_schema_non_finite_number');
  return value;
}

export function canonicalCheckpointJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function hashPreimage(artifact: CheckpointArtifactV1): unknown {
  return { ...artifact, id: '', integrity: { contentSha256: '' } };
}

export function computeCheckpointContentSha256(artifact: CheckpointArtifactV1): string {
  return crypto.createHash('sha256').update(canonicalCheckpointJson(hashPreimage(artifact))).digest('hex');
}

function semanticPreimage(artifact: CheckpointArtifactV1): unknown {
  return {
    schemaVersion: artifact.schemaVersion,
    project: artifact.project,
    session: artifact.session,
    trigger: artifact.trigger,
    state: artifact.state,
    anchors: artifact.anchors,
    evidence: artifact.evidence,
    coverage: artifact.coverage,
    redaction: artifact.redaction,
    ...(artifact.supersedes ? { supersedes: artifact.supersedes } : {}),
  };
}

export function canonicalCheckpointSemanticJson(artifact: CheckpointArtifactV1): string {
  return canonicalCheckpointJson(semanticPreimage(artifact));
}

export function computeCheckpointSemanticSha256(artifact: CheckpointArtifactV1): string {
  return crypto.createHash('sha256').update(canonicalCheckpointSemanticJson(artifact)).digest('hex');
}

function mergeOmitted(...parts: Array<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of parts) {
    for (const [key, count] of Object.entries(part)) {
      if (count > 0) out[key] = (out[key] ?? 0) + count;
    }
  }
  return out;
}

function sizeWithHashPlaceholders(artifact: Omit<CheckpointArtifactV1, 'id' | 'integrity'>): number {
  const value: CheckpointArtifactV1 = {
    ...artifact,
    id: `cp_${'0'.repeat(64)}`,
    integrity: { contentSha256: '0'.repeat(64) },
  };
  return Buffer.byteLength(canonicalCheckpointJson(value), 'utf8');
}

function shrinkArtifactToMax(artifact: Omit<CheckpointArtifactV1, 'id' | 'integrity'>): void {
  type TextTarget = { key: string; get(): string | undefined; set(value: string): void };
  const anchorTargets = (): TextTarget[] => {
    const out: TextTarget[] = [];
    const push = (key: string, get: () => string | undefined, set: (value: string) => void) => out.push({ key, get, set });
    if (artifact.anchors.git) {
      push('anchors.git.repo.characters', () => artifact.anchors.git?.repo, (v) => { if (artifact.anchors.git) artifact.anchors.git.repo = v; });
      push('anchors.git.branch.characters', () => artifact.anchors.git?.branch, (v) => { if (artifact.anchors.git) artifact.anchors.git.branch = v; });
    }
    artifact.anchors.files.forEach((_, i) => push('anchors.files.path.characters', () => artifact.anchors.files[i].path, (v) => { artifact.anchors.files[i].path = v; }));
    artifact.anchors.commands.forEach((_, i) => push('anchors.commands.label.characters', () => artifact.anchors.commands[i].label, (v) => { artifact.anchors.commands[i].label = v; }));
    return out;
  };
  const draftTargets = (): TextTarget[] => {
    const out: TextTarget[] = [];
    const push = (key: string, get: () => string | undefined, set: (value: string) => void) => out.push({ key, get, set });
    push('state.objective.characters', () => artifact.state.objective, (v) => { artifact.state.objective = v; });
    for (const field of ['completed', 'pending', 'decisions', 'blockers', 'nextActions'] as const) {
      artifact.state[field].forEach((_, i) => push(`state.${field}.characters`, () => artifact.state[field][i], (v) => { artifact.state[field][i] = v; }));
    }
    artifact.evidence.forEach((_, i) => {
      push('evidence.kind.characters', () => artifact.evidence[i].kind, (v) => { artifact.evidence[i].kind = v; });
      push('evidence.ref.characters', () => artifact.evidence[i].ref, (v) => { artifact.evidence[i].ref = v; });
    });
    return out;
  };
  const shrinkTargets = (getTargets: () => TextTarget[]): void => {
    while (sizeWithHashPlaceholders(artifact) > CHECKPOINT_ARTIFACT_MAX_BYTES) {
      const candidates = getTargets()
        .map((target, index) => ({ target, index, length: codePoints(target.get() ?? '').length }))
        .filter((entry) => entry.length > 32)
        .sort((a, b) => b.length - a.length || a.target.key.localeCompare(b.target.key) || a.index - b.index);
      if (!candidates.length) break;
      const chosen = candidates[0];
      const current = codePoints(chosen.target.get() ?? '');
      const nextLength = Math.max(32, Math.floor(current.length / 2));
      chosen.target.set(current.slice(0, nextLength).join(''));
      artifact.coverage.omittedCounts[chosen.target.key] = (artifact.coverage.omittedCounts[chosen.target.key] ?? 0) + current.length - nextLength;
      artifact.coverage.complete = false;
    }
  };
  const dropFromLists = (lists: Array<{ key: string; value: unknown[] }>): void => {
    while (sizeWithHashPlaceholders(artifact) > CHECKPOINT_ARTIFACT_MAX_BYTES) {
      const list = lists.find((entry) => entry.value.length > 0);
      if (!list) break;
      list.value.pop();
      artifact.coverage.omittedCounts[list.key] = (artifact.coverage.omittedCounts[list.key] ?? 0) + 1;
      artifact.coverage.complete = false;
    }
  };

  // Machine-derived fields are exhausted before draft-derived fields. The draft reserve guarantees that
  // service finalization does not need the fallback below, making marker-only recovery reproducible.
  shrinkTargets(anchorTargets);
  dropFromLists([
    { key: 'anchors.commands.items', value: artifact.anchors.commands },
    { key: 'anchors.files.items', value: artifact.anchors.files },
  ]);
  shrinkTargets(draftTargets);
  dropFromLists([
    { key: 'evidence.items', value: artifact.evidence },
    { key: 'state.blockers.items', value: artifact.state.blockers },
    { key: 'state.decisions.items', value: artifact.state.decisions },
    { key: 'state.pending.items', value: artifact.state.pending },
    { key: 'state.completed.items', value: artifact.state.completed },
    { key: 'state.nextActions.items', value: artifact.state.nextActions },
  ]);
  if (sizeWithHashPlaceholders(artifact) > CHECKPOINT_ARTIFACT_MAX_BYTES) fail('checkpoint_artifact_size_limit_unreachable');
}

export function buildCheckpointArtifact(input: {
  project: CheckpointProjectIdentity;
  session: CheckpointSessionIdentity;
  createdAt: string;
  trigger: CheckpointArtifactV1['trigger'];
  state: CheckpointClaims;
  anchors: CheckpointMachineAnchors;
  evidence: CheckpointEvidence[];
  coverage: Omit<CheckpointCoverage, 'omittedCounts'> & { omittedCounts: Record<string, number> };
  redaction: { applied: boolean; count: number };
  supersedes?: string;
  anchorOmittedCounts?: Record<string, number>;
  anchorRedaction?: { applied: boolean; count: number };
}): CheckpointArtifactV1 {
  const omittedCounts = mergeOmitted(input.coverage.omittedCounts, input.anchorOmittedCounts ?? {});
  const base: Omit<CheckpointArtifactV1, 'id' | 'integrity'> = {
    schemaVersion: 1,
    project: input.project,
    session: input.session,
    createdAt: iso(input.createdAt, 'created_at'),
    trigger: input.trigger,
    state: structuredClone(input.state),
    anchors: structuredClone(input.anchors),
    evidence: structuredClone(input.evidence),
    coverage: {
      ...input.coverage,
      complete: input.coverage.complete && Object.keys(omittedCounts).length === 0,
      omittedCounts,
    },
    redaction: {
      applied: input.redaction.applied || !!input.anchorRedaction?.applied,
      count: input.redaction.count + (input.anchorRedaction?.count ?? 0),
    },
    ...(input.supersedes ? { supersedes: input.supersedes } : {}),
  };
  shrinkArtifactToMax(base);
  const placeholder: CheckpointArtifactV1 = {
    ...base,
    id: `cp_${'0'.repeat(64)}`,
    integrity: { contentSha256: '0'.repeat(64) },
  };
  const digest = computeCheckpointContentSha256(placeholder);
  const artifact: CheckpointArtifactV1 = {
    ...base,
    id: `cp_${digest}`,
    integrity: { contentSha256: digest },
  };
  validateCheckpointArtifact(artifact);
  return artifact;
}

function shrinkDraftToMax(draft: CheckpointDraftV1, maxBytes: number): void {
  type TextTarget = { key: string; get(): string | undefined; set(value: string): void };
  const targets = (): TextTarget[] => {
    const out: TextTarget[] = [];
    const push = (key: string, get: () => string | undefined, set: (value: string) => void) => out.push({ key, get, set });
    push('state.objective.characters', () => draft.claims.objective, (v) => { draft.claims.objective = v; });
    for (const field of ['completed', 'pending', 'decisions', 'blockers', 'nextActions'] as const) {
      draft.claims[field].forEach((_, i) => push(`state.${field}.characters`, () => draft.claims[field][i], (v) => { draft.claims[field][i] = v; }));
    }
    draft.evidence.forEach((_, i) => {
      push('evidence.kind.characters', () => draft.evidence[i].kind, (v) => { draft.evidence[i].kind = v; });
      push('evidence.ref.characters', () => draft.evidence[i].ref, (v) => { draft.evidence[i].ref = v; });
    });
    return out;
  };

  while (Buffer.byteLength(canonicalCheckpointJson(draft), 'utf8') > maxBytes) {
    const candidates = targets()
      .map((target, index) => ({ target, index, length: codePoints(target.get() ?? '').length }))
      .filter((entry) => entry.length > 32)
      .sort((a, b) => b.length - a.length || a.target.key.localeCompare(b.target.key) || a.index - b.index);
    if (!candidates.length) break;
    const chosen = candidates[0];
    const current = codePoints(chosen.target.get() ?? '');
    const nextLength = Math.max(32, Math.floor(current.length / 2));
    chosen.target.set(current.slice(0, nextLength).join(''));
    draft.coverage.omittedCounts[chosen.target.key] = (draft.coverage.omittedCounts[chosen.target.key] ?? 0) + current.length - nextLength;
    draft.coverage.complete = false;
  }

  const lists: Array<{ key: string; value: unknown[] }> = [
    { key: 'evidence.items', value: draft.evidence },
    { key: 'state.blockers.items', value: draft.claims.blockers },
    { key: 'state.decisions.items', value: draft.claims.decisions },
    { key: 'state.pending.items', value: draft.claims.pending },
    { key: 'state.completed.items', value: draft.claims.completed },
    { key: 'state.nextActions.items', value: draft.claims.nextActions },
  ];
  while (Buffer.byteLength(canonicalCheckpointJson(draft), 'utf8') > maxBytes) {
    const list = lists.find((entry) => entry.value.length > 0);
    if (!list) fail('checkpoint_draft_size_limit_unreachable');
    list.value.pop();
    draft.coverage.omittedCounts[list.key] = (draft.coverage.omittedCounts[list.key] ?? 0) + 1;
    draft.coverage.complete = false;
  }
}

export function boundCheckpointDraft(value: CheckpointDraftV1): CheckpointDraftV1 {
  const draft = structuredClone(value);
  if (Object.keys(draft.coverage.omittedCounts).length > 0) draft.coverage.complete = false;
  // Leave deterministic room for the artifactId marker so artifact-first finalization never has to
  // mutate the claims/evidence that were used to construct the immutable artifact.
  shrinkDraftToMax(
    draft,
    draft.finalization ? CHECKPOINT_DRAFT_MAX_BYTES : CHECKPOINT_DRAFT_MAX_BYTES - CHECKPOINT_DRAFT_ARTIFACT_RESERVE_BYTES,
  );
  validateCheckpointDraft(draft);
  return draft;
}

function persistedText(value: unknown, at: string, max = CHECKPOINT_TEXT_MAX_CHARS): string {
  const text = requiredString(value, at);
  if (codePoints(text).length > max) fail(`checkpoint_schema_${at}_too_long`);
  if (containsCheckpointSecretLikeContent(text)) fail('checkpoint_secret_rejected');
  return text;
}

function validateProject(value: unknown): CheckpointProjectIdentity {
  const item = exactKeys(value, ['cwdHash', 'workspaceId', 'projectId'], 'artifact_project');
  return {
    cwdHash: sha256(item.cwdHash, 'project_cwd_hash'),
    ...(item.workspaceId === undefined ? {} : { workspaceId: persistedText(item.workspaceId, 'project_workspace_id', 128) }),
    ...(item.projectId === undefined ? {} : { projectId: persistedText(item.projectId, 'project_project_id', 128) }),
  };
}

function validateSession(value: unknown): CheckpointSessionIdentity {
  const item = exactKeys(value, ['runtime', 'sessionIdHash'], 'artifact_session');
  return { runtime: persistedText(item.runtime, 'session_runtime', 128), ...(item.sessionIdHash === undefined ? {} : { sessionIdHash: sha256(item.sessionIdHash, 'session_id_hash') }) };
}

function validateClaims(value: unknown): CheckpointClaims {
  const item = exactKeys(value, ['objective', 'completed', 'pending', 'decisions', 'blockers', 'nextActions'], 'artifact_state');
  const list = (entry: unknown, at: string): string[] => stringArray(entry, at).map((text, index) => persistedText(text, `${at}_${index}`));
  return {
    ...(item.objective === undefined ? {} : { objective: persistedText(item.objective, 'state_objective') }),
    completed: list(item.completed, 'state_completed'),
    pending: list(item.pending, 'state_pending'),
    decisions: list(item.decisions, 'state_decisions'),
    blockers: list(item.blockers, 'state_blockers'),
    nextActions: list(item.nextActions, 'state_next_actions'),
  };
}

function validateEvidence(value: unknown): CheckpointEvidence[] {
  if (!Array.isArray(value)) fail('checkpoint_schema_artifact_evidence_array_required');
  return value.map((entry, index) => {
    const item = exactKeys(entry, ['kind', 'ref', 'sha256'], `artifact_evidence_${index}`);
    return { kind: persistedText(item.kind, `artifact_evidence_${index}_kind`), ref: persistedText(item.ref, `artifact_evidence_${index}_ref`), ...(item.sha256 === undefined ? {} : { sha256: sha256(item.sha256, `artifact_evidence_${index}_sha256`) }) };
  });
}

function validateAnchors(value: unknown): CheckpointMachineAnchors {
  const item = exactKeys(value, ['git', 'files', 'commands'], 'artifact_anchors');
  let git: CheckpointMachineAnchors['git'];
  if (item.git !== undefined) {
    const value = exactKeys(item.git, ['repo', 'branch', 'head', 'dirty', 'statusHash'], 'artifact_anchor_git');
    git = {
      repo: persistedText(value.repo, 'artifact_anchor_git_repo'),
      ...(value.branch === undefined ? {} : { branch: persistedText(value.branch, 'artifact_anchor_git_branch') }),
      ...(value.head === undefined ? {} : { head: persistedText(value.head, 'artifact_anchor_git_head', 128) }),
      ...(value.dirty === undefined ? {} : { dirty: bool(value.dirty, 'artifact_anchor_git_dirty') }),
      ...(value.statusHash === undefined ? {} : { statusHash: sha256(value.statusHash, 'artifact_anchor_git_status_hash') }),
    };
  }
  if (!Array.isArray(item.files)) fail('checkpoint_schema_artifact_anchor_files_array_required');
  const files = item.files.map((entry, index) => {
    const value = exactKeys(entry, ['path', 'sha256', 'mtime'], `artifact_anchor_file_${index}`);
    return {
      path: persistedText(value.path, `artifact_anchor_file_${index}_path`),
      ...(value.sha256 === undefined ? {} : { sha256: sha256(value.sha256, `artifact_anchor_file_${index}_sha256`) }),
      ...(value.mtime === undefined ? {} : { mtime: iso(value.mtime, `artifact_anchor_file_${index}_mtime`) }),
    };
  });
  if (!Array.isArray(item.commands)) fail('checkpoint_schema_artifact_anchor_commands_array_required');
  const commands = item.commands.map((entry, index) => {
    const value = exactKeys(entry, ['label', 'exitCode', 'outputHash'], `artifact_anchor_command_${index}`);
    return {
      label: persistedText(value.label, `artifact_anchor_command_${index}_label`),
      ...(value.exitCode === undefined ? {} : { exitCode: integer(value.exitCode, `artifact_anchor_command_${index}_exit_code`) }),
      ...(value.outputHash === undefined ? {} : { outputHash: sha256(value.outputHash, `artifact_anchor_command_${index}_output_hash`) }),
    };
  });
  return { ...(git ? { git } : {}), files, commands };
}

function validateOmittedCounts(value: unknown, at: string): Record<string, number> {
  const counts = exactKeys(value, Object.keys(isRecord(value) ? value : {}), at);
  const omittedCounts: Record<string, number> = {};
  for (const [key, count] of Object.entries(counts)) {
    if (!OMITTED_COUNT_KEY_RE.test(key) || containsSecretLikeContent(key)) fail('checkpoint_schema_omitted_count_key_invalid');
    if (!Number.isSafeInteger(count) || (count as number) <= 0) fail('checkpoint_schema_omitted_count_invalid');
    omittedCounts[key] = count as number;
  }
  return omittedCounts;
}

function validateCoverage(value: unknown): CheckpointCoverage {
  const item = exactKeys(value, ['complete', 'fromCheckpointId', 'eventCount', 'omittedCounts'], 'artifact_coverage');
  const omittedCounts = validateOmittedCounts(item.omittedCounts, 'artifact_omitted_counts');
  const eventCount = item.eventCount === undefined ? undefined : integer(item.eventCount, 'artifact_event_count');
  if (eventCount !== undefined && eventCount < 0) fail('checkpoint_schema_artifact_event_count_range');
  const complete = bool(item.complete, 'artifact_complete');
  if (complete && Object.keys(omittedCounts).length > 0) fail('checkpoint_schema_coverage_complete_with_omissions');
  return {
    complete,
    ...(item.fromCheckpointId === undefined ? {} : { fromCheckpointId: checkpointId(item.fromCheckpointId, 'artifact_from_checkpoint_id') }),
    ...(eventCount === undefined ? {} : { eventCount }),
    omittedCounts,
  };
}

export function validateCheckpointArtifactBuild(value: unknown): CheckpointArtifactBuildV1 {
  const item = exactKeys(
    value,
    ['createdAt', 'trigger', 'anchors', 'anchorOmittedCounts', 'anchorRedaction', 'supersedes'],
    'finalization_build',
  );
  const trigger = exactKeys(item.trigger, ['kind', 'signal', 'sourceEvent', 'reasonCode'], 'finalization_build_trigger');
  const kind = requiredString(trigger.kind, 'finalization_build_trigger_kind');
  const signal = requiredString(trigger.signal, 'finalization_build_trigger_signal');
  if (!TRIGGER_KINDS.has(kind) || !TRIGGER_SIGNALS.has(signal)) fail('checkpoint_schema_trigger_invalid');
  const redaction = exactKeys(item.anchorRedaction, ['applied', 'count'], 'finalization_build_anchor_redaction');
  const applied = bool(redaction.applied, 'finalization_build_anchor_redaction_applied');
  const count = integer(redaction.count, 'finalization_build_anchor_redaction_count');
  if (count < 0 || applied !== (count > 0)) fail('checkpoint_schema_redaction_count_invalid');
  const anchorOmittedCounts = validateOmittedCounts(item.anchorOmittedCounts, 'finalization_build_anchor_omitted_counts');
  if (Object.keys(anchorOmittedCounts).some((key) => !isCheckpointAnchorOmissionKey(key))) {
    fail('checkpoint_finalization_intent_invalid');
  }
  return {
    createdAt: iso(item.createdAt, 'finalization_build_created_at'),
    trigger: {
      kind: kind as CheckpointTriggerKind,
      signal: signal as CheckpointTriggerSignal,
      ...(trigger.sourceEvent === undefined ? {} : { sourceEvent: persistedText(trigger.sourceEvent, 'finalization_build_source_event', 128) }),
      reasonCode: persistedText(trigger.reasonCode, 'finalization_build_reason_code', 128),
    },
    anchors: validateAnchors(item.anchors),
    anchorOmittedCounts,
    anchorRedaction: { applied, count },
    ...(item.supersedes === undefined ? {} : { supersedes: checkpointId(item.supersedes, 'finalization_build_supersedes') }),
  };
}

export function validateCheckpointArtifact(value: unknown): CheckpointArtifactV1 {
  const item = exactKeys(value, ['schemaVersion', 'id', 'project', 'session', 'createdAt', 'trigger', 'state', 'anchors', 'evidence', 'coverage', 'redaction', 'supersedes', 'integrity'], 'artifact');
  if (item.schemaVersion !== 1) fail('checkpoint_schema_version_unsupported');
  const trigger = exactKeys(item.trigger, ['kind', 'signal', 'sourceEvent', 'reasonCode'], 'artifact_trigger');
  const kind = requiredString(trigger.kind, 'artifact_trigger_kind');
  const signal = requiredString(trigger.signal, 'artifact_trigger_signal');
  if (!TRIGGER_KINDS.has(kind) || !TRIGGER_SIGNALS.has(signal)) fail('checkpoint_schema_trigger_invalid');
  const redaction = exactKeys(item.redaction, ['applied', 'count'], 'artifact_redaction');
  const integrity = exactKeys(item.integrity, ['contentSha256'], 'artifact_integrity');
  const artifact: CheckpointArtifactV1 = {
    schemaVersion: 1,
    id: checkpointId(item.id, 'artifact_id'),
    project: validateProject(item.project),
    session: validateSession(item.session),
    createdAt: iso(item.createdAt, 'artifact_created_at'),
    trigger: {
      kind: kind as CheckpointTriggerKind,
      signal: signal as CheckpointTriggerSignal,
      ...(trigger.sourceEvent === undefined ? {} : { sourceEvent: persistedText(trigger.sourceEvent, 'artifact_source_event', 128) }),
      reasonCode: persistedText(trigger.reasonCode, 'artifact_reason_code', 128),
    },
    state: validateClaims(item.state),
    anchors: validateAnchors(item.anchors),
    evidence: validateEvidence(item.evidence),
    coverage: validateCoverage(item.coverage),
    redaction: { applied: bool(redaction.applied, 'artifact_redaction_applied'), count: integer(redaction.count, 'artifact_redaction_count') },
    ...(item.supersedes === undefined ? {} : { supersedes: checkpointId(item.supersedes, 'artifact_supersedes') }),
    integrity: { contentSha256: sha256(integrity.contentSha256, 'artifact_content_sha256') },
  };
  if (artifact.redaction.count < 0 || artifact.redaction.applied !== (artifact.redaction.count > 0)) fail('checkpoint_schema_redaction_count_invalid');
  if (artifact.state.completed.length > STATE_LIST_MAX_ITEMS || artifact.state.pending.length > STATE_LIST_MAX_ITEMS || artifact.state.decisions.length > STATE_LIST_MAX_ITEMS || artifact.state.blockers.length > STATE_LIST_MAX_ITEMS || artifact.state.nextActions.length > STATE_LIST_MAX_ITEMS) fail('checkpoint_schema_state_list_too_large');
  if (artifact.evidence.length > CHECKPOINT_EVIDENCE_MAX_ITEMS || artifact.anchors.files.length > CHECKPOINT_FILE_ANCHOR_MAX_ITEMS || artifact.anchors.commands.length > COMMAND_ANCHOR_MAX_ITEMS) fail('checkpoint_schema_anchor_or_evidence_list_too_large');
  const digest = computeCheckpointContentSha256(artifact);
  if (artifact.integrity.contentSha256 !== digest || artifact.id !== `cp_${digest}`) fail('checkpoint_integrity_mismatch');
  const serialized = canonicalCheckpointJson(artifact);
  if (Buffer.byteLength(serialized, 'utf8') > CHECKPOINT_ARTIFACT_MAX_BYTES) fail('checkpoint_artifact_too_large');
  return artifact;
}

export function validateCheckpointDraft(value: unknown): CheckpointDraftV1 {
  const item = exactKeys(value, ['schemaVersion', 'draftId', 'project', 'session', 'createdAt', 'updatedAt', 'claims', 'evidence', 'coverage', 'redaction', 'finalization'], 'draft');
  if (item.schemaVersion !== 1) fail('checkpoint_draft_schema_version_unsupported');
  const draftId = requiredString(item.draftId, 'draft_id');
  if (!DRAFT_ID_RE.test(draftId)) fail('checkpoint_schema_draft_id_invalid');
  const coverage = validateCoverage(item.coverage);
  const redaction = exactKeys(item.redaction, ['applied', 'count'], 'draft_redaction');
  let finalization: CheckpointDraftV1['finalization'];
  if (item.finalization !== undefined) {
    const f = exactKeys(item.finalization, ['artifactId'], 'draft_finalization');
    finalization = { artifactId: checkpointId(f.artifactId, 'draft_artifact_id') };
  }
  const redactionApplied = bool(redaction.applied, 'draft_redaction_applied');
  const redactionCount = integer(redaction.count, 'draft_redaction_count');
  if (redactionCount < 0 || redactionApplied !== (redactionCount > 0)) fail('checkpoint_schema_draft_redaction_count_invalid');
  const draft: CheckpointDraftV1 = {
    schemaVersion: 1,
    draftId,
    project: validateProject(item.project),
    session: validateSession(item.session),
    createdAt: iso(item.createdAt, 'draft_created_at'),
    updatedAt: iso(item.updatedAt, 'draft_updated_at'),
    claims: validateClaims(item.claims),
    evidence: validateEvidence(item.evidence),
    coverage,
    redaction: { applied: redactionApplied, count: redactionCount },
    ...(finalization ? { finalization } : {}),
  };
  if (draft.claims.completed.length > STATE_LIST_MAX_ITEMS || draft.claims.pending.length > STATE_LIST_MAX_ITEMS || draft.claims.decisions.length > STATE_LIST_MAX_ITEMS || draft.claims.blockers.length > STATE_LIST_MAX_ITEMS || draft.claims.nextActions.length > STATE_LIST_MAX_ITEMS) fail('checkpoint_schema_draft_state_list_too_large');
  if (draft.evidence.length > CHECKPOINT_EVIDENCE_MAX_ITEMS) fail('checkpoint_schema_draft_evidence_list_too_large');
  if (Buffer.byteLength(canonicalCheckpointJson(draft), 'utf8') > CHECKPOINT_DRAFT_MAX_BYTES) fail('checkpoint_draft_too_large');
  return draft;
}
