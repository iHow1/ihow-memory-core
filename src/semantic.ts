// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Opt-in semantic engine wiring (alpha.18). Turning semantic ON is a per-space, EXPLICIT, REVERSIBLE
// choice persisted to <spaceDir>/.runtime/semantic.json. The DEFAULT install stays zero-dependency
// lexical FTS5 with capabilities.semantic=false; nothing in this module runs unless the user opts in,
// and the semantic lane is ADDITIVE — if the local Ollama sidecar is down, search transparently falls
// back to the FTS floor (see searchWithEngineFallback), so semantic is never load-bearing for
// availability. The sidecar is the SPAWNED subprocess bundled at dist/providers/ (see provider-path.ts);
// it is never imported into the default graph.
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Workspace, WorkspaceOptions } from './types.ts';
import { BUNDLED_PROVIDERS, providerScriptPath } from './provider-path.ts';

export const DEFAULT_OLLAMA_HOST = 'http://localhost:11434';
export const DEFAULT_EMBED_MODEL = 'nomic-embed-text';
const DEFAULT_TIMEOUT_MS = 20000;

export type SemanticConfig = {
  engine: 'vector';
  vectorProviderCommand: string;
  vectorModel: string;
  host: string;
  vectorTimeoutMs: number;
  enabledAt?: string;
};

export function semanticConfigPath(workspace: Workspace): string {
  return path.join(workspace.spaceDir, '.runtime', 'semantic.json');
}

// Tokenize a provider command the SAME way the engine does (splitCommand) so validation sees the exact
// argv that would be spawned — quotes respected.
function tokenizeCommand(cmd: string): string[] {
  return (cmd.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || []).map((t) => t.replace(/^["']|["']$/g, ''));
}

// A persisted marker is only honored if its command is EXACTLY `<node> <bundled-sidecar>` — never an
// arbitrary executable. The engine spawns vectorProviderCommand[0], so a substring check is not enough:
// `/bin/echo /tmp/providers/ollama-embedding-provider.mjs` contains the magic name but spawns /bin/echo
// (red-team r-alpha18-2). We parse argv and require: exactly two tokens, the FIRST is a node binary, and
// the SECOND resolves to a bundled provider file under a `providers/` dir. No wrapper exe, no extra args.
function isBundledProviderCommand(cmd: string): boolean {
  if (/[;&|`]|\$\(/.test(cmd)) return false;
  const argv = tokenizeCommand(cmd);
  if (argv.length !== 2) return false;
  const exe = (argv[0].split(/[\\/]/).pop() || '').toLowerCase();
  if (exe !== 'node' && exe !== 'node.exe') return false;
  const script = argv[1].replace(/\\/g, '/');
  const base = script.slice(script.lastIndexOf('/') + 1);
  const dir = script.slice(0, script.lastIndexOf('/'));
  const parentBase = dir.slice(dir.lastIndexOf('/') + 1);
  return parentBase === 'providers' && (BUNDLED_PROVIDERS as readonly string[]).includes(base);
}

function coerce(raw: string): SemanticConfig | null {
  try {
    const cfg = JSON.parse(raw);
    if (
      cfg &&
      cfg.engine === 'vector' &&
      typeof cfg.vectorProviderCommand === 'string' &&
      cfg.vectorProviderCommand.trim() &&
      isBundledProviderCommand(cfg.vectorProviderCommand)
    ) {
      return {
        engine: 'vector',
        vectorProviderCommand: cfg.vectorProviderCommand,
        vectorModel: typeof cfg.vectorModel === 'string' && cfg.vectorModel ? cfg.vectorModel : DEFAULT_EMBED_MODEL,
        host: typeof cfg.host === 'string' && cfg.host ? cfg.host : DEFAULT_OLLAMA_HOST,
        vectorTimeoutMs: Number.isFinite(cfg.vectorTimeoutMs) ? cfg.vectorTimeoutMs : DEFAULT_TIMEOUT_MS,
        enabledAt: typeof cfg.enabledAt === 'string' ? cfg.enabledAt : undefined,
      };
    }
  } catch {
    /* unreadable / not JSON -> treat as not enabled */
  }
  return null;
}

export async function loadSemanticConfig(workspace: Workspace): Promise<SemanticConfig | null> {
  try {
    return coerce(await fs.readFile(semanticConfigPath(workspace), 'utf8'));
  } catch {
    return null; // not enabled
  }
}

// Sync variant for mcpServerSpec (a sync function called on the connect/setup/doctor paths).
export function loadSemanticConfigSync(workspace: Workspace): SemanticConfig | null {
  try {
    return coerce(readFileSync(semanticConfigPath(workspace), 'utf8'));
  } catch {
    return null;
  }
}

export async function writeSemanticConfig(workspace: Workspace, cfg: SemanticConfig): Promise<string> {
  const target = semanticConfigPath(workspace);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  return target;
}

// The extra MCP-server CLI flags that turn on the additive vector lane for a semantic-enabled space.
// Empty array when semantic is OFF — so the default server is the zero-dependency FTS5 binary. Used by
// mcpServerSpec; factored out so the injection is unit-testable without spinning up the whole CLI.
export function semanticEngineArgs(workspace: Workspace): string[] {
  const cfg = loadSemanticConfigSync(workspace);
  if (!cfg) return [];
  // --vector-host carries the CONFIGURED host so the server can export OLLAMA_HOST for the spawned
  // sidecar — deterministic propagation, so the runtime sidecar talks to the SAME host enable-semantic
  // probed (no recorded-but-unpropagated host → no configured-healthy-but-runtime-degraded split).
  return [
    '--engine', 'vector',
    '--vector-provider-command', cfg.vectorProviderCommand,
    '--vector-model', cfg.vectorModel,
    '--vector-timeout-ms', String(cfg.vectorTimeoutMs),
    '--vector-host', cfg.host,
  ];
}

// Merge the persisted semantic engine config into CLI options so a one-shot command (status/doctor)
// evaluates the SAME effective engine the connected MCP server runs — otherwise it would always report
// the default FTS engine even when semantic is enabled (a false-green-adjacent split). SIDE EFFECT: sets
// process.env.OLLAMA_HOST to the configured host so the spawned sidecar's readiness probe hits the right
// daemon. No-op when semantic is off.
export function applySemanticEngine<T extends WorkspaceOptions>(workspace: Workspace, options: T): T {
  const cfg = loadSemanticConfigSync(workspace);
  if (!cfg) return options;
  process.env.OLLAMA_HOST = cfg.host;
  return {
    ...options,
    engine: 'vector',
    vectorProviderCommand: cfg.vectorProviderCommand,
    vectorModel: cfg.vectorModel,
    vectorTimeoutMs: cfg.vectorTimeoutMs,
  };
}

export async function removeSemanticConfig(workspace: Workspace): Promise<boolean> {
  try {
    await fs.rm(semanticConfigPath(workspace));
    return true;
  } catch {
    return false; // already off
  }
}

function quote(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

// Build the semantic engine config that points at the BUNDLED Ollama sidecar (a spawned subprocess).
// The provider reads OLLAMA_HOST / OLLAMA_EMBED_MODEL from env at spawn time; we also record host/model
// here so status, doctor and disable can reason about (and reverse) the exact configuration.
export function buildSemanticConfig(
  opts: { host?: string; model?: string; timeoutMs?: number; nodePath?: string; enabledAt?: string } = {},
): SemanticConfig {
  const node = opts.nodePath || process.execPath;
  return {
    engine: 'vector',
    vectorProviderCommand: `${quote(node)} ${quote(providerScriptPath())}`,
    vectorModel: opts.model || DEFAULT_EMBED_MODEL,
    host: opts.host || DEFAULT_OLLAMA_HOST,
    vectorTimeoutMs: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
    enabledAt: opts.enabledAt,
  };
}

// Probe a local Ollama daemon. Two steps, because /api/tags is NOT proof of embeddability — a non-Ollama
// server (or a stub) can return 200 with the model name and still have no working /api/embeddings (red-team
// r-alpha18 blocker). The REAL gate is `canEmbed`: an actual POST /api/embeddings that returns a non-empty
// numeric vector for the selected model. `hasModel` (from /api/tags) is kept only for better diagnostics.
// Never throws — an unreachable daemon is a normal, reportable state.
export async function detectOllama(
  opts: { host?: string; model?: string; timeoutMs?: number } = {},
): Promise<{
  reachable: boolean;
  host: string;
  model: string;
  models: string[];
  hasModel: boolean;
  canEmbed: boolean;
  dims?: number;
  error?: string;
}> {
  const host = (opts.host || DEFAULT_OLLAMA_HOST).replace(/\/+$/, '');
  const model = opts.model || DEFAULT_EMBED_MODEL;

  // Step 1 — reachability + tag list (for clearer error messages only).
  let reachable = false;
  let models: string[] = [];
  let hasModel = false;
  {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || 4000);
    try {
      const res = await fetch(`${host}/api/tags`, { signal: ctrl.signal });
      if (!res.ok) return { reachable: false, host, model, models: [], hasModel: false, canEmbed: false, error: `tags_http_${res.status}` };
      reachable = true;
      const json = (await res.json()) as { models?: Array<{ name?: unknown }> };
      models = Array.isArray(json?.models) ? json.models.map((m) => String(m?.name || '')).filter(Boolean) : [];
      hasModel = models.some((m) => m === model || m.startsWith(`${model}:`));
    } catch (err) {
      return { reachable: false, host, model, models: [], hasModel: false, canEmbed: false, error: (err as Error).message };
    } finally {
      clearTimeout(timer);
    }
  }

  // Step 2 — the REAL gate: a genuine embedding call against the selected model.
  {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || 8000);
    try {
      const res = await fetch(`${host}/api/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, prompt: 'ihow-memory enable-semantic probe' }),
        signal: ctrl.signal,
      });
      if (!res.ok) return { reachable, host, model, models, hasModel, canEmbed: false, error: `embeddings_http_${res.status}` };
      const json = (await res.json()) as { embedding?: unknown };
      const vec = json?.embedding;
      const ok = Array.isArray(vec) && vec.length > 0 && vec.every((n) => typeof n === 'number' && Number.isFinite(n));
      if (!ok) return { reachable, host, model, models, hasModel, canEmbed: false, error: 'empty_or_non_numeric_embedding' };
      return { reachable, host, model, models, hasModel, canEmbed: true, dims: (vec as number[]).length };
    } catch (err) {
      return { reachable, host, model, models, hasModel, canEmbed: false, error: (err as Error).message };
    } finally {
      clearTimeout(timer);
    }
  }
}
