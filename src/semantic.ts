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
import type { Workspace } from './types.ts';
import { providerScriptPath } from './provider-path.ts';

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

function coerce(raw: string): SemanticConfig | null {
  try {
    const cfg = JSON.parse(raw);
    if (
      cfg &&
      cfg.engine === 'vector' &&
      typeof cfg.vectorProviderCommand === 'string' &&
      cfg.vectorProviderCommand.trim()
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
  return [
    '--engine', 'vector',
    '--vector-provider-command', cfg.vectorProviderCommand,
    '--vector-model', cfg.vectorModel,
    '--vector-timeout-ms', String(cfg.vectorTimeoutMs),
  ];
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

// Probe a local Ollama daemon: GET <host>/api/tags. Returns reachability + whether the embed model is
// already pulled. Never throws — an unreachable daemon is a normal (reportable) state, not an error.
export async function detectOllama(
  opts: { host?: string; model?: string; timeoutMs?: number } = {},
): Promise<{ reachable: boolean; host: string; model: string; models: string[]; hasModel: boolean; error?: string }> {
  const host = opts.host || DEFAULT_OLLAMA_HOST;
  const model = opts.model || DEFAULT_EMBED_MODEL;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || 4000);
  try {
    const res = await fetch(`${host.replace(/\/+$/, '')}/api/tags`, { signal: ctrl.signal });
    if (!res.ok) return { reachable: false, host, model, models: [], hasModel: false, error: `http_${res.status}` };
    const json = (await res.json()) as { models?: Array<{ name?: unknown }> };
    const models = Array.isArray(json?.models)
      ? json.models.map((m) => String(m?.name || '')).filter(Boolean)
      : [];
    // Ollama tags look like "nomic-embed-text:latest" — match the base name or an explicit tag.
    const hasModel = models.some((m) => m === model || m.startsWith(`${model}:`));
    return { reachable: true, host, model, models, hasModel };
  } catch (err) {
    return { reachable: false, host, model, models: [], hasModel: false, error: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}
