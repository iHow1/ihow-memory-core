// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory

export type RuntimeLifecycleEventName =
  | 'runtime.session_start'
  | 'runtime.session_reset'
  | 'runtime.before_prompt'
  | 'runtime.after_turn'
  | 'runtime.session_finalize'
  | 'runtime.session_end';

export type RuntimeLifecycleEvent = Readonly<{
  schemaVersion: 1;
  event: RuntimeLifecycleEventName;
  runtime: string;
  cwd: string;
  sessionId?: string;
  platform?: string;
  observedAt: string;
  promptDigest?: string;
}>;

export type RuntimeContextProbeRequest = Readonly<{
  cwd: string;
  runtime: string;
  sessionHint?: string;
  promptDigest?: string;
  eventHint: 'session_start' | 'prompt' | 'session_end' | 'tick';
}>;

const HERMES_HOOK_EVENTS: Readonly<Record<string, RuntimeLifecycleEventName>> = Object.freeze({
  on_session_start: 'runtime.session_start',
  on_session_reset: 'runtime.session_reset',
  pre_llm_call: 'runtime.before_prompt',
  post_llm_call: 'runtime.after_turn',
  on_session_finalize: 'runtime.session_finalize',
  on_session_end: 'runtime.session_end',
});

export function mapHermesHookEvent(hookName: string): RuntimeLifecycleEventName | undefined {
  return typeof hookName === 'string' ? HERMES_HOOK_EVENTS[hookName] : undefined;
}

function normalizedString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

function validateRuntimeEvent(input: RuntimeLifecycleEvent): RuntimeLifecycleEvent {
  if (!input || typeof input !== 'object' || input.schemaVersion !== 1) {
    throw new Error('runtime_event_schema_invalid');
  }
  if (!normalizedString(input.runtime, 64)) throw new Error('runtime_event_runtime_required');
  if (!normalizedString(input.cwd, 4096)) throw new Error('runtime_event_cwd_required');
  if (!Number.isFinite(Date.parse(input.observedAt))) throw new Error('runtime_event_observed_at_invalid');
  if (typeof input.promptDigest === 'string' && input.promptDigest.length > 2000) {
    throw new Error('runtime_event_prompt_digest_too_large');
  }
  return input;
}

export function runtimeEventToContextProbe(
  raw: RuntimeLifecycleEvent,
): RuntimeContextProbeRequest | undefined {
  const event = validateRuntimeEvent(raw);
  const base = {
    cwd: event.cwd.trim(),
    runtime: event.runtime.trim().toLowerCase(),
    ...(normalizedString(event.sessionId, 256) ? { sessionHint: normalizedString(event.sessionId, 256) } : {}),
  };
  if (event.event === 'runtime.session_start' || event.event === 'runtime.session_reset') {
    return { ...base, eventHint: 'session_start' };
  }
  if (event.event === 'runtime.before_prompt') {
    return {
      ...base,
      ...(normalizedString(event.promptDigest, 2000) ? { promptDigest: normalizedString(event.promptDigest, 2000) } : {}),
      eventHint: 'prompt',
    };
  }
  if (event.event === 'runtime.session_finalize' || event.event === 'runtime.session_end') {
    return { ...base, eventHint: 'session_end' };
  }
  return undefined;
}
