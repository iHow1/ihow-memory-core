// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
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

async function coreFor(t) {
  const root = await mkdtempReal('ihow-enterprise-audit-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return await openCore({ root, space: 'auditgates' });
}

async function writeMemory(core, rel, body) {
  const p = path.join(core.workspace.memoryDir, rel);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, body, 'utf8');
  return p;
}

function eventById(events, id) {
  const hit = events.find((event) => event.id === id);
  assert.ok(hit, `audit event ${id} exists`);
  return hit;
}

function assertDetectorClean(value, label) {
  const raw = JSON.stringify(value);
  assert.equal(containsSecretLikeContent(raw), false, `${label} is detector-clean`);
  assert.doesNotMatch(raw, /alice@example\.com/, `${label} does not leak raw email`);
}

test('alpha25 audit baseline: candidate write, promote, organize, and export are all auditable and redacted', async (t) => {
  const core = await coreFor(t);

  const candidate = await core.write_candidate({
    title: 'Enterprise audit handoff alice@example.com',
    text: 'Decision: Project Orchard keeps review-first approval. Notify alice@example.com after review.',
    sourceAgent: 'auditor alice@example.com',
    autoPromote: false,
    metadata: { scope: 'project-orchard', fixture: 'enterprise-audit-baseline' },
  });
  assert.equal(candidate.status, 'candidate');

  const promoted = await core.promote(candidate.path, { scope: 'project-orchard', title: 'Enterprise audit handoff alice@example.com' });
  assert.equal(promoted.status, 'promoted');

  const draft = await core.organize({ scope: 'project-orchard', actor: 'enterprise-audit-test' });
  const exported = await core.export_vault(draft.draft_id, { actor: 'enterprise-audit-test' });

  const events = await core.audit();
  const candidateEvent = events.find((event) => event.type === 'candidate.created' && event.path === candidate.path);
  assert.ok(candidateEvent, 'candidate audit event exists for candidate path');
  const promoteEvent = eventById(events, promoted.eventId);
  const organizeEvent = eventById(events, draft.audit_event_id);
  const exportEvent = eventById(events, exported.audit_event_id);

  assert.equal(candidateEvent.type, 'candidate.created');
  assert.match(candidateEvent.path, /^memory\/candidate\/inbox\//);
  assert.equal(promoteEvent.type, 'memory.promoted');
  assert.match(promoteEvent.targetPath, /^memory\/scopes\/project-orchard\//);
  assert.equal(organizeEvent.type, 'memory.organized');
  assert.equal(organizeEvent.metadata?.scope, 'project-orchard');
  assert.equal(organizeEvent.metadata?.curatedRewrite, false);
  assert.equal(exportEvent.type, 'memory.exported');
  assert.match(exportEvent.path, /memory-gardener-digest\.md$/);

  assertDetectorClean(candidateEvent, 'candidate audit event');
  assertDetectorClean(promoteEvent, 'promote audit event');
  assertDetectorClean(organizeEvent, 'organize audit event');
  assertDetectorClean(exportEvent, 'export audit event');

  const draftRaw = await fs.readFile(path.join(core.workspace.spaceDir, draft.draft_path), 'utf8');
  const exportRaw = await fs.readFile(path.join(core.workspace.spaceDir, exported.path), 'utf8');
  assertDetectorClean(draftRaw, 'draft artifact');
  assertDetectorClean(exportRaw, 'export artifact');
});

test('alpha25 audit baseline: journal rollback emits reversible audit events without leaking benign PII', async (t) => {
  const core = await coreFor(t);

  const journal = await core.journal({
    title: 'Daily operator note alice@example.com',
    text: 'Fact: operator follow-up goes to alice@example.com after the review window.',
    sourceAgent: 'operator alice@example.com',
  });
  assert.equal(journal.status, 'journaled');

  const rolled = await core.rollback(journal.eventId);
  assert.equal(rolled.removed, true);

  const events = await core.audit();
  const journalEvent = eventById(events, journal.eventId);
  const rollbackEvent = eventById(events, rolled.rolledbackEventId);

  assert.equal(journalEvent.type, 'memory.journal.appended');
  assert.equal(rollbackEvent.type, 'memory.rolledback');
  assert.equal(rollbackEvent.metadata?.rolledBackEventId, journal.eventId);
  assert.equal(rollbackEvent.metadata?.removed, true);

  assertDetectorClean(journalEvent, 'journal audit event');
  assertDetectorClean(rollbackEvent, 'rollback audit event');

  const journalAbs = path.join(core.workspace.spaceDir, journal.path);
  const journalRaw = await fs.readFile(journalAbs, 'utf8');
  assert.doesNotMatch(journalRaw, /operator follow-up goes to/);
  assertDetectorClean(journalRaw, 'rolled-back journal file');
});


test('alpha25 audit baseline: organize/export event metadata is enough to reconstruct review scope', async (t) => {
  const core = await coreFor(t);
  await writeMemory(core, 'scopes/project-orchard/plan.md', `---
visibility: project
---
- Decision: Project Orchard keeps boundary checks in CI.
- Fact: audit completeness checks cover organized and exported artifacts.
`);

  const draft = await core.organize({ scope: 'project-orchard', actor: 'enterprise-audit-test' });
  const exported = await core.export_vault(draft.draft_id, { actor: 'enterprise-audit-test' });
  const events = await core.audit();
  const organizeEvent = eventById(events, draft.audit_event_id);
  const exportEvent = eventById(events, exported.audit_event_id);

  assert.equal(organizeEvent.metadata?.draftId, draft.draft_id);
  assert.equal(organizeEvent.metadata?.scope, 'project-orchard');
  assert.equal(typeof organizeEvent.metadata?.decisionsFacts, 'number');
  assert.equal(typeof organizeEvent.metadata?.outOfScopeSourcesExcluded, 'number');
  assert.equal(exportEvent.metadata?.draftId, draft.draft_id);
  assert.equal(exportEvent.metadata?.format, 'markdown');
  assert.equal(exportEvent.metadata?.sourceOfTruth, 'view/export artifact only');
  assert.equal(exportEvent.metadata?.exportPath, exported.path);
});
