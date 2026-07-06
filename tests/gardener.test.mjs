// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openCore } from '../src/core.ts';
import { containsSecretLikeContent } from '../src/governance.ts';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts');

async function mkdtempReal(prefix) {
  return await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

async function coreFor(t) {
  const root = await mkdtempReal('ihow-gardener-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return await openCore({ root, space: 'gtest' });
}

async function writeMemory(core, rel, body) {
  const p = path.join(core.workspace.memoryDir, rel);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, body, 'utf8');
  return p;
}

function normalizeDraft(d) {
  const copy = JSON.parse(JSON.stringify(d));
  copy.created_at = '<time>';
  copy.audit_event_id = '<event>';
  return copy;
}

async function fixture(core) {
  await writeMemory(core, 'scopes/project/alpha.md', `---
visibility: project
---
# Alpha plan
- Decision: use deterministic heuristics for the gardener MVP.
- Fact: export writes Markdown with evidence links.
- Next action: add independent review notes.
- Decision: use deterministic heuristics for the gardener MVP.
- Stale: old auto-merge plan is deprecated and replaced by review-first drafts.
`);
  await writeMemory(core, 'scopes/private/secret-note.md', `---
visibility: private
---
- Fact: private roadmap should not appear in project public digest.
`);
  await writeMemory(core, 'scopes/project/open.md', `# Open
- Open question: should export grouping change later?
`);
}

test('organize draft from deterministic fixture is stable and evidence-backed', async (t) => {
  const core = await coreFor(t);
  await fixture(core);
  const a = await core.organize({ scope: 'project', actor: 'test' });
  const b = await core.organize({ scope: 'project', actor: 'test' });

  assert.equal(a.draft_id, b.draft_id, 'content-derived draft id is stable');
  assert.deepEqual(normalizeDraft(a), normalizeDraft(b), 'draft JSON is stable aside from audit time/id');
  assert.equal(a.mode, 'review-first');
  assert.match(a.source_of_truth, /not rewritten/);
  for (const item of [...a.decisions_facts, ...a.next_actions_open_questions]) {
    if (item.claim_kind === 'evidence') assert.ok(item.evidence.length > 0, `${item.id} has evidence`);
    else assert.match(item.claim_kind, /inference|open-question/);
  }
});

test('duplicate/stale candidates are flagged, not deleted or rewritten', async (t) => {
  const core = await coreFor(t);
  await fixture(core);
  const before = await fs.readFile(path.join(core.workspace.memoryDir, 'scopes/project/alpha.md'), 'utf8');
  const draft = await core.organize({ scope: 'project' });
  const after = await fs.readFile(path.join(core.workspace.memoryDir, 'scopes/project/alpha.md'), 'utf8');

  assert.equal(after, before, 'organize does not rewrite curated/source memory');
  assert.ok(draft.duplicate_stale_flags.some((f) => f.kind === 'duplicate_candidate' && f.destructive === false));
  assert.ok(draft.duplicate_stale_flags.some((f) => f.kind === 'stale_candidate' && f.destructive === false));
});

test('export produces Markdown view artifact, preserves evidence links, and audits export', async (t) => {
  const core = await coreFor(t);
  await fixture(core);
  const draft = await core.organize({ scope: 'project' });
  const out = await core.export_vault(draft.draft_id);
  assert.equal(out.ok, true);
  assert.equal(out.format, 'markdown');
  assert.match(out.source_of_truth, /view\/export artifact only/);

  const abs = path.join(core.workspace.spaceDir, out.path);
  const md = await fs.readFile(abs, 'utf8');
  assert.match(md, /^# Safe Memory Gardener Draft/m);
  assert.match(md, /Evidence:/);
  assert.match(md, /memory\/scopes\/project\/alpha\.md:L\d+/);
  assert.equal(containsSecretLikeContent(md), false, 'export is detector-clean');
  const events = await core.audit();
  assert.ok(events.some((e) => e.type === 'memory.organized' && e.id === draft.audit_event_id));
  assert.ok(events.some((e) => e.type === 'memory.exported' && e.id === out.audit_event_id));
});

test('secret/PII fixture is redacted in draft/export and raw value does not leak', async (t) => {
  const core = await coreFor(t);
  await writeMemory(core, 'scopes/project/pii.md', `# Contact
- Fact: contact owner at person@example.com for review.
`);
  const draft = await core.organize({ scope: 'project' });
  const draftRaw = await fs.readFile(path.join(core.workspace.spaceDir, draft.draft_path), 'utf8');
  assert.doesNotMatch(draftRaw, /person@example\.com/);
  assert.equal(containsSecretLikeContent(draftRaw), false);

  const out = await core.export_vault(draft.draft_id);
  const md = await fs.readFile(path.join(core.workspace.spaceDir, out.path), 'utf8');
  assert.doesNotMatch(md, /person@example\.com/);
  assert.match(md, /\[redacted\]/);
  assert.equal(containsSecretLikeContent(md), false);
});

test('project/public scope smoke excludes private and audit-only content', async (t) => {
  const core = await coreFor(t);
  await fixture(core);
  await writeMemory(core, 'audit/log.md', `---
visibility: audit-only
---
- Fact: audit-only line should not appear.
`);
  const draft = await core.organize({ scope: 'project' });
  const serialized = JSON.stringify(draft);
  assert.doesNotMatch(serialized, /private roadmap/);
  assert.doesNotMatch(serialized, /audit-only line/);
  assert.ok(draft.safety.out_of_scope_sources_excluded >= 2);
});

test('CLI organize/export surfaces work with JSON', async (t) => {
  const root = await mkdtempReal('ihow-gardener-cli-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const core = await openCore({ root, space: 'cli' });
  await writeMemory(core, 'scopes/project/cli.md', '- Decision: CLI gardener command emits JSON draft.\n');

  const env = { ...process.env, IHOW_MEMORY_HOME: root };
  const out = execFileSync(process.execPath, [CLI, 'organize', '--root', root, '--space', 'cli', '--scope', 'project', '--draft', '--json'], { encoding: 'utf8', env });
  const draft = JSON.parse(out);
  assert.ok(draft.draft_id);
  assert.equal(draft.audit_event_id.length > 0, true);

  const exp = execFileSync(process.execPath, [CLI, 'export-vault', '--root', root, '--space', 'cli', '--from-draft', draft.draft_id, '--format', 'markdown', '--json'], { encoding: 'utf8', env });
  const result = JSON.parse(exp);
  assert.equal(result.ok, true);
  assert.match(result.path, /memory-gardener-digest\.md$/);
});
