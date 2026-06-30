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
import { redactSecretLikeContent, containsSecretLikeContent, redactIngestBenign } from '../src/governance.ts';

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

// Red-team Blocker 3: a `Bearer <email-shaped value>` (e.g. `Bearer xxx@yyy.com`) misses the strict
// RFC-alphabet Bearer detector but matches EMAIL_PATTERN. WITHOUT the wide precheck, redactIngestBenign
// would have masked the email tail -> `Bearer [redacted]` -> detector-clean, silently DOWNGRADING a
// credential-shaped value to "clean". The fix: redactIngestBenign treats any `Bearer <non-empty>` /
// `Authorization: Bearer <non-empty>` as a real secret and NO-OPs, so the value survives to trip the hard
// gate (it is NOT masked to clean). We assert the email-in-place redaction does NOT fire on it.
test('Blocker 3: Bearer email-shaped value is NOT downgraded to clean by the email redactor', () => {
  const s = 'Bearer xxx@yyy.com';
  const out = redactIngestBenign(s);
  // The wide precheck makes redactIngestBenign a no-op here, so the email tail is left intact (NOT masked).
  assert.equal(out, s, 'redactIngestBenign must not mask a Bearer-prefixed email-shaped value');
  // And the untouched text is still detector-dirty (via EMAIL_PATTERN), so the downstream hard gate fires.
  assert.equal(containsSecretLikeContent(out), true, 'the value remains detector-visible -> hard gate will reject');
});

test('Blocker 3: Authorization: Bearer email-shaped value is also not downgraded', () => {
  const s = 'Authorization: Bearer alice@example.com';
  const out = redactIngestBenign(s);
  assert.equal(out, s, 'Authorization: Bearer <value> is a real secret -> redactIngestBenign no-ops');
  assert.equal(containsSecretLikeContent(out), true);
});

// Guard the OTHER side of the invariant: the wide Bearer precheck must NOT swallow ordinary prose that
// happens to contain the word "bearer" as an English word with no token after it.
test('Blocker 3: prose "bearer" with no token value is NOT treated as a secret by the precheck', () => {
  // `redactIngestBenign` should still redact a plain email in benign prose (the precheck did not fire,
  // because there is no `Bearer <token>` shape — "bearer of" is followed by "bad", not a credential).
  const benign = redactIngestBenign('the bearer of bad news emailed carol@example.com about it');
  assert.ok(!benign.includes('carol@example.com'), 'a benign email in prose still redacts in place');
  assert.match(benign, /\[redacted\]/);
});
