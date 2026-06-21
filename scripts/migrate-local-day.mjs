#!/usr/bin/env -S node --experimental-strip-types
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// ONE-TIME migration for the UTC -> local-day cutover. Older code named the daily journal/event files by
// the UTC calendar day (new Date().toISOString().slice(0,10)); the fix (src/time.ts localDay) names them
// by the LOCAL day. At the cutover, files written in the evening before the fix (e.g. 2026-06-21.md while
// the local day was 2026-06-20) coexist with new local-day files, splitting one local day across two files
// and skewing audit/--since/grouping. This script re-buckets every entry/event into its true local-day
// file, idempotently, with a backup. Safe to run repeatedly; a no-op once everything is already local-day.
//
// Usage:
//   node scripts/migrate-local-day.mjs --memory-root <dir> [--apply]
//   node scripts/migrate-local-day.mjs --root <dir> --space <id> [--apply]
// Without --apply it DRY-RUNS (prints the plan, writes nothing). IHOW_MEMORY_TZ is honored (same as runtime).
import fs from 'node:fs/promises';
import path from 'node:path';
import { localDay } from '../src/time.ts';
import { resolveWorkspace } from '../src/workspace.ts';
import { mcpLaneWorkspace } from '../src/store/events.ts';

const DATED = /^(\d{4}-\d{2}-\d{2})\.(md|ndjson)$/;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// Split a journal markdown file into { header, entries[] }. Entries begin at a line "## <iso> · ...".
function parseJournal(content) {
  const parts = content.split(/\n(?=## )/);
  const entries = [];
  let header = '';
  for (const part of parts) {
    if (/^## \S/.test(part)) entries.push(part.replace(/\s+$/, ''));
    else if (!header) header = part; // the leading frontmatter + "# Journal" block
  }
  return { header, entries };
}

function entryDay(entry) {
  const m = entry.match(/^## (\S+)/);
  if (!m) return null;
  const d = new Date(m[1]);
  return Number.isNaN(d.getTime()) ? null : localDay(d);
}

function entryTimestamp(entry) {
  const m = entry.match(/^## (\S+)/);
  return m ? m[1] : '';
}

function journalFor(day, entries) {
  const header = `---\ntype: "memory_journal"\nweight: "low"\ndate: ${JSON.stringify(day)}\n---\n# Journal ${day}\n\n> Auto-captured, append-only, low-weight. Searchable but ranked below curated memory.\n`;
  const body = entries.map((e) => `\n${e.trim()}\n`).join('');
  return header + body;
}

async function listDated(dir, ext) {
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  return names.filter((n) => DATED.test(n) && n.endsWith(`.${ext}`)).sort();
}

// Returns { plan: [{day, count}], removals: [name], changed: bool } and, when apply, performs it.
async function migrateJournalDir(dir, apply, log) {
  const files = await listDated(dir, 'md');
  if (!files.length) return { changed: false };
  const byDay = new Map(); // localDay -> Map(key -> entry) for dedup
  for (const name of files) {
    const content = await fs.readFile(path.join(dir, name), 'utf8');
    for (const entry of parseJournal(content).entries) {
      const day = entryDay(entry) || name.slice(0, 10);
      if (!byDay.has(day)) byDay.set(day, new Map());
      byDay.get(day).set(entry.trim(), entry); // dedup identical entries
    }
  }
  // Already correct? A file is "misfiled" only if one of its entries' true localDay differs from its name.
  let misfiled = false;
  for (const name of files) {
    const content = await fs.readFile(path.join(dir, name), 'utf8');
    for (const entry of parseJournal(content).entries) {
      const day = entryDay(entry);
      if (day && day !== name.slice(0, 10)) { misfiled = true; break; }
    }
    if (misfiled) break;
  }
  if (!misfiled) return { changed: false };

  log(`  [journal] ${dir}`);
  for (const [day, map] of [...byDay.entries()].sort()) log(`    -> ${day}.md  (${map.size} entr${map.size === 1 ? 'y' : 'ies'})`);
  if (!apply) return { changed: true };

  const bak = path.join(dir, `.premigrate-${Date.now()}`);
  await fs.mkdir(bak, { recursive: true });
  for (const name of files) await fs.copyFile(path.join(dir, name), path.join(bak, name));
  // remove old dated files, then write the rebucketed set
  for (const name of files) await fs.rm(path.join(dir, name), { force: true });
  for (const [day, map] of byDay) {
    const entries = [...map.values()].sort((a, b) => entryTimestamp(a).localeCompare(entryTimestamp(b)));
    await fs.writeFile(path.join(dir, `${day}.md`), journalFor(day, entries), 'utf8');
  }
  log(`    backup: ${bak}`);
  return { changed: true };
}

async function migrateEventsDir(dir, apply, log) {
  const files = await listDated(dir, 'ndjson');
  if (!files.length) return { changed: false };
  const byDay = new Map(); // localDay -> Map(id -> line)
  let misfiled = false;
  for (const name of files) {
    const raw = await fs.readFile(path.join(dir, name), 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      const day = (typeof ev.at === 'string' && !Number.isNaN(new Date(ev.at).getTime())) ? localDay(new Date(ev.at)) : name.slice(0, 10);
      if (day !== name.slice(0, 10)) misfiled = true;
      if (!byDay.has(day)) byDay.set(day, new Map());
      byDay.get(day).set(ev.id || line, line.trim());
    }
  }
  if (!misfiled) return { changed: false };

  log(`  [events]  ${dir}`);
  for (const [day, map] of [...byDay.entries()].sort()) log(`    -> ${day}.ndjson  (${map.size} event${map.size === 1 ? '' : 's'})`);
  if (!apply) return { changed: true };

  const bak = path.join(dir, `.premigrate-${Date.now()}`);
  await fs.mkdir(bak, { recursive: true });
  for (const name of files) await fs.copyFile(path.join(dir, name), path.join(bak, name));
  for (const name of files) await fs.rm(path.join(dir, name), { force: true });
  for (const [day, map] of byDay) {
    const lines = [...map.values()].sort((a, b) => {
      const ja = JSON.parse(a), jb = JSON.parse(b);
      return String(ja.at).localeCompare(String(jb.at));
    });
    await fs.writeFile(path.join(dir, `${day}.ndjson`), `${lines.join('\n')}\n`, 'utf8');
  }
  log(`    backup: ${bak}`);
  return { changed: true };
}

export async function migrateLocalDay(options, apply, log = () => {}) {
  const ws = resolveWorkspace(options);
  const lanes = ws.mode === 'managed-space' ? [ws, mcpLaneWorkspace(ws)] : [ws];
  let changed = false;
  for (const w of lanes) {
    changed = (await migrateJournalDir(w.journalDir, apply, log)).changed || changed;
    changed = (await migrateEventsDir(w.eventsDir, apply, log)).changed || changed;
  }
  return { changed };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const options = {
    memoryRoot: arg('--memory-root'),
    root: arg('--root'),
    space: arg('--space'),
    stateRoot: arg('--state-root'),
    cwd: arg('--cwd'),
  };
  if (!options.memoryRoot && !options.root) {
    console.error('usage: migrate-local-day.mjs --memory-root <dir> [--apply]   (or --root <dir> --space <id>)');
    process.exitCode = 1;
    return;
  }
  console.log(apply ? 'migrate-local-day: APPLYING (originals backed up to .premigrate-* per dir)' : 'migrate-local-day: DRY RUN (no changes; pass --apply to write)');
  const { changed } = await migrateLocalDay(options, apply, (m) => console.log(m));
  if (!changed) console.log('  nothing to migrate — all journal/event files already use local-day names.');
  else if (!apply) console.log('  re-run with --apply to perform the migration.');
  else console.log('  done.');
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) {
  main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; });
}
