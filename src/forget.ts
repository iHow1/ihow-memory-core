// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// C4 — one-gesture correction. "忘掉这条 / 记错了" must work without the user knowing tiers or promote:
// forgetting is a TOMBSTONE in the append-only event log (memory.forgotten / memory.remembered), never a
// file deletion — reversible, audited, and folded into a forgotten-set exactly the way the anchored-trust
// set is (the event log is the trust source; file content/frontmatter is forgeable, so a re-written file
// at a forgotten path stays forgotten until an explicit remember event). The single enforcement chokepoint
// is core.search: the recall hook, CLI search, MCP memory.search and HTTP all flow through it, so a
// forgotten entry stops surfacing EVERYWHERE at once. `read` still works by design — forget means
// "stop bringing this up", not "shred the file" (rollback is the deletion path, and stays separate).
import fs from 'node:fs/promises';
import type { SearchResult, Workspace } from './types.ts';
import { appendEvent, readEventsAllLanes } from './store/events.ts';
import { absoluteFromMemoryPath } from './workspace.ts';

export type ForgetOutcome =
  | { status: 'forgotten'; path: string; eventId: string; tier: EntryTier; undo: string }
  | { status: 'needs-confirm'; path: string; tier: 'reviewed'; hint: string }
  | { status: 'ambiguous'; matches: Array<{ path: string; snippet: string }> }
  | { status: 'no-match' };

export type RememberOutcome =
  | { status: 'remembered'; path: string; eventId: string }
  | { status: 'not-forgotten'; path?: string }
  | { status: 'ambiguous'; matches: Array<{ path: string; snippet: string }> };

export type EntryTier = 'reviewed' | 'auto' | 'flagged';

// Tier detection from frontmatter — the SAME tolerant regexes as cli.ts recallTier / decay.ts
// isDecayExempt / governance.ts (the four sites must not disagree): flagged wins, positive auto markers
// (reviewed:false / tier:auto-promoted) mean machine-judged, anything else is treated as human-reviewed.
// Conservative on purpose: an unreadable/ambiguous entry counts as reviewed, so forgetting it requires
// the explicit confirmation, never less.
export function entryTierFromHead(head: string): EntryTier {
  const fm = head.match(/^---\n([\s\S]*?)\n---/);
  const front = fm ? fm[1] : head;
  if (/^\s*flagged:\s*["']?true\b/im.test(front)) return 'flagged';
  const isAuto = /^\s*reviewed:\s*["']?false\b/im.test(front) || /^\s*tier:\s*["']?auto-promoted\b/im.test(front);
  return isAuto ? 'auto' : 'reviewed';
}

async function tierForPath(workspace: Workspace, relPath: string): Promise<EntryTier> {
  try {
    const abs = absoluteFromMemoryPath(workspace, relPath);
    const head = (await fs.readFile(abs, 'utf8')).slice(0, 1024);
    return entryTierFromHead(head);
  } catch {
    return 'reviewed';
  }
}

// Fold the append-only log into the forgotten set, keyed by ABSOLUTE path (the same normalization the
// anchored-trust set uses, so a hit path and an event path always compare on one basis). Oldest-first,
// last event wins: forgotten adds, remembered removes — a later re-forget re-adds. Both lanes are read
// (an auto-captured _mcp entry must be forgettable too). An unreadable log yields an EMPTY set: search
// keeps working and nothing is silently hidden — forget degrades open, recall-safety gates stay separate.
export async function forgottenSet(workspace: Workspace): Promise<Set<string>> {
  const out = new Set<string>();
  let events;
  try {
    events = await readEventsAllLanes(workspace);
  } catch {
    return out;
  }
  for (const e of events) {
    if (typeof e?.path !== 'string') continue;
    try {
      if (e.type === 'memory.forgotten') out.add(absoluteFromMemoryPath(workspace, e.path));
      else if (e.type === 'memory.remembered') out.delete(absoluteFromMemoryPath(workspace, e.path));
    } catch { /* unresolvable path -> ignore that event */ }
  }
  return out;
}

// The core.search chokepoint filter. Never throws; on any error the hits pass through unchanged
// (degrade open — see forgottenSet).
export async function filterForgotten(workspace: Workspace, hits: SearchResult[]): Promise<SearchResult[]> {
  if (!hits.length) return hits;
  let dropped: Set<string>;
  try {
    dropped = await forgottenSet(workspace);
  } catch {
    return hits;
  }
  if (!dropped.size) return hits;
  return hits.filter((h) => {
    try { return !dropped.has(absoluteFromMemoryPath(workspace, String(h.path))); } catch { return true; }
  });
}

export async function forgetPath(
  workspace: Workspace,
  relPath: string,
  opts: { actor?: string; yes?: boolean; reason?: string } = {},
): Promise<ForgetOutcome> {
  const abs = absoluteFromMemoryPath(workspace, relPath); // throws outside the memory allowlist — traversal-safe
  await fs.access(abs); // forget targets something that exists; a typo'd path is an error, not a silent no-op
  const tier = await tierForPath(workspace, relPath);
  // A human-REVIEWED entry needs the explicit flag: one extra token for the user, but an agent gesture
  // can't silently disappear a curated rule (red-team surface: "forget the rule about not force-pushing").
  // Auto-tier entries — the machine-judged lane this gesture exists for — forget in one step.
  if (tier === 'reviewed' && opts.yes !== true) {
    return {
      status: 'needs-confirm',
      path: relPath,
      tier: 'reviewed',
      hint: 'this is a human-reviewed entry — re-run with --yes to forget it (reversible: ihow-memory remember)',
    };
  }
  const event = await appendEvent(workspace, {
    type: 'memory.forgotten',
    path: relPath,
    actor: opts.actor || 'cli',
    metadata: { tier, ...(opts.reason ? { reason: opts.reason } : {}) },
  });
  return { status: 'forgotten', path: relPath, eventId: event.id, tier, undo: `ihow-memory remember ${relPath}` };
}

export async function rememberPath(
  workspace: Workspace,
  relPath: string,
  opts: { actor?: string } = {},
): Promise<RememberOutcome> {
  const abs = absoluteFromMemoryPath(workspace, relPath);
  const dropped = await forgottenSet(workspace);
  if (!dropped.has(abs)) return { status: 'not-forgotten', path: relPath };
  const event = await appendEvent(workspace, {
    type: 'memory.remembered',
    path: relPath,
    actor: opts.actor || 'cli',
  });
  return { status: 'remembered', path: relPath, eventId: event.id };
}

// `forget --list` / remember-by-needle support: the forgotten entries with a first-content-line snippet
// (frontmatter skipped; a since-deleted file shows as such instead of erroring the whole listing).
export async function listForgotten(workspace: Workspace): Promise<Array<{ path: string; snippet: string }>> {
  const dropped = await forgottenSet(workspace);
  const out: Array<{ path: string; snippet: string }> = [];
  const events = await readEventsAllLanes(workspace);
  const relByAbs = new Map<string, string>();
  for (const e of events) {
    if (e.type === 'memory.forgotten' && typeof e.path === 'string') {
      try { relByAbs.set(absoluteFromMemoryPath(workspace, e.path), e.path); } catch { /* ignore */ }
    }
  }
  for (const abs of dropped) {
    const rel = relByAbs.get(abs);
    if (!rel) continue;
    let snippet = '(file no longer readable)';
    try {
      const body = (await fs.readFile(abs, 'utf8')).replace(/^---[\s\S]*?\n---\n?/, '');
      const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
      // prefer the first CONTENT line — the engine writes a "# Candidate <uuid>" heading first, which
      // tells the user nothing about WHAT was forgotten
      const content = lines.find((l) => !l.startsWith('#')) || lines[0] || '';
      snippet = content.slice(0, 120) || '(empty)';
    } catch { /* keep placeholder */ }
    out.push({ path: rel, snippet });
  }
  return out;
}
