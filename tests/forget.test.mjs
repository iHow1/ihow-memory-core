// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// C4 — one-gesture correction ("忘掉这条 / 记错了"). The contract:
//   - forget TOMBSTONES via the append-only event log (memory.forgotten) — the file is untouched,
//     `read` still works, and the entry stops surfacing in BOTH search and recall (core.search is the
//     single chokepoint: CLI / MCP / HTTP / recall hook all flow through it).
//   - fully reversible (memory.remembered), both directions audited with actor.
//   - free text applies ONLY on a single unambiguous match; multiple matches are listed, nothing applied.
//   - a HUMAN-REVIEWED entry needs --yes (an agent gesture can't silently disappear a curated rule);
//     the machine-judged auto lane — what this gesture exists for — forgets in one step.
//   - the event log is the trust source: a file re-written at a forgotten path stays forgotten.
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
function cliRaw(args, root, space) {
  return spawnSync(process.execPath, [CLI, ...args, '--root', root, '--space', space], { encoding: 'utf8' });
}
function recall(prompt, root, space) {
  return spawnSync(process.execPath, [CLI, 'hook-user-prompt-submit', '--root', root, '--space', space], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt, cwd: root }),
    encoding: 'utf8',
  });
}
const recallCtx = (prompt, root, space) => {
  const out = recall(prompt, root, space);
  return out.stdout.trim() ? JSON.parse(out.stdout).hookSpecificOutput.additionalContext : '';
};
const searchPaths = (q, root, space) => JSON.parse(cli(['search', q], root, space)).map((h) => h.path);

test('forget (C4 happy path): auto entry → forget by free text → gone from search AND recall → remember → back', async (t) => {
  const root = await mkdtempReal('ihow-forget-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const space = 'h';
  cli(['write-candidate', 'ZFG1 the vulpeservice dashboards use warm amber accents.'], root, space);
  cli(['reindex'], root, space);

  // surfaces before
  assert.ok(searchPaths('vulpeservice amber', root, space).length > 0, 'entry is searchable before forget');
  assert.ok(recallCtx('what accent color do vulpeservice dashboards use', root, space).includes('ZFG1'), 'entry recalls before forget');

  // one gesture — free text, single match, no tier knowledge needed
  const out = cliRaw(['forget', 'vulpeservice amber accents'], root, space);
  assert.equal(out.status, 0, `forget applies in one step: ${out.stderr}`);
  assert.match(out.stdout, /✓ forgotten/, 'confirms plainly');
  assert.match(out.stdout, /ihow-memory remember/, 'shows the undo handle');

  // gone EVERYWHERE (search + recall through the same chokepoint), file untouched
  assert.equal(searchPaths('vulpeservice amber', root, space).length, 0, 'search no longer surfaces it');
  assert.ok(!recallCtx('what accent color do vulpeservice dashboards use', root, space).includes('ZFG1'), 'recall no longer surfaces it');
  const listed = cli(['forget', '--list'], root, space);
  assert.match(listed, /ZFG1|vulpeservice/, 'forget --list shows it');
  const gone = JSON.parse(cli(['forget', '--list', '--json'], root, space)).forgotten;
  assert.equal(gone.length, 1);
  const read = JSON.parse(cli(['search', 'vulpeservice', '--json'], root, space).trim() || '[]');
  void read; // search returns [] — but the FILE is untouched:
  const abs = path.join(root, space, gone[0].path);
  await fs.access(abs); // does not throw — tombstone, not deletion

  // remember by free text against the forgotten list
  const back = cliRaw(['remember', 'vulpeservice'], root, space);
  assert.equal(back.status, 0, back.stderr);
  assert.ok(searchPaths('vulpeservice amber', root, space).length > 0, 'search surfaces it again');
  assert.ok(recallCtx('what accent color do vulpeservice dashboards use', root, space).includes('ZFG1'), 'recall surfaces it again');
});

test('forget (C4 guard): a human-reviewed entry needs --yes; auto entries do not', async (t) => {
  const root = await mkdtempReal('ihow-forget-rv-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const space = 'h';
  const cand = JSON.parse(cli(['write-candidate', '--no-auto-promote', 'ZFG2 decision: lynxservice uses the eu-central region.'], root, space)).path;
  cli(['promote', cand, '--scope', 'team', '--title', 'lynxservice region'], root, space);
  cli(['reindex'], root, space);

  const refuse = cliRaw(['forget', 'lynxservice region decision'], root, space);
  assert.notEqual(refuse.status, 0, 'refuses without --yes');
  assert.match(refuse.stdout, /human-reviewed/, 'says WHY and how to proceed');
  assert.ok(searchPaths('lynxservice region', root, space).length > 0, 'nothing was forgotten on refusal');

  const ok = cliRaw(['forget', 'lynxservice region decision', '--yes'], root, space);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.equal(searchPaths('lynxservice region', root, space).length, 0, 'forgotten with explicit --yes');
});

test('forget (C4 ambiguity): multiple matches list the candidates and apply NOTHING; exact path applies', async (t) => {
  const root = await mkdtempReal('ihow-forget-amb-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const space = 'h';
  cli(['write-candidate', 'ZFG3a corvusservice retries use exponential backoff.'], root, space);
  cli(['write-candidate', 'ZFG3b corvusservice retries cap at five attempts.'], root, space);
  cli(['reindex'], root, space);

  const amb = cliRaw(['forget', 'corvusservice retries'], root, space);
  assert.notEqual(amb.status, 0, 'ambiguous -> no gesture applied');
  assert.match(amb.stdout, /several memories match/, 'explains');
  assert.match(amb.stdout, /ihow-memory forget memory\//, 'offers copy-pasteable per-path commands');
  assert.equal(searchPaths('corvusservice retries', root, space).length, 2, 'both still surface');

  const pathTo = searchPaths('corvusservice retries', root, space)[0];
  const one = cliRaw(['forget', pathTo], root, space);
  assert.equal(one.status, 0, one.stdout + one.stderr);
  assert.equal(searchPaths('corvusservice retries', root, space).length, 1, 'exactly the picked one is gone');
});

test('forget (C4 trust source): a file RE-WRITTEN at a forgotten path stays forgotten (event log wins, not file content)', async (t) => {
  const root = await mkdtempReal('ihow-forget-rw-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const space = 'h';
  cli(['write-candidate', 'ZFG4 the pavoservice cache TTL is ninety seconds.'], root, space);
  cli(['reindex'], root, space);
  const p = searchPaths('pavoservice cache', root, space)[0];
  assert.ok(p);
  cliRaw(['forget', p], root, space);
  assert.equal(searchPaths('pavoservice cache', root, space).length, 0);

  // adversarial: re-write fresh content at the SAME path (frontmatter says nothing about forgotten)
  const abs = path.join(root, space, p);
  await fs.writeFile(abs, ['---', 'status: "promoted"', 'type: "memory"', '---', '', 'ZFG4 the pavoservice cache TTL is ninety seconds, resurrected.', ''].join('\n'), 'utf8');
  cli(['reindex'], root, space);
  assert.equal(searchPaths('pavoservice cache', root, space).length, 0, 'still forgotten — the tombstone lives in the append-only log, not the file');
  // …until an EXPLICIT remember
  cliRaw(['remember', p], root, space);
  assert.equal(searchPaths('pavoservice cache', root, space).length, 1, 'explicit remember re-admits it');
});

test('forget (C4 audit): both directions are events with actor; no-match and empty input fail politely', async (t) => {
  const root = await mkdtempReal('ihow-forget-audit-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const space = 'h';
  cli(['write-candidate', 'ZFG5 the aquilaservice logo sits top left.'], root, space);
  cli(['reindex'], root, space);
  const p = searchPaths('aquilaservice logo', root, space)[0];
  const f = JSON.parse(cli(['forget', p, '--json'], root, space));
  assert.equal(f.status, 'forgotten');
  assert.ok(f.eventId, 'forget returns its audit event id');
  const r = JSON.parse(cli(['remember', p, '--json'], root, space));
  assert.equal(r.status, 'remembered');
  const audit = cli(['audit'], root, space);
  assert.match(audit, /memory\.forgotten/, 'forgotten event in the audit log');
  assert.match(audit, /memory\.remembered/, 'remembered event in the audit log');

  const none = cliRaw(['forget', 'zzz nothing matches this zzz'], root, space);
  assert.notEqual(none.status, 0);
  assert.match(none.stdout, /no matching memory/, 'polite no-match');
  const empty = cliRaw(['forget'], root, space);
  assert.notEqual(empty.status, 0, 'empty input -> usage, not a crash');
});

test('forget (C4): remembering something never forgotten says so; forget is idempotent-safe via the live filter', async (t) => {
  const root = await mkdtempReal('ihow-forget-idem-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const space = 'h';
  cli(['write-candidate', 'ZFG6 the geminiservice banner is teal.'], root, space);
  cli(['reindex'], root, space);
  const p = searchPaths('geminiservice banner', root, space)[0];
  const nf = cliRaw(['remember', p], root, space);
  assert.notEqual(nf.status, 0);
  assert.match(nf.stdout, /nothing forgotten matches/, 'remember on a live entry is a polite no-op');
  cliRaw(['forget', p], root, space);
  // forgetting again by FREE TEXT now finds nothing live -> no-match (never double-tombstones silently)
  const again = cliRaw(['forget', 'geminiservice banner teal'], root, space);
  assert.notEqual(again.status, 0);
  assert.match(again.stdout, /no matching memory|already be forgotten/, 'second gesture explains instead of stacking');
});

// --- Red-team BLOCK regression (2026-07-02): uniqueness must be PROVEN, never window-shaped. The
// tombstone filter runs after the search cap, so a shallow raw window could hide a second LIVE match
// behind already-forgotten hits and misfire the "unique match" tombstone. ---
test('forget (red-team): a live second match hidden behind forgotten hits must yield ambiguous, never a tombstone', async (t) => {
  const root = await mkdtempReal('ihow-forget-cap-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const space = 'h';
  // 6 entries sharing the same needle
  for (let i = 0; i < 6; i++) cli(['write-candidate', `ZFG7-${i} the lupusservice worker pool tunes batch size ${i}.`], root, space);
  cli(['reindex'], root, space);
  const deepSearch = (q) => JSON.parse(cli(['search', q, '--limit', '20'], root, space)).map((h) => h.path);
  let paths = deepSearch('lupusservice worker pool');
  assert.equal(paths.length, 6, 'all six surface before any forget');
  // forget the first FOUR by exact path — they now sit as tombstoned hits at the top of the raw window
  for (const p of paths.slice(0, 4)) assert.equal(cliRaw(['forget', p], root, space).status, 0);
  // free-text forget with TWO live matches left: must be ambiguous, must apply NOTHING
  const out = cliRaw(['forget', 'lupusservice worker pool'], root, space);
  assert.notEqual(out.status, 0, 'ambiguous → non-zero, nothing applied');
  assert.match(out.stdout, /match/i, 'explains the ambiguity');
  const live = deepSearch('lupusservice worker pool');
  assert.equal(live.length, 2, 'BOTH remaining live entries still surface — no misfired tombstone');
});
