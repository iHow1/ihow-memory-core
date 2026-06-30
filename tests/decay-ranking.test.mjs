// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Phase-4 DETERMINISTIC DECAY — INTEGRATION regression on the real CLI/FTS path. Locks the two HARD
// INVARIANTS this change is a governance/ranking variant of:
//   (1) verified/flagged (PINNED) entries are NEVER decayed and NEVER hard-deleted;
//   (2) decay only REORDERS / triages toward archive — it NEVER changes recall/search eligibility:
//       every seeded entry is still RETURNED by search; decay only moves it within the ranked list.
// End-to-end via `ihow-memory search` against a real built workspace (no mocks of the engine).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/ihow-memory.mjs', import.meta.url));
function cli(args, root, space) {
  return execFileSync(process.execPath, [CLI, ...args, '--space', space, '--root', root], {
    encoding: 'utf8',
    env: { ...process.env, IHOW_HANDOFF_METRICS: '0' },
  });
}
function recall(prompt, root, space, env = {}) {
  return spawnSync(process.execPath, [CLI, 'hook-user-prompt-submit', '--space', space, '--root', root], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt, cwd: root }),
    encoding: 'utf8',
    env: { ...process.env, IHOW_HANDOFF_METRICS: '0', ...env },
  });
}
const promoteVerified = (text, title, root, space) => {
  const cand = JSON.parse(cli(['write-candidate', '--no-auto-promote', text], root, space)).path;
  cli(['promote', cand, '--scope', 'team', '--title', title], root, space);
};

// Write a low-weight journal day-file directly on disk (the auto-capture lane), so we can control the DAY
// stamp (journal files are day-named, the deterministic salience proxy) without touching wall-clock time.
async function seedJournalDay(root, space, day, body) {
  const dir = path.join(root, space, 'memory', 'journal');
  await fs.mkdir(dir, { recursive: true });
  const header = `---\ntype: "memory_journal"\nweight: "low"\ndate: "${day}"\n---\n\n# Journal ${day}\n\n`;
  await fs.writeFile(path.join(dir, `${day}.md`), `${header}## ${day}T12:00:00.000Z · note\n\n${body}\n`, 'utf8');
}

test('SALIENCE DECAY: a NEWER journal note outranks an OLDER one — but BOTH stay eligible (search returns both)', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-decay-rank-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const space = 'd';
  cli(['init'], root, space);
  // Two journal notes sharing the query term "zetaframework", different days (old vs new).
  await seedJournalDay(root, space, '2026-01-01', 'old low-weight note about zetaframework rollout.');
  await seedJournalDay(root, space, '2026-06-20', 'new low-weight note about zetaframework rollout.');
  cli(['reindex'], root, space);

  const hits = JSON.parse(cli(['search', 'zetaframework'], root, space));
  const journalHits = hits.filter((h) => h.path.includes('/journal/'));
  // INVARIANT 2 (eligibility unchanged): BOTH journal notes are still returned — decay did not drop either.
  assert.equal(journalHits.length, 2, 'both journal notes remain search-eligible (decay never hard-drops)');
  // RANKING: the newer day sorts ABOVE the older day within the journal lane (salience decay tiebreaker).
  const newerIdx = journalHits.findIndex((h) => h.path.includes('2026-06-20'));
  const olderIdx = journalHits.findIndex((h) => h.path.includes('2026-01-01'));
  assert.ok(newerIdx >= 0 && olderIdx >= 0, 'both days present');
  assert.ok(newerIdx < olderIdx, 'newer (higher-salience) journal note ranks above the older one');
});

test('PINNED EXEMPTION: a verified curated entry always outranks ANY journal note and is never decayed/dropped', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-decay-pin-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const space = 'p';
  cli(['init'], root, space);
  // A human-reviewed (verified, PINNED) curated decision.
  promoteVerified('Decision: adopt zetaframework for the dashboard, approved by the team.', 'zeta decision', root, space);
  // A VERY OLD journal note on the same topic — deeply decayed by salience, yet still must be RETURNED.
  await seedJournalDay(root, space, '2024-01-01', 'ancient low-weight note mentioning zetaframework.');
  cli(['reindex'], root, space);

  const hits = JSON.parse(cli(['search', 'zetaframework'], root, space));
  assert.ok(hits.length >= 2, 'both the curated entry and the ancient journal note are returned');
  // The PINNED curated entry sits ABOVE the journal lane (is_journal ASC is unchanged; decay never lifts a
  // soft note over curated memory, and never lowers the verified entry).
  const curatedIdx = hits.findIndex((h) => !h.path.includes('/journal/'));
  const journalIdx = hits.findIndex((h) => h.path.includes('/journal/'));
  assert.ok(curatedIdx >= 0, 'verified curated entry present (never decayed away)');
  assert.ok(journalIdx >= 0, 'ancient journal note STILL eligible (decay never hard-deletes)');
  assert.ok(curatedIdx < journalIdx, 'PINNED verified memory ranks above the decayed journal note');
});

test('ELIGIBILITY UNCHANGED: flagged stays quarantined out of default search, surfaced only with --include-flagged (decay does not touch the gate)', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-decay-flag-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const space = 'f';
  cli(['init'], root, space);
  // A flagged 🟡 entry written straight into a curated path, exactly as the governance flag tier writes it.
  const dir = path.join(root, space, 'memory', 'scopes', 'general');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'flagged-zeta.md'), [
    '---', 'candidate_id: "flag-zeta"', 'status: "promoted"', 'type: "memory"',
    'promoted_at: "2026-06-25T00:00:00Z"', 'flagged: true', 'flag_reason: "needs review"', '---', '',
    'A flagged note about zetaframework awaiting human review.', '',
  ].join('\n'), 'utf8');
  cli(['reindex'], root, space);

  // Default search: flagged is EXCLUDED by the eligibility gate (WHERE flagged != 1) — decay did not change this.
  const def = JSON.parse(cli(['search', 'zetaframework'], root, space));
  assert.equal(def.filter((h) => h.path.includes('flagged-zeta')).length, 0, 'flagged stays out of default search (gate intact)');
  // With --include-flagged the SAME gate admits it — proving the entry was never deleted, only quarantined.
  const incl = JSON.parse(cli(['search', '--include-flagged', 'zetaframework'], root, space));
  assert.equal(incl.filter((h) => h.path.includes('flagged-zeta')).length, 1, 'flagged surfaces with --include-flagged (never decayed away)');
});

test('RECALL TIME-DIM: the time-since-verification penalty NEVER drops or down-ranks a PINNED verified entry, and never beats a currency marker', async (t) => {
  // The verify-first time extension feeds the recall recency SORT only. This proves the hard safety side:
  // an OLD-but-verified entry that carries the currency marker is STILL the one recalled — the freshness
  // discount (bounded, exempt for pinned) can neither evict it nor lift its superseded same-topic peer.
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-decay-recall-')));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const space = 'r';
  cli(['init'], root, space);
  // A NEWLY-promoted but SUPERSEDED reviewed entry (no currency marker) — recent promoted_at.
  promoteVerified('The deploy concurrency for omegaservice was set to 100 requests per second.', 'omega old limit', root, space);
  // An OLDER same-topic reviewed entry that is the CORRECTION (currency marker present). Rewrite its
  // promoted_at to be far in the PAST so the time-since-verification penalty is at its MAX for this entry.
  promoteVerified('Correction: the deploy concurrency for omegaservice was raised to 500 requests per second. This supersedes the old value.', 'omega corrected', root, space);
  const correctedDir = path.join(root, space, 'memory', 'scopes', 'team');
  const files = await fs.readdir(correctedDir);
  for (const f of files) {
    const p = path.join(correctedDir, f);
    let c = await fs.readFile(p, 'utf8');
    if (/Correction:/.test(c)) {
      c = c.replace(/promoted_at:\s*"[^"]+"/, 'promoted_at: "2024-01-01T00:00:00Z"'); // ancient verification
      await fs.writeFile(p, c, 'utf8');
    }
  }
  cli(['reindex'], root, space);

  const out = recall('what is the omegaservice deploy concurrency limit', root, space);
  assert.equal(out.status, 0, 'recall never blocks');
  const ctx = out.stdout.trim() ? JSON.parse(out.stdout).hookSpecificOutput.additionalContext : '';
  // The corrected (currency-marked) entry wins the collapse DESPITE being verified long ago — the bounded
  // freshness discount can never override a real currency marker, and never drops a pinned verified entry.
  assert.match(ctx, /500 requests per second|raised to 500/, 'the corrected entry is recalled (currency beats the freshness discount)');
  assert.ok(!/100 requests per second/.test(ctx), 'the superseded entry is collapsed away, not the corrected one');
  assert.match(ctx, /🟢 reviewed/, 'the recalled entry stays the pinned/reviewed tier (never decayed out)');
});
