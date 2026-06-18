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
