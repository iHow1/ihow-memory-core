// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openCore } from '../src/core.ts';

async function mkdtempReal(prefix) {
  return await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

async function coreFor(t) {
  const root = await mkdtempReal('ihow-durable-policy-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return await openCore({ root, space: 'dpolicy' });
}

async function writeCandidate(core, text, title = 'policy marker') {
  return await core.write_candidate({
    title,
    text,
    sourceAgent: 'durable-policy-test',
    autoPromote: false,
  });
}

function durablePolicy(event) {
  return event.metadata?.durableWritePolicy;
}

test('alpha25 durable write policy: duplicate promote is review-first metadata, not silent durable truth rewrite', async (t) => {
  const core = await coreFor(t);
  const text = 'Fact: Project Atlas durable duplicate marker ZDUPBASELINE stays review-first.';
  const first = await writeCandidate(core, text, 'atlas durable baseline');
  const promoted = await core.promote(first.path, { scope: 'project-atlas', title: 'atlas durable baseline' });
  const originalRaw = await fs.readFile(path.join(core.workspace.spaceDir, promoted.path), 'utf8');

  const dup = await writeCandidate(core, text, 'atlas durable duplicate');
  const dupPromoted = await core.promote(dup.path, { scope: 'project-atlas', title: 'atlas durable duplicate' });

  const afterRaw = await fs.readFile(path.join(core.workspace.spaceDir, promoted.path), 'utf8');
  assert.equal(afterRaw, originalRaw, 'duplicate promote never rewrites the pre-existing durable memory');

  const dupRaw = await fs.readFile(path.join(core.workspace.spaceDir, dupPromoted.path), 'utf8');
  assert.match(dupRaw, /durable_write_policy: "alpha25\.durable-write-policy\.v0"/);
  assert.match(dupRaw, /durable_write_review_required: true/);
  assert.match(dupRaw, /duplicate_candidate/);
  assert.match(dupRaw, /supersede_candidate/);

  const events = await core.audit();
  const dupEvent = events.find((event) => event.id === dupPromoted.eventId);
  assert.ok(dupEvent, 'duplicate promote is audited');
  const policy = durablePolicy(dupEvent);
  assert.equal(policy?.mode, 'review-first');
  assert.equal(policy?.destructive, false);
  assert.equal(policy?.reviewRequired, true);
  assert.ok(policy?.flags?.some((f) => f.kind === 'duplicate_candidate' && f.destructive === false));
  assert.ok(policy?.flags?.some((f) => f.kind === 'supersede_candidate' && f.destructive === false));
  assert.ok(policy?.duplicateCandidates?.some((d) => d.path === promoted.path), 'audit points at the existing durable duplicate');
});

test('alpha25 durable write policy: durable_promote dry-run surfaces duplicate/stale policy without writes', async (t) => {
  const core = await coreFor(t);
  const text = 'Fact: Project Atlas old durable plan is deprecated and replaced by the review-first baseline.';
  const first = await writeCandidate(core, text, 'atlas old durable plan');
  const promoted = await core.promote(first.path, { scope: 'project-atlas', title: 'atlas old durable plan' });
  const before = await fs.readFile(path.join(core.workspace.spaceDir, promoted.path), 'utf8');

  const staleDup = await writeCandidate(core, text, 'atlas stale duplicate');
  const dry = await core.durable_promote(staleDup.path, {
    dryRun: true,
    actor: 'durable-policy-test',
    target: { scope: 'project-atlas', title: 'atlas stale duplicate' },
  });

  assert.equal(dry.status, 'dry-run');
  assert.equal(dry.proof.dryRunNoWrites, true);
  assert.match(dry.plan.appendContent, /durable_write_review_required: true/);
  assert.match(dry.plan.appendContent, /duplicate_candidate/);
  assert.match(dry.plan.appendContent, /stale_candidate/);
  assert.match(dry.plan.appendContent, /supersede_candidate/);
  const policy = dry.plan.auditEvent.metadata.durableWritePolicy;
  assert.equal(policy.mode, 'review-first');
  assert.equal(policy.destructive, false);
  assert.ok(policy.flags.some((f) => f.kind === 'duplicate_candidate'));
  assert.ok(policy.flags.some((f) => f.kind === 'stale_candidate'));
  assert.ok(policy.flags.some((f) => f.kind === 'supersede_candidate'));
  assert.ok(policy.duplicateCandidates.some((d) => d.path === promoted.path));

  const after = await fs.readFile(path.join(core.workspace.spaceDir, promoted.path), 'utf8');
  assert.equal(after, before, 'dry-run duplicate/stale review never changes existing durable memory');
  await fs.readFile(path.join(core.workspace.spaceDir, staleDup.path), 'utf8');
});

test('alpha25 durable write policy: real durable append marks stale candidates but only appends', async (t) => {
  const core = await coreFor(t);
  const targetRel = 'memory/scopes/project-atlas/append-only-ledger.md';
  const targetAbs = path.join(core.workspace.spaceDir, targetRel);
  await fs.mkdir(path.dirname(targetAbs), { recursive: true });
  await fs.writeFile(targetAbs, '# Append-only ledger\n\nExisting reviewed fact remains intact.\n', 'utf8');

  const candidate = await writeCandidate(core, 'Fact: the old import route is obsolete and no longer used.', 'obsolete route note');
  const real = await core.durable_promote(candidate.path, {
    realWrite: true,
    actor: 'durable-policy-test',
    target: { path: targetRel },
  });

  assert.equal(real.status, 'promoted');
  const raw = await fs.readFile(targetAbs, 'utf8');
  assert.match(raw, /^# Append-only ledger/m, 'existing target content remains');
  assert.match(raw, /Existing reviewed fact remains intact\./);
  assert.match(raw, /durable_write_review_required: true/);
  assert.match(raw, /stale_candidate/);
  assert.match(raw, /old import route is obsolete/);

  const events = await core.audit();
  const event = events.find((e) => e.id === real.eventId);
  assert.ok(event, 'real durable promote is audited');
  const policy = durablePolicy(event);
  assert.equal(policy.reviewRequired, true);
  assert.ok(policy.flags.some((f) => f.kind === 'stale_candidate' && f.destructive === false));
  assert.equal(policy.source_of_truth, 'audit/frontmatter metadata only; no durable memory is rewritten or deleted');
});
