// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Red-team alpha.16 BLOCKED_NO_SIGN_OFF regression suite: the email "redact-in-place" friction fix only
// scrubbed the BODY, leaving PII/secret VALUES to leak through DERIVED persistence surfaces —
//   Blocker 1: writeCandidate / promote built the filename slug from the RAW title (and the candidate
//              sub-dir from the RAW sourceAgent), so `title:'alice@example.com'` landed
//              `…-alice-example.com.md` on disk and in the audit path.
//   Blocker 2: appendJournal wrote the RAW title + sourceAgent into the markdown HEADING and the audit
//              actor field, so a PII/secret title/sourceAgent leaked verbatim into the journal heading.
// These tests pin: PII/secret VALUES never appear in filename/path, markdown content/frontmatter, or the
// journal heading — while the P0-C friction-fix invariant (a legitimate email-bearing entry still LANDS,
// body [redacted], never hard-rejected) stays intact.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openCore } from '../src/core.ts';
import { containsSecretLikeContent } from '../src/governance.ts';

async function mkdtempReal(prefix) {
  return await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

async function managed(t, space = 'rtest') {
  const root = await mkdtempReal('ihow-redact-surfaces-');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  return await openCore({ root, space });
}

// Walk every file under the memory root and return [{ rel, content }] so a test can assert that no PII
// value survives ANYWHERE on disk (path OR content), including audit logs.
async function allFiles(dir, base = dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await allFiles(abs, base)));
    else out.push({ rel: path.relative(base, abs), content: await fs.readFile(abs, 'utf8') });
  }
  return out;
}

// ── Blocker 1: filename / path must not carry a PII/secret value ────────────────────────────────────

test('Blocker 1: write_candidate with an email TITLE keeps the email out of filename/path AND content', async (t) => {
  const core = await managed(t);
  const cand = await core.write_candidate({
    text: 'clean project handoff body',
    title: 'contact alice@example.com',
    sourceAgent: 'tester',
    autoPromote: false,
  });
  assert.equal(cand.status, 'candidate', 'a legitimate email title is accepted (friction-fix), not rejected');

  // The returned path (audit/search/citation surface) must not carry the email local-part or domain.
  assert.ok(!/alice/.test(cand.path), `path must not contain the email local-part: ${cand.path}`);
  assert.ok(!/example\.com/.test(cand.path), `path must not contain the email domain: ${cand.path}`);

  // Nothing on disk — filename, path, markdown content/frontmatter, OR audit log — may carry the raw email.
  const files = await allFiles(core.workspace.memoryDir);
  for (const f of files) {
    assert.ok(!f.rel.includes('alice'), `filename/path leaks email local-part: ${f.rel}`);
    assert.ok(!f.rel.includes('example.com'), `filename/path leaks email domain: ${f.rel}`);
    assert.ok(!f.content.includes('alice@example.com'), `content leaks raw email: ${f.rel}`);
  }
  // The candidate markdown heading is redacted, but the body content is preserved.
  const candFile = files.find((f) => f.rel.includes('candidate'));
  assert.ok(candFile, 'candidate file exists');
  assert.match(candFile.content, /\[redacted\]/, 'email in the title degrades to [redacted] in the heading');
  assert.match(candFile.content, /clean project handoff body/, 'body content is preserved');
});

test('Blocker 1: an email SOURCEAGENT does not leak into the candidate sub-dir path or audit actor', async (t) => {
  const core = await managed(t, 'existing'); // sub-dir-per-agent only applies to existing-memory-root… use default too
  const cand = await core.write_candidate({
    text: 'clean body',
    title: 'normal title',
    sourceAgent: 'alice@example.com',
    autoPromote: false,
  });
  assert.equal(cand.status, 'candidate');
  const files = await allFiles(core.workspace.memoryDir);
  for (const f of files) {
    assert.ok(!f.rel.includes('alice'), `sourceAgent email leaks into path: ${f.rel}`);
    assert.ok(!f.rel.includes('example.com'), `sourceAgent email domain leaks into path: ${f.rel}`);
    assert.ok(!f.content.includes('alice@example.com'), `sourceAgent raw email leaks into content/audit: ${f.rel}`);
  }
});

test('Blocker 1: promote of an email-titled candidate keeps the email out of the durable path', async (t) => {
  const core = await managed(t);
  const cand = await core.write_candidate({
    text: 'kafka consumer lag deploy decision: raise max.poll.interval.ms',
    title: 'bob@example.org follow-up',
    sourceAgent: 'tester',
    autoPromote: false,
  });
  const promoted = await core.promote(cand.path, { scope: 'team', title: 'bob@example.org follow-up' });
  const promotedPath = promoted.path || promoted.target || JSON.stringify(promoted);
  assert.ok(!/bob/.test(String(promotedPath)), `promoted path leaks email local-part: ${promotedPath}`);
  assert.ok(!/example\.org/.test(String(promotedPath)), `promoted path leaks email domain: ${promotedPath}`);
  const files = await allFiles(core.workspace.memoryDir);
  for (const f of files) {
    assert.ok(!f.rel.includes('bob'), `durable filename leaks email: ${f.rel}`);
    assert.ok(!f.content.includes('bob@example.org'), `durable content leaks raw email: ${f.rel}`);
  }
});

test('Blocker 1: a REAL secret in the title is dropped from the slug AND hard-rejects the entry', async (t) => {
  const core = await managed(t);
  // A real credential in the title must reject (never lands), and even if it somehow did, the slug must
  // not carry the secret value — we assert the reject here.
  await assert.rejects(
    core.write_candidate({ text: 'clean body', title: 'api_key: ABCDEF0123456789', sourceAgent: 'tester', autoPromote: false }),
    /secret/,
    'a real secret in the title hard-rejects (reject-vs-redact)',
  );
});

// ── Blocker 2: journal heading / sourceAgent must not carry a PII/secret value ──────────────────────

test('Blocker 2: journal with an email TITLE keeps the raw email out of the heading + whole file', async (t) => {
  const core = await managed(t);
  const r = await core.journal({ text: 'clean session note', title: 'alice@example.com', sourceAgent: 'tester' });
  assert.equal(r.status, 'journaled', 'a legitimate email title still journals (friction-fix)');
  const abs = path.join(core.workspace.memoryDir, 'journal', `${r.day}.md`);
  const content = await fs.readFile(abs, 'utf8');
  assert.ok(!content.includes('alice@example.com'), 'raw email title must not appear anywhere in the journal file');
  assert.match(content, /## .*\[redacted\]/, 'the email title degrades to [redacted] in the heading');
  assert.equal(containsSecretLikeContent(content), false, 'the on-disk journal is detector-clean');
});

test('Blocker 2: journal with an email SOURCEAGENT keeps the raw email out of the heading + audit', async (t) => {
  const core = await managed(t);
  const r = await core.journal({ text: 'clean note', title: 'standup', sourceAgent: 'alice@example.com' });
  assert.equal(r.status, 'journaled');
  const files = await allFiles(core.workspace.memoryDir);
  for (const f of files) {
    assert.ok(!f.content.includes('alice@example.com'), `raw email sourceAgent leaks into ${f.rel}`);
    assert.ok(!f.rel.includes('example.com'), `email sourceAgent leaks into path ${f.rel}`);
  }
});

test('Blocker 2: a secret-shaped journal TITLE rejects (or at minimum never lands a raw secret value)', async (t) => {
  const core = await managed(t);
  await assert.rejects(
    core.journal({ text: 'clean', title: 'api_key: ABCDEF0123456789', sourceAgent: 'tester' }),
    /secret/,
    'a real secret in the journal title hard-rejects rather than leaking into the heading',
  );
});

// ── Friction-fix invariant still holds: legitimate email content LANDS, body [redacted], not rejected ──

test('friction-fix preserved: a clean title + email-in-BODY still lands, body [redacted], not rejected', async (t) => {
  const core = await managed(t);
  const cand = await core.write_candidate({
    text: 'Handoff: emailed carol@example.com about the rollback; next step confirm the deploy window.',
    title: 'contact us',
    sourceAgent: 'tester',
    autoPromote: false,
  });
  assert.equal(cand.status, 'candidate', 'a clean-title, email-in-body entry is accepted, not rejected');
  const file = path.join(core.workspace.memoryDir, cand.path.replace(/^memory\//, ''));
  const content = await fs.readFile(file, 'utf8');
  assert.ok(!content.includes('carol@example.com'), 'the body email value is [redacted]');
  assert.match(content, /\[redacted\]/, 'body email degraded to [redacted]');
  assert.match(content, /rollback/, 'surrounding body content preserved');
  assert.match(content, /deploy window/, 'surrounding body content preserved');
  // The clean title is preserved verbatim (the slug + heading are NOT over-redacted for benign titles).
  assert.match(content, /# contact us/, 'a benign title is preserved, not over-redacted');
  assert.match(cand.path, /contact-us/, 'a benign title still produces a readable slug');
});
