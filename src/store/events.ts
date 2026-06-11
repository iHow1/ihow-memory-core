// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import path from 'node:path';
import crypto from 'node:crypto';
import type { JsonRecord, Workspace } from '../types.ts';
import { appendFileAtomic } from './files.ts';

export type MemoryEvent = {
  id: string;
  type: 'candidate.created' | 'memory.promoted' | 'memory.promoted.durable';
  at: string;
  path?: string;
  candidatePath?: string;
  targetPath?: string;
  actor?: string;
  metadata?: JsonRecord;
};

export async function appendEvent(workspace: Workspace, event: Omit<MemoryEvent, 'id' | 'at'>): Promise<MemoryEvent> {
  const fullEvent: MemoryEvent = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    ...event,
  };
  const day = fullEvent.at.slice(0, 10);
  const logPath = path.join(workspace.eventsDir, `${day}.ndjson`);
  await appendFileAtomic(logPath, `${JSON.stringify(fullEvent)}\n`);
  return fullEvent;
}
