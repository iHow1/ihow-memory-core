// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
// iHow Memory — opt-in anonymous telemetry.
//
// PRIVACY CONTRACT (this is the product's core promise — do not weaken):
//   1. Default OFF. Nothing is collected or sent until the user explicitly opts in.
//   2. Only a fixed allow-list of fields ever leaves track(): event / runtime / version /
//      errorType / ts. Memory content, file names, queries, paths, prompts — NEVER.
//   3. When disabled, track() returns immediately and touches neither disk nor network.
//   4. Endpoint stage ③: events are appended to a LOCAL file only. No network upload yet;
//      a future flush adapter (PostHog / self-hosted) ships them only when configured.
//
// Config + local events live under ~/.ihow-memory/ (global, not per-workspace, so the
// user's choice is consistent everywhere).

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const CONFIG_DIR = path.join(os.homedir(), '.ihow-memory');
const CONFIG_PATH = path.join(CONFIG_DIR, 'telemetry.json');
const EVENTS_PATH = path.join(CONFIG_DIR, 'telemetry-events.jsonl');

// The ONLY fields that may ever be recorded. Anything else is dropped.
const ALLOWED_PROP_KEYS = ['runtime', 'version', 'errorType'] as const;

export type TelemetryConfig = { enabled: boolean; anonId: string; asked: boolean };

type TrackProps = { runtime?: string; version?: string; errorType?: string };

function freshConfig(): TelemetryConfig {
  return { enabled: false, anonId: crypto.randomBytes(8).toString('hex'), asked: false };
}

export async function readConfig(): Promise<TelemetryConfig | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
    if (parsed && typeof parsed === 'object') return parsed as TelemetryConfig;
    return null;
  } catch {
    return null;
  }
}

async function writeConfig(cfg: TelemetryConfig): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
}

export async function isEnabled(): Promise<boolean> {
  const cfg = await readConfig();
  return cfg?.enabled === true; // default OFF
}

export async function hasAsked(): Promise<boolean> {
  const cfg = await readConfig();
  return cfg?.asked === true;
}

export async function setEnabled(enabled: boolean): Promise<void> {
  const cfg = (await readConfig()) || freshConfig();
  cfg.enabled = enabled;
  cfg.asked = true;
  await writeConfig(cfg);
}

export async function markAsked(): Promise<void> {
  const cfg = (await readConfig()) || freshConfig();
  cfg.asked = true;
  await writeConfig(cfg);
}

// Record one anonymous event. No-op unless the user opted in.
// Hard privacy boundary: only ALLOWED_PROP_KEYS survive; everything else is discarded
// before anything is written.
export async function track(event: string, props: TrackProps = {}): Promise<void> {
  try {
    if (!(await isEnabled())) return; // disabled → never touch disk/network
    const safe: Record<string, unknown> = { event: String(event), ts: new Date().toISOString() };
    for (const key of ALLOWED_PROP_KEYS) {
      const value = (props as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.length > 0 && value.length < 64) safe[key] = value;
    }
    await fs.mkdir(CONFIG_DIR, { recursive: true });
    await fs.appendFile(EVENTS_PATH, `${JSON.stringify(safe)}\n`, 'utf8');
  } catch {
    // Telemetry must NEVER break the main flow.
  }
}

export async function status(): Promise<Record<string, unknown>> {
  const cfg = await readConfig();
  return {
    enabled: cfg?.enabled === true,
    asked: cfg?.asked === true,
    anonId: cfg?.anonId ? `${cfg.anonId.slice(0, 4)}…` : null,
    collects: ['event', 'runtime', 'version', 'errorType', 'ts'],
    neverCollects: ['memory content', 'file names', 'queries', 'paths', 'prompts', 'any user data'],
    endpoint: 'local-only — not uploaded (opt-in framework; real endpoint TBD)',
    configPath: CONFIG_PATH,
  };
}
