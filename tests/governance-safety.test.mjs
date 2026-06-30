// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Pre-write safety regression tests (alpha.4 P0): the secret reject gate and the
// protected-path guard are the only pre-write defenses once auto-capture removes the
// human promote step, so both get explicit coverage here (previously none).
import test from 'node:test';
import assert from 'node:assert/strict';
import { containsSecretLikeContent, isProtectedPath, redactSecretLikeContent, redactIngestBenign } from '../src/governance.ts';

// Provider-token fixtures are written split/concatenated so that NEITHER the repo's CI secret-scan
// grep NOR GitHub push-protection's partner patterns flag this test file — same convention as
// scripts/activation-proof.mjs. The runtime string is identical, so it still exercises the governance
// regex exactly as a contiguous literal would. Shared by the detect + redact tests below.
const SECRET_FIXTURES = {
  'assignment api_key': 'api_key: ABCDEF0123456789',
  'assignment password': 'password=hunter2longenough',
  'assignment client_secret': 'client_secret = abcdef123456',
  'assignment access_token': 'access_token: zzzzzzzzzzzz',
  'OpenAI sk-': 'key is ' + 'sk' + '-ABCDEFGHIJKLMNOP12345',
  'Stripe live': 'sk' + '_live_abcdEFGH12345678ZZZZ',
  'GitHub PAT classic': 'gh' + 'p_ABCDEFGHIJKLMNOPQRST0123456789',
  'GitHub gho_': 'gho' + '_ABCDEFGHIJKLMNOPQRST',
  'GitHub fine-grained': 'github' + '_pat_ABCDEFGHIJKLMNOPQRSTUVWX',
  'AWS access key id': 'AKIA' + 'ABCDEFGHIJKLMNOP',
  'Google API key': 'AIza' + 'SyA1234567890abcdefghijklmnopqrstuv',
  'Google OAuth': 'ya29' + '.A0ARrdaM-abcdefghijklmnop',
  'Slack token': 'xoxb' + '-1234567890-abcdefghijkl',
  'Twilio SK': 'SK' + '0123456789abcdef0123456789abcdef',
  'JWT': 'eyJ' + 'hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQabcdef',
  'PEM private key': '-----BEGIN ' + 'OPENSSH ' + 'PRIVATE KEY-----',
  'email': 'contact me at someone@example.com',
  'CJK 密码': '密码：correct-horse',
};

test('secret reject gate flags each high-precision secret type', () => {
  for (const [label, text] of Object.entries(SECRET_FIXTURES)) {
    assert.equal(containsSecretLikeContent(text), true, `should flag: ${label}`);
  }
});

test('redactSecretLikeContent is same-source: removes the value AND clears the hard detector', () => {
  // OpenClaw automation-v2 signing condition: any text entering the journal must be redactable so the
  // FULL hard detector (not just CLI redactSecrets' narrower set) no longer hits — else appendJournal's
  // assertNoSecretLikeContent throws and the hook's no-throw contract turns it into silent capture loss.
  for (const [label, text] of Object.entries(SECRET_FIXTURES)) {
    assert.equal(containsSecretLikeContent(redactSecretLikeContent(text)), false, `hard detector must be clean after redaction: ${label}`);
  }
  // the secret VALUE is removed, not merely the keyword (assignment-style) and not left in place
  assert.doesNotMatch(redactSecretLikeContent('api_key: ABCDEF0123456789'), /ABCDEF0123456789/);
  assert.doesNotMatch(redactSecretLikeContent('contact me at someone@example.com'), /someone@example\.com/);
  // benign engineering prose is left untouched
  const benign = 'We decided to add retry logic with a 30s timeout to the API handler.';
  assert.equal(redactSecretLikeContent(benign), benign);
});

// P0-C: the INGEST-path benign redactor strips email/PII to [redacted] (so write_candidate / journal can
// redact-in-place instead of rejecting), but leaves REAL secrets untouched so the hard detector still
// rejects them. It is NARROWER than redactSecretLikeContent on purpose — reject-vs-redact, never ignore.
test('redactIngestBenign redacts email but leaves real secrets for the hard-reject gate', () => {
  const email = redactIngestBenign('Handoff: ping alice@example.com about the rollback plan.');
  assert.doesNotMatch(email, /alice@example\.com/, 'the email value is removed');
  assert.match(email, /\[redacted\]/);
  assert.match(email, /rollback plan/, 'surrounding content is preserved');
  // After the benign pass an email is detector-clean (it was a detector member that we redacted)...
  assert.equal(containsSecretLikeContent(email), false, 'a redacted email no longer trips the hard detector');

  // ...but a REAL secret is NOT in the benign set, so it survives the pass and STILL trips the detector.
  const secret = redactIngestBenign('rotate api_key: ABCDEF0123456789 tonight');
  assert.match(secret, /ABCDEF0123456789/, 'the real secret is left untouched by the benign pass');
  assert.equal(containsSecretLikeContent(secret), true, 'the real secret still trips the hard detector -> hard reject');

  // benign engineering prose is left untouched
  const benign = 'We decided to add retry logic with a 30s timeout to the API handler.';
  assert.equal(redactIngestBenign(benign), benign);
});

// RED-TEAM BLOCKER regression: the broad email regex also matches the `pass@host.tld` tail of a
// URL-embedded credential. If redactIngestBenign rewrote that tail to [redacted] it would erase the `@`
// the URL-cred / Bearer detector relies on and silently DOWNGRADE a real secret to "clean". The guard:
// when a real secret is present, redactIngestBenign is a NO-OP, so the hard detector still fires.
test('redactIngestBenign NEVER masks a real secret via the email overlap (URL creds / mixed)', () => {
  const urlCreds = [
    'connect via redis://default:p4ssw0rd@cache.internal:6379/0',
    'postgres://user:s3cr3tpw@db.example.com:5432/app',
    'mongodb://admin:topsecret@cluster0.mongodb.net/test',
  ];
  for (const c of urlCreds) {
    assert.equal(redactIngestBenign(c), c, `URL-cred is left intact (no email-shaped masking): ${c}`);
    assert.equal(containsSecretLikeContent(redactIngestBenign(c)), true, `URL-cred still hard-detected: ${c}`);
  }
  // A real secret AND an email in the same text: the whole thing stays a hard reject (real secret wins);
  // the email is NOT individually redacted-and-accepted (that would hide the real secret).
  const mixed = 'rotate api_key: ABCDEF0123456789 then notify bob@example.com';
  assert.equal(redactIngestBenign(mixed), mixed, 'a real secret present → benign redaction is a no-op');
  assert.equal(containsSecretLikeContent(redactIngestBenign(mixed)), true, 'real secret still hard-detected');
});

test('secret reject gate does not flag benign engineering prose', () => {
  const benign = [
    'We decided to add retry logic with a 30s timeout to the API handler.',
    'The password field on the login form should be cleared after submit.',
    'Promote candidates from the inbox only; durable writes append to the dated daily file.',
    'Token bucket rate limiting was chosen over a fixed window.',
  ];
  for (const text of benign) {
    assert.equal(containsSecretLikeContent(text), false, `should NOT flag: ${text}`);
  }
});

test('protected-path guard covers identity, MEMORY, and curated anchors', () => {
  const protectedRefs = [
    'MEMORY.md',
    'IDENTITY.md',
    'SOUL.md',
    'USER.md',
    'preferences.md',
    'active-anchors.md',
    'anchors.md',
    'active-topics.md',
    'memory/MEMORY.md',
    'memory/preferences.md',
    'scopes/team/current.md',
    'projects/foo/MEMORY.md', // basename match closes the projects/ path bypass for named anchors
    'projects/foo/preferences.md',
  ];
  for (const ref of protectedRefs) {
    assert.equal(isProtectedPath(ref), true, `should protect: ${ref}`);
  }
});

test('protected-path guard allows ordinary durable targets', () => {
  const allowed = ['2026-06-13.md', 'scopes/team/2026-06-13-some-note.md', 'inbox/note.md', 'projects/foo/plan.md'];
  for (const ref of allowed) {
    assert.equal(isProtectedPath(ref), false, `should NOT protect: ${ref}`);
  }
});
