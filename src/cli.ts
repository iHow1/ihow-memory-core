#!/usr/bin/env -S node --experimental-strip-types
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openCore } from './core.ts';
import { defaultRoot, ensureWorkspace, resolveWorkspace } from './workspace.ts';
import { resolveEngineConfig } from './engine/retrieval.ts';
import { sqliteRuntimeStatus } from './engine/fts.ts';
import type { WorkspaceOptions } from './types.ts';
import * as telemetry from './telemetry.ts';

// Suppress only Node's node:sqlite ExperimentalWarning (Node >= 22.12 is our supported runtime); all other warnings pass through unchanged.
const _emitWarning = process.emitWarning.bind(process);
process.emitWarning = function (warning: string | Error, ...args: any[]): void {
  const message = typeof warning === 'string' ? warning : warning.message;
  const opts = args[0];
  const type = opts && typeof opts === 'object' ? opts.type : opts;
  if (type === 'ExperimentalWarning' && /SQLite/i.test(message)) return;
  (_emitWarning as (...a: any[]) => void)(warning, ...args);
} as typeof process.emitWarning;

type ParsedArgs = {
  command: string;
  options: WorkspaceOptions & {
    json?: boolean;
    limit?: number;
    dryRun?: boolean;
    realWrite?: boolean;
    actor?: string;
    runtime?: 'claude-code' | 'codex' | 'cursor';
    shareDiagnostics?: boolean;
  };
  rest: string[];
};

type DoctorCheck = {
  name: string;
  ok: boolean;
  detail: string;
  hint?: string;
  severity?: 'error' | 'warning' | 'info';
  required?: boolean;
};

type DoctorResult = {
  ok: boolean;
  checks: DoctorCheck[];
  status?: Record<string, unknown>;
};

function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...tail] = argv;
  const options: ParsedArgs['options'] = {};
  const rest: string[] = [];
  for (let index = 0; index < tail.length; index += 1) {
    const arg = tail[index];
    if (arg === '--space') options.space = tail[++index];
    else if (arg === '--root') options.root = tail[++index];
    else if (arg === '--memory-root') options.memoryRoot = tail[++index];
    else if (arg === '--state-root') options.stateRoot = tail[++index];
    else if (arg === '--cwd') options.cwd = tail[++index];
    else if (arg === '--engine') options.engine = tail[++index];
    else if (arg === '--vector-provider-command') options.vectorProviderCommand = tail[++index];
    else if (arg === '--vector-model') options.vectorModel = tail[++index];
    else if (arg === '--vector-timeout-ms') options.vectorTimeoutMs = Number(tail[++index]);
    else if (arg === '--runtime') {
      const runtime = tail[++index];
      if (runtime === 'claude-code' || runtime === 'codex' || runtime === 'cursor') options.runtime = runtime;
      else throw new Error('unsupported_runtime_use_claude-code_codex_or_cursor');
    }
    else if (arg === '--share-diagnostics') options.shareDiagnostics = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--limit') options.limit = Number(tail[++index]);
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--real-write') options.realWrite = true;
    else if (arg === '--actor') options.actor = tail[++index];
    else rest.push(arg);
  }
  return { command, options, rest };
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function workspaceMcpConfigSnippet(memoryRoot: string, stateRoot: string, runtimeDir: string): Record<string, unknown> {
  return {
    mcpServers: {
      'ihow-memory': {
        command: 'node',
        args: [
          'mcp/server.js',
          '--memory-root',
          memoryRoot,
          '--state-root',
          stateRoot,
        ],
        cwd: runtimeDir,
      },
    },
  };
}

function packageDir(): string {
  return path.resolve(new URL('..', import.meta.url).pathname);
}

function packageVersion(): string {
  try {
    const raw = readFileSync(path.join(packageDir(), 'package.json'), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version || 'unknown';
  } catch {
    return 'unknown';
  }
}

function runtimeLabel(runtime?: string): string {
  if (runtime === 'claude-code') return 'Claude Code';
  if (runtime === 'codex') return 'Codex';
  if (runtime === 'cursor') return 'Cursor';
  return 'generic MCP client';
}

function codexTomlSnippet(memoryRoot: string, stateRoot: string, runtimeDir: string): string {
  return `[mcp_servers.ihow-memory]
command = "node"
args = [
  "mcp/server.js",
  "--memory-root",
  "${memoryRoot}",
  "--state-root",
  "${stateRoot}"
]
cwd = "${runtimeDir}"`;
}

function runtimeConfigSnippet(workspace: Awaited<ReturnType<typeof ensureWorkspace>>, runtime?: string): unknown {
  const stateRoot = workspace.root;
  const runtimeDir = path.join(workspace.spaceDir, '.runtime');
  if (runtime === 'codex') return codexTomlSnippet(workspace.memoryDir, stateRoot, runtimeDir);
  return workspaceMcpConfigSnippet(workspace.memoryDir, stateRoot, runtimeDir);
}

function printRuntimeSnippet(snippet: unknown, runtime?: string): void {
  const label = runtimeLabel(runtime);
  console.log(`\n${label} MCP config snippet:`);
  if (typeof snippet === 'string') console.log(snippet);
  else printJson(snippet);
}

function initBackupGuidance(runtime?: string): string {
  if (runtime === 'codex') return 'Before editing Codex config, copy the existing config file or commit it first.';
  if (runtime === 'claude-code') return 'Before editing Claude Code MCP settings, make a copy of the current settings file.';
  if (runtime === 'cursor') return 'Before editing Cursor MCP settings, copy the current MCP/settings JSON.';
  return 'Before writing this snippet into any runtime config, back up the existing config file.';
}

async function installRuntimeBundle(workspace: Awaited<ReturnType<typeof ensureWorkspace>>): Promise<string> {
  const source = path.join(packageDir(), 'dist');
  const target = path.join(workspace.spaceDir, '.runtime');
  try {
    await fs.access(path.join(source, 'mcp', 'server.js'));
  } catch {
    throw new Error('runtime_bundle_missing_run_npm_build');
  }
  await fs.rm(target, { recursive: true, force: true });
  await fs.cp(source, target, { recursive: true });
  // Stamp the real package version into the runtime bundle so the MCP server (run from .runtime/) reports the right version.
  await fs.writeFile(path.join(target, 'package.json'), `${JSON.stringify({ type: 'module', version: packageVersion() }, null, 2)}\n`, 'utf8');
  return target;
}

function commandExists(bin: string): boolean {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8' });
  return probe.status === 0;
}

// Absolute entry path. codex mcp add has no cwd field, so the entry must not rely on cwd;
// .runtime/package.json{type:module} sits on the file's directory chain and keeps ESM working regardless of cwd.
function mcpServerSpec(
  workspace: Awaited<ReturnType<typeof ensureWorkspace>>,
): { command: string; args: string[] } {
  const serverEntry = path.join(workspace.spaceDir, '.runtime', 'mcp', 'server.js');
  return {
    command: 'node',
    args: [serverEntry, '--memory-root', workspace.memoryDir, '--state-root', workspace.root],
  };
}

// Safe direct-write for runtimes without an official CLI (cursor), or as a claude-cli fallback.
// Guards: distinguish ENOENT (new file) vs parse-failure (refuse to overwrite — would destroy the
// user's config) / backup existing / atomic temp+rename.
async function writeJsonMcpConfig(
  targetPath: string,
  runtime: string,
  spec: { command: string; args: string[] },
  options: { dryRun?: boolean },
): Promise<Record<string, unknown>> {
  let config: Record<string, unknown> = {};
  let existed = false;
  let raw: string | null = null;
  try {
    raw = await fs.readFile(targetPath, 'utf8');
    existed = true;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOENT') {
      existed = false;
    } else {
      throw new Error(`connect_cannot_read_config: ${targetPath}: ${(err as Error).message}`);
    }
  }
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') throw new Error('config is not a JSON object');
      config = parsed as Record<string, unknown>;
    } catch (err) {
      throw new Error(
        `connect_refuse_overwrite_unparseable_config: ${targetPath} exists but is not valid JSON (${(err as Error).message}). Aborting to avoid data loss — fix/remove the file or use the runtime's official CLI.`,
      );
    }
  }
  let backup = '';
  if (existed && !options.dryRun) {
    backup = `${targetPath}.ihow-bak-${Date.now()}`;
    await fs.copyFile(targetPath, backup);
  }
  const servers = (config.mcpServers && typeof config.mcpServers === 'object')
    ? (config.mcpServers as Record<string, unknown>)
    : {};
  servers['ihow-memory'] = { type: 'stdio', command: spec.command, args: spec.args };
  config.mcpServers = servers;
  if (!options.dryRun) {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    // atomic write: temp then rename (same-dir rename is atomic)
    const tmp = `${targetPath}.ihow-tmp-${process.pid}`;
    await fs.writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, targetPath);
  }
  return { ok: true, runtime, method: 'direct-json', target: targetPath, backup, dryRun: !!options.dryRun, existed };
}

// claude-code prefers the official CLI (claude mcp add-json --scope user): atomic, officially
// supported, and avoids racing Claude Code's own writes to ~/.claude.json.
// Returns null when the claude CLI is absent -> caller falls back to writeJsonMcpConfig.
function connectViaClaudeCli(
  spec: { command: string; args: string[] },
  options: { dryRun?: boolean },
): Record<string, unknown> | null {
  if (!commandExists('claude')) return null;
  const exists = spawnSync('claude', ['mcp', 'get', 'ihow-memory'], { encoding: 'utf8' }).status === 0;
  if (options.dryRun) {
    return { ok: true, runtime: 'claude-code', method: 'official-cli:claude', alreadyExists: exists, dryRun: true };
  }
  // idempotent: add-json errors on an existing name, so remove first, then re-add with the latest spec
  if (exists) spawnSync('claude', ['mcp', 'remove', 'ihow-memory', '--scope', 'user'], { encoding: 'utf8' });
  const json = JSON.stringify({ type: 'stdio', command: spec.command, args: spec.args });
  const add = spawnSync('claude', ['mcp', 'add-json', '--scope', 'user', 'ihow-memory', json], { encoding: 'utf8' });
  if (add.status !== 0) {
    throw new Error(`claude_mcp_add_failed: ${(add.stderr || add.stdout || '').slice(0, 300)}`);
  }
  return {
    ok: true, runtime: 'claude-code', method: 'official-cli:claude',
    target: '~/.claude.json (claude mcp add-json --scope user)', replaced: exists,
  };
}

// codex uses the official CLI (codex mcp add). It has no cwd field -> rely on the absolute entry path.
// An existing entry must NOT be bare-added (codex would drop the .tools subsection) -> remove then add.
function connectViaCodexCli(
  spec: { command: string; args: string[] },
  options: { dryRun?: boolean },
): Record<string, unknown> {
  if (!commandExists('codex')) {
    throw new Error('codex_cli_not_found: install the Codex CLI to connect codex (or run init for manual TOML).');
  }
  const exists = spawnSync('codex', ['mcp', 'get', 'ihow-memory'], { encoding: 'utf8' }).status === 0;
  if (options.dryRun) {
    return { ok: true, runtime: 'codex', method: 'official-cli:codex', alreadyExists: exists, dryRun: true };
  }
  if (exists) spawnSync('codex', ['mcp', 'remove', 'ihow-memory'], { encoding: 'utf8' });
  const add = spawnSync('codex', ['mcp', 'add', 'ihow-memory', '--', spec.command, ...spec.args], { encoding: 'utf8' });
  if (add.status !== 0) {
    throw new Error(`codex_mcp_add_failed: ${(add.stderr || add.stdout || '').slice(0, 300)}`);
  }
  return {
    ok: true, runtime: 'codex', method: 'official-cli:codex',
    target: '~/.codex/config.toml (codex mcp add)', replaced: exists,
  };
}

async function connectRuntime(
  workspace: Awaited<ReturnType<typeof ensureWorkspace>>,
  runtime: string,
  options: { dryRun?: boolean },
): Promise<Record<string, unknown>> {
  const home = os.homedir();
  const spec = mcpServerSpec(workspace);
  if (runtime === 'claude-code') {
    const viaCli = connectViaClaudeCli(spec, options); // official CLI first
    if (viaCli) return viaCli;
    return writeJsonMcpConfig(path.join(home, '.claude.json'), runtime, spec, options); // fallback: safe direct-write
  }
  if (runtime === 'codex') {
    return connectViaCodexCli(spec, options);
  }
  if (runtime === 'cursor') {
    return writeJsonMcpConfig(path.join(home, '.cursor', 'mcp.json'), runtime, spec, options); // no official CLI
  }
  throw new Error(`connect_unsupported_runtime: ${runtime}`);
}

function help(): void {
  console.log(`iHow Memory Core v${packageVersion()}

Usage:
  ihow-memory init [--space name] [--root path] [--runtime claude-code|codex|cursor]
  ihow-memory status [--space name] [--root path] [--memory-root path] [--state-root path] [--json]
  ihow-memory doctor [--space name] [--root path] [--memory-root path] [--state-root path] [--runtime claude-code|codex|cursor] [--share-diagnostics] [--json]
  ihow-memory proof [--root path] [--space name] [--engine fts|vector-gguf]
  ihow-memory reindex [--memory-root path] [--state-root path] [--json]
  ihow-memory search <query> [--limit n]
  ihow-memory read <memory/path.md>
  ihow-memory write-candidate <text> [--space name]
  ihow-memory promote <candidate-path> [--scope name] [--title title]
  ihow-memory durable-promote <candidate-path> (--dry-run | --real-write) [--scope name] [--title title] [--path path]
  ihow-memory feedback [--runtime claude-code|codex|cursor]
  ihow-memory reset --space name [--root path]
  ihow-memory console [--port 8788] [--host 127.0.0.1] [--memory-root path]   # read-only local web UI
  ihow-memory connect --runtime claude-code|codex|cursor [--dry-run] [--json]   # auto-config MCP (official CLI for claude/codex; safe backup+merge for cursor)
  ihow-memory telemetry [on|off|status]   # anonymous usage telemetry — OFF by default; only event/runtime/version, never memory content

Defaults:
  root: ${defaultRoot()}
  space: derived from cwd unless --space is provided
`);
}

async function isWritable(dir: string): Promise<boolean> {
  try {
    await fs.mkdir(dir, { recursive: true });
    const probe = path.join(dir, `.write-test-${process.pid}-${Date.now()}`);
    await fs.writeFile(probe, 'ok', 'utf8');
    await fs.rm(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

async function latestAuditSummary(eventsDir: string): Promise<Record<string, unknown> | null> {
  let entries;
  try {
    entries = await fs.readdir(eventsDir);
  } catch {
    return null;
  }
  const files = entries.filter((entry) => entry.endsWith('.ndjson')).sort();
  const latest = files.at(-1);
  if (!latest) return null;
  const eventPath = path.join(eventsDir, latest);
  const lines = (await fs.readFile(eventPath, 'utf8')).trim().split('\n').filter(Boolean);
  const last = lines.at(-1);
  if (!last) return null;
  return {
    path: eventPath,
    event: JSON.parse(last),
  };
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]'],
  [/\b(sk-[A-Za-z0-9_-]{8,})\b/g, '[redacted]'],
  [/\b(ghp_[A-Za-z0-9_]{8,})\b/g, '[redacted]'],
  [/\b(github_pat_[A-Za-z0-9_]{8,})\b/g, '[redacted]'],
  [/\b(AKIA[0-9A-Z]{16})\b/g, '[redacted]'],
  [/\b(token|password|passwd|secret|api[_-]?key|authorization|cookie)\b\s*[:=]\s*[^\s"',;]+/gi, '$1=[redacted]'],
];

function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}

function redactionHints(options: WorkspaceOptions = {}, status?: Record<string, unknown>): Array<[string, string]> {
  const workspace = resolveWorkspace(options);
  const statusWorkspace = (status?.workspace || {}) as Record<string, unknown>;
  const index = (status?.index || {}) as Record<string, unknown>;
  const hints: Array<[string, string]> = [
    [os.homedir(), '<home>'],
    [process.cwd(), '<cwd>'],
    [packageDir(), '<package-dir>'],
    [workspace.root, '<state-root>'],
    [workspace.spaceDir, '<workspace>'],
    [workspace.memoryDir, '<memory-root>'],
  ];
  for (const [key, label] of [
    ['root', '<state-root>'],
    ['path', '<workspace>'],
    ['memoryRoot', '<memory-root>'],
  ] as const) {
    if (typeof statusWorkspace[key] === 'string') hints.push([statusWorkspace[key], label]);
  }
  for (const [key, label] of [
    ['path', '<index>'],
    ['manifestPath', '<index-manifest>'],
  ] as const) {
    if (typeof index[key] === 'string') hints.push([index[key], label]);
  }
  return hints
    .filter(([absolute]) => path.isAbsolute(absolute))
    .sort((a, b) => b[0].length - a[0].length);
}

function redactPaths(value: string, hints: Array<[string, string]>): string {
  let text = value;
  for (const [absolute, label] of hints) {
    const normalized = absolute.replace(/\\/g, '/');
    text = text.split(absolute).join(label);
    text = text.split(normalized).join(label);
  }
  return text.replace(/(^|[\s"'`=([{:,])\/(?:[^\s"'`)\]}{,;]|\\ )+/g, (_match, prefix: string) => `${prefix}<path>`);
}

function sanitizeString(value: string, hints: Array<[string, string]>): string {
  return redactPaths(redactSecrets(value), hints).slice(0, 1000);
}

function sanitizeValue(value: unknown, hints: Array<[string, string]>): unknown {
  if (typeof value === 'string') return sanitizeString(value, hints);
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry, hints));
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (/token|password|secret|api[_-]?key|authorization|cookie/i.test(key)) {
        output[key] = '[redacted]';
      } else {
        output[key] = sanitizeValue(entry, hints);
      }
    }
    return output;
  }
  return value;
}

function sanitizeDoctorResult(result: DoctorResult, options: WorkspaceOptions): DoctorResult {
  const hints = redactionHints(options, result.status);
  return sanitizeValue(result, hints) as DoctorResult;
}

function friendlyError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return sanitizeString(raw, redactionHints()).slice(0, 500);
}

function nodeVersionAtLeast(actual: string, expected: string): boolean {
  return actual.localeCompare(expected, undefined, { numeric: true }) >= 0;
}

async function doctor(
  options: WorkspaceOptions & { runtime?: 'claude-code' | 'codex' | 'cursor' },
): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  const workspace = resolveWorkspace(options);
  const nodeOk = nodeVersionAtLeast(process.versions.node, '22.12.0');
  const sqliteStatus = sqliteRuntimeStatus();
  const writable = await isWritable(workspace.memoryDir);
  let status: Record<string, unknown> | undefined;

  checks.push({
    name: 'node',
    ok: nodeOk,
    detail: `v${process.versions.node}`,
    hint: nodeOk
      ? undefined
      : 'Install Node >= 22.12, then rerun: ihow-memory doctor. Example: nvm install 22 && nvm use 22.',
    severity: nodeOk ? 'info' : 'error',
    required: true,
  });
  checks.push({
    name: 'sqlite',
    ok: sqliteStatus.ok,
    detail: sqliteStatus.detail,
    hint: sqliteStatus.ok
      ? undefined
      : 'Use a Node build with node:sqlite. The supported path is Node >= 22.12 from nodejs.org, nvm, fnm, or Volta.',
    severity: sqliteStatus.ok ? 'info' : 'error',
    required: true,
  });
  checks.push({
    name: 'memory-root',
    ok: writable,
    detail: workspace.memoryDir,
    hint: writable
      ? undefined
      : 'Choose a writable location: ihow-memory init --root <writable-dir> or ihow-memory doctor --memory-root <writable-memory-dir> --state-root <writable-state-dir>.',
    severity: writable ? 'info' : 'error',
    required: true,
  });
  checks.push({
    name: 'runtime',
    ok: Boolean(options.runtime),
    detail: options.runtime ? `${runtimeLabel(options.runtime)} selected` : 'not selected',
    hint: options.runtime
      ? `Run ihow-memory init --runtime ${options.runtime} and paste the snippet into ${runtimeLabel(options.runtime)} after backing up existing config.`
      : 'Run ihow-memory init --runtime claude-code, --runtime codex, or --runtime cursor to print a ready-to-paste MCP snippet.',
    severity: options.runtime ? 'info' : 'warning',
    required: false,
  });

  if (nodeOk && sqliteStatus.ok && writable) {
    try {
      const core = await openCore(options);
      status = (await core.status()) as unknown as Record<string, unknown>;
    } catch (error) {
      checks.push({
        name: 'core-status',
        ok: false,
        detail: friendlyError(error),
        hint: 'Run ihow-memory doctor --share-diagnostics and include the redacted output in a feedback issue.',
        severity: 'error',
        required: true,
      });
    }
  }

  const engineConfig = resolveEngineConfig(options);
  if (status) {
    const provider = status.provider as Record<string, unknown>;
    const index = status.index as Record<string, unknown>;
    const sync = status.sync as Record<string, unknown>;
    const providerDetail = provider.fallback
      ? `active=fts fallbackFrom=${provider.fallbackFrom} lastError=${provider.lastError}`
      : `active=${provider.id} ready=${provider.ready}`;
    checks.push({
      name: 'engine',
      ok: provider.ready === true,
      detail: providerDetail,
      hint: provider.ready ? undefined : 'FTS should be available locally; run ihow-memory reindex or check workspace paths.',
      severity: provider.ready ? 'info' : 'error',
      required: true,
    });
    checks.push({
      name: 'vector',
      ok: true,
      detail: engineConfig.vectorProviderCommand
        ? `configured requested=${engineConfig.requestedId}`
        : `not configured requested=${engineConfig.requestedId}`,
      severity: 'info',
      required: false,
    });
    checks.push({
      name: 'index-manifest',
      ok: Boolean(index.manifestPath),
      detail: index.lastError
        ? `${String(index.manifestPath)} lastError=${String(index.lastError)}`
        : String(index.manifestPath),
      hint: index.manifestPath ? undefined : 'Run ihow-memory reindex to create the local index manifest.',
      severity: index.manifestPath ? 'info' : 'error',
      required: true,
    });
    checks.push({
      name: 'cloud',
      ok: provider.cloud === false && sync.enabled === false,
      detail: 'disabled / local only',
      hint: provider.cloud ? 'Disable cloud provider for this local-first proof.' : undefined,
      severity: provider.cloud === false && sync.enabled === false ? 'info' : 'error',
      required: true,
    });
  } else {
    checks.push({
      name: 'engine',
      ok: false,
      detail: 'skipped because node/sqlite/memory-root preflight did not pass',
      hint: 'Fix the failed preflight checks above, then rerun ihow-memory doctor.',
      severity: 'warning',
      required: false,
    });
  }

  return { ok: checks.every((check) => check.ok || check.required === false), checks, status };
}

async function packageInfo(): Promise<{ name: string; version: string }> {
  try {
    const raw = await fs.readFile(path.join(packageDir(), 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { name?: string; version?: string };
    return {
      name: parsed.name || 'ihow-memory-core',
      version: parsed.version || 'unknown',
    };
  } catch {
    return { name: 'ihow-memory-core', version: 'unknown' };
  }
}

async function diagnosticReport(
  result: DoctorResult,
  options: WorkspaceOptions & { runtime?: 'claude-code' | 'codex' | 'cursor' } = {},
): Promise<Record<string, unknown>> {
  const sanitized = sanitizeDoctorResult(result, options);
  const info = await packageInfo();
  const provider = (sanitized.status?.provider || {}) as Record<string, unknown>;
  const sync = (sanitized.status?.sync || {}) as Record<string, unknown>;
  return {
    schema: 'ihow-memory-diagnostics-v1',
    diagnosticId: crypto.randomUUID(),
    generatedAt: new Date().toISOString(),
    package: info,
    runtime: options.runtime || 'not-selected',
    environment: {
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    },
    localOnly: {
      cloud: provider.cloud === false ? 'disabled' : 'unknown',
      sync: sync.enabled === false ? 'disabled' : 'unknown',
      telemetry: (await telemetry.isEnabled()) ? 'opt-in (on)' : 'off (default)',
    },
    checks: sanitized.checks,
    status: sanitized.status
      ? {
          workspace: (sanitized.status.workspace || {}) as Record<string, unknown>,
          index: (sanitized.status.index || {}) as Record<string, unknown>,
          provider,
          sync,
        }
      : undefined,
    redaction: {
      paths: 'redacted',
      secrets: 'redacted',
      fullMemoryContent: 'omitted',
    },
  };
}

function githubIssueUrl(body: string): string {
  const url = new URL('https://github.com/iHow1/ihow-memory-core/issues/new');
  url.searchParams.set('title', '[Activation] ');
  url.searchParams.set('body', body);
  return url.toString();
}

async function feedbackTemplate(
  result: DoctorResult,
  options: WorkspaceOptions & { runtime?: 'claude-code' | 'codex' | 'cursor' } = {},
): Promise<{ body: string; url: string }> {
  const report = await diagnosticReport(result, options);
  const body = `## What happened
<!-- Describe what you ran and what went wrong. -->

## What I expected
<!-- Describe what you expected to happen. -->

## Steps to reproduce
1. \`npx ihow-memory init\`
2. \`ihow-memory doctor\`
3. <!-- next step -->

## Runtime
- Runtime: ${options.runtime || 'not selected'}
- Node: ${process.versions.node}
- Package: ${(report.package as Record<string, string>).name}@${(report.package as Record<string, string>).version}

## Redacted diagnostics
\`\`\`json
${JSON.stringify(report, null, 2)}
\`\`\`
`;
  return { body, url: githubIssueUrl(body) };
}

async function resetSpace(options: WorkspaceOptions): Promise<Record<string, unknown>> {
  if (!options.space) throw new Error('reset_requires_space');
  if (options.memoryRoot) throw new Error('reset_managed_space_only_pass_root_and_space');
  const workspace = resolveWorkspace(options);
  await fs.rm(workspace.spaceDir, { recursive: true, force: true });
  return {
    ok: true,
    reset: {
      space: workspace.space,
      removed: workspace.spaceDir,
    },
  };
}

async function runProof(options: WorkspaceOptions & { json?: boolean }): Promise<Record<string, unknown>> {
  const root = options.root ? path.resolve(options.root) : await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-memory-proof-cli-'));
  const space = options.space || 'proof-local';
  const core = await openCore({ ...options, root, space });
  const marker = `blue-copper-river-${Date.now()}`;

  const initialStatus = await core.status();
  const candidate = await core.write_candidate({
    title: 'agent-a-proof-memory',
    text: `Agent A proof memory marker ${marker}. Local-only citation and audit demo.`,
    sourceAgent: 'agent-a',
    metadata: {
      proof: 'ToC-1B',
      cloud: false,
      model: null,
    },
  });
  const promoted = await core.promote(candidate.path, {
    scope: 'proof',
    title: 'agent-a-proof-memory',
  });

  const agentB = await openCore({ ...options, root, space });
  const hits = await agentB.search(marker, { limit: 5 });
  if (hits.length === 0) throw new Error('proof_search_miss');
  const read = await agentB.read(hits[0].path);
  const finalStatus = await agentB.status();
  const audit = await latestAuditSummary(agentB.workspace.eventsDir);

  const result = {
    ok: true,
    cloud: 'disabled / local only',
    workspace: {
      root,
      space,
      path: agentB.workspace.spaceDir,
    },
    initialStatus: {
      provider: initialStatus.provider,
      index: initialStatus.index,
    },
    agentA: {
      candidate,
      promoted,
    },
    agentB: {
      query: marker,
      hit: hits[0],
      read: {
        path: read.path,
        citation: read.citation,
        containsMarker: read.content.includes(marker),
      },
    },
    audit,
    finalStatus: {
      provider: finalStatus.provider,
      index: finalStatus.index,
    },
  };

  if (!options.root && process.env.IHOW_MEMORY_KEEP_PROOF !== '1') {
    await fs.rm(root, { recursive: true, force: true });
  }
  return result;
}

// First-run opt-in prompt. Interactive: ask [y/N] (default N). Non-interactive (agent/CI):
// stay OFF, print one non-blocking hint. Asked once, then never again.
async function maybeAskTelemetry(): Promise<void> {
  if (await telemetry.hasAsked()) return;
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.log('(Want to help anonymously? Run `ihow-memory telemetry on` — usage only, never memory content.)');
    await telemetry.markAsked();
    return;
  }
  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question(
      '\nHelp us improve? (optional)\n  ✓ Reports only: when used · which runtime · version · error type\n  ✗ Never reports: your memory / files / projects — nothing\n  Turn off anytime: ihow-memory telemetry off\n  Share anonymous usage? [y/N] › ',
      (a) => resolve(a),
    );
  });
  rl.close();
  const yes = /^y(es)?$/i.test(answer.trim());
  await telemetry.setEnabled(yes);
  console.log(yes ? '✓ Enabled, thank you! (turn off anytime: `ihow-memory telemetry off`)' : 'Skipped — telemetry stays off.');
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const { command, options, rest } = parsed;
  if (command === 'help' || command === '--help' || command === '-h') {
    help();
    return;
  }

  if (command === '--version' || command === '-v' || command === 'version') {
    console.log(packageVersion());
    return;
  }

  if (command === 'init') {
    const workspace = await ensureWorkspace(resolveWorkspace(options));
    const runtimeDir = await installRuntimeBundle(workspace);
    const snippet = runtimeConfigSnippet(workspace, options.runtime);
    const result = {
      ok: true,
      workspace: {
        root: workspace.root,
        space: workspace.space,
        path: workspace.spaceDir,
        mode: workspace.mode,
        memoryRoot: workspace.memoryDir,
      },
      runtime: options.runtime || 'generic',
      runtimeDir,
      backupBeforeWrite: initBackupGuidance(options.runtime),
      mcpConfig: snippet,
    };
    if (options.json) printJson(result);
    else {
      console.log('cloud: disabled / local only');
      console.log(`initialized: ${workspace.spaceDir}`);
      console.log(`mode: ${workspace.mode}`);
      console.log(`memory root: ${workspace.memoryDir}`);
      console.log(`runtime bundle: ${runtimeDir}`);
      console.log(`backup first: ${result.backupBeforeWrite}`);
      printRuntimeSnippet(snippet, options.runtime);
    }
    return;
  }

  if (command === 'connect') {
    if (!options.runtime) {
      console.error('connect requires --runtime claude-code|codex|cursor');
      process.exitCode = 1;
      return;
    }
    const workspace = await ensureWorkspace(resolveWorkspace(options));
    if (!options.dryRun) await installRuntimeBundle(workspace); // dry-run: don't materialize the bundle
    const result = await connectRuntime(workspace, options.runtime, { dryRun: options.dryRun });
    if (options.json) printJson(result);
    else {
      console.log('cloud: disabled / local only');
      if (result.dryRun) {
        const where = result.method === 'direct-json'
          ? String(result.target)
          : `${result.method} (already present: ${result.alreadyExists})`;
        console.log(`[dry-run] would register mcpServers.ihow-memory via ${where}`);
      } else {
        console.log(`✓ connected ${runtimeLabel(options.runtime)} → iHow Memory`);
        console.log(`method: ${result.method}`);
        if (result.target) console.log(`target: ${result.target}`);
        if (result.backup) console.log(`backup: ${result.backup}`);
        if (result.replaced) console.log('(replaced an existing ihow-memory entry)');
        console.log(`Restart ${runtimeLabel(options.runtime)} to load the memory tools.`);
      }
    }
    if (!result.dryRun) {
      await telemetry.track('connect', { runtime: options.runtime });
      await maybeAskTelemetry();
    }
    return;
  }

  if (command === 'status') {
    const core = await openCore(options);
    const status = await core.status();
    if (options.json) printJson(status);
    else {
      console.log(`workspace: ${status.workspace.path}`);
      console.log(`space: ${status.workspace.space}`);
      console.log(`mode: ${status.workspace.mode}`);
      console.log(`memory root: ${status.workspace.memoryRoot}`);
      console.log(
        `provider: ${status.provider.id} (ready=${status.provider.ready}, cloud=${status.provider.cloud}, model=${status.provider.model})`,
      );
      if (status.provider.fallback) {
        console.log(`fallback: ${status.provider.fallbackFrom} -> fts (${status.provider.lastError})`);
      }
      console.log(`index: ${status.index.status}, documents=${status.index.documents}`);
      console.log(`index path: ${status.index.path}`);
      console.log(`sync: enabled=${status.sync.enabled}`);
    }
    return;
  }

  if (command === 'doctor') {
    const result = await doctor(options);
    const output = options.shareDiagnostics ? await diagnosticReport(result, options) : result;
    if (options.json || options.shareDiagnostics) printJson(output);
    else {
      console.log(`doctor: ${result.ok ? 'ok' : 'failed'}`);
      console.log('cloud: disabled / local only');
      for (const check of result.checks) {
        const label = check.ok ? 'ok' : check.required === false ? 'action' : 'fail';
        console.log(`- ${label} ${check.name}: ${check.detail}`);
        if (check.hint) console.log(`  hint: ${check.hint}`);
      }
    }
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === 'feedback') {
    const result = await doctor(options);
    const feedback = await feedbackTemplate(result, options);
    if (options.json) printJson(feedback);
    else {
      console.log('No issue was submitted. Review the redacted template, then open the URL yourself.');
      console.log('\nGitHub issue URL:');
      console.log(feedback.url);
      console.log('\nPrefilled issue body:');
      console.log(feedback.body);
    }
    return;
  }

  if (command === 'telemetry') {
    const sub = process.argv[3];
    if (sub === 'on') { await telemetry.setEnabled(true); console.log('✓ Anonymous telemetry enabled (records usage events locally only; not uploaded in this version; never includes memory content).'); return; }
    if (sub === 'off') { await telemetry.setEnabled(false); console.log('✓ Anonymous telemetry disabled.'); return; }
    const st = await telemetry.status();
    if (options.json) printJson(st);
    else {
      console.log(`telemetry: ${st.enabled ? 'on' : 'off (default)'}`);
      console.log(`collects: ${(st.collects as string[]).join(' · ')}`);
      console.log(`never collects: ${(st.neverCollects as string[]).join(' · ')}`);
      console.log(`endpoint: ${st.endpoint}`);
    }
    return;
  }

  if (command === 'reset') {
    const result = await resetSpace(options);
    if (options.json) printJson(result);
    else {
      console.log(`reset complete: ${(result.reset as Record<string, unknown>).space}`);
      console.log(`removed demo workspace: ${(result.reset as Record<string, unknown>).removed}`);
    }
    return;
  }

  if (command === 'proof') {
    const result = await runProof(options);
    if (options.json) printJson(result);
    else {
      console.log('iHow Memory 10-second proof');
      console.log('cloud: disabled / local only');
      console.log(`workspace: ${result.workspace.path}`);
      console.log(
        `agent A wrote candidate: ${(result.agentA as Record<string, Record<string, string>>).candidate.path}`,
      );
      console.log(`agent A promoted: ${(result.agentA as Record<string, Record<string, string>>).promoted.path}`);
      const hit = (result.agentB as Record<string, unknown>).hit as Record<string, unknown>;
      const citation = hit.citation as Record<string, unknown>;
      console.log(`agent B search hit: ${hit.path}`);
      console.log(`citation: ${citation.path}`);
      console.log(`source: ${hit.source}`);
      if (hit.fallback) {
        const fallback = hit.fallback as Record<string, unknown>;
        console.log(`fallback: ${fallback.from} -> ${fallback.to} (${fallback.reason})`);
      }
      console.log(`read contains marker: ${((result.agentB as Record<string, unknown>).read as Record<string, unknown>).containsMarker}`);
      const audit = result.audit as Record<string, unknown> | null;
      const event = audit?.event as Record<string, unknown> | undefined;
      console.log(`audit event: ${event?.type || 'missing'} ${event?.id || ''}`);
      console.log('PASS proof: A write -> promote -> B search/read with citation and audit');
    }
    return;
  }

  if (command === 'console') {
    const { createConsoleServer } = await import('./http/console.ts');
    const argv = process.argv.slice(2);
    const hostIdx = argv.indexOf('--host');
    const portIdx = argv.indexOf('--port');
    const host = hostIdx >= 0 && argv[hostIdx + 1] ? argv[hostIdx + 1] : '127.0.0.1';
    const port = portIdx >= 0 && argv[portIdx + 1] ? Number(argv[portIdx + 1]) : 8788;
    const server = await createConsoleServer(options);
    server.listen(port, host, () => {
      console.log('cloud: disabled / local only');
      console.log(`iHow Memory console (read-only): http://${host}:${port}`);
      console.log('Open the URL in a browser. Ctrl+C to stop.');
    });
    return;
  }

  const core = await openCore(options);
  if (command === 'reindex') {
    const documents = await core.rebuild();
    const status = await core.status();
    const result = { ok: true, documents, index: status.index };
    if (options.json) printJson(result);
    else {
      console.log(`reindexed: documents=${documents}`);
      console.log(`index: ${status.index.path}`);
    }
    return;
  }
  if (command === 'search') {
    const query = rest.join(' ');
    printJson(await core.search(query, { limit: options.limit }));
    return;
  }
  if (command === 'read') {
    printJson(await core.read(rest[0]));
    return;
  }
  if (command === 'write-candidate') {
    printJson(await core.write_candidate({ text: rest.join(' '), sourceAgent: 'cli' }));
    return;
  }
  if (command === 'promote') {
    const candidate = rest[0];
    const target: Record<string, string> = {};
    for (let index = 1; index < rest.length; index += 1) {
      if (rest[index] === '--scope') target.scope = rest[++index];
      else if (rest[index] === '--title') target.title = rest[++index];
    }
    printJson(await core.promote(candidate, target));
    return;
  }
  if (command === 'durable-promote') {
    const candidate = rest[0];
    const target: Record<string, string> = {};
    for (let index = 1; index < rest.length; index += 1) {
      if (rest[index] === '--scope') target.scope = rest[++index];
      else if (rest[index] === '--title') target.title = rest[++index];
      else if (rest[index] === '--path') target.path = rest[++index];
    }
    printJson(
      await core.durable_promote(candidate, {
        dryRun: options.dryRun,
        realWrite: options.realWrite,
        actor: options.actor || 'cli',
        target,
      }),
    );
    return;
  }

  help();
  process.exitCode = 1;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'reset_requires_space') {
    console.error('reset requires an explicit demo space: ihow-memory reset --space <id> [--root <dir>]');
  } else if (message === 'reset_managed_space_only_pass_root_and_space') {
    console.error('reset only removes managed demo spaces. Use --root and --space; existing --memory-root data is never deleted.');
  } else if (message === 'unsupported_runtime_use_claude-code_codex_or_cursor') {
    console.error('unsupported runtime. Use --runtime claude-code, --runtime codex, or --runtime cursor.');
  } else if (message.startsWith('sqlite_unavailable:')) {
    console.error('SQLite is unavailable. Install Node >= 22.12 with node:sqlite support, then rerun ihow-memory doctor.');
  } else {
    console.error(friendlyError(error));
  }
  process.exitCode = 1;
});
