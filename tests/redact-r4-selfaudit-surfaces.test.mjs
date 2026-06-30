// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// alpha.16 PRE-r4 self-audit — additional raw-PII-into-_events surfaces in the SAME class as red-team r3
// Blocker 2 (target.title leak), found by an adversarial self-audit before re-sending the red-team. The
// root cause was that the audit safe-helpers were incomplete supersets:
//  - safeAuditTarget redacted only target.title and spread target.scope/target.path RAW -> _events ndjson.
//  - safeAuditMetadata recursed over object VALUES but copied object KEYS verbatim -> a PII email used as a
//    metadata key leaked raw into the audit log while the markdown frontmatter masked it (detector/redactor drift).
//  - target.path was only isProtectedPath-checked; a PII/secret path became the durable FILENAME + the raw
//    event.targetPath, neither redactable after the fact -> hard-reject at resolve time instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openCore } from '../src/core.ts';

async function managed(t, tag) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `ihow-r4-${tag}-`)));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return { root, core: await openCore({ root, space: 'r4', cwd: root }) };
}
async function anyFileContains(dir, needle) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (await anyFileContains(full, needle)) return true; }
    else { try { if ((await fs.readFile(full, 'utf8')).includes(needle)) return true; } catch { /* skip binary */ } }
  }
  return false;
}
const PII = 'carol@example.net';

test('promote(): raw PII in target.scope must not land in the _events audit log', async (t) => {
  const { root, core } = await managed(t, 'scope');
  const c = await core.write_candidate({ text: 'clean body', sourceAgent: 't', autoPromote: false });
  await core.promote(c.path, { scope: PII, title: 'ok title' });
  assert.equal(await anyFileContains(root, PII), false, 'target.scope PII must not appear raw in any surface (incl _events ndjson)');
});

test('durable_promote() real-write: raw PII in target.scope must not land in the _events audit log', async (t) => {
  const { root, core } = await managed(t, 'durscope');
  const c = await core.write_candidate({ text: 'clean body', sourceAgent: 't', autoPromote: false });
  await core.durable_promote(c.path, { realWrite: true, target: { scope: PII, title: 'ok' } });
  assert.equal(await anyFileContains(root, PII), false, 'durable target.scope PII must not appear raw (incl _events ndjson)');
});

test('promote(): a secret-like explicit target.path is HARD-REJECTED (it would become the durable filename + raw audit targetPath)', async (t) => {
  const { root, core } = await managed(t, 'path');
  const c = await core.write_candidate({ text: 'clean body', sourceAgent: 't', autoPromote: false });
  await assert.rejects(
    core.promote(c.path, { path: `memory/notes/${PII}.md` }),
    /secret_like|secret/,
    'a PII/secret target.path must be rejected at resolve time',
  );
  assert.equal(await anyFileContains(root, PII), false, 'no raw PII persisted via filename or audit log');
});

test('write_candidate auto-promote: a PII email used as a metadata KEY must not leak raw into _events', async (t) => {
  const { root, core } = await managed(t, 'key');
  await core.write_candidate({ text: 'clean harmless body', sourceAgent: 't', metadata: { [PII]: 'v' } });
  assert.equal(await anyFileContains(root, PII), false, 'metadata KEY PII must be redacted in the audit event, not copied verbatim');
});

test('write_candidate auto-promote: a NESTED PII metadata KEY is also redacted', async (t) => {
  const { root, core } = await managed(t, 'keynest');
  await core.write_candidate({ text: 'clean harmless body', sourceAgent: 't', metadata: { wrap: { [PII]: 'v' } } });
  assert.equal(await anyFileContains(root, PII), false, 'nested metadata KEY PII must be redacted too');
});

test('no over-redaction: a normal scope/title still promotes cleanly (the audit hardening must not break the happy path)', async (t) => {
  const { core } = await managed(t, 'happy');
  const c = await core.write_candidate({ text: 'clean body', sourceAgent: 't', autoPromote: false });
  const r = await core.promote(c.path, { scope: 'general', title: 'normal title' });
  assert.equal(r.status, 'promoted', 'a benign scope/title must still promote (no false reject / over-redaction)');
});

// --- round 2 (scope path-derivation) + appendEvent actor audit ---

test('promote(): raw PII in target.scope is redacted in the durable path / filename / _events targetPath / index.sqlite', async (t) => {
  const { root, core } = await managed(t, 'scopepath');
  const c = await core.write_candidate({ text: 'clean body', sourceAgent: 't', autoPromote: false });
  const r = await core.promote(c.path, { scope: 'mgr-pii@corp.example', title: 'ok' });
  assert.equal(await anyFileContains(root, 'mgr-pii@corp.example'), false, 'raw email scope must not appear anywhere');
  // the partial-mask the old safeFileSlug produced (local-part+domain) must also be gone from path/_events/sqlite
  assert.equal(await anyFileContains(root, 'mgr-pii-corp.example'), false, `slugged email (local+domain) must not survive in the path (${r.path})`);
});

test('durable_promote(): raw credential in target.scope never reaches the path / filename / _events / index.sqlite', async (t) => {
  const { root, core } = await managed(t, 'scopecred');
  const c = await core.write_candidate({ text: 'clean body', sourceAgent: 't', autoPromote: false });
  const cred = 'sk-ABCDEFGH1234567890IJKLMNOP';
  await core.durable_promote(c.path, { realWrite: true, target: { scope: cred, title: 'ok' } });
  assert.equal(await anyFileContains(root, cred), false, 'credential scope must not survive (any case)');
  assert.equal(await anyFileContains(root, cred.toLowerCase()), false, 'credential scope must not survive (lowercased slug form)');
});

test('no over-redaction: a normal scope is preserved in the durable path', async (t) => {
  const { core } = await managed(t, 'scopeok');
  const c = await core.write_candidate({ text: 'clean body', sourceAgent: 't', autoPromote: false });
  const r = await core.promote(c.path, { scope: 'work-notes', title: 'ok' });
  assert.ok(r.path.includes('work-notes'), `a benign scope must survive in the path (${r.path})`);
});

test('journal(): a PII/secret-shaped sourceAgent never lands raw in the _events actor field', async (t) => {
  const { root, core } = await managed(t, 'actor');
  await core.journal({ text: 'a clean harmless note', sourceAgent: 'carol@example.net' });
  assert.equal(await anyFileContains(root, 'carol@example.net'), false, 'sourceAgent PII must be collapsed by safeActorId in the audit actor');
});

// --- r4 red-team Blocker: durable_promote external actor must be audit-safe ---

test('durable_promote(): an external PII/secret actor never lands raw in the _events audit log', async (t) => {
  for (const actor of ['actor-carol@example.net', 'sk-ABCDEFGH1234567890IJKLMNOP', 'Bearer abc1234-']) {
    const { root, core } = await managed(t, 'actorleak');
    const c = await core.write_candidate({ text: 'clean body', sourceAgent: 't', autoPromote: false });
    await core.durable_promote(c.path, { realWrite: true, actor, target: { scope: 'general', title: 'ok' } });
    assert.equal(await anyFileContains(root, actor), false, `durable actor "${actor}" must be collapsed by safeActorId, not raw in _events`);
  }
});

test('durable_promote(): a benign actor is preserved in the audit event (no over-redaction)', async (t) => {
  const { root, core } = await managed(t, 'actorok');
  const c = await core.write_candidate({ text: 'clean body', sourceAgent: 't', autoPromote: false });
  const r = await core.durable_promote(c.path, { realWrite: true, actor: 'agent-auto', target: { scope: 'general', title: 'ok' } });
  assert.equal(r.status, 'promoted', 'benign actor still promotes');
  assert.equal(await anyFileContains(root, 'agent-auto'), true, 'a benign actor must survive in the audit event');
});

// --- r5 red-team Blocker: candidate REF path itself must not carry raw PII into _events / history ---

async function plantCandidate(root, space, needle) {
  const rel = `memory/candidate/inbox/${needle}.md`;
  const abs = path.join(root, space, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, `---\ntype: "memory_candidate"\ncandidate_id: "cid-r5"\nstatus: "candidate"\nsource_agent: "unit"\ncreated_at: "2026-06-30T00:00:00.000Z"\n---\n# Clean\n\nclean body\n`);
  return rel;
}

test('promote()/durable_promote(): an out-of-band candidate with a PII/secret FILENAME is hard-rejected (no raw candidatePath in _events/history)', async (t) => {
  for (const needle of ['candpath-carol@example.net', 'candpath-sk-ABCDEFGH1234567890IJKL']) {
    const { root, core } = await managed(t, 'candpath');
    const rel = await plantCandidate(root, 'r4', needle);
    await assert.rejects(core.promote(rel, { scope: 'general', title: 'ok' }), /secret_like|secret/, `promote must reject "${needle}"`);
    await assert.rejects(core.durable_promote(rel, { realWrite: true, actor: 'unit', target: { scope: 'general', title: 'ok' } }), /secret_like|secret/, `durable must reject "${needle}"`);
    const eventsDir = path.join(root, 'r4', 'memory', '_events');
    assert.equal(await anyFileContains(eventsDir, needle), false, `candidatePath "${needle}" must not reach _events`);
    const histDir = path.join(root, 'r4', 'memory', 'history');
    assert.equal(await anyFileContains(histDir, needle), false, `candidate "${needle}" must not be archived to history`);
  }
});

test('promote(): a normal write_candidate path still promotes (candidate-path guard does not over-reject)', async (t) => {
  const { core } = await managed(t, 'candok');
  const c = await core.write_candidate({ text: 'clean body', sourceAgent: 'unit', autoPromote: false });
  const r = await core.promote(c.path, { scope: 'general', title: 'ok' });
  assert.equal(r.status, 'promoted', 'a safe slugged candidate path must still promote');
});

// --- r5 self-audit (9th vector): a frontmatter candidate_id carrying PII must not leak via promote() ---

test('promote(): a PII/secret candidate_id in an out-of-band candidate frontmatter is gated (no _events/filename leak)', async (t) => {
  const { root, core } = await managed(t, 'cidfm');
  const needle = 'cidpii-carol@example.net';
  const rel = 'memory/candidate/inbox/safe-named.md';
  const abs = path.join(root, 'r4', rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  // safe FILENAME but PII candidate_id in frontmatter + empty title (would slug the id into the path)
  await fs.writeFile(abs, `---\ntype: "memory_candidate"\ncandidate_id: "${needle}"\nstatus: "candidate"\nsource_agent: "unit"\ncreated_at: "2026-06-30T00:00:00.000Z"\n---\n# \n\nclean body\n`);
  await assert.rejects(core.promote(rel, { scope: 'general' }), /secret/, 'promote must gate a PII candidate_id (content backstop, not just auto-promote)');
  assert.equal(await anyFileContains(path.join(root, 'r4', 'memory', '_events'), needle), false, 'candidate_id must not reach _events');
  assert.equal(await anyFileContains(path.join(root, 'r4', 'memory', 'scopes'), needle), false, 'candidate_id must not become a durable filename');
});
