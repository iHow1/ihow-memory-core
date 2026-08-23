// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
const OMP_EXTENSION_OWNER = 'ihow-memory-v1';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type OmpMemoryConfig = {
  schemaVersion: 1;
  managedBy: 'ihow-memory-v1';
  command: string;
  cli: string;
  memoryRoot: string;
  stateRoot: string;
  space: string;
};

type HookOutput = {
  hookSpecificOutput?: { additionalContext?: string };
};
type OmpExtensionContext = {
  cwd: string;
  sessionManager: {
    getSessionId(): string;
    getSessionFile(): string | undefined;
  };
};

type OmpExtensionEvents = {
  session_start: { type: 'session_start' };
  before_agent_start: { type: 'before_agent_start'; prompt: string };
  session_before_compact: { type: 'session_before_compact'; preparation?: unknown };
  session_before_switch: { type: 'session_before_switch' };
  session_shutdown: { type: 'session_shutdown' };
};

type OmpExtensionApi = {
  on<K extends keyof OmpExtensionEvents>(
    event: K,
    handler: (event: OmpExtensionEvents[K], context: OmpExtensionContext) => unknown,
  ): void;
};

const MAX_OUTPUT_BYTES = 256 * 1024;
const HOOK_TIMEOUT_MS = 12_000;
const startupContextBySession = new Map<string, string>();

function agentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.omp', 'agent');
}

function loadConfig(): OmpMemoryConfig | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(agentDir(), 'ihow-memory.json'), 'utf8')) as Partial<OmpMemoryConfig>;
    if (
      value.schemaVersion !== 1
      || value.managedBy !== 'ihow-memory-v1'
      || typeof value.command !== 'string'
      || typeof value.cli !== 'string'
      || typeof value.memoryRoot !== 'string'
      || typeof value.stateRoot !== 'string'
      || typeof value.space !== 'string'
      || !path.isAbsolute(value.command)
      || !path.isAbsolute(value.cli)
      || !path.isAbsolute(value.memoryRoot)
      || !path.isAbsolute(value.stateRoot)
    ) return undefined;
    return value as OmpMemoryConfig;
  } catch {
    return undefined;
  }
}

async function invokeHook(
  hook: 'hook-session-start' | 'hook-user-prompt-submit' | 'hook-pre-compact' | 'hook-session-end',
  payload: Record<string, unknown>,
  cwd: string,
): Promise<string> {
  const config = loadConfig();
  if (!config) return '';
  const args = [
    config.cli,
    hook,
    '--hook-owner', OMP_EXTENSION_OWNER,
    '--runtime', 'omp',
    '--memory-root', config.memoryRoot,
    '--state-root', config.stateRoot,
    '--space', config.space,
    '--cwd', cwd,
  ];
  try {
    const { promise, resolve } = Promise.withResolvers<string>();
    let settled = false;
    let stdout = '';
    let timer: NodeJS.Timeout;
    const finish = (value = ''): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const child = spawn(config.command, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'ignore'],
      env: process.env,
    });
    timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish();
    }, HOOK_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (Buffer.byteLength(stdout, 'utf8') >= MAX_OUTPUT_BYTES) return;
      stdout += chunk;
      if (Buffer.byteLength(stdout, 'utf8') > MAX_OUTPUT_BYTES) stdout = stdout.slice(0, MAX_OUTPUT_BYTES);
    });
    child.on('error', () => finish());
    child.on('close', (code) => finish(code === 0 ? stdout : ''));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
    return await promise;
  } catch {
    return '';
  }
}

function dispatchShutdownCapture(ctx: OmpExtensionContext): void {
  const payload = sessionPayload(ctx);
  if (!payload || !payload.transcript_path) return;
  const config = loadConfig();
  if (!config) return;
  const args = [
    config.cli,
    'hook-session-end',
    '--hook-owner', OMP_EXTENSION_OWNER,
    '--runtime', 'omp',
    '--memory-root', config.memoryRoot,
    '--state-root', config.stateRoot,
    '--space', config.space,
    '--cwd', ctx.cwd,
  ];
  try {
    const child = spawn(config.command, args, {
      cwd: ctx.cwd,
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
      env: process.env,
    });
    child.on('error', () => {});
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ ...payload, hook_event_name: 'SessionEnd' }));
    child.unref();
  } catch {
    // OMP gives session_shutdown handlers 2s; teardown must remain fail-open.
  }
}

function additionalContext(raw: string): string {
  for (const line of raw.trim().split('\n').reverse()) {
    try {
      const parsed = JSON.parse(line) as HookOutput;
      const text = parsed.hookSpecificOutput?.additionalContext;
      if (typeof text === 'string' && text.trim()) return text.trim();
    } catch {
      // Hooks are fail-open; ignore non-JSON diagnostics.
    }
  }
  return '';
}
function sessionPayload(ctx: OmpExtensionContext): Record<string, unknown> | undefined {
  const sessionId = ctx.sessionManager.getSessionId();
  const transcriptPath = ctx.sessionManager.getSessionFile();
  if (!sessionId) return undefined;
  return {
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd: ctx.cwd,
  };
}
async function captureSession(ctx: OmpExtensionContext): Promise<void> {
  const payload = sessionPayload(ctx);
  if (!payload || !payload.transcript_path) return;
  await invokeHook('hook-session-end', {
    ...payload,
    hook_event_name: 'SessionEnd',
  }, ctx.cwd);
}
export default function iHowMemoryOmpExtension(pi: OmpExtensionApi): void {
  pi.on('session_start', async (_event, ctx) => {
    const payload = sessionPayload(ctx);
    if (!payload) return;
    const raw = await invokeHook('hook-session-start', {
      ...payload,
      hook_event_name: 'SessionStart',
      source: 'startup',
    }, ctx.cwd);
    const startupContext = additionalContext(raw);
    if (startupContext) startupContextBySession.set(payload.session_id as string, startupContext);
    else startupContextBySession.delete(payload.session_id as string);
  });

  pi.on('before_agent_start', async (event, ctx) => {
    const payload = sessionPayload(ctx);
    if (!payload) return;
    const raw = await invokeHook('hook-user-prompt-submit', {
      ...payload,
      hook_event_name: 'UserPromptSubmit',
      prompt: event.prompt,
    }, ctx.cwd);
    const recalled = additionalContext(raw);
    const startupContext = startupContextBySession.get(payload.session_id as string) ?? '';
    const content = [startupContext, recalled].filter(Boolean).join('\n\n');
    startupContextBySession.delete(payload.session_id as string);
    if (!content) return;
    return {
      message: {
        customType: 'ihow-memory-recall',
        content,
        display: false,
        attribution: 'agent',
      },
    };
  });

  pi.on('session_before_compact', async (_event, ctx) => {
    const payload = sessionPayload(ctx);
    if (!payload) return;
    await invokeHook('hook-pre-compact', {
      ...payload,
      hook_event_name: 'PreCompact',
      trigger: 'auto',
    }, ctx.cwd);
  });

  pi.on('session_before_switch', async (_event, ctx) => {
    startupContextBySession.delete(ctx.sessionManager.getSessionId());
    await captureSession(ctx);
  });

  pi.on('session_shutdown', (_event, ctx) => {
    startupContextBySession.delete(ctx.sessionManager.getSessionId());
    dispatchShutdownCapture(ctx);
  });
}
