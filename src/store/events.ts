// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { JsonRecord, Workspace } from '../types.ts';
import { appendFileAtomic } from './files.ts';
import { localDay } from '../time.ts';

export type MemoryEvent = {
  id: string;
  type:
    | 'candidate.created'
    | 'memory.promoted'
    | 'memory.promoted.durable'
    | 'memory.journal.appended'
    | 'memory.rolledback'
    | 'memory.flagged.expired';
  at: string;
  path?: string;
  candidatePath?: string;
  targetPath?: string;
  actor?: string;
  metadata?: JsonRecord;
};

// Read the append-only audit log (events/*.ndjson), oldest-first. Used by `ihow-memory audit`
// and rollback. Malformed lines and a missing events dir are tolerated (return what we can).
export async function readEvents(workspace: Workspace, opts: { since?: string } = {}): Promise<MemoryEvent[]> {
  let files: string[];
  try {
    files = (await fs.readdir(workspace.eventsDir)).filter((name) => name.endsWith('.ndjson')).sort();
  } catch {
    return [];
  }
  const events: MemoryEvent[] = [];
  for (const file of files) {
    // No filename-based --since prefilter: file names are LOCAL-day post-fix but UTC-day for logs written
    // by older code, so the two bases disagree at the cutover. Filter authoritatively per-event by
    // localDay(event.at) below — one basis, no transition inconsistency. (Audit is not a hot path; the
    // ndjson logs are small, so reading all of them and filtering per-line is fine.)
    let raw: string;
    try {
      raw = await fs.readFile(path.join(workspace.eventsDir, file), 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as MemoryEvent;
        if (opts.since && typeof event.at === 'string') {
          const at = new Date(event.at);
          // Compare on the LOCAL calendar day (same basis as the file names / --since), not the UTC
          // prefix of the instant — otherwise an evening event filters inconsistently with its file.
          if (!Number.isNaN(at.getTime()) && localDay(at) < opts.since) continue;
        }
        events.push(event);
      } catch {
        // skip malformed line
      }
    }
  }
  return events;
}

// The MCP auto-capture lane writes events/journal under <memoryDir>/_mcp, while a managed-space
// workspace's CLI/console default to the MAIN lane (<memoryDir>/_events). This returns a view of the
// workspace pointed at the _mcp lane so callers can read/rollback auto-captured entries.
export function mcpLaneWorkspace(workspace: Workspace): Workspace {
  return {
    ...workspace,
    eventsDir: path.join(workspace.mcpDir, '_events'),
    journalDir: path.join(workspace.mcpDir, 'journal'),
  };
}

// Read the audit log across BOTH lanes (main + _mcp) for a managed-space workspace, merged
// oldest-first. In existing-memory-root mode the workspace already targets the _mcp lane, so this is
// just readEvents. Single source of truth for two-lane audit reads (core.audit, Stop hook, console).
export async function readEventsAllLanes(workspace: Workspace, opts: { since?: string } = {}): Promise<MemoryEvent[]> {
  const main = await readEvents(workspace, opts);
  if (workspace.mode !== 'managed-space') return main;
  const mcp = await readEvents(mcpLaneWorkspace(workspace), opts);
  return [...main, ...mcp].sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

export async function appendEvent(workspace: Workspace, event: Omit<MemoryEvent, 'id' | 'at'>): Promise<MemoryEvent> {
  const fullEvent: MemoryEvent = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    ...event,
  };
  const day = localDay(new Date(fullEvent.at)); // LOCAL calendar day for the log file name (see time.ts)
  const logPath = path.join(workspace.eventsDir, `${day}.ndjson`);
  await appendFileAtomic(logPath, `${JSON.stringify(fullEvent)}\n`);
  return fullEvent;
}
