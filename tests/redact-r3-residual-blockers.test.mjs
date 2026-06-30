// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// alpha.16 red-team R3 residual blockers — regression lock.
//  - Blocker 1: a credential-shaped Bearer token whose LAST char is an RFC 6750 / base64url non-word char
//    (`- ~ + / =`) evaded the detector — the old precheck used a trailing `\b`, which does not exist after
//    `-`/`~`/`+`/`/`/`=`. detector AND redactor (they share the pattern) silently missed `Bearer abc1234-`,
//    so raw tokens landed in journal/candidate/index.sqlite. The right boundary is now a negative lookahead
//    ("not another Bearer-alphabet char"). Ordinary prose using "bearer" must stay unflagged.
//  - Blocker 2: durable_promote's REAL-write audit event wrote `target: options.target || {}` raw, while the
//    dry-run plan used safeAuditTarget(...). A PII/secret-shaped target.title therefore leaked raw into the
//    _events/*.ndjson audit surface. Real-write now mirrors the dry-run plan.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openCore } from '../src/core.ts';
import { containsSecretLikeContent, redactSecretLikeContent } from '../src/governance.ts';

async function managed(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-r3-')));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return await openCore({ root, space: 'r3', cwd: root });
}

// Recursively read every file under dir and return true if any contains `needle`.
async function anyFileContains(dir, needle) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (await anyFileContains(full, needle)) return true; }
    else {
      try { if ((await fs.readFile(full, 'utf8')).includes(needle)) return true; } catch { /* skip binary */ }
    }
  }
  return false;
}

// The red-team's exact bypass family: 8-char tokens with a digit, ending in each RFC non-word char.
const BEARER_BYPASS = ['Bearer abc1234-', 'Bearer abc1234~', 'Bearer abc1234+', 'Bearer abc1234/', 'Bearer abc1234='];

test('Blocker 1: non-word-ending Bearer tokens are now DETECTED (detector no longer misses them)', () => {
  for (const cred of BEARER_BYPASS) {
    assert.ok(containsSecretLikeContent(cred), `credential-shaped "${cred}" must be detected`);
  }
});

test('Blocker 1: the redactor stays a superset of the detector (no drift after redaction)', () => {
  for (const cred of BEARER_BYPASS) {
    const redacted = redactSecretLikeContent(cred);
    assert.equal(containsSecretLikeContent(redacted), false, `redactor must clean "${cred}" (got ${JSON.stringify(redacted)})`);
  }
});

test('Blocker 1: a non-word-ending Bearer hard-rejects on journal + write_candidate and never persists raw', async (t) => {
  const core = await managed(t);
  const bearer = 'Bearer abc1234-';
  await assert.rejects(core.journal({ text: bearer, sourceAgent: 't' }), /secret/, 'journal hard-rejects');
  await assert.rejects(core.write_candidate({ text: bearer, sourceAgent: 't', autoPromote: false }), /secret/, 'write_candidate hard-rejects');
  assert.equal(await anyFileContains(core.workspace.root, bearer), false, 'raw token must not land in journal/candidate/index.sqlite');
});

test('Blocker 1 (no regression): the r2 Bearer samples are still detected', () => {
  for (const cred of ['Bearer a1b2c3d4', 'Bearer abcd1234', 'Bearer xxx@yyy.com', 'Authorization: Bearer short']) {
    assert.ok(containsSecretLikeContent(cred), `"${cred}" still detected`);
  }
});

test('Blocker 1 (false-positive guard): ordinary prose using "bearer" is NOT flagged by the precheck', () => {
  // The red-team's prose guards — these must stay clean (the fix only changed the token right-boundary, so
  // these short, alphabetic, no-digit phrases still fail the ≥8 / non-alpha requirements).
  for (const prose of ['the bearer of bad news', 'Bearer of the standard', 'a flag bearer marched']) {
    assert.equal(containsSecretLikeContent(prose), false, `prose "${prose}" must not be flagged`);
  }
});

test('Blocker 2: durable real-write audit event never raw-leaks a PII target.title into _events', async (t) => {
  const core = await managed(t);
  const c = await core.write_candidate({ text: 'clean candidate body', sourceAgent: 't', autoPromote: false });
  await core.durable_promote(c.path, { realWrite: true, target: { scope: 'general', title: 'carol@example.net' } });
  assert.equal(
    await anyFileContains(core.workspace.root, 'carol@example.net'),
    false,
    'raw target.title email must not land in any persistence surface (incl _events/*.ndjson)',
  );
});

test('Blocker 2: a real SECRET in the durable target.title is dropped from the audit event, not logged', async (t) => {
  const core = await managed(t);
  const c = await core.write_candidate({ text: 'clean candidate body two', sourceAgent: 't', autoPromote: false });
  // safeAuditTarget routes the whole target through the full-set audit redactor, so a secret title is
  // mapped to [redacted] (never the raw value) in the audit event.
  await core.durable_promote(c.path, { realWrite: true, target: { scope: 'general', title: 'token: ABCDEF0123456789' } });
  assert.equal(await anyFileContains(core.workspace.root, 'ABCDEF0123456789'), false, 'raw secret target.title must not land in _events');
});
