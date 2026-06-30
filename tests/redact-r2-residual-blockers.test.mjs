// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// alpha.16 red-team R2 residual blockers — regression lock.
//  - Blocker 1: payload.metadata PII must NOT reach the audit event (_events/*.ndjson) raw — it flowed
//    verbatim through auto-promote provenance. Now deep-sanitized (safeAuditMetadata).
//  - Blocker 2: credential-shaped `Bearer <8-11 token-ish>` must HARD-REJECT (the precheck is now in the
//    hard detector, mirrored in the redactor so detector/redactor never drift), while prose "bearer of …"
//    and legitimate email-bearing content are unaffected (P0-C friction-fix preserved).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openCore } from '../src/core.ts';
import { containsSecretLikeContent } from '../src/governance.ts';

async function managed(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-r2-')));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return await openCore({ root, space: 'r2', cwd: root });
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

test('Blocker 1: metadata EMAIL never lands raw in any persistence surface (content, frontmatter, audit ndjson)', async (t) => {
  const core = await managed(t);
  // The red-team's exact sample: a clean handoff whose metadata carries a PII email. It auto-promotes;
  // the email must not survive raw in the candidate/durable markdown, frontmatter, OR the _events ndjson.
  await core.write_candidate({
    text: 'kafka deploy runbook clean note, harmless operations detail',
    title: 'normal',
    sourceAgent: 'tester',
    metadata: { contact: 'carol@example.net' },
  });
  assert.equal(await anyFileContains(core.workspace.root, 'carol@example.net'), false, 'metadata email must not land raw anywhere (incl _events ndjson + candidate frontmatter)');
});

test('Blocker 1b: a real SECRET in metadata hard-rejects the candidate (never persisted)', async (t) => {
  const core = await managed(t);
  // metadata is spread into the candidate frontmatter (markdownCandidate), so a credential there must
  // hit the same hard gate as body content — reject, not silently persist.
  await assert.rejects(
    core.write_candidate({ text: 'clean body', title: 'normal', sourceAgent: 'tester', metadata: { note: 'token: ABCDEF0123456789' } }),
    /secret/,
    'a secret in metadata hard-rejects the candidate',
  );
});

test('Blocker 2: credential-shaped Bearer hard-rejects; prose + legit email are unaffected', async (t) => {
  const core = await managed(t);
  // detector: the 8-11 token-ish Bearer the strict 12+ detector missed
  for (const cred of ['Bearer a1b2c3d4', 'Bearer abcd1234', 'Bearer xxx@yyy.com', 'Authorization: Bearer short']) {
    assert.ok(containsSecretLikeContent(cred), `credential-shaped "${cred}" is detected`);
  }
  // false-positive guard: ordinary prose using the word bearer must NOT trip
  for (const prose of ['the bearer of bad news', 'Bearer of the standard', 'a flag bearer marched']) {
    assert.equal(containsSecretLikeContent(prose), false, `prose "${prose}" is not falsely flagged`);
  }
  // end-to-end hard reject on the candidate gate
  await assert.rejects(core.journal({ text: 'Bearer a1b2c3d4', sourceAgent: 't' }), /secret/, 'Bearer token hard-rejects on the journal gate');

  // P0-C friction-fix still intact: a legitimate email-bearing handoff still lands, body redacted in place
  const r = await core.write_candidate({ text: 'contact alice@example.com about the runbook', title: 'normal', sourceAgent: 't', autoPromote: false });
  const candContent = await fs.readFile(path.join(core.workspace.root, r.path.replace(/^memory\//, 'r2/memory/')), 'utf8').catch(() => '');
  // (path resolution is workspace-mode dependent; assert via workspace scan instead)
  assert.equal(await anyFileContains(core.workspace.root, 'alice@example.com'), false, 'the email VALUE is redacted out');
  assert.ok(await anyFileContains(core.workspace.root, '[redacted]'), 'legit email content still LANDS (as [redacted]) — not bounced');
});
