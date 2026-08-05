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
  const root = await mkdtempReal('ihow-enterprise-gates-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return await openCore({ root, space: 'egates' });
}

async function writeMemory(core, rel, body) {
  const p = path.join(core.workspace.memoryDir, rel);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, body, 'utf8');
  return p;
}

async function seedEnterpriseGateMatrix(core) {
  await writeMemory(core, 'scopes/project-orchard/plan.md', `---
visibility: project
---
# Project Orchard
- Decision: Project Orchard ships the review-first export gate.
- Fact: Orchard evidence must stay linked to source documents.
- Next action: Orchard reviewer checks source-shared import notes.
`);
  await writeMemory(core, 'scopes/project-harbor/plan.md', `---
visibility: project
---
# Project Harbor
- Decision: Project Harbor keeps a separate release queue.
- Fact: Harbor budget is private to Harbor and must not appear in Orchard.
`);
  await writeMemory(core, 'scopes/private/orchard-private.md', `---
visibility: private
---
- Fact: Orchard private staffing note must not appear in project/public digest.
`);
  await writeMemory(core, 'audit/orchard-routing.md', `---
visibility: audit-only
---
- Fact: audit-only routing detail must never appear in organize/export output.
`);
  await writeMemory(core, 'sources/shared/project-orchard/research.md', `---
visibility: source-shared
source_id: source:shared:orchard-research
---
- Fact: source-shared Orchard research can support Orchard review.
`);
  await writeMemory(core, 'sources/local/project-orchard/operator-notes.md', `---
visibility: source-local
source_id: source-local:orchard-operator
---
- Fact: source-local operator scratchpad is adapter-local and excluded from project digest.
`);
  await writeMemory(core, 'scopes/project-orchard/redaction.md', `---
visibility: project
---
- Fact: escalation contact owner@example.com must be redacted before export.
`);
}

function serialized(value) {
  return JSON.stringify(value);
}

test('alpha25 gate matrix: named project scope excludes other projects, private, audit-only, and source-local lanes', async (t) => {
  const core = await coreFor(t);
  await seedEnterpriseGateMatrix(core);

  const draft = await core.organize({ scope: 'project-orchard', actor: 'enterprise-gate-test' });
  const json = serialized(draft);

  assert.match(json, /Project Orchard ships the review-first export gate/);
  assert.match(json, /source-shared Orchard research/);
  assert.doesNotMatch(json, /Project Harbor keeps a separate release queue/);
  assert.doesNotMatch(json, /Harbor budget/);
  assert.doesNotMatch(json, /private staffing note/);
  assert.doesNotMatch(json, /audit-only routing detail/);
  assert.doesNotMatch(json, /source-local operator scratchpad/);
  assert.ok(draft.safety.out_of_scope_sources_excluded >= 4, 'excluded cross-boundary sources are counted');
  assert.deepEqual(new Set(draft.sources.map((s) => s.visibility)), new Set(['project', 'source-shared']));
});

test('alpha25 gate matrix: public scope excludes private, audit-only, source-local, and source-shared imports', async (t) => {
  const core = await coreFor(t);
  await seedEnterpriseGateMatrix(core);

  const draft = await core.organize({ scope: 'public', actor: 'enterprise-gate-test' });
  const json = serialized(draft);

  assert.match(json, /Project Orchard ships the review-first export gate/);
  assert.match(json, /Project Harbor keeps a separate release queue/);
  assert.doesNotMatch(json, /private staffing note/);
  assert.doesNotMatch(json, /audit-only routing detail/);
  assert.doesNotMatch(json, /source-local operator scratchpad/);
  assert.doesNotMatch(json, /source-shared Orchard research/);
  assert.ok(draft.sources.every((s) => s.visibility === 'project'));
});

test('alpha25 gate matrix: source scope includes source lanes without leaking curated private/audit content', async (t) => {
  const core = await coreFor(t);
  await seedEnterpriseGateMatrix(core);

  const draft = await core.organize({ scope: 'source', actor: 'enterprise-gate-test' });
  const json = serialized(draft);

  assert.match(json, /source-shared Orchard research/);
  assert.match(json, /source-local operator scratchpad/);
  assert.doesNotMatch(json, /private staffing note/);
  assert.doesNotMatch(json, /audit-only routing detail/);
  assert.ok(draft.sources.every((s) => s.visibility === 'source-local' || s.visibility === 'source-shared'));
});

test('alpha25 gate matrix: blocked_items export fails closed with auditable policy metadata', async (t) => {
  const core = await coreFor(t);
  await seedEnterpriseGateMatrix(core);

  const draft = await core.organize({ scope: 'project-orchard', actor: 'enterprise-gate-test' });
  const draftPath = path.join(core.workspace.spaceDir, draft.draft_path);
  const blockedDraft = {
    ...draft,
    decisions_facts: [
      ...draft.decisions_facts,
      {
        id: 'item_blocked_placeholder',
        type: 'fact',
        text: '[blocked item intentionally omitted]',
        claim_kind: 'evidence',
        evidence: [],
        flags: [],
      },
    ],
    safety: {
      ...draft.safety,
      blocked_items: 1,
      export_safe: false,
    },
  };
  await fs.writeFile(draftPath, `${JSON.stringify(blockedDraft, null, 2)}\n`, 'utf8');

  await assert.rejects(
    core.export_vault(draft.draft_id, { actor: 'enterprise-gate-test' }),
    (error) => {
      assert.equal(error?.code, 'export_blocked_items_fail_closed');
      assert.equal(error?.blocked_items, 1);
      return true;
    },
  );

  const exportsDir = path.join(core.workspace.spaceDir, 'gardener', 'exports', draft.draft_id);
  await assert.rejects(fs.readdir(exportsDir), /ENOENT/, 'no sanitized subset is silently exported');

  const events = await core.audit();
  const refused = events.find((event) => event.type === 'memory.exported' && event.metadata?.draftId === draft.draft_id && event.metadata?.status === 'refused');
  assert.ok(refused, 'blocked export refusal is audited');
  assert.equal(refused.metadata?.blockedItemsPolicy, 'fail-closed');
  assert.equal(refused.metadata?.reason, 'blocked_items_present');
  assert.equal(containsSecretLikeContent(JSON.stringify(refused)), false, 'refusal audit metadata is detector-clean');
});

test('alpha25 gate matrix: export preserves the same boundary and redaction invariants', async (t) => {
  const core = await coreFor(t);
  await seedEnterpriseGateMatrix(core);

  const draft = await core.organize({ scope: 'project-orchard', actor: 'enterprise-gate-test' });
  const out = await core.export_vault(draft.draft_id, { actor: 'enterprise-gate-test' });
  const md = await fs.readFile(path.join(core.workspace.spaceDir, out.path), 'utf8');

  assert.match(md, /Project Orchard ships the review-first export gate/);
  assert.match(md, /source-shared Orchard research/);
  assert.match(md, /\[redacted\]/);
  assert.doesNotMatch(md, /owner@example\.com/);
  assert.doesNotMatch(md, /Project Harbor keeps a separate release queue/);
  assert.doesNotMatch(md, /private staffing note/);
  assert.doesNotMatch(md, /audit-only routing detail/);
  assert.doesNotMatch(md, /source-local operator scratchpad/);
  assert.equal(containsSecretLikeContent(md), false);

  const events = await core.audit();
  assert.ok(events.some((event) => event.type === 'memory.organized' && event.id === draft.audit_event_id));
  assert.ok(events.some((event) => event.type === 'memory.exported' && event.id === out.audit_event_id));
});
