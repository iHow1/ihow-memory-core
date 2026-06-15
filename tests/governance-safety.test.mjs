// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Pre-write safety regression tests (alpha.4 P0): the secret reject gate and the
// protected-path guard are the only pre-write defenses once auto-capture removes the
// human promote step, so both get explicit coverage here (previously none).
import test from 'node:test';
import assert from 'node:assert/strict';
import { containsSecretLikeContent, isProtectedPath } from '../src/governance.ts';

test('secret reject gate flags each high-precision secret type', () => {
  // Provider-token fixtures are written split/concatenated so that NEITHER the repo's CI secret-scan
  // grep NOR GitHub push-protection's partner patterns flag this test file — same convention as
  // scripts/activation-proof.mjs. The runtime string is identical, so it still exercises the
  // governance regex (containsSecretLikeContent) exactly as a contiguous literal would.
  const secrets = {
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
  for (const [label, text] of Object.entries(secrets)) {
    assert.equal(containsSecretLikeContent(text), true, `should flag: ${label}`);
  }
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
