// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// The UTC->local-day cutover migration: re-buckets entries/events from UTC-named files into their true
// local-day files, idempotently, with a backup. Pinned to America/Los_Angeles so the instant
// 2026-06-21T02:00Z is unambiguously local day 2026-06-20 (19:00 PDT).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateLocalDay } from '../scripts/migrate-local-day.mjs';

async function mkdtempReal(p) {
  return await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), p)));
}

test('migrate re-buckets UTC-named journal + event files into local-day files (idempotent)', async (t) => {
  const prevTz = process.env.IHOW_MEMORY_TZ;
  process.env.IHOW_MEMORY_TZ = 'America/Los_Angeles';
  const root = await mkdtempReal('ihow-migrate-');
  t.after(async () => {
    if (prevTz === undefined) delete process.env.IHOW_MEMORY_TZ; else process.env.IHOW_MEMORY_TZ = prevTz;
    await fs.rm(root, { recursive: true, force: true });
  });

  const memoryRoot = path.join(root, 'memory');
  const journalDir = path.join(memoryRoot, '_mcp', 'journal');
  const eventsDir = path.join(memoryRoot, '_mcp', '_events');
  await fs.mkdir(journalDir, { recursive: true });
  await fs.mkdir(eventsDir, { recursive: true });

  // A pre-fix UTC-named journal whose only entry's instant is local day 2026-06-20.
  await fs.writeFile(
    path.join(journalDir, '2026-06-21.md'),
    `---\ntype: "memory_journal"\nweight: "low"\ndate: "2026-06-21"\n---\n# Journal 2026-06-21\n\n> Auto-captured.\n\n## 2026-06-21T02:00:00.000Z · tester · evening note\n\nthe split-brain entry\n`,
    'utf8',
  );
  // A pre-fix UTC-named event log likewise.
  await fs.writeFile(
    path.join(eventsDir, '2026-06-21.ndjson'),
    `${JSON.stringify({ id: 'e1', type: 'memory.journal.appended', at: '2026-06-21T02:00:00.000Z' })}\n`,
    'utf8',
  );

  const r1 = await migrateLocalDay({ memoryRoot }, true);
  assert.equal(r1.changed, true, 'migration reports a change');

  // journal entry now lives in the local-day file, and the UTC-named file is gone
  const localJournal = await fs.readFile(path.join(journalDir, '2026-06-20.md'), 'utf8');
  assert.match(localJournal, /the split-brain entry/);
  assert.match(localJournal, /date: "2026-06-20"/);
  await assert.rejects(fs.access(path.join(journalDir, '2026-06-21.md')), 'UTC-named journal removed');

  // event likewise
  const localEvents = await fs.readFile(path.join(eventsDir, '2026-06-20.ndjson'), 'utf8');
  assert.match(localEvents, /"id":"e1"/);
  await assert.rejects(fs.access(path.join(eventsDir, '2026-06-21.ndjson')), 'UTC-named event log removed');

  // a backup of the originals was kept
  const baks = (await fs.readdir(journalDir)).filter((n) => n.startsWith('.premigrate-'));
  assert.ok(baks.length >= 1, 'originals backed up');

  // idempotent: a second run is a no-op
  const r2 = await migrateLocalDay({ memoryRoot }, true);
  assert.equal(r2.changed, false, 'second run finds nothing to migrate');
});
