// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// ONE-TIME migration for the UTC -> local-day cutover. Older code named the daily journal/event files
// by the UTC calendar day (new Date().toISOString().slice(0,10)); the fix (time.ts localDay) names them
// by the LOCAL day. At the cutover, files written in the evening before the fix (e.g. 2026-06-21.md while
// the local day was 2026-06-20) coexist with new local-day files, splitting one local day across two
// files and skewing audit/--since/grouping. This re-buckets every entry/event into its true local-day
// file, idempotently, with a backup. Safe to run repeatedly; a no-op once everything is already local-day.
//
// Lives in src/ (not scripts/) so it ships in dist/ and is reachable as `ihow-memory migrate-local-day`
// by installed users — scripts/ is not in the npm package.
import fs from 'node:fs/promises';
import path from 'node:path';
import type { WorkspaceOptions } from './types.ts';
import { localDay } from './time.ts';
import { resolveWorkspace } from './workspace.ts';
import { mcpLaneWorkspace } from './store/events.ts';

const DATED = /^(\d{4}-\d{2}-\d{2})\.(md|ndjson)$/;

// Split a journal markdown file into entries (each begins at a line "## <iso> · ...").
function parseJournalEntries(content: string): string[] {
  const entries: string[] = [];
  for (const part of content.split(/\n(?=## )/)) {
    if (/^## \S/.test(part)) entries.push(part.replace(/\s+$/, ''));
  }
  return entries;
}

function entryTimestamp(entry: string): string {
  const m = entry.match(/^## (\S+)/);
  return m ? m[1] : '';
}

function entryDay(entry: string): string | null {
  const ts = entryTimestamp(entry);
  if (!ts) return null;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : localDay(d);
}

function journalFor(day: string, entries: string[]): string {
  const header = `---\ntype: "memory_journal"\nweight: "low"\ndate: ${JSON.stringify(day)}\n---\n# Journal ${day}\n\n> Auto-captured, append-only, low-weight. Searchable but ranked below curated memory.\n`;
  return header + entries.map((e) => `\n${e.trim()}\n`).join('');
}

async function listDated(dir: string, ext: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).filter((n) => DATED.test(n) && n.endsWith(`.${ext}`)).sort();
  } catch {
    return [];
  }
}

type Log = (msg: string) => void;

async function migrateJournalDir(dir: string, apply: boolean, log: Log, now: number): Promise<boolean> {
  const files = await listDated(dir, 'md');
  if (!files.length) return false;
  const byDay = new Map<string, Map<string, string>>(); // localDay -> (entry-text -> entry) dedup
  let misfiled = false;
  for (const name of files) {
    const content = await fs.readFile(path.join(dir, name), 'utf8');
    for (const entry of parseJournalEntries(content)) {
      const day = entryDay(entry) || name.slice(0, 10);
      if (day !== name.slice(0, 10)) misfiled = true;
      if (!byDay.has(day)) byDay.set(day, new Map());
      byDay.get(day)!.set(entry.trim(), entry);
    }
  }
  if (!misfiled) return false;

  log(`  [journal] ${dir}`);
  for (const [day, map] of [...byDay.entries()].sort()) log(`    -> ${day}.md  (${map.size} entr${map.size === 1 ? 'y' : 'ies'})`);
  if (!apply) return true;

  const bak = path.join(dir, `.premigrate-${now}`);
  await fs.mkdir(bak, { recursive: true });
  for (const name of files) await fs.copyFile(path.join(dir, name), path.join(bak, name));
  for (const name of files) await fs.rm(path.join(dir, name), { force: true });
  for (const [day, map] of byDay) {
    const entries = [...map.values()].sort((a, b) => entryTimestamp(a).localeCompare(entryTimestamp(b)));
    await fs.writeFile(path.join(dir, `${day}.md`), journalFor(day, entries), 'utf8');
  }
  log(`    backup: ${bak}`);
  return true;
}

async function migrateEventsDir(dir: string, apply: boolean, log: Log, now: number): Promise<boolean> {
  const files = await listDated(dir, 'ndjson');
  if (!files.length) return false;
  const byDay = new Map<string, Map<string, string>>(); // localDay -> (id -> line)
  let misfiled = false;
  for (const name of files) {
    const raw = await fs.readFile(path.join(dir, name), 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let ev: { id?: string; at?: string };
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      const at = typeof ev.at === 'string' ? new Date(ev.at) : null;
      const day = at && !Number.isNaN(at.getTime()) ? localDay(at) : name.slice(0, 10);
      if (day !== name.slice(0, 10)) misfiled = true;
      if (!byDay.has(day)) byDay.set(day, new Map());
      byDay.get(day)!.set(ev.id || line, line.trim());
    }
  }
  if (!misfiled) return false;

  log(`  [events]  ${dir}`);
  for (const [day, map] of [...byDay.entries()].sort()) log(`    -> ${day}.ndjson  (${map.size} event${map.size === 1 ? '' : 's'})`);
  if (!apply) return true;

  const bak = path.join(dir, `.premigrate-${now}`);
  await fs.mkdir(bak, { recursive: true });
  for (const name of files) await fs.copyFile(path.join(dir, name), path.join(bak, name));
  for (const name of files) await fs.rm(path.join(dir, name), { force: true });
  for (const [day, map] of byDay) {
    const lines = [...map.values()].sort((a, b) => String(JSON.parse(a).at).localeCompare(String(JSON.parse(b).at)));
    await fs.writeFile(path.join(dir, `${day}.ndjson`), `${lines.join('\n')}\n`, 'utf8');
  }
  log(`    backup: ${bak}`);
  return true;
}

// Migrate every journal/event lane reachable from these workspace options. `now` is the backup-dir
// suffix (pass a timestamp; kept as a param so callers control it / it stays testable).
export async function migrateLocalDay(
  options: WorkspaceOptions,
  apply: boolean,
  log: Log = () => {},
  now = 0,
): Promise<{ changed: boolean }> {
  const ws = resolveWorkspace(options);
  const lanes = ws.mode === 'managed-space' ? [ws, mcpLaneWorkspace(ws)] : [ws];
  let changed = false;
  for (const w of lanes) {
    changed = (await migrateJournalDir(w.journalDir, apply, log, now)) || changed;
    changed = (await migrateEventsDir(w.eventsDir, apply, log, now)) || changed;
  }
  return { changed };
}
