// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Secret-redaction hardening: the auto-capture redactor (used on the floor-capture journal, the
// cross-agent handoff narrative, and the recall read path) previously only caught assignment-style
// and branded tokens. Prose secrets, URL-embedded credentials, and generic high-entropy blobs leaked
// verbatim into durable, searchable, cross-agent-injected files. These tests pin the new coverage AND
// the deliberate non-false-positive on git SHAs / UUIDs (mixed-class requirement).
import test from 'node:test';
import assert from 'node:assert/strict';
import { redactSecretLikeContent, containsSecretLikeContent } from '../src/governance.ts';

test('redactor quarantines prose secrets, URL creds, and keyword-led blobs', () => {
  const prose = redactSecretLikeContent('Note: the password is hunter2supersecret for staging.');
  assert.ok(!prose.includes('hunter2supersecret'), 'prose secret value must not survive');
  assert.match(prose, /\[redacted\]/);

  const url = redactSecretLikeContent('connect via redis://default:p4ssw0rd@cache.internal:6379/0');
  assert.ok(!url.includes('p4ssw0rd'), 'URL-embedded credential must not survive');

  // A high-entropy blob is caught when it is LED BY a secret keyword (the prose rule), not by a generic
  // entropy detector (that one was removed — see governance.ts — because it shredded ordinary paths).
  const aws = redactSecretLikeContent('aws secret was wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY today');
  assert.ok(!aws.includes('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'), 'keyword-led secret value must not survive');
});

test('NO over-redaction of ordinary handoff content: paths, long identifiers, artifacts survive', () => {
  // Regression guard for the removed high-entropy pattern, which collapsed these to [redacted].
  const samples = [
    'edited src/store/Events2026Handler_v3_FinalBuild.ts and node Test1FooBarBazQuxLongModuleName2026.mjs',
    'artifact build/Output_Bundle_2026_Abc123Def456Ghi789.tar.gz produced',
    'route /api/v2/UserProfile2026/Settings_AbcDef123_Final reviewed',
  ];
  for (const s of samples) {
    assert.equal(redactSecretLikeContent(s), s, `must not redact ordinary content: ${s}`);
  }
});

test('URL-embedded credentials are also caught by the hard-reject detector', () => {
  assert.equal(containsSecretLikeContent('postgres://user:s3cr3tpw@db:5432/app'), true);
});

test('NO false positive on git SHAs / hex hashes (mixed-class requirement protects them)', () => {
  const sha = 'commit 9c353470a1b2c3d4e5f60718293a4b5c6d7e8f90 landed on main';
  // Pure lowercase-hex: not a secret. It must survive redaction and not trip the detector.
  assert.equal(redactSecretLikeContent(sha), sha, 'git SHA must not be redacted');
  assert.equal(containsSecretLikeContent(sha), false, 'git SHA must not be flagged as a secret');

  const uuid = 'run id d8fd499a-3472-4cfb-8609-7c2433fa02e8 completed';
  assert.equal(redactSecretLikeContent(uuid), uuid, 'UUID must not be redacted');
});

test('post-redaction invariant: redactor output is clean per the detector (redactor ⊇ detector)', () => {
  const dirty = 'token: eyJabc123.def456ghi.jkl789mno and redis://u:p@h and the secret is topsecretvalue';
  const clean = redactSecretLikeContent(dirty);
  assert.equal(containsSecretLikeContent(clean), false, 'redacted text must not still contain detector-visible secrets');
});
