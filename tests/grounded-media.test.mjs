// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeGroundedMediaEvidence,
  verifyGroundedMediaObservation,
} from '../src/grounded-media.ts';

const H = (ch) => ch.repeat(64);

function valid(overrides = {}) {
  return {
    schemaVersion: 1,
    runtime: 'hermes',
    mediaKind: 'image',
    locator: 'host-attachment:att_7Yx2Q9',
    contentSha256: H('a'),
    mime: 'image/png',
    bytes: 12345,
    hostCapabilitySha256: H('b'),
    observedAt: '2026-07-20T03:00:00.000Z',
    ...overrides,
  };
}

test('normalizes grounded metadata without media bytes, paths, URLs, model output, or raw attachment id', () => {
  const input = valid();
  const evidence = normalizeGroundedMediaEvidence(input);
  assert.match(evidence.locator, /^hostref:hermes:sha256:[a-f0-9]{64}$/);
  assert.equal(evidence.locator.includes('att_7Yx2Q9'), false);
  assert.deepEqual(evidence, { ...input, locator: evidence.locator });
  const raw = JSON.stringify(evidence);
  for (const forbidden of ['base64', 'data:', 'file://', 'https://', '/Users/', 'prompt', 'caption', 'model']) {
    assert.equal(raw.includes(forbidden), false);
  }
});

test('rejects locator escape surfaces, raw content fields, unknown MIME, and unbounded bytes', () => {
  for (const locator of [
    'file:///private-media/image.png',
    'https://example.com/image.png?token=secret',
    '/private-media/image.png',
    '../secret.png',
    'host-attachment:../../secret',
    'host-attachment:att_1?token=secret',
  ]) assert.throws(() => normalizeGroundedMediaEvidence(valid({ locator })), /grounded_media_locator_invalid/);

  assert.throws(() => normalizeGroundedMediaEvidence(valid({ base64: 'AAAA' })), /grounded_media_unknown_field/);
  assert.throws(() => normalizeGroundedMediaEvidence(valid({ caption: 'model-generated claim' })), /grounded_media_unknown_field/);
  assert.throws(() => normalizeGroundedMediaEvidence(valid({ mime: 'text/html' })), /grounded_media_mime_invalid/);
  assert.throws(() => normalizeGroundedMediaEvidence(valid({ mediaKind: 'video', mime: 'video/mp4' })), /grounded_media_kind_invalid/);
  assert.throws(() => normalizeGroundedMediaEvidence(valid({ mediaKind: 'document', mime: 'application/pdf' })), /grounded_media_kind_invalid/);
  assert.throws(() => normalizeGroundedMediaEvidence(valid({ bytes: 0 })), /grounded_media_bytes_invalid/);
  assert.throws(() => normalizeGroundedMediaEvidence(valid({ bytes: 64 * 1024 * 1024 + 1 })), /grounded_media_bytes_invalid/);
});

test('normalizer single-reads adversarial getters and verifier rejects malformed evidence before comparison', () => {
  let locatorReads = 0;
  const hostile = valid();
  Object.defineProperty(hostile, 'locator', {
    enumerable: true,
    get() {
      locatorReads += 1;
      return locatorReads === 1 ? 'host-attachment:att_safe' : 'file:///private-media/secret.png';
    },
  });
  const normalized = normalizeGroundedMediaEvidence(hostile);
  assert.match(normalized.locator, /^hostref:hermes:sha256:[a-f0-9]{64}$/);
  assert.equal(normalized.locator.includes('att_safe'), false);
  assert.equal(locatorReads, 1);

  assert.throws(() => verifyGroundedMediaObservation({}, {
    observedAt: '2026-07-20T03:00:01.000Z',
  }), /grounded_media_schema_invalid|grounded_media_unknown_field/);
  assert.throws(() => normalizeGroundedMediaEvidence(valid({ mediaKind: 'toString' })), /grounded_media_kind_invalid/);
});

test('verification requires live host observation to exactly match locator, bytes, MIME, content and capability hashes', () => {
  const evidence = normalizeGroundedMediaEvidence(valid());
  const rawLocator = valid().locator;
  const verified = verifyGroundedMediaObservation(evidence, {
    locator: rawLocator,
    contentSha256: evidence.contentSha256,
    mime: evidence.mime,
    bytes: evidence.bytes,
    hostCapabilitySha256: evidence.hostCapabilitySha256,
    observedAt: '2026-07-20T03:00:01.000Z',
  });
  assert.deepEqual(verified, {
    verdict: 'EQUAL_UNTRUSTED',
    observationAt: '2026-07-20T03:00:01.000Z',
    evidenceSha256: verified.evidenceSha256,
  });
  assert.match(verified.evidenceSha256, /^[a-f0-9]{64}$/);
  assert.throws(() => verifyGroundedMediaObservation(evidence, {
    locator: evidence.locator,
    contentSha256: evidence.contentSha256,
    mime: evidence.mime,
    bytes: evidence.bytes,
    hostCapabilitySha256: evidence.hostCapabilitySha256,
    observedAt: '2026-07-20T03:00:01.000Z',
  }), /grounded_media_observation_locator_invalid/);

  const baseObservation = {
    locator: rawLocator,
    contentSha256: evidence.contentSha256,
    mime: evidence.mime,
    bytes: evidence.bytes,
    hostCapabilitySha256: evidence.hostCapabilitySha256,
    observedAt: '2026-07-20T03:00:01.000Z',
  };
  for (const observation of [
    { ...baseObservation, contentSha256: H('c') },
    { ...baseObservation, bytes: evidence.bytes + 1 },
    { ...baseObservation, hostCapabilitySha256: H('c') },
  ]) {
    assert.deepEqual(verifyGroundedMediaObservation(evidence, observation).verdict, 'MISMATCH');
  }
});
