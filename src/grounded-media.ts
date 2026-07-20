// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
// Grounded media evidence is metadata-only. Media bytes and model-derived captions never enter this schema.
import crypto from 'node:crypto';

const HASH_RE = /^[a-f0-9]{64}$/;
const RAW_LOCATOR_RE = /^host-attachment:[A-Za-z0-9_-]{1,128}$/;
const NORMALIZED_LOCATOR_RE = /^hostref:([a-z0-9._-]{1,64}):sha256:([a-f0-9]{64})$/;
const RUNTIMES = new Set(['hermes', 'claude-code', 'codex', 'workbuddy', 'openclaw', 'opencode', 'unknown']);
const MIME_BY_KIND = {
  image: new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/heic', 'image/avif']),
  audio: new Set(['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/ogg', 'audio/webm', 'audio/flac']),
} as const;
const MAX_GROUNDED_MEDIA_BYTES = 64 * 1024 * 1024;
const INPUT_KEYS = new Set([
  'schemaVersion', 'runtime', 'mediaKind', 'locator', 'contentSha256', 'mime', 'bytes',
  'hostCapabilitySha256', 'observedAt',
]);
const OBSERVATION_KEYS = new Set([
  'locator', 'contentSha256', 'mime', 'bytes', 'hostCapabilitySha256', 'observedAt',
]);

export type GroundedMediaKind = keyof typeof MIME_BY_KIND;
export type GroundedMediaEvidenceV1 = {
  schemaVersion: 1;
  runtime: string;
  mediaKind: GroundedMediaKind;
  locator: string;
  contentSha256: string;
  mime: string;
  bytes: number;
  hostCapabilitySha256: string;
  observedAt: string;
};

function record(value: unknown, error: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(error);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: Set<string>, error: string, requireAll = false): void {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${error}:${key}`);
  if (requireAll) for (const key of allowed) if (!Object.hasOwn(value, key)) throw new Error(`${error}:missing_${key}`);
}

function iso(value: unknown, error = 'grounded_media_observed_at_invalid'): string {
  if (typeof value !== 'string' || value.length > 40) throw new Error(error);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) throw new Error(error);
  return value;
}

function hash(value: unknown, error: string): string {
  if (typeof value !== 'string' || !HASH_RE.test(value)) throw new Error(error);
  return value;
}

function normalizedLocator(runtime: string, value: unknown): string {
  if (typeof value !== 'string') throw new Error('grounded_media_locator_invalid');
  const normalized = NORMALIZED_LOCATOR_RE.exec(value);
  if (normalized) {
    if (normalized[1] !== runtime) throw new Error('grounded_media_locator_invalid');
    return value;
  }
  if (!RAW_LOCATOR_RE.test(value)) throw new Error('grounded_media_locator_invalid');
  const digest = crypto.createHash('sha256').update('grounded-media-locator-v1\0').update(runtime).update('\0').update(value).digest('hex');
  return `hostref:${runtime}:sha256:${digest}`;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function evidenceHash(value: GroundedMediaEvidenceV1): string {
  return crypto.createHash('sha256').update('grounded-media-evidence-v1\0').update(canonical(value)).digest('hex');
}

export function normalizeGroundedMediaEvidence(value: unknown): GroundedMediaEvidenceV1 {
  const input = record(value, 'grounded_media_schema_invalid');
  exactKeys(input, INPUT_KEYS, 'grounded_media_unknown_field', true);
  const schemaVersion = input.schemaVersion;
  const runtimeValue = input.runtime;
  const mediaKindValue = input.mediaKind;
  const locator = input.locator;
  const contentSha256 = input.contentSha256;
  const mime = input.mime;
  const bytes = input.bytes;
  const hostCapabilitySha256 = input.hostCapabilitySha256;
  const observedAt = input.observedAt;
  if (schemaVersion !== 1) throw new Error('grounded_media_schema_invalid');
  if (typeof runtimeValue !== 'string') throw new Error('grounded_media_runtime_invalid');
  const runtime = runtimeValue.trim().toLowerCase();
  if (!RUNTIMES.has(runtime)) throw new Error('grounded_media_runtime_invalid');
  if (typeof mediaKindValue !== 'string' || !Object.hasOwn(MIME_BY_KIND, mediaKindValue)) throw new Error('grounded_media_kind_invalid');
  const mediaKind = mediaKindValue as GroundedMediaKind;
  const locatorToken = normalizedLocator(runtime, locator);
  if (typeof mime !== 'string') throw new Error('grounded_media_mime_invalid');
  const mimeValue = mime;
  if (!MIME_BY_KIND[mediaKind].has(mimeValue as never)) throw new Error('grounded_media_mime_invalid');
  if (!Number.isSafeInteger(bytes) || (bytes as number) < 1 || (bytes as number) > MAX_GROUNDED_MEDIA_BYTES) {
    throw new Error('grounded_media_bytes_invalid');
  }
  return {
    schemaVersion: 1,
    runtime,
    mediaKind,
    locator: locatorToken,
    contentSha256: hash(contentSha256, 'grounded_media_content_sha256_invalid'),
    mime: mimeValue,
    bytes: bytes as number,
    hostCapabilitySha256: hash(hostCapabilitySha256, 'grounded_media_capability_sha256_invalid'),
    observedAt: iso(observedAt),
  };
}

export function verifyGroundedMediaObservation(
  evidenceValue: unknown,
  value: unknown,
): { verdict: 'EQUAL_UNTRUSTED' | 'MISMATCH'; observationAt: string; evidenceSha256: string } {
  const evidence = normalizeGroundedMediaEvidence(evidenceValue);
  const input = record(value, 'grounded_media_observation_invalid');
  exactKeys(input, OBSERVATION_KEYS, 'grounded_media_observation_unknown_field', true);
  const locator = input.locator;
  const contentSha256 = input.contentSha256;
  const mime = input.mime;
  const bytes = input.bytes;
  const hostCapabilitySha256 = input.hostCapabilitySha256;
  const observationAt = iso(input.observedAt, 'grounded_media_verification_observed_at_invalid');
  if (typeof locator !== 'string' || !RAW_LOCATOR_RE.test(locator)) throw new Error('grounded_media_observation_locator_invalid');
  const observationLocator = normalizedLocator(evidence.runtime, locator);
  const matches = observationLocator === evidence.locator
    && contentSha256 === evidence.contentSha256
    && mime === evidence.mime
    && bytes === evidence.bytes
    && hostCapabilitySha256 === evidence.hostCapabilitySha256;
  return { verdict: matches ? 'EQUAL_UNTRUSTED' : 'MISMATCH', observationAt, evidenceSha256: evidenceHash(evidence) };
}
