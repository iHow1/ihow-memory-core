#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import fs from 'node:fs';
import { openCore } from './core.ts';
import { contextProbe } from './context-probe.ts';
import {
  runtimeEventToContextProbe,
  type RuntimeLifecycleEvent,
  type RuntimeLifecycleEventName,
} from './runtime-events.ts';

const KNOWN_EVENTS = new Set<RuntimeLifecycleEventName>([
  'runtime.session_start',
  'runtime.session_reset',
  'runtime.before_prompt',
  'runtime.after_turn',
  'runtime.session_finalize',
  'runtime.session_end',
]);
const MAX_CONTEXT_CHARS = 8_000;

function errorCode(error: unknown): string {
  return error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
    ? error.message
    : 'hermes_bridge_failed';
}

async function main(): Promise<void> {
  const raw = fs.readFileSync(0, 'utf8').trim();
  if (!raw) throw new Error('runtime_event_input_required');
  let event: RuntimeLifecycleEvent;
  try {
    event = JSON.parse(raw) as RuntimeLifecycleEvent;
  } catch {
    throw new Error('runtime_event_json_invalid');
  }
  if (!KNOWN_EVENTS.has(event.event)) throw new Error('runtime_event_name_invalid');
  const request = runtimeEventToContextProbe(event);
  if (!request) {
    process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
    return;
  }
  const core = await openCore({ cwd: event.cwd });
  const output = await contextProbe(core.workspace, request, {
    search: core.search,
  });
  const context = typeof output.injectText === 'string' && output.injectText.trim()
    ? output.injectText.slice(0, MAX_CONTEXT_CHARS)
    : undefined;
  process.stdout.write(`${JSON.stringify({ ok: true, ...(context ? { context } : {}) })}\n`);
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ ok: false, error: errorCode(error) })}\n`);
  process.exitCode = 1;
});
