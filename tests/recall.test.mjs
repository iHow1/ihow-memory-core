// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Recall (UserPromptSubmit hook) tests — the OpenClaw-GATED reading path. Recall is default-off and
// safety-first; these lock the contract:
//   - SAFETY: injects ONLY curated/promoted memory; NEVER the low-weight journal/floor lanes (the
//     recall-harm guard) — even when a low-weight entry matches the query.
//   - bounded (top-N), valid UserPromptSubmit additionalContext JSON, never blocks, never throws.
//   - no-op (no output) when there is no relevant curated memory.
//   - kill-switch: IHOW_RECALL_OFF disables injection.
//   - DEFAULT-OFF install: plain `install-hook` adds NO UserPromptSubmit hook; only `--recall` does.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts');

async function mkdtempReal(prefix) {
  return await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}
function cli(args, root, space) {
  return execFileSync(process.execPath, [CLI, ...args, '--root', root, '--space', space], { encoding: 'utf8' });
}
function recall(prompt, root, space, env = {}) {
  return spawnSync(process.execPath, [CLI, 'hook-user-prompt-submit', '--root', root, '--space', space], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt, cwd: root }),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}
// Seed one CURATED (promoted) memory + one LOW-WEIGHT (journal) memory that both match a query term.
async function seed(root, space) {
  const cand = JSON.parse(cli(['write-candidate', 'Decision: adopt zetaframework for the dashboard rollout, approved by the team.'], root, space)).path;
  cli(['promote', cand, '--scope', 'team', '--title', 'zetaframework decision'], root, space);
  cli(['journal', 'passing aside: someone mentioned zetaframework once, unverified low-weight note.', '--actor', 'claude-code-hook'], root, space);
}

test('recall: NEVER injects an unreviewed auto-promoted entry (machine-judged, not human-reviewed)', async (t) => {
  const root = await mkdtempReal('ihow-recall-auto-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const space = 'h';
  // a HUMAN-reviewed promoted decision (the trusted lane) — must still be recalled
  const cand = JSON.parse(cli(['write-candidate', 'Decision: adopt zetaframework for the dashboard, approved by the team.'], root, space)).path;
  cli(['promote', cand, '--scope', 'team', '--title', 'zetaframework decision'], root, space);
  // an AUTO-promoted entry (tier: auto-promoted / reviewed: false) written straight into the curated lane,
  // exactly as the engine floor writes it — same path allowlist, but machine-judged, never human-vetted.
  const autoDir = path.join(root, space, 'memory', 'scopes', 'general');
  await fs.mkdir(autoDir, { recursive: true });
  await fs.writeFile(path.join(autoDir, 'auto-kappa.md'), [
    '---', 'candidate_id: "auto-kappa"', 'status: "promoted"', 'type: "memory"',
    'source_agent: "agent-auto"', 'promoted_at: "2026-06-25T00:00:00Z"',
    'tier: "auto-promoted"', 'reviewed: false', 'promoted_by: "agent-auto"', '---', '',
    'The kappaframework migration finished and all the checks passed.', '',
  ].join('\n'), 'utf8');
  cli(['reindex'], root, space);

  const out = recall('remind me about the zetaframework and kappaframework decisions', root, space);
  assert.equal(out.status, 0, 'never blocks');
  const ctx = out.stdout.trim() ? JSON.parse(out.stdout).hookSpecificOutput.additionalContext : '';
  assert.match(ctx, /zetaframework/, 'the human-reviewed promoted decision IS recalled');
  assert.ok(!/kappaframework/i.test(ctx), 'the unreviewed auto-promoted entry is NEVER injected (it lives only in scopes/general/auto-kappa)');
  assert.ok(!/auto-kappa/.test(ctx), 'the auto-promoted file path is not injected either');
});

test('recall: opt-in attributed auto tier — IHOW_RECALL_INCLUDE_AUTO surfaces auto entries tagged 🟡 with provenance', async (t) => {
  const root = await mkdtempReal('ihow-recall-tier-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const space = 'h';
  // a HUMAN-reviewed promoted decision (🟢) and an AUTO-promoted entry carrying its provenance in frontmatter (🟡).
  const cand = JSON.parse(cli(['write-candidate', 'Decision: adopt zetaframework for the dashboard, approved by the team.'], root, space)).path;
  cli(['promote', cand, '--scope', 'team', '--title', 'zetaframework decision'], root, space);
  const autoDir = path.join(root, space, 'memory', 'scopes', 'general');
  await fs.mkdir(autoDir, { recursive: true });
  await fs.writeFile(path.join(autoDir, 'auto-kappa.md'), [
    '---', 'candidate_id: "auto-kappa"', 'status: "promoted"', 'type: "memory"', 'source_agent: "agent-auto"',
    'promoted_at: "2026-06-25T00:00:00Z"', 'tier: "auto-promoted"', 'reviewed: false',
    'command: "npm test"', 'exitCode: 0', '---', '',
    'The kappaframework migration finished and all the checks passed.', '',
  ].join('\n'), 'utf8');
  cli(['reindex'], root, space);
  const prompt = 'remind me about the zetaframework and kappaframework decisions';

  // DEFAULT (no opt-in): auto entry excluded (the OpenClaw guard), reviewed entry tagged 🟢.
  const off = recall(prompt, root, space);
  const offCtx = off.stdout.trim() ? JSON.parse(off.stdout).hookSpecificOutput.additionalContext : '';
  assert.match(offCtx, /🟢 reviewed/, 'reviewed entry carries the green tag');
  assert.match(offCtx, /zetaframework/, 'reviewed entry is recalled');
  assert.ok(!/kappaframework/i.test(offCtx), 'by default the auto entry is still excluded');

  // OPT-IN: auto entry surfaces, tagged 🟡 with its provenance basis; reviewed stays 🟢.
  const on = recall(prompt, root, space, { IHOW_RECALL_INCLUDE_AUTO: '1' });
  const onCtx = on.stdout.trim() ? JSON.parse(on.stdout).hookSpecificOutput.additionalContext : '';
  assert.match(onCtx, /kappaframework/i, 'with opt-in the auto entry IS surfaced');
  assert.match(onCtx, /🟡 auto/, 'auto entry carries the yellow tier tag');
  assert.match(onCtx, /cites `npm test` exit 0/, 'auto entry shows its provenance basis');
  assert.match(onCtx, /🟢 reviewed/, 'the reviewed entry stays green-tagged alongside');
});

test('recall: variant YAML for unreviewed auto-promoted is STILL excluded (case/quote-tolerant)', async (t) => {
  const root = await mkdtempReal('ihow-recall-var-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const space = 'h';
  // a HUMAN-reviewed promoted decision — must still be recalled
  const cand = JSON.parse(cli(['write-candidate', 'Decision: adopt omegaframework for billing, approved by the team.'], root, space)).path;
  cli(['promote', cand, '--scope', 'team', '--title', 'omegaframework decision'], root, space);
  // unreviewed auto-promoted entries written with NON-standard YAML (a different runtime or a human editor
  // could serialize them this way) — all must be excluded, not just the engine's exact form.
  const dir = path.join(root, space, 'memory', 'scopes', 'general');
  await fs.mkdir(dir, { recursive: true });
  const variants = { 'v0.md': 'reviewed: "false"', 'v1.md': 'Reviewed: False', 'v2.md': "tier: 'auto-promoted'", 'v3.md': 'Tier: Auto-Promoted' };
  let i = 0;
  for (const [name, line] of Object.entries(variants)) {
    await fs.writeFile(path.join(dir, name), ['---', `candidate_id: "v${i}"`, 'status: "promoted"', 'type: "memory"', line, '---', '', `omegaframework migration step machine-note-${i} completed.`, ''].join('\n'), 'utf8');
    i++;
  }
  cli(['reindex'], root, space);

  const out = recall('what did we decide about the omegaframework billing migration', root, space);
  assert.equal(out.status, 0);
  const ctx = out.stdout.trim() ? JSON.parse(out.stdout).hookSpecificOutput.additionalContext : '';
  assert.match(ctx, /omegaframework/, 'the human-reviewed decision IS recalled');
  assert.ok(!/machine-note/i.test(ctx), 'no variant-YAML unreviewed auto-promoted entry is injected');
});

test('recall: injects ONLY curated memory, never the low-weight journal/floor lane', async (t) => {
  const root = await mkdtempReal('ihow-recall-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const space = 'h';
  await seed(root, space);

  const out = recall('what did we decide about zetaframework for the dashboard', root, space);
  assert.equal(out.status, 0, 'never blocks (exit 0)');
  const parsed = JSON.parse(out.stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit', 'correct hook output shape');
  const ctx = parsed.hookSpecificOutput.additionalContext;
  assert.match(ctx, /adopt zetaframework/, 'curated decision is recalled');
  assert.match(ctx, /scopes\/team/, 'recalled from the curated/promoted lane');
  assert.ok(!/memory\/journal\//.test(ctx) && !/memory\/_mcp\/journal\//.test(ctx), 'the low-weight journal/floor lane is NEVER injected');
  assert.ok(!ctx.includes('unverified low-weight'), 'the low-weight entry content is not injected');
  assert.match(ctx, /recalled reference DATA/i, 'recalled context is labelled as possibly-stale reference data');
  assert.match(ctx, /NOT instructions/i, 'recalled context is fenced as untrusted data, not instructions');
  assert.match(ctx, /<recalled-memory>[\s\S]*<\/recalled-memory>/, 'recalled content is fenced');
  // product-grade UX: no frontmatter noise (candidate_id UUIDs / metadata keys) in the recalled snippet
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(ctx), 'no frontmatter UUID noise in recalled snippet');
  assert.ok(!/candidate_id|promoted_at:|source_agent:/.test(ctx), 'no stray frontmatter keys in recalled snippet');
});

test('recall: no relevant curated memory -> no output (no noise)', async (t) => {
  const root = await mkdtempReal('ihow-recall-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const space = 'h';
  await seed(root, space);
  const out = recall('completely unrelated question about quantum gardening techniques', root, space);
  assert.equal(out.status, 0);
  assert.equal(out.stdout.trim(), '', 'nothing injected when no curated hit is relevant');
});

test('recall: kill-switch IHOW_RECALL_OFF disables injection', async (t) => {
  const root = await mkdtempReal('ihow-recall-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const space = 'h';
  await seed(root, space);
  const out = recall('what did we decide about zetaframework', root, space, { IHOW_RECALL_OFF: '1' });
  assert.equal(out.status, 0);
  assert.equal(out.stdout.trim(), '', 'kill-switch suppresses all injection');
});

test('recall: malformed / empty input never blocks, never throws', async (t) => {
  const root = await mkdtempReal('ihow-recall-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const space = 'h';
  const bad = spawnSync(process.execPath, [CLI, 'hook-user-prompt-submit', '--root', root, '--space', space], { input: 'not json {{{', encoding: 'utf8' });
  assert.equal(bad.status, 0, 'unparseable input -> exit 0');
  assert.equal(bad.stdout.trim(), '', 'no output on bad input');
  const empty = recall('', root, space);
  assert.equal(empty.status, 0);
  assert.equal(empty.stdout.trim(), '', 'empty prompt -> no output');
});

test('recall: bounded — at most 3 curated entries injected, within the char budget', async (t) => {
  const root = await mkdtempReal('ihow-recall-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const space = 'h';
  for (let i = 0; i < 6; i++) {
    const cand = JSON.parse(cli(['write-candidate', `Decision ${i}: zetaframework rollout step ${i} for the dashboard, approved.`], root, space)).path;
    cli(['promote', cand, '--scope', 'team', '--title', `zeta step ${i}`], root, space);
  }
  const out = recall('zetaframework dashboard rollout decisions', root, space);
  const ctx = JSON.parse(out.stdout).hookSpecificOutput.additionalContext;
  const bullets = ctx.split('\n').filter((l) => l.startsWith('- '));
  assert.ok(bullets.length <= 3, `at most 3 entries injected (got ${bullets.length})`);
  assert.ok(ctx.length <= 1200, 'within the char budget');
});

test('install: recall is DEFAULT-OFF — plain install-hook adds no UserPromptSubmit hook; --recall adds it', async (t) => {
  const proj = await mkdtempReal('ihow-proj-');
  t.after(async () => { await fs.rm(proj, { recursive: true, force: true }); });
  const dest = path.join(proj, '.claude', 'settings.local.json');
  const userPromptHooks = (s) => (s.hooks?.UserPromptSubmit ?? []).flatMap((g) => g.hooks ?? []).map((h) => h.command);

  // default: NO recall hook
  execFileSync(process.execPath, [CLI, 'install-hook'], { cwd: proj, encoding: 'utf8', env: { ...process.env } });
  let settings = JSON.parse(await fs.readFile(dest, 'utf8'));
  assert.ok((settings.hooks?.Stop ?? []).length > 0, 'Stop hook installed by default');
  assert.equal(userPromptHooks(settings).length, 0, 'NO UserPromptSubmit recall hook by default (OpenClaw: recall off)');

  // opt-in: --recall adds it
  execFileSync(process.execPath, [CLI, 'install-hook', '--recall'], { cwd: proj, encoding: 'utf8', env: { ...process.env } });
  settings = JSON.parse(await fs.readFile(dest, 'utf8'));
  assert.ok(userPromptHooks(settings).some((c) => c.includes('hook-user-prompt-submit')), '--recall adds the UserPromptSubmit recall hook');
});

// --- regression tests from the 2026-06-17 recall-safety review (all reproduced as real leaks) ---
function cliMR(args, memoryRoot, stateRoot) {
  return execFileSync(process.execPath, [CLI, ...args, '--memory-root', memoryRoot, '--state-root', stateRoot], { encoding: 'utf8' });
}
function recallMR(prompt, memoryRoot, stateRoot, env = {}) {
  return spawnSync(process.execPath, [CLI, 'hook-user-prompt-submit', '--memory-root', memoryRoot, '--state-root', stateRoot], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt, cwd: memoryRoot }),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('recall (existing-memory-root): an UNREVIEWED candidate is NEVER injected (allowlist, not denylist)', async (t) => {
  // The review reproduced: in --memory-root mode (the production OpenClaw-vault wiring) the candidate inbox
  // is memory/_mcp/candidates/, which IS indexed but was NOT excluded by the old journal-only denylist, so
  // unreviewed candidates were injected. The allowlist must reject them.
  const parent = await mkdtempReal('ihow-recall-mr-');
  const stateRoot = await mkdtempReal('ihow-recall-sr-');
  t.after(async () => { await fs.rm(parent, { recursive: true, force: true }); await fs.rm(stateRoot, { recursive: true, force: true }); });
  const memoryRoot = path.join(parent, 'memory');
  await fs.mkdir(memoryRoot, { recursive: true });
  cliMR(['write-candidate', 'CANDLEAKMARKER zetaframework dashboard rumor, NOT approved'], memoryRoot, stateRoot);
  const cand = JSON.parse(cliMR(['write-candidate', 'GOODMARKER zetaframework dashboard decision approved'], memoryRoot, stateRoot)).path;
  cliMR(['promote', cand, '--title', 'zeta decision'], memoryRoot, stateRoot);

  const out = recallMR('what about zetaframework for the dashboard', memoryRoot, stateRoot);
  assert.equal(out.status, 0, 'never blocks');
  const ctx = out.stdout.trim() ? JSON.parse(out.stdout).hookSpecificOutput.additionalContext : '';
  assert.ok(!ctx.includes('CANDLEAKMARKER'), 'the UNREVIEWED candidate is NEVER injected (allowlist fix, existing-memory-root)');
  assert.ok(!/_mcp\/candidates\//.test(ctx), 'no candidate-lane path injected');
});

test('recall: a secret in curated memory is redacted on the READ path, never injected raw', async (t) => {
  // The review reproduced: recall read the FTS snippet verbatim with NO redaction, so a secret in a
  // pre-existing/hand-maintained curated file (never passed a write gate) was injected raw.
  const root = await mkdtempReal('ihow-recall-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const space = 'h';
  const scopes = path.join(root, space, 'memory', 'scopes', 'team');
  await fs.mkdir(scopes, { recursive: true });
  // fixture uses a `password=` assignment (caught by the governance redactor) — NOT an AKIA/sk-/ghp_ shape
  // that would also trip the release pipeline's secret-scan on this test file.
  await fs.writeFile(path.join(scopes, 'seeded.md'), '# deploy\nzetaframework deploy is gated; password=hunter2supersecretvalue keeps it locked, ok.\n', 'utf8');
  cli(['reindex'], root, space);
  const out = recall('zetaframework deploy password', root, space);
  assert.equal(out.status, 0);
  const ctx = out.stdout.trim() ? JSON.parse(out.stdout).hookSpecificOutput.additionalContext : '';
  assert.ok(ctx.length > 0, 'the curated entry is recalled (the read path is exercised)');
  assert.ok(!ctx.includes('hunter2supersecretvalue'), 'the raw secret value is NEVER injected (read-path redaction)');
  assert.match(ctx, /\[redacted\]/, 'the secret was redacted in place');
});

test('recall: relevance gate — an off-topic prompt injects NOTHING even when curated memory exists', async (t) => {
  // harm-eval 2026-06-17: FTS matched on stopwords + a fixed 3-entry budget made recall inject off-topic
  // memory on every prompt (e.g. "capital of France" surfaced Postgres/API entries). The relevance gate
  // requires a shared meaningful term, so an unrelated prompt stays silent.
  const root = await mkdtempReal('ihow-recall-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const space = 'h';
  await seed(root, space); // curated zetaframework/dashboard memory exists
  const out = recall('what is the capital of France', root, space);
  assert.equal(out.status, 0);
  assert.equal(out.stdout.trim(), '', 'off-topic prompt -> no injection (relevance gate), despite curated memory present');
});

test('recall: intent-aware PII — redacted on an identity query, revealed when the value is asked', async (t) => {
  // harm-eval 2026-06-17: recall over-exposed a personal mobile + home address. Gate it by INTENT:
  // a "who do I contact" query keeps name+escalation but redacts the mobile/address; an explicit
  // "what is the phone number" query reveals it (good UX — you asked).
  const root = await mkdtempReal('ihow-recall-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const space = 'h';
  const cand = JSON.parse(cli(['write-candidate', 'On-call rotation: primary contact is Dana Lee, mobile 137-0000-2222, home address on file; escalate to Sam.'], root, space)).path;
  cli(['promote', cand, '--scope', 'team', '--title', 'on-call'], root, space);

  const idq = recall('who do I contact about the on-call rotation', root, space);
  const idCtx = idq.stdout.trim() ? JSON.parse(idq.stdout).hookSpecificOutput.additionalContext : '';
  assert.ok(idCtx.includes('Dana Lee') || idCtx.includes('Sam'), 'useful contact name / escalation path is kept');
  assert.ok(!idCtx.includes('137-0000-2222'), 'personal mobile NOT over-exposed on an identity query');
  assert.ok(!/home address on file/i.test(idCtx), 'home address NOT over-exposed on an identity query');

  const valq = recall('what is the on-call mobile phone number', root, space);
  const valCtx = valq.stdout.trim() ? JSON.parse(valq.stdout).hookSpecificOutput.additionalContext : '';
  assert.ok(valCtx.includes('137-0000-2222'), 'the mobile IS surfaced when the prompt explicitly asks for the number');
});

test('recall: recency/supersession — injects the current entry, drops the superseded one', async (t) => {
  // harm-eval 2026-06-17: recall co-injected a superseded value beside its current version. The recency/
  // contradiction collapse keeps only the current (currency-marked / latest) entry of a same-topic pair.
  const root = await mkdtempReal('ihow-recall-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const space = 'h';
  const c1 = JSON.parse(cli(['write-candidate', 'The widget service runs on cluster-alpha for all traffic.'], root, space)).path;
  cli(['promote', c1, '--scope', 'team', '--title', 'widget-cluster-old'], root, space);
  const c2 = JSON.parse(cli(['write-candidate', 'Update: the widget service was migrated to cluster-beta; cluster-alpha is deprecated, do not use.'], root, space)).path;
  cli(['promote', c2, '--scope', 'team', '--title', 'widget-cluster-new'], root, space);

  const out = recall('which cluster does the widget service run on', root, space);
  const ctx = out.stdout.trim() ? JSON.parse(out.stdout).hookSpecificOutput.additionalContext : '';
  const bullets = ctx.split('\n').filter((l) => l.startsWith('- '));
  assert.match(ctx, /cluster-beta/, 'the current (superseding) entry is injected');
  assert.ok(!/runs on cluster-alpha for all traffic/.test(ctx), 'the superseded entry is NOT co-injected');
  assert.equal(bullets.length, 1, 'same-topic pair collapses to a single current entry');
});
