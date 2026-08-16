// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Anonymous metrics are an explicit-consent subsystem. Disabled calls do not create telemetry files
// or make network requests. Enabled calls accept only the versioned event and categorical dimension
// allowlists below; arbitrary caller data never reaches serialization.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sendTelemetryBatch } from './telemetry-transport.ts';

export const ALLOWED_TELEMETRY_EVENTS = Object.freeze([
  'setup_completed',
  'activation_completed',
  'checkpoint_created',
  'continue_attempted',
  'continue_verified_green',
  'continue_verified_yellow',
  'continue_verified_red',
  'active_week',
  'upgrade_completed',
  'error_class',
] as const);

export type TelemetryEventName = typeof ALLOWED_TELEMETRY_EVENTS[number];
export type TelemetryConsent = 'opt-in' | 'no-send' | 'later';

const EVENT_NAMES = new Set<string>(ALLOWED_TELEMETRY_EVENTS);
const RUNTIMES = new Set([
  'claude-code', 'codex', 'cursor', 'workbuddy', 'claude-desktop', 'opencode', 'hermes', 'openclaw',
  'vscode', 'gemini', 'unknown',
]);
const ERROR_CLASSES = new Set(['configuration', 'filesystem', 'network', 'timeout', 'validation', 'unknown']);
const RUNTIME_DIMENSION_EVENTS = new Set<TelemetryEventName>([
  'activation_completed',
  'checkpoint_created',
  'upgrade_completed',
]);
const ERROR_DIMENSION_EVENTS = new Set<TelemetryEventName>(['error_class']);

type TelemetryDimensions = {
  runtime?: string;
  errorClass?: string;
};

type TelemetryEventV1 = {
  schemaVersion: 1;
  event: TelemetryEventName;
  installationId: string;
  occurredAt: string;
  dimensions?: TelemetryDimensions;
};

type RetryState = {
  failures: number;
  nextAttemptAt: string;
};

export type TelemetryConfig = {
  schemaVersion: 1;
  enabled: boolean;
  asked: boolean;
  installationId?: string;
  endpoint?: string;
  activationDedupe?: string[];
  activeWeek?: string;
  retry?: RetryState;
};

export type TelemetryStatus = {
  enabled: boolean;
  asked: boolean;
  installationId: string | null;
  endpoint: string | null;
  queuedEvents: number;
  collects: string[];
  neverCollects: string[];
};

export type SendBatchResult = { accepted: number };

export type TelemetryOptions = {
  stateDir?: string;
  endpoint?: string;
  now?: () => Date;
  randomUUID?: () => string;
  sendBatch?: (endpoint: URL, payload: string, timeoutMs: number) => Promise<SendBatchResult>;
  maxQueueEvents?: number;
  batchSize?: number;
  timeoutMs?: number;
  baseBackoffMs?: number;
  beforeQueueWrite?: () => Promise<void>;
  beforeSend?: () => Promise<void>;
};

export type TelemetryClient = {
  applyConsent(choice: TelemetryConsent, endpoint?: string): Promise<TelemetryConsent>;
  enable(endpoint?: string): Promise<void>;
  disable(): Promise<void>;
  flush(): Promise<boolean>;
  hasAsked(): Promise<boolean>;
  record(event: string, dimensions?: Record<string, unknown>): Promise<boolean>;
  status(): Promise<TelemetryStatus>;
};

const CONFIG_FILE = 'telemetry.json';
const QUEUE_FILE = 'telemetry-queue.ndjson';
const DEFAULT_MAX_QUEUE_EVENTS = 100;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_TIMEOUT_MS = 1_000;
const DEFAULT_BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60 * 60 * 1_000;
const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 5_000;

const localLockTails = new Map<string, Promise<void>>();

function telemetryDir(): string {
  return path.join(os.homedir(), '.ihow-memory');
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function validEndpoint(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error('telemetry_endpoint_invalid'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('telemetry_endpoint_invalid');
  }
  return parsed.toString();
}

function parseConfig(value: unknown): TelemetryConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== 1 || typeof row.enabled !== 'boolean' || typeof row.asked !== 'boolean') return null;
  if (!row.enabled) return { schemaVersion: 1, enabled: false, asked: row.asked };
  if (!row.asked || !isUuid(row.installationId)) return null;

  let endpoint: string | undefined;
  if (row.endpoint !== undefined) {
    if (typeof row.endpoint !== 'string') return null;
    try { endpoint = validEndpoint(row.endpoint); } catch { return null; }
  }
  let activationDedupe: string[] | undefined;
  if (row.activationDedupe !== undefined) {
    if (!Array.isArray(row.activationDedupe)
      || row.activationDedupe.length > RUNTIMES.size
      || row.activationDedupe.some((runtime) => typeof runtime !== 'string' || !RUNTIMES.has(runtime))) return null;
    activationDedupe = [...new Set(row.activationDedupe as string[])];
  }
  let activeWeek: string | undefined;
  if (row.activeWeek !== undefined) {
    if (typeof row.activeWeek !== 'string' || !/^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/.test(row.activeWeek)) return null;
    activeWeek = row.activeWeek;
  }
  let retry: RetryState | undefined;
  if (row.retry !== undefined) {
    if (!row.retry || typeof row.retry !== 'object' || Array.isArray(row.retry)) return null;
    const candidate = row.retry as Record<string, unknown>;
    if (!Number.isSafeInteger(candidate.failures) || Number(candidate.failures) < 1 || Number(candidate.failures) > 10
      || typeof candidate.nextAttemptAt !== 'string' || !Number.isFinite(Date.parse(candidate.nextAttemptAt))) return null;
    retry = { failures: Number(candidate.failures), nextAttemptAt: new Date(candidate.nextAttemptAt).toISOString() };
  }
  return {
    schemaVersion: 1,
    enabled: true,
    asked: true,
    installationId: row.installationId,
    ...(endpoint ? { endpoint } : {}),
    ...(activationDedupe ? { activationDedupe } : {}),
    ...(activeWeek ? { activeWeek } : {}),
    ...(retry ? { retry } : {}),
  };
}

function safeDimensions(event: TelemetryEventName, input: Record<string, unknown>): TelemetryDimensions | undefined {
  const dimensions: TelemetryDimensions = {};
  if (event === 'activation_completed' || event === 'checkpoint_created' || event === 'upgrade_completed') {
    if (typeof input.runtime === 'string' && RUNTIMES.has(input.runtime)) dimensions.runtime = input.runtime;
  }
  if (event === 'error_class' && typeof input.errorClass === 'string' && ERROR_CLASSES.has(input.errorClass)) {
    dimensions.errorClass = input.errorClass;
  }
  return Object.keys(dimensions).length ? dimensions : undefined;
}

function hasRequiredDimensions(event: TelemetryEventName, dimensions: TelemetryDimensions | undefined): boolean {
  if (RUNTIME_DIMENSION_EVENTS.has(event)) return typeof dimensions?.runtime === 'string';
  if (ERROR_DIMENSION_EVENTS.has(event)) return typeof dimensions?.errorClass === 'string';
  return true;
}

function isoWeek(date: Date): string {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((day.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export async function promptForTelemetryConsent(options: {
  interactive: boolean;
  ask: (question: string) => Promise<string>;
}): Promise<TelemetryConsent | null> {
  if (!options.interactive) return null;
  const answer = (await options.ask(
    '\nOptional anonymous metrics (off until you choose)\n'
    + '  Sends only allowlisted event names, a random installation ID, time, and categorical runtime/error values.\n'
    + '  Never sends memory, prompts, queries, paths, git data, user/host names, or hardware/MAC identifiers.\n'
    + '  1) Opt in\n'
    + '  2) No send\n'
    + '  3) Ask me later\n'
    + 'Choose 1, 2, or 3: ',
  )).trim();
  if (answer === '1') return 'opt-in';
  if (answer === '2') return 'no-send';
  return 'later';
}

function isTelemetryEvent(value: unknown): value is TelemetryEventV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== 1 || typeof row.event !== 'string' || !EVENT_NAMES.has(row.event) || !isUuid(row.installationId)) return false;
  if (!isCanonicalTimestamp(row.occurredAt)) return false;
  const rowKeys = Object.keys(row);
  if (rowKeys.some((key) => !['schemaVersion', 'event', 'installationId', 'occurredAt', 'dimensions'].includes(key))) return false;
  const event = row.event as TelemetryEventName;
  if (row.dimensions === undefined) {
    return !RUNTIME_DIMENSION_EVENTS.has(event) && !ERROR_DIMENSION_EVENTS.has(event);
  }
  if (!row.dimensions || typeof row.dimensions !== 'object' || Array.isArray(row.dimensions)) return false;
  const dimensions = row.dimensions as Record<string, unknown>;
  const keys = Object.keys(dimensions);
  if (event === 'activation_completed' || event === 'checkpoint_created' || event === 'upgrade_completed') {
    return keys.length === 1 && keys[0] === 'runtime'
      && typeof dimensions.runtime === 'string' && RUNTIMES.has(dimensions.runtime);
  }
  if (event === 'error_class') {
    return keys.length === 1 && keys[0] === 'errorClass'
      && typeof dimensions.errorClass === 'string' && ERROR_CLASSES.has(dimensions.errorClass);
  }
  return false;
}

async function readJson(file: string): Promise<unknown> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; }
}

async function atomicWrite(file: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, contents, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmp, file);
}

async function removeTelemetryCrashRemnants(stateDir: string): Promise<void> {
  let names: string[];
  try { names = await fs.readdir(stateDir); } catch { return; }
  const generatedRemnant = /^(?:telemetry\.json|telemetry-queue\.ndjson)\.tmp-\d+$|^\.telemetry\.lock\.orphan-\d+-[0-9a-f-]+$/i;
  await Promise.all(names
    .filter((name) => generatedRemnant.test(name))
    .map((name) => fs.rm(path.join(stateDir, name), { force: true }).catch(() => {})));
}

async function withTelemetryLock<T>(stateDir: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = path.join(stateDir, '.telemetry.lock');
  const previous = localLockTails.get(lockPath);
  let releaseTurn!: () => void;
  const turn = new Promise<void>((resolve) => { releaseTurn = resolve; });
  localLockTails.set(lockPath, turn);
  if (previous) await previous;

  let handle: fs.FileHandle | undefined;
  try {
    await fs.mkdir(stateDir, { recursive: true });
    const started = Date.now();
    while (!handle) {
      try {
        handle = await fs.open(lockPath, 'wx', 0o600);
        await handle.writeFile(`${process.pid}\n`, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (Date.now() - started >= LOCK_TIMEOUT_MS) throw new Error('telemetry_lock_timeout');
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
      }
    }
    return await fn();
  } finally {
    if (handle) {
      try { await handle.close(); } finally { await fs.rm(lockPath, { force: true }); }
    }
    releaseTurn();
    if (localLockTails.get(lockPath) === turn) localLockTails.delete(lockPath);
  }
}

async function readQueue(file: string, limit: number): Promise<TelemetryEventV1[]> {
  let raw: string;
  try { raw = await fs.readFile(file, 'utf8'); } catch { return []; }
  const events: TelemetryEventV1[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isTelemetryEvent(parsed)) events.push(parsed);
    } catch { /* malformed rows are never eligible for upload */ }
  }
  return events.slice(-limit);
}

export function createTelemetry(options: TelemetryOptions = {}): TelemetryClient {
  const stateDir = options.stateDir ?? telemetryDir();
  const configPath = path.join(stateDir, CONFIG_FILE);
  const queuePath = path.join(stateDir, QUEUE_FILE);
  const now = options.now ?? (() => new Date());
  const randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
  const maxQueueEvents = options.maxQueueEvents ?? DEFAULT_MAX_QUEUE_EVENTS;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
  const sender = options.sendBatch ?? sendTelemetryBatch;
  let configuredEndpoint: string | undefined;
  if (options.endpoint !== undefined) configuredEndpoint = validEndpoint(options.endpoint);
  else {
    // Environment configuration is operational input, not user consent. A malformed inherited value
    // disables transport and must never make setup or a host hook fail.
    try { configuredEndpoint = validEndpoint(process.env.IHOW_TELEMETRY_ENDPOINT); } catch { configuredEndpoint = undefined; }
  }

  const readConfig = async (): Promise<TelemetryConfig | null> => parseConfig(await readJson(configPath));
  const writeConfig = async (config: TelemetryConfig): Promise<void> => {
    await atomicWrite(configPath, `${JSON.stringify(config, null, 2)}\n`);
  };

  const enable = async (endpoint?: string): Promise<void> => withTelemetryLock(stateDir, async () => {
    const prior = await readConfig();
    const nextEndpoint = validEndpoint(endpoint) ?? configuredEndpoint ?? prior?.endpoint;
    const installationId = prior?.enabled && prior.installationId ? prior.installationId : randomUUID();
    if (!isUuid(installationId)) throw new Error('telemetry_installation_id_invalid');
    await writeConfig({
      schemaVersion: 1,
      enabled: true,
      asked: true,
      installationId,
      ...(nextEndpoint ? { endpoint: nextEndpoint } : {}),
      ...(prior?.enabled && prior.activationDedupe ? { activationDedupe: prior.activationDedupe } : {}),
      ...(prior?.enabled && prior.activeWeek ? { activeWeek: prior.activeWeek } : {}),
      ...(prior?.enabled && prior.retry ? { retry: prior.retry } : {}),
    });
  });

  const disable = async (): Promise<void> => withTelemetryLock(stateDir, async () => {
    await fs.rm(queuePath, { force: true }).catch(() => {});
    await removeTelemetryCrashRemnants(stateDir);
    await writeConfig({ schemaVersion: 1, enabled: false, asked: true });
  });

  const record = async (event: string, input: Record<string, unknown> = {}): Promise<boolean> => withTelemetryLock(stateDir, async () => {
    if (!EVENT_NAMES.has(event)) return false;
    try {
      const config = await readConfig();
      if (!config?.enabled || !config.installationId) return false;
      const name = event as TelemetryEventName;
      const dimensions = safeDimensions(name, input);
      if (!hasRequiredDimensions(name, dimensions)) return false;
      const activationKey = name === 'activation_completed' ? dimensions?.runtime ?? 'unknown' : undefined;
      const week = name === 'active_week' ? isoWeek(now()) : undefined;
      if (activationKey && config.activationDedupe?.includes(activationKey)) return false;
      if (week && config.activeWeek === week) return false;
      const row: TelemetryEventV1 = {
        schemaVersion: 1,
        event: name,
        installationId: config.installationId,
        occurredAt: now().toISOString(),
        ...(dimensions ? { dimensions } : {}),
      };
      const queue = await readQueue(queuePath, Math.max(0, maxQueueEvents - 1));
      if (activationKey && queue.some((item) => (
        item.event === 'activation_completed' && (item.dimensions?.runtime ?? 'unknown') === activationKey
      ))) return false;
      if (week && queue.some((item) => item.event === 'active_week' && isoWeek(new Date(item.occurredAt)) === week)) return false;
      queue.push(row);
      await options.beforeQueueWrite?.();
      await atomicWrite(queuePath, `${queue.map((item) => JSON.stringify(item)).join('\n')}\n`);
      if (activationKey || week) {
        await writeConfig({
          ...config,
          ...(activationKey
            ? { activationDedupe: [...new Set([...(config.activationDedupe ?? []), activationKey])].slice(-RUNTIMES.size) }
            : {}),
          ...(week ? { activeWeek: week } : {}),
        });
      }
      return true;
    } catch {
      return false;
    }
  });

  const status = async (): Promise<TelemetryStatus> => {
    const config = await readConfig();
    const queue = config?.enabled ? await readQueue(queuePath, maxQueueEvents) : [];
    return {
      enabled: config?.enabled === true,
      asked: config?.asked === true,
      installationId: config?.installationId ?? null,
      endpoint: config?.endpoint ?? configuredEndpoint ?? null,
      queuedEvents: queue.length,
      collects: ['schema version', 'event name', 'random installation ID', 'timestamp', 'allowlisted categorical dimensions'],
      neverCollects: ['memory content', 'prompts', 'queries', 'file or directory paths', 'git data', 'hardware or MAC addresses', 'user or host names'],
    };
  };

  const flush = async (): Promise<boolean> => withTelemetryLock(stateDir, async () => {
    let config: TelemetryConfig | null = null;
    try {
      config = await readConfig();
      if (!config?.enabled || !config.installationId) return false;
      const endpoint = validEndpoint(config.endpoint ?? configuredEndpoint);
      if (!endpoint) return false;
      const currentTime = now();
      if (config.retry && Date.parse(config.retry.nextAttemptAt) > currentTime.getTime()) return false;
      const queue = await readQueue(queuePath, maxQueueEvents);
      if (!queue.length) return false;
      const batch = queue.slice(0, Math.max(1, batchSize));
      const payload = JSON.stringify({ schemaVersion: 1, events: batch });
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('telemetry_request_timeout')), timeoutMs);
      });
      let result: SendBatchResult;
      try {
        await options.beforeSend?.();
        result = await Promise.race([sender(new URL(endpoint), payload, timeoutMs), deadline]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (result.accepted !== batch.length) throw new Error('telemetry_acknowledgement_invalid');
      const remaining = queue.slice(batch.length);
      if (remaining.length) {
        await atomicWrite(queuePath, `${remaining.map((item) => JSON.stringify(item)).join('\n')}\n`);
      } else {
        await fs.rm(queuePath, { force: true });
      }
      const { retry: _retry, ...withoutRetry } = config;
      await writeConfig(withoutRetry);
      return true;
    } catch {
      if (config?.enabled) {
        const failures = Math.min(10, (config.retry?.failures ?? 0) + 1);
        const delay = Math.min(MAX_BACKOFF_MS, baseBackoffMs * (2 ** (failures - 1)));
        await writeConfig({
          ...config,
          retry: {
            failures,
            nextAttemptAt: new Date(now().getTime() + delay).toISOString(),
          },
        }).catch(() => {});
      }
      return false;
    }
  });

  return {
    applyConsent: async (choice, endpoint) => {
      if (choice === 'later') return choice;
      if (choice === 'opt-in') await enable(endpoint);
      else await disable();
      return choice;
    },
    enable,
    disable,
    flush,
    hasAsked: async () => (await readConfig())?.asked === true,
    record,
    status,
  };
}

function defaultClient(): TelemetryClient {
  return createTelemetry();
}

// CLI compatibility wrappers keep callers fail-open and resolve HOME at call time for hermetic runs.
export async function readConfig(): Promise<TelemetryConfig | null> {
  const file = path.join(telemetryDir(), CONFIG_FILE);
  return parseConfig(await readJson(file));
}

export async function isEnabled(): Promise<boolean> {
  return (await readConfig())?.enabled === true;
}

export async function hasAsked(): Promise<boolean> {
  return (await readConfig())?.asked === true;
}

export async function setEnabled(enabled: boolean, endpoint?: string): Promise<void> {
  if (enabled) await defaultClient().enable(endpoint);
  else await defaultClient().disable();
}

export async function applyConsent(choice: TelemetryConsent, endpoint?: string): Promise<TelemetryConsent> {
  return defaultClient().applyConsent(choice, endpoint);
}

export async function track(event: string, dimensions: Record<string, unknown> = {}): Promise<void> {
  try { await defaultClient().record(event, dimensions); } catch { /* metrics never affect product flow */ }
}

export async function flush(): Promise<boolean> {
  try { return await defaultClient().flush(); } catch { return false; }
}

export async function status(): Promise<Record<string, unknown>> {
  const value = await defaultClient().status();
  return {
    ...value,
    installationId: value.installationId ? `${value.installationId.slice(0, 8)}...` : null,
    endpoint: value.endpoint ?? 'not configured (no uploads)',
  };
}
