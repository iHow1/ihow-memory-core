// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Workspace, WorkspaceOptions } from './types.ts';

export type CommandHookEntry = {
  type: 'command';
  command: string;
  timeout?: number;
  statusMessage?: string;
  ihowGeneration?: string;
};

export type HookGroup = {
  matcher?: string;
  hooks?: CommandHookEntry[];
};

export type HookCommandOptions = WorkspaceOptions & {
  runtime?: string;
  globalHook?: boolean;
  recall?: boolean;
};

export type RuntimeHookWiring = {
  runtime: 'claude-code' | 'codex';
  state: 'current' | 'absent' | 'broken';
  managedPresent: boolean;
  generationId?: string;
  configPath?: string;
  notes: string[];
};

export const IHOW_HOOK_OWNER = 'ihow-memory-v1';
const IHOW_GENERATION_VERSION = 'ihow-generation-v1';

function generationIntegrityPayload(
  nonce: string,
  event: string,
  marker: string,
  expected: CommandHookEntry,
  matcher?: string,
): string {
  return JSON.stringify({
    version: IHOW_GENERATION_VERSION,
    nonce,
    event,
    marker,
    matcher: matcher ?? null,
    type: expected.type,
    command: expected.command,
    timeout: expected.timeout ?? null,
    statusMessage: expected.statusMessage ?? null,
  });
}

function createIhowGeneration(
  event: string,
  marker: string,
  expected: CommandHookEntry,
  matcher?: string,
): string {
  const nonce = crypto.randomUUID();
  const digest = crypto.createHash('sha256')
    .update(generationIntegrityPayload(nonce, event, marker, expected, matcher))
    .digest('hex');
  return `${IHOW_GENERATION_VERSION}.${nonce}.${digest}`;
}

function ihowGenerationIsValid(
  value: unknown,
  event: string,
  marker: string,
  expected: CommandHookEntry,
  matcher?: string,
): boolean {
  if (typeof value !== 'string') return false;
  const match = /^ihow-generation-v1\.([0-9a-f-]{36})\.([0-9a-f]{64})$/.exec(value);
  if (!match) return false;
  const digest = crypto.createHash('sha256')
    .update(generationIntegrityPayload(match[1], event, marker, expected, matcher))
    .digest('hex');
  const actual = Buffer.from(match[2], 'hex');
  const wanted = Buffer.from(digest, 'hex');
  return actual.length === wanted.length && crypto.timingSafeEqual(actual, wanted);
}

// Conservative tokenizer for the command strings we generate (POSIX single/double quotes + escapes).
// It is used only for ownership classification, never to execute input. A malformed command is unowned.
export function hookCommandTokens(command: string): string[] | null {
  const words: string[] = [];
  let word = '';
  let started = false;
  let quote: 'single' | 'double' | null = null;
  let escaped = false;
  for (const char of command) {
    if (escaped) {
      word += char;
      started = true;
      escaped = false;
      continue;
    }
    if (quote === 'single') {
      if (char === "'") quote = null;
      else word += char;
      started = true;
      continue;
    }
    if (quote === 'double') {
      if (char === '"') quote = null;
      else if (char === '\\') escaped = true;
      else word += char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        words.push(word);
        word = '';
        started = false;
      }
    } else if (char === "'") {
      quote = 'single';
      started = true;
    } else if (char === '"') {
      quote = 'double';
      started = true;
    } else if (char === '\\') {
      escaped = true;
      started = true;
    } else {
      word += char;
      started = true;
    }
  }
  if (quote || escaped) return null;
  if (started) words.push(word);
  return words;
}

export function commandHookIsOwned(command: string, marker: string): boolean {
  const words = hookCommandTokens(command);
  if (!words || words[2] !== marker) return false;
  const owner = words.indexOf('--hook-owner');
  if (owner >= 0 && words[owner + 1] === IHOW_HOOK_OWNER) return true;
  // Legacy iHow commands had the strict shape: node <.../bin/ihow-memory.mjs> <hook-subcommand> ...
  // Requiring both executable argv positions avoids claiming vendor commands that merely mention us.
  const executable = path.basename(words[0] || '').toLowerCase();
  return (executable === 'node' || executable === 'node.exe') && path.basename(words[1] || '') === 'ihow-memory.mjs';
}

export function hookEventShapesValid(hooks: Record<string, unknown>, events: string[]): boolean {
  for (const event of events) {
    const groups = hooks[event];
    if (groups === undefined) continue;
    if (!Array.isArray(groups)) return false;
    for (const group of groups) {
      if (!group || typeof group !== 'object' || Array.isArray(group)) return false;
      const record = group as { matcher?: unknown; hooks?: unknown };
      if (record.matcher !== undefined && typeof record.matcher !== 'string') return false;
      if (!Array.isArray(record.hooks)) return false;
      if (record.hooks.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry))) return false;
    }
  }
  return true;
}

export function commandHookIsAbsent(hooks: Record<string, unknown>, event: string, marker: string): boolean {
  const list = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
  return !list.some((group) => {
    const entries = (group as { hooks?: unknown[] })?.hooks;
    return Array.isArray(entries) && entries.some((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
      const command = (entry as Record<string, unknown>).command;
      return typeof command === 'string' && commandHookIsOwned(command, marker);
    });
  });
}

export function commandHookIsCurrent(
  hooks: Record<string, unknown>,
  event: string,
  marker: string,
  expected: CommandHookEntry,
  matcher?: string,
): boolean {
  const list = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
  let owned = 0;
  let currentCount = 0;
  for (const group of list) {
    const record = group as { matcher?: unknown; hooks?: unknown[] };
    const entries = record?.hooks;
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const current = entry as Record<string, unknown>;
      if (typeof current.command !== 'string' || !commandHookIsOwned(current.command, marker)) continue;
      owned += 1;
      if (entries.length === 1 && record.matcher === matcher &&
        current.type === expected.type && current.command === expected.command &&
        current.timeout === expected.timeout && current.statusMessage === expected.statusMessage &&
        ihowGenerationIsValid(current.ihowGeneration, event, marker, expected, matcher)) currentCount += 1;
    }
  }
  return owned === 1 && currentCount === 1;
}

export function removeCommandHooks(hooks: Record<string, unknown>, event: string, marker: string): boolean {
  const list = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
  const nextGroups: unknown[] = [];
  let changed = false;
  for (const group of list) {
    const record = group as { hooks?: unknown[] };
    if (!Array.isArray(record.hooks)) {
      nextGroups.push(group);
      continue;
    }
    const next = record.hooks.filter((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return true;
      const command = (entry as Record<string, unknown>).command;
      const owned = typeof command === 'string' && commandHookIsOwned(command, marker);
      if (owned) changed = true;
      return !owned;
    });
    if (next.length > 0 || next.length === record.hooks.length) {
      if (next.length !== record.hooks.length) record.hooks = next;
      nextGroups.push(group);
    }
  }
  if (changed) {
    if (nextGroups.length) hooks[event] = nextGroups;
    else delete hooks[event];
  }
  return changed;
}

export function ensureCommandHook(
  hooks: Record<string, unknown>,
  event: string,
  marker: string,
  command: string,
  hook: Omit<CommandHookEntry, 'type' | 'command'> = {},
  matcher?: string,
  forceGeneration = false,
): boolean {
  const list = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
  const expected: CommandHookEntry = { type: 'command', command, ...hook };
  if (!forceGeneration && commandHookIsCurrent(hooks, event, marker, expected, matcher)) return false;

  let firstOwned: Record<string, unknown> | undefined;
  let preservedGroupFields: Record<string, unknown> = {};
  const nextGroups: unknown[] = [];
  for (const group of list) {
    const record = group as Record<string, unknown> & { hooks?: unknown[] };
    if (!Array.isArray(record.hooks)) {
      nextGroups.push(group);
      continue;
    }
    const ownedEntries = record.hooks.filter((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
      const current = entry as Record<string, unknown>;
      return typeof current.command === 'string' && commandHookIsOwned(current.command, marker);
    }) as Record<string, unknown>[];
    if (!ownedEntries.length) {
      nextGroups.push(group);
      continue;
    }
    if (!firstOwned) {
      firstOwned = ownedEntries[0];
      if (ownedEntries.length === record.hooks.length) {
        preservedGroupFields = Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'hooks' && key !== 'matcher'));
      }
    }
    const remaining = record.hooks.filter((entry) => !ownedEntries.includes(entry as Record<string, unknown>));
    if (remaining.length) {
      record.hooks = remaining;
      nextGroups.push(group);
    }
  }

  const entry = firstOwned ?? {};
  for (const key of ['type', 'command', 'timeout', 'statusMessage'] as const) {
    const value = expected[key];
    if (value === undefined) delete entry[key];
    else entry[key] = value;
  }
  // This nonce is installation/repair state owned by iHow, not filesystem metadata. It changes only
  // when ensureCommandHook actually repairs/adds this managed entry, and survives unrelated config
  // edits, touch, and atomic save/rename by other tools.
  entry.ihowGeneration = createIhowGeneration(event, marker, expected, matcher);
  const canonical: HookGroup & Record<string, unknown> = { ...preservedGroupFields, hooks: [entry as CommandHookEntry] };
  if (matcher !== undefined) canonical.matcher = matcher;
  nextGroups.push(canonical);
  hooks[event] = nextGroups;
  return true;
}

function shellQuoteHookArg(value: string): string {
  if (process.platform === 'win32') {
    if (/[%!^&|<>()`]/.test(value)) throw new Error('unsupported_special_character_in_native_windows_hook_path');
    return JSON.stringify(value);
  }
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function hookCommand(workspace: Workspace, command: string, runtime: 'claude-code' | 'codex'): string {
  const cli = path.join(workspace.spaceDir, '.runtime', 'cli.js');
  const parts = [
    shellQuoteHookArg(process.execPath),
    shellQuoteHookArg(cli),
    command,
    '--hook-owner',
    IHOW_HOOK_OWNER,
    '--runtime',
    shellQuoteHookArg(runtime),
  ];
  if (workspace.mode === 'existing-memory-root') {
    parts.push('--memory-root', shellQuoteHookArg(workspace.memoryDir));
    parts.push('--state-root', shellQuoteHookArg(workspace.root));
  } else {
    parts.push('--root', shellQuoteHookArg(workspace.root));
  }
  parts.push('--space', shellQuoteHookArg(workspace.space));
  return parts.join(' ');
}

export function stopHookCommand(workspace: Workspace): string {
  return hookCommand(workspace, 'hook-stop', 'claude-code');
}

export function sessionStartHookCommand(workspace: Workspace, runtime: 'claude-code' | 'codex'): string {
  return hookCommand(workspace, 'hook-session-start', runtime);
}

export function recallHookCommand(workspace: Workspace, runtime: 'claude-code' | 'codex'): string {
  return hookCommand(workspace, 'hook-user-prompt-submit', runtime);
}

export function claudeHookInstallPath(options: HookCommandOptions): string {
  return options.globalHook
    ? path.join(os.homedir(), '.claude', 'settings.json')
    : path.join(path.resolve(options.cwd || process.cwd()), '.claude', 'settings.local.json');
}

export function claudeHookConfigPaths(options: HookCommandOptions): string[] {
  const local = path.join(path.resolve(options.cwd || process.cwd()), '.claude', 'settings.local.json');
  const global = path.join(os.homedir(), '.claude', 'settings.json');
  // Claude merges scopes at runtime. Verification must always inspect both, even when the caller asks
  // to install into one particular scope with --global-hook.
  return [local, global];
}

export function codexHookConfigPath(): string {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'hooks.json');
}

function commandBinding(command: string): Record<string, string> | null {
  const words = hookCommandTokens(command);
  if (!words) return null;
  const binding: Record<string, string> = {};
  for (const flag of ['--root', '--space', '--memory-root', '--state-root', '--runtime']) {
    const index = words.indexOf(flag);
    if (index >= 0 && typeof words[index + 1] === 'string') binding[flag] = words[index + 1];
  }
  return binding;
}

function sameHookBinding(command: string, expected: string): boolean {
  const currentBinding = commandBinding(command);
  const expectedBinding = commandBinding(expected);
  if (!currentBinding || !expectedBinding) return false;
  return Object.entries(expectedBinding).every(([flag, value]) => currentBinding[flag] === value);
}

function commandIsManagedOrOwnerConflict(command: string, marker: string, expectedCommand: string): boolean {
  const words = hookCommandTokens(command);
  const expected = hookCommandTokens(expectedCommand);
  if (!words || !expected || words[2] !== marker) return false;
  const currentWorkspaceCli = words[0] === expected[0] && words[1] === expected[1];
  // The current workspace's frozen CLI is always relevant, even if owner or binding was tampered.
  // A genuinely foreign workspace has a different frozen CLI and remains isolated below.
  if (currentWorkspaceCli) return true;
  if (!sameHookBinding(command, expectedCommand)) return false;
  return commandHookIsOwned(command, marker);
}

function relevantCommandsForEvent(
  hooks: Record<string, unknown>,
  event: string,
  marker: string,
  expectedCommand: string,
): Array<{ group: { matcher?: unknown; hooks?: unknown[] }; entry: Record<string, unknown>; relevantInGroup: number }> {
  const result: Array<{ group: { matcher?: unknown; hooks?: unknown[] }; entry: Record<string, unknown>; relevantInGroup: number }> = [];
  const groups = Array.isArray(hooks[event]) ? hooks[event] as unknown[] : [];
  for (const group of groups) {
    const record = group as { matcher?: unknown; hooks?: unknown[] };
    if (!Array.isArray(record.hooks)) continue;
    const relevant = record.hooks.filter((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
      const command = (entry as Record<string, unknown>).command;
      return typeof command === 'string' && commandIsManagedOrOwnerConflict(command, marker, expectedCommand);
    }) as Record<string, unknown>[];
    for (const entry of relevant) result.push({ group: record, entry, relevantInGroup: relevant.length });
  }
  return result;
}

function commandHookIsCurrentForBinding(
  hooks: Record<string, unknown>,
  event: string,
  marker: string,
  expected: CommandHookEntry,
  matcher?: string,
): boolean {
  const relevant = relevantCommandsForEvent(hooks, event, marker, expected.command);
  if (relevant.length !== 1) return false;
  const { group, entry, relevantInGroup } = relevant[0];
  return relevantInGroup === 1 && group.matcher === matcher && commandHookIsOwned(String(entry.command), marker) &&
    entry.type === expected.type && entry.command === expected.command &&
    entry.timeout === expected.timeout && entry.statusMessage === expected.statusMessage &&
    ihowGenerationIsValid(entry.ihowGeneration, event, marker, expected, matcher);
}

function commandHookIsAbsentForBinding(
  hooks: Record<string, unknown>,
  event: string,
  marker: string,
  expectedCommand: string,
): boolean {
  return relevantCommandsForEvent(hooks, event, marker, expectedCommand).length === 0;
}

function hasRelevantManagedHook(
  hooks: Record<string, unknown>,
  expected: Array<{ event: string; marker: string; entry: CommandHookEntry }>,
): boolean {
  return expected.some((item) => relevantCommandsForEvent(
    hooks, item.event, item.marker, item.entry.command,
  ).length > 0);
}

async function managedGeneration(commands: string[], installationEpochs: string[]): Promise<string> {
  const cliToken = hookCommandTokens(commands[0] || '')?.[1] || '';
  let cliIdentity = 'missing';
  try {
    const cli = await fs.readFile(cliToken);
    cliIdentity = crypto.createHash('sha256').update(cli).digest('hex');
  } catch {
    // The caller separately classifies a missing CLI as broken. Keep generation metadata-only.
  }
  // Generation is semantic managed state: exact verified commands, frozen CLI bytes, and installer
  // epochs stored on managed entries. Filesystem inode/mtime and unrelated third-party config bytes
  // are excluded, so external atomic saves cannot move configuredAt.
  return crypto.createHash('sha256').update(JSON.stringify({
    commands,
    cliIdentity,
    installationEpochs,
  })).digest('hex');
}

async function targetsExist(commands: string[]): Promise<boolean> {
  for (const command of commands) {
    const words = hookCommandTokens(command);
    if (!words || !path.isAbsolute(words[0] || '') || !path.isAbsolute(words[1] || '')) return false;
    try {
      await fs.access(words[0], 1);
      const stat = await fs.stat(words[1]);
      if (!stat.isFile() || stat.size <= 0) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function verifyConfig(
  file: string,
  expected: Array<{ event: string; marker: string; entry: CommandHookEntry; matcher?: string }>,
  optionalAbsent: { event: string; marker: string },
): Promise<{ state: 'current' | 'absent' | 'broken'; managedPresent: boolean; generationId?: string; notes: string[] }> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'absent', managedPresent: false, notes: [] };
    return { state: 'broken', managedPresent: true, notes: ['hook config unreadable'] };
  }
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not_object');
    parsed = value as Record<string, unknown>;
  } catch {
    return { state: 'broken', managedPresent: true, notes: ['hook config invalid JSON'] };
  }
  const hooks = parsed.hooks;
  if (hooks === undefined) return { state: 'absent', managedPresent: false, notes: [] };
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return { state: 'broken', managedPresent: true, notes: ['hooks shape invalid'] };
  const record = hooks as Record<string, unknown>;
  const shapeEvents = [...expected.map((item) => item.event), optionalAbsent.event];
  if (!hookEventShapesValid(record, shapeEvents)) return { state: 'broken', managedPresent: true, notes: ['hook event shape invalid'] };
  // An iHow hook for another root/space is not broken wiring for THIS workspace. Treat it as absent;
  // if this workspace was previously configured, the activation ledger will still turn absence into
  // NEEDS REPAIR. Hooks that target this exact binding but have wrong events/metadata remain broken.
  const managedPresent = hasRelevantManagedHook(record, expected);
  if (!managedPresent) return { state: 'absent', managedPresent: false, notes: [] };

  const coreCurrent = expected.slice(0, 1).every((item) => commandHookIsCurrentForBinding(record, item.event, item.marker, item.entry, item.matcher));
  const fullCurrent = expected.every((item) => commandHookIsCurrentForBinding(record, item.event, item.marker, item.entry, item.matcher));
  const optionalExpected = expected.find((item) => item.event === optionalAbsent.event && item.marker === optionalAbsent.marker);
  const recallOffCurrent = coreCurrent && expected.slice(1, -1).every((item) => commandHookIsCurrentForBinding(record, item.event, item.marker, item.entry, item.matcher)) &&
    !!optionalExpected && commandHookIsAbsentForBinding(record, optionalAbsent.event, optionalAbsent.marker, optionalExpected.entry.command);
  if (!fullCurrent && !recallOffCurrent) return { state: 'broken', managedPresent, notes: ['managed hooks do not exactly match current command, binding, owner, or metadata'] };
  const active = expected.filter((item) => item.event !== optionalAbsent.event || fullCurrent);
  const commands = active.map((item) => item.entry.command);
  if (!(await targetsExist(commands))) return { state: 'broken', managedPresent, notes: ['managed hook command target is missing or unusable'] };
  const installationEpochs = active.map((item) => {
    const relevant = relevantCommandsForEvent(record, item.event, item.marker, item.entry.command);
    const value = relevant[0]?.entry.ihowGeneration;
    return typeof value === 'string' && value.length > 0 ? value : `legacy:${item.event}:${item.marker}`;
  });
  return { state: 'current', managedPresent, generationId: await managedGeneration(commands, installationEpochs), notes: [] };
}

export async function verifyRuntimeHookWiring(
  workspace: Workspace,
  runtime: 'claude-code' | 'codex',
  options: HookCommandOptions = {},
): Promise<RuntimeHookWiring> {
  if (runtime === 'claude-code') {
    const expected = [
      { event: 'Stop', marker: 'hook-stop', entry: { type: 'command' as const, command: stopHookCommand(workspace), timeout: 30 } },
      { event: 'SessionStart', marker: 'hook-session-start', entry: { type: 'command' as const, command: sessionStartHookCommand(workspace, runtime), timeout: 30 } },
      { event: 'UserPromptSubmit', marker: 'hook-user-prompt-submit', entry: { type: 'command' as const, command: recallHookCommand(workspace, runtime), timeout: 30 } },
    ];
    const results = [];
    for (const file of claudeHookConfigPaths(options)) {
      results.push({ file, result: await verifyConfig(file, expected, { event: 'UserPromptSubmit', marker: 'hook-user-prompt-submit' }) });
    }
    // Claude merges user + project/local hook scopes. Any broken managed scope therefore wins over a
    // current one, and two current iHow registrations are also broken because both hooks would fire.
    const broken = results.find(({ result }) => result.state === 'broken' && result.managedPresent);
    if (broken) return { runtime, ...broken.result, configPath: broken.file };
    const currents = results.filter(({ result }) => result.state === 'current');
    if (currents.length > 1) {
      return {
        runtime, state: 'broken', managedPresent: true,
        configPath: currents.map(({ file }) => file).join(', '),
        notes: ['managed hooks are duplicated across Claude user and project/local scopes'],
      };
    }
    const current = currents[0];
    if (current) return { runtime, ...current.result, configPath: current.file };
    return { runtime, state: 'absent', managedPresent: false, notes: [] };
  }

  const file = codexHookConfigPath();
  const expected = [
    {
      event: 'SessionStart', marker: 'hook-session-start',
      entry: { type: 'command' as const, command: sessionStartHookCommand(workspace, runtime), timeout: 30, statusMessage: 'Checking iHow Memory handoff' },
      matcher: 'startup|resume|clear|compact',
    },
    {
      event: 'UserPromptSubmit', marker: 'hook-user-prompt-submit',
      entry: { type: 'command' as const, command: recallHookCommand(workspace, runtime), timeout: 30, statusMessage: 'Searching iHow Memory' },
    },
  ];
  const result = await verifyConfig(file, expected, { event: 'UserPromptSubmit', marker: 'hook-user-prompt-submit' });
  return { runtime, ...result, configPath: result.state === 'absent' ? undefined : file };
}
