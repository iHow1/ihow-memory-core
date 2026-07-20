// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openCore } from '../src/core.ts';
import { containsSecretLikeContent } from '../src/governance.ts';
import { gardenerDraftPath, organizeReportTick } from '../src/gardener.ts';
import { seedEnterpriseGardenerFixture, WORKFLOW_EVENTS } from './fixtures/enterprise-gardener.mjs';

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

async function runNode(args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve(stdout) : reject(new Error(`child_exit_${code}: ${stderr}`)));
  });
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

test('report-only tick is idempotent inside a TTL window and proves zero authority writes', async (t) => {
  const core = await coreFor(t);
  await fixture(core);
  const authority = path.join(core.workspace.memoryDir, 'scopes/project/alpha.md');
  const before = await fs.readFile(authority);
  const now = Date.parse('2026-07-20T03:00:00.000Z');

  const first = await organizeReportTick(core.workspace, { scope: 'project', actor: 'dream', ttlMs: 3_600_000, nowMs: now });
  const eventsAfterFirst = (await core.audit()).filter((event) => event.type === 'memory.organized');
  const draftBeforeReplay = await fs.readFile(path.join(core.workspace.spaceDir, first.draft_path));
  const second = await organizeReportTick(core.workspace, { scope: 'project', actor: 'dream', ttlMs: 3_600_000, nowMs: now + 30_000 });
  const eventsAfterSecond = (await core.audit()).filter((event) => event.type === 'memory.organized');

  assert.equal(first.status, 'created');
  assert.equal(second.status, 'reused');
  assert.equal(second.run_id, first.run_id);
  assert.equal(second.draft_id, first.draft_id);
  assert.equal(second.source_manifest_sha256, first.source_manifest_sha256);
  assert.equal(second.expires_at, first.expires_at);
  assert.equal(eventsAfterSecond.length, eventsAfterFirst.length, 'replay adds no organize audit event');
  assert.deepEqual(await fs.readFile(path.join(core.workspace.spaceDir, first.draft_path)), draftBeforeReplay, 'replay does not overwrite the draft');
  assert.deepEqual(await fs.readFile(authority), before, 'tick never writes authoritative memory');
  assert.deepEqual(first.safety, { mode: 'report-only', authority_writes: 0, rollback_required: false });
});

test('report-only tick creates a new run only when source bytes or the TTL window changes', async (t) => {
  const core = await coreFor(t);
  await fixture(core);
  const now = Date.parse('2026-07-20T03:00:00.000Z');
  const first = await organizeReportTick(core.workspace, { scope: 'project', ttlMs: 60_000, nowMs: now });

  await fs.appendFile(path.join(core.workspace.memoryDir, 'scopes/project/open.md'), '- Fact: a new source byte changes the report manifest.\n');
  const changed = await organizeReportTick(core.workspace, { scope: 'project', ttlMs: 60_000, nowMs: now + 1_000 });
  assert.notEqual(changed.source_manifest_sha256, first.source_manifest_sha256);
  assert.notEqual(changed.run_id, first.run_id);
  assert.equal(changed.status, 'created');

  const expired = await organizeReportTick(core.workspace, { scope: 'project', ttlMs: 60_000, nowMs: now + 61_000 });
  assert.equal(expired.status, 'created');
  assert.notEqual(expired.run_id, changed.run_id, 'a new TTL window produces a new run even with unchanged source bytes');
  assert.equal(expired.source_manifest_sha256, changed.source_manifest_sha256);
});

test('concurrent report-only ticks converge on one created run and one organize event', async (t) => {
  const core = await coreFor(t);
  await fixture(core);
  const opts = { scope: 'project', ttlMs: 60_000, nowMs: Date.parse('2026-07-20T03:00:00.000Z') };
  const results = await Promise.all(Array.from({ length: 8 }, () => organizeReportTick(core.workspace, opts)));
  assert.equal(new Set(results.map((result) => result.run_id)).size, 1);
  assert.equal(results.filter((result) => result.status === 'created').length, 1);
  assert.equal(results.filter((result) => result.status === 'reused').length, 7);
  assert.equal((await core.audit()).filter((event) => event.type === 'memory.organized').length, 1);
});

test('report-only tick refuses a tampered receipt or missing draft instead of claiming reuse', async (t) => {
  const core = await coreFor(t);
  await fixture(core);
  const opts = { scope: 'project', ttlMs: 60_000, nowMs: Date.parse('2026-07-20T03:00:00.000Z') };
  const created = await organizeReportTick(core.workspace, opts);
  const runsDir = path.join(core.workspace.spaceDir, 'gardener', 'runs');
  const [receiptName] = await fs.readdir(runsDir);
  const receiptPath = path.join(runsDir, receiptName);
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));

  await fs.writeFile(receiptPath, `${JSON.stringify({ ...receipt, safety: { ...receipt.safety, authority_writes: 1 } }, null, 2)}\n`);
  await assert.rejects(organizeReportTick(core.workspace, opts), /gardener_report_receipt_invalid/);

  await fs.writeFile(receiptPath, `${JSON.stringify({ ...receipt, draft_path: '../../outside.json' }, null, 2)}\n`);
  await assert.rejects(organizeReportTick(core.workspace, opts), /gardener_report_receipt_invalid/);

  const draftPath = path.join(core.workspace.spaceDir, created.draft_path);
  const draft = JSON.parse(await fs.readFile(draftPath, 'utf8'));
  await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  await fs.writeFile(draftPath, `${JSON.stringify({ ...draft, current_state_summary: { ...draft.current_state_summary, text: 'tampered' } }, null, 2)}\n`);
  await assert.rejects(organizeReportTick(core.workspace, opts), /gardener_report_draft_invalid/);

  await fs.writeFile(draftPath, `${JSON.stringify(draft, null, 2)}\n`);
  await fs.rm(draftPath);
  await assert.rejects(organizeReportTick(core.workspace, opts), /gardener_report_draft_missing/);
});

test('programmatic invalid TTL is normalized before any audit or draft side effect', async (t) => {
  const core = await coreFor(t);
  await fixture(core);
  const result = await organizeReportTick(core.workspace, { scope: 'project', ttlMs: Number.NaN, nowMs: Date.parse('2026-07-20T03:00:00.000Z') });
  assert.equal(result.status, 'created');
  assert.equal(Date.parse(result.expires_at) - Date.parse(result.window_started_at), 3_600_000);
  assert.equal((await core.audit()).filter((event) => event.type === 'memory.organized').length, 1);
});

test('non-manifest draft-input drift opens a new run instead of false tamper until TTL expiry', async (t) => {
  const core = await coreFor(t);
  await fixture(core);
  const now = Date.parse('2026-07-20T03:00:00.000Z');
  const first = await organizeReportTick(core.workspace, { scope: 'project', ttlMs: 60_000, nowMs: now });
  await writeMemory(core, 'scopes/private/another-private.md', '- Fact: remains outside project scope.\n');
  const second = await organizeReportTick(core.workspace, { scope: 'project', ttlMs: 60_000, nowMs: now + 1_000 });
  assert.equal(second.status, 'created');
  assert.notEqual(second.run_id, first.run_id);
  assert.equal(second.source_manifest_sha256, first.source_manifest_sha256);
});

test('two CLI processes racing in one window converge through the cross-process workspace lock', async (t) => {
  const root = await mkdtempReal('ihow-gardener-race-cli-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const core = await openCore({ root, space: 'race' });
  await fixture(core);
  const env = { ...process.env, IHOW_MEMORY_HOME: root };
  const args = [CLI, 'organize-tick', '--root', root, '--space', 'race', '--scope', 'project', '--ttl', '1h', '--json'];
  const outputs = await Promise.all([runNode(args, { env }), runNode(args, { env })]);
  const results = outputs.map((output) => JSON.parse(output));
  assert.equal(new Set(results.map((result) => result.run_id)).size, 1);
  assert.equal(results.filter((result) => result.status === 'created').length, 1);
  assert.equal(results.filter((result) => result.status === 'reused').length, 1);
  assert.equal((await core.audit()).filter((event) => event.type === 'memory.organized').length, 1);
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

test('export fails closed when a draft reports blocked items and audits the policy', async (t) => {
  const core = await coreFor(t);
  await fixture(core);
  const draft = await core.organize({ scope: 'project', actor: 'test' });
  const draftPath = gardenerDraftPath(core.workspace, draft.draft_id);
  const tampered = {
    ...draft,
    safety: {
      ...draft.safety,
      blocked_items: 1,
      export_safe: false,
    },
  };
  await fs.writeFile(draftPath, `${JSON.stringify(tampered, null, 2)}\n`, 'utf8');

  await assert.rejects(
    core.export_vault(draft.draft_id, { actor: 'blocked-export-test' }),
    (error) => {
      assert.equal(error?.code, 'export_blocked_items_fail_closed');
      assert.equal(error?.draft_id, draft.draft_id);
      assert.equal(error?.blocked_items, 1);
      assert.match(error?.audit_event_id, /^[0-9a-f-]+$/);
      return true;
    },
  );

  const exportPath = path.join(core.workspace.spaceDir, 'gardener', 'exports', draft.draft_id, 'memory-gardener-digest.md');
  await assert.rejects(fs.stat(exportPath), /ENOENT/, 'blocked export does not write Markdown');

  const events = await core.audit();
  const refused = events.find((event) => event.type === 'memory.exported' && event.metadata?.draftId === draft.draft_id && event.metadata?.status === 'refused');
  assert.ok(refused, 'refused export is audited');
  assert.equal(refused.metadata?.reason, 'blocked_items_present');
  assert.equal(refused.metadata?.blockedItems, 1);
  assert.equal(refused.metadata?.blockedItemsPolicy, 'fail-closed');
  assert.equal(refused.metadata?.exportPath, null);
});

test('successful export records explicit fail-closed blocked-items policy metadata', async (t) => {
  const core = await coreFor(t);
  await fixture(core);
  const draft = await core.organize({ scope: 'project', actor: 'test' });
  const out = await core.export_vault(draft.draft_id, { actor: 'policy-test' });

  assert.deepEqual(out.safety, {
    secret_redaction: 'passed',
    export_safe: true,
    blocked_items: 0,
    blocked_items_policy: 'fail-closed',
  });

  const md = await fs.readFile(path.join(core.workspace.spaceDir, out.path), 'utf8');
  assert.doesNotMatch(md, /api[_-]?key\s*[:=]/i, 'successful export has no blocked secret assignment');
  assert.equal(containsSecretLikeContent(md), false, 'successful export is detector-clean');

  const events = await core.audit();
  const exported = events.find((event) => event.id === out.audit_event_id);
  assert.ok(exported, 'successful export is audited');
  assert.equal(exported.metadata?.status, 'exported');
  assert.equal(exported.metadata?.blockedItems, 0);
  assert.equal(exported.metadata?.blockedItemsPolicy, 'fail-closed');
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

test('enterprise-style fixture proves workflow events through digest/export audit chain', async (t) => {
  const core = await coreFor(t);
  const seeded = await seedEnterpriseGardenerFixture(core);

  assert.equal(seeded.workflowEvents.length, WORKFLOW_EVENTS.length, 'workflow event fixture is deterministic');
  assert.match(seeded.candidate.path, /memory\/candidate\/inbox\//, 'workflow state includes a candidate-stage artifact');
  assert.match(seeded.promoted.path, /memory\/scopes\/project-orchard\//, 'workflow state includes promoted project memory');

  const draft = await core.organize({ scope: 'project', actor: 'enterprise-fixture-test' });
  const draftJson = JSON.stringify(draft);
  assert.equal(draft.schema_version, 'alpha24.gardener.v1');
  assert.equal(draft.mode, 'review-first');
  assert.equal(draft.safety.export_safe, true);
  assert.equal(containsSecretLikeContent(draftJson), false, 'draft is detector-clean');
  assert.match(draftJson, /Project Orchard will keep approvals review-first/);
  assert.match(draftJson, /candidate queue captures synthetic workflow evidence/);
  assert.doesNotMatch(draftJson, /private staffing notes/);
  assert.doesNotMatch(draftJson, /audit-only routing details/);
  assert.ok(draft.duplicate_stale_flags.some((flag) => flag.kind === 'duplicate_candidate' && flag.destructive === false));
  assert.ok(draft.duplicate_stale_flags.some((flag) => flag.kind === 'stale_candidate' && flag.destructive === false));

  for (const item of [...draft.decisions_facts, ...draft.next_actions_open_questions]) {
    assert.ok(item.evidence.length > 0, `${item.id} has linked evidence`);
    for (const evidence of item.evidence) {
      assert.match(evidence.source, /^memory\//, 'evidence links point back to source memory');
      assert.ok(evidence.lineStart >= 1 && evidence.lineEnd >= evidence.lineStart, 'evidence has line numbers');
    }
  }

  const out = await core.export_vault(draft.draft_id, { actor: 'enterprise-fixture-test' });
  const md = await fs.readFile(path.join(core.workspace.spaceDir, out.path), 'utf8');
  assert.match(md, /Export artifact only/);
  assert.match(md, /not source of truth/);
  assert.match(md, /memory\/scopes\/project-orchard\/workflow-state\.md:L\d+/);
  assert.match(md, /memory\/scopes\/project-orchard\/review-backlog\.md:L\d+/);
  assert.match(md, /memory\/scopes\/project-orchard\/\d{8}T\d{6}Z-candidate-queue-captured-synthetic-workflow-evidence\.md:L\d+/);
  assert.equal(containsSecretLikeContent(md), false, 'Markdown export passes redaction/secret detector');

  const events = await core.audit();
  assert.ok(events.some((event) => event.type === 'candidate.created' && event.path === seeded.candidate.path));
  assert.ok(events.some((event) => event.type === 'memory.promoted' && event.targetPath === seeded.promoted.path));
  assert.ok(events.some((event) => event.type === 'memory.organized' && event.id === draft.audit_event_id));
  assert.ok(events.some((event) => event.type === 'memory.exported' && event.id === out.audit_event_id));
});

test('CLI organize/export surfaces work with JSON', async (t) => {
  const root = await mkdtempReal('ihow-gardener-cli-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const core = await openCore({ root, space: 'cli' });
  await seedEnterpriseGardenerFixture(core);

  const env = { ...process.env, IHOW_MEMORY_HOME: root };
  const out = execFileSync(process.execPath, [CLI, 'organize', '--root', root, '--space', 'cli', '--scope', 'project', '--draft', '--json'], { encoding: 'utf8', env });
  const draft = JSON.parse(out);
  assert.ok(draft.draft_id);
  assert.equal(draft.audit_event_id.length > 0, true);
  assert.ok(draft.sources.some((source) => source.source === 'memory/scopes/project-orchard/workflow-state.md'));
  assert.equal(containsSecretLikeContent(out), false, 'CLI draft JSON is detector-clean');

  const exp = execFileSync(process.execPath, [CLI, 'export-vault', '--root', root, '--space', 'cli', '--from-draft', draft.draft_id, '--format', 'markdown', '--json'], { encoding: 'utf8', env });
  const result = JSON.parse(exp);
  assert.equal(result.ok, true);
  assert.match(result.path, /memory-gardener-digest\.md$/);
  const md = await fs.readFile(path.join(core.workspace.spaceDir, result.path), 'utf8');
  assert.match(md, /Project Orchard/);
  assert.match(md, /Evidence:/);
  assert.equal(containsSecretLikeContent(md), false, 'CLI export Markdown is detector-clean');
});

test('CLI organize-tick exposes the report-only idempotent scheduler primitive', async (t) => {
  const root = await mkdtempReal('ihow-gardener-tick-cli-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const core = await openCore({ root, space: 'tick-cli' });
  await fixture(core);
  const env = { ...process.env, IHOW_MEMORY_HOME: root };
  const args = [CLI, 'organize-tick', '--root', root, '--space', 'tick-cli', '--scope', 'project', '--ttl', '1h', '--json'];
  const first = JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8', env }));
  const second = JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8', env }));
  assert.equal(first.status, 'created');
  assert.equal(second.status, 'reused');
  assert.equal(second.run_id, first.run_id);
  assert.deepEqual(first.safety, { mode: 'report-only', authority_writes: 0, rollback_required: false });
  assert.equal((await core.audit()).filter((event) => event.type === 'memory.organized').length, 1);
  assert.throws(
    () => execFileSync(process.execPath, [CLI, 'organize-tick', '--root', root, '--space', 'tick-cli', '--ttl', '0h', '--json'], { encoding: 'utf8', env }),
    /Command failed/,
  );
});
