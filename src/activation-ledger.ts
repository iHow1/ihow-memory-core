// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Local activation evidence is intentionally metadata-only. The append-only ledger never accepts a
// transcript, prompt, tool payload, environment value, or free-form error string; caller-provided
// dedupe material is hashed before persistence. Runtime activation therefore remains auditable without
// becoming another content/secret retention surface.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Workspace } from './types.ts';

export type ActivationEvidenceStatus =
  | 'configured'
  | 'synthetic'
  | 'observed-live-started'
  | 'observed-live-completed'
  | 'failed';

export type ActivationEvidenceSource =
  | 'setup'
  | 'connect'
  | 'install-hook'
  | 'native-hook'
  | 'context-probe'
  | 'synthetic-proof'
  | 'test';

export type ActivationEvidenceEvent =
  | 'runtime-configured'
  | 'hook-stop'
  | 'hook-session-start'
  | 'hook-user-prompt-submit'
  | 'context-probe-session-start'
  | 'context-probe-prompt'
  | 'context-probe-session-end'
  | 'context-probe-tick'
  | 'synthetic-check';

export type ActivationEvidence = {
  schemaVersion: 1;
  id: string;
  runtime: string;
  event: ActivationEvidenceEvent;
  source: ActivationEvidenceSource;
  status: ActivationEvidenceStatus;
  observedAt: string;
  workspaceBinding: {
    algorithm: 'sha256';
    id: string;
  };
  dedupe: {
    algorithm: 'sha256';
    id: string;
  };
  configuration?: {
    algorithm: 'sha256';
    id: string;
  };
};

export type AppendActivationEvidenceInput = {
  runtime: string;
  event: ActivationEvidenceEvent;
  source: ActivationEvidenceSource;
  status: ActivationEvidenceStatus;
  observedAt?: string;
  // May contain a host event/session id. It is never persisted verbatim.
  dedupeKey?: string;
  // Exact verified wiring generation. It is independently hashed before persistence.
  configurationKey?: string;
};

export const ACTIVATION_LEDGER_FILE = 'activation-ledger.ndjson';

const KNOWN_RUNTIMES = new Set([
  'claude-code', 'codex', 'cursor', 'workbuddy', 'claude-desktop', 'opencode', 'hermes', 'openclaw',
  'vscode', 'gemini', 'no-hook', 'unknown',
]);
const KNOWN_EVENTS = new Set<ActivationEvidenceEvent>([
  'runtime-configured', 'hook-stop', 'hook-session-start', 'hook-user-prompt-submit',
  'context-probe-session-start', 'context-probe-prompt', 'context-probe-session-end',
  'context-probe-tick', 'synthetic-check',
]);
const KNOWN_SOURCES = new Set<ActivationEvidenceSource>([
  'setup', 'connect', 'install-hook', 'native-hook', 'context-probe', 'synthetic-proof', 'test',
]);
const KNOWN_STATUSES = new Set<ActivationEvidenceStatus>([
  'configured', 'synthetic', 'observed-live-started', 'observed-live-completed', 'failed',
]);

export function activationLedgerPath(workspace: Workspace): string {
  return path.join(workspace.mcpDir, ACTIVATION_LEDGER_FILE);
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function activationConfigurationId(configurationKey: string): string {
  return sha256(configurationKey);
}

export function normalizeActivationRuntime(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase().replace(/\s+/g, '-') : '';
  const safe = normalized.replace(/[^a-z0-9._-]+/g, '-').replace(/-+/g, '-').slice(0, 64);
  return KNOWN_RUNTIMES.has(safe) ? safe : 'unknown';
}

export function activationWorkspaceBinding(workspace: Workspace): ActivationEvidence['workspaceBinding'] {
  return {
    algorithm: 'sha256',
    id: sha256(JSON.stringify({
      mode: workspace.mode,
      root: path.resolve(workspace.root),
      space: workspace.space,
      memoryDir: path.resolve(workspace.memoryDir),
    })),
  };
}

function validObservedAt(value: string | undefined): string {
  if (value === undefined) return new Date().toISOString();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error('activation_evidence_observed_at_invalid');
  return new Date(parsed).toISOString();
}

function isActivationEvidence(value: unknown): value is ActivationEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<ActivationEvidence>;
  return row.schemaVersion === 1 && typeof row.id === 'string' && typeof row.runtime === 'string' &&
    KNOWN_RUNTIMES.has(row.runtime) && KNOWN_EVENTS.has(row.event as ActivationEvidenceEvent) &&
    KNOWN_SOURCES.has(row.source as ActivationEvidenceSource) && KNOWN_STATUSES.has(row.status as ActivationEvidenceStatus) &&
    typeof row.observedAt === 'string' && !!row.workspaceBinding && row.workspaceBinding.algorithm === 'sha256' &&
    typeof row.workspaceBinding.id === 'string' &&
    !!row.dedupe && row.dedupe.algorithm === 'sha256' && typeof row.dedupe.id === 'string' &&
    (row.configuration === undefined || (row.configuration.algorithm === 'sha256' && typeof row.configuration.id === 'string'));
}

async function readLedgerFile(file: string): Promise<ActivationEvidence[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const rows: ActivationEvidence[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isActivationEvidence(parsed)) rows.push(parsed);
    } catch {
      // Audit reads are tolerant: a torn/malformed line must not hide the remaining valid evidence.
    }
  }
  return rows;
}

export async function readActivationEvidence(workspace: Workspace): Promise<ActivationEvidence[]> {
  const binding = activationWorkspaceBinding(workspace);
  const rows = await readLedgerFile(activationLedgerPath(workspace));
  return rows
    .filter((row) => row.workspaceBinding.id === binding.id)
    .sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.id.localeCompare(b.id));
}

export function activationLedgerLockPath(workspace: Workspace): string {
  return `${activationLedgerPath(workspace)}.lock`;
}

const ACTIVATION_LOCK_RETRY_MS = 5;
const ACTIVATION_LOCK_TIMEOUT_MS = 40;
const ACTIVATION_LOCK_STALE_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function activationLockIsStale(file: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const [pidLine, atLine] = raw.split('\n');
    const pid = Number.parseInt(pidLine || '', 10);
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
        if ((error as NodeJS.ErrnoException).code === 'EPERM') return false;
      }
    }
    const at = Date.parse(atLine || '');
    return Number.isFinite(at) && Date.now() - at > ACTIVATION_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

async function withActivationLedgerLock<T>(workspace: Workspace, fn: () => Promise<T>): Promise<T> {
  const lock = activationLedgerLockPath(workspace);
  await fs.mkdir(path.dirname(lock), { recursive: true });
  const started = Date.now();
  let handle: fs.FileHandle | undefined;
  while (!handle) {
    try {
      handle = await fs.open(lock, 'wx', 0o600);
      await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await activationLockIsStale(lock)) {
        const stale = `${lock}.stale-${process.pid}-${crypto.randomUUID()}`;
        try {
          await fs.rename(lock, stale);
          await fs.rm(stale, { force: true });
        } catch {
          // Another contender reclaimed or released it first.
        }
        continue;
      }
      if (Date.now() - started >= ACTIVATION_LOCK_TIMEOUT_MS) throw new Error('activation_ledger_lock_busy');
      await sleep(ACTIVATION_LOCK_RETRY_MS);
    }
  }
  try {
    return await fn();
  } finally {
    await handle.close().catch(() => {});
    await fs.rm(lock, { force: true }).catch(() => {});
  }
}

export async function appendActivationEvidence(
  workspace: Workspace,
  input: AppendActivationEvidenceInput,
): Promise<{ evidence: ActivationEvidence; appended: boolean }> {
  const runtime = normalizeActivationRuntime(input.runtime);
  if (!KNOWN_EVENTS.has(input.event) || !KNOWN_SOURCES.has(input.source) || !KNOWN_STATUSES.has(input.status)) {
    throw new Error('activation_evidence_kind_invalid');
  }
  const observedAt = validObservedAt(input.observedAt);
  const workspaceBinding = activationWorkspaceBinding(workspace);
  const callerDedupe = input.dedupeKey ?? crypto.randomUUID();
  // A verified wiring generation is one installation epoch regardless of which idempotent front door
  // observed it (setup, connect --easy, or install-hook). Including the caller source would append a
  // later configured row for the SAME unchanged generation and incorrectly move configuredAt forward,
  // making already-observed live activity look pre-install. Other evidence keeps source in its identity.
  const dedupeId = sha256(JSON.stringify({
    workspace: workspaceBinding.id,
    runtime,
    event: input.event,
    source: input.status === 'configured' ? 'verified-wiring-generation' : input.source,
    status: input.status,
    callerDedupe,
  }));
  const evidence: ActivationEvidence = {
    schemaVersion: 1,
    id: sha256(`${dedupeId}\n${observedAt}`).slice(0, 32),
    runtime,
    event: input.event,
    source: input.source,
    status: input.status,
    observedAt,
    workspaceBinding,
    dedupe: { algorithm: 'sha256', id: dedupeId },
    ...(input.configurationKey
      ? { configuration: { algorithm: 'sha256' as const, id: activationConfigurationId(input.configurationKey) } }
      : {}),
  };
  const file = activationLedgerPath(workspace);
  return await withActivationLedgerLock(workspace, async () => {
    const existing = await readLedgerFile(file);
    const duplicate = existing.find((row) => row.workspaceBinding.id === workspaceBinding.id && row.dedupe.id === dedupeId);
    if (duplicate) return { evidence: duplicate, appended: false };
    await fs.mkdir(path.dirname(file), { recursive: true });
    // A crash may leave a torn final row without a newline. Start the next valid record on a fresh line
    // so the tolerant reader can discard only the torn row instead of losing the first post-crash event.
    let separator = '';
    try {
      const current = await fs.readFile(file);
      if (current.length > 0 && current[current.length - 1] !== 0x0a) separator = '\n';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await fs.appendFile(file, `${separator}${JSON.stringify(evidence)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.chmod(file, 0o600).catch(() => {});
    return { evidence, appended: true };
  });
}

// Activation telemetry must never become a host availability dependency. Hook/probe/setup callers use
// this wrapper so a read-only disk, lock timeout, or malformed prior ledger cannot block the runtime.
export async function appendActivationEvidenceFailOpen(
  workspace: Workspace,
  input: AppendActivationEvidenceInput,
): Promise<ActivationEvidence | undefined> {
  try {
    return (await appendActivationEvidence(workspace, input)).evidence;
  } catch {
    return undefined;
  }
}
