// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export type HermesLifecycleWiring = {
  state: 'current' | 'missing' | 'broken';
  generationId?: string;
  reason?: string;
};

export type HermesBridgeConfiguration = {
  schemaVersion: 1;
  node: string;
  bridge: string;
  memoryRoot: string;
  stateRoot: string;
};

const LIFECYCLE_FILES = ['plugin.yaml', '__init__.py'] as const;
const COMPACTION_FILES = ['plugin.yaml', '__init__.py', 'provider.py'] as const;
const BRIDGE_KEYS = ['bridge', 'memoryRoot', 'node', 'schemaVersion', 'stateRoot'] as const;

function sha(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function cleanYamlScalar(value: string): string {
  const trimmed = value.trim().replace(/\s+#.*$/, '').trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  return trimmed;
}

function splitYamlFlowMapping(body: string): string[] {
  const items: string[] = [];
  let current = '';
  let quote = '';
  let depth = 0;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (quote) {
      current += char;
      if (char === quote && (quote === "'" || body[index - 1] !== '\\')) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '{' || char === '[') {
      depth += 1;
      current += char;
      continue;
    }
    if (char === '}' || char === ']') {
      if (depth === 0) throw new Error('hermes_memory_provider_config_invalid');
      depth -= 1;
      current += char;
      continue;
    }
    if (char === ',' && depth === 0) {
      items.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (quote || depth !== 0) throw new Error('hermes_memory_provider_config_invalid');
  items.push(current);
  return items;
}

function yamlFlowEntry(item: string): { key: string; value: string } {
  let quote = '';
  let depth = 0;
  for (let index = 0; index < item.length; index += 1) {
    const char = item[index];
    if (quote) {
      if (char === quote && (quote === "'" || item[index - 1] !== '\\')) quote = '';
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '{' || char === '[') { depth += 1; continue; }
    if (char === '}' || char === ']') { depth -= 1; continue; }
    if (char === ':' && depth === 0) {
      return { key: cleanYamlScalar(item.slice(0, index)), value: item.slice(index + 1).trim() };
    }
  }
  throw new Error('hermes_memory_provider_config_invalid');
}

function normalizedHermesProvider(value: string): string | null {
  const normalized = cleanYamlScalar(value);
  if (!normalized || ['built-in', 'builtin', 'none', 'null', '~'].includes(normalized.toLowerCase())) return null;
  if (!/^[A-Za-z0-9_.-]+$/.test(normalized)) throw new Error('hermes_memory_provider_config_invalid');
  return normalized;
}

async function readHermesConfig(home: string): Promise<string> {
  try {
    return await fs.readFile(path.join(home, 'config.yaml'), 'utf8');
  } catch {
    return '';
  }
}

export async function readHermesMemoryProvider(home: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(home, 'config.yaml'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }

  try {
    const parsed = JSON.parse(raw) as { memory?: { provider?: unknown } };
    const value = parsed?.memory?.provider;
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string') throw new Error('hermes_memory_provider_config_invalid');
    return normalizedHermesProvider(value);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }

  const lines = raw.split(/\r?\n/);
  const sections: Array<{ index: number; inline: string }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(?:memory|"memory"|'memory')\s*:\s*(.*?)\s*$/.exec(lines[index]);
    if (match) sections.push({ index, inline: match[1] });
  }
  if (sections.length === 0) return null;
  if (sections.length !== 1) throw new Error('hermes_memory_provider_config_ambiguous');

  const inline = sections[0].inline.replace(/\s+#.*$/, '').trim();
  if (inline) {
    if (['null', '~'].includes(inline.toLowerCase())) return null;
    if (!inline.startsWith('{') || !inline.endsWith('}')) throw new Error('hermes_memory_provider_config_invalid');
    const body = inline.slice(1, -1).trim();
    if (!body) return null;
    const providers = splitYamlFlowMapping(body)
      .map(yamlFlowEntry)
      .filter(entry => entry.key === 'provider');
    if (providers.length === 0) return null;
    if (providers.length !== 1) throw new Error('hermes_memory_provider_config_ambiguous');
    return normalizedHermesProvider(providers[0].value);
  }

  const start = sections[0].index + 1;
  let end = lines.length;
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (!/^\s/.test(line)) { end = index; break; }
  }
  const body = lines.slice(start, end).filter(line => line.trim() && !/^\s*#/.test(line));
  if (body.length === 0) return null;
  const directIndent = Math.min(...body.map(line => line.match(/^\s*/)?.[0].length ?? 0));
  const providers = body.filter(line =>
    (line.match(/^\s*/)?.[0].length ?? 0) === directIndent &&
    /^\s*(?:provider|"provider"|'provider')\s*:/.test(line));
  if (providers.length === 0) return null;
  if (providers.length !== 1) throw new Error('hermes_memory_provider_config_ambiguous');
  return normalizedHermesProvider(
    providers[0].replace(/^\s*(?:provider|"provider"|'provider')\s*:\s*/, ''),
  );
}

function yamlBlock(raw: string, key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return raw.match(new RegExp(`(?:^|\\n)${escaped}\\s*:\\s*\\n([\\s\\S]*?)(?=\\n\\S|$)`))?.[1] ?? '';
}

function yamlList(block: string, key: string): string[] {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = block.match(new RegExp(`(?:^|\\n)\\s+${escaped}\\s*:\\s*\\n([\\s\\S]*?)(?=\\n\\s{0,2}\\S|$)`))?.[1] ?? '';
  return body.split(/\r?\n/)
    .map(line => line.match(/^\s*-\s*(.*?)\s*$/)?.[1])
    .filter((value): value is string => typeof value === 'string')
    .map(cleanYamlScalar);
}

function lifecycleEnabled(raw: string): boolean {
  const plugins = yamlBlock(raw, 'plugins');
  const enabled = new Set(yamlList(plugins, 'enabled'));
  const disabled = new Set(yamlList(plugins, 'disabled'));
  return enabled.has('ihow-memory') && !disabled.has('ihow-memory');
}

function compactionSelected(raw: string): boolean {
  const memory = yamlBlock(raw, 'memory');
  const provider = memory.match(/(?:^|\n)\s+provider\s*:\s*([^\n]*)/)?.[1];
  return provider !== undefined && cleanYamlScalar(provider) === 'ihow-memory-compaction';
}

function bridgeConfiguration(value: unknown): HermesBridgeConfiguration | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join('\0') !== [...BRIDGE_KEYS].sort().join('\0') ||
      record.schemaVersion !== 1) return null;
  for (const key of ['node', 'bridge', 'memoryRoot', 'stateRoot'] as const) {
    const field = record[key];
    if (typeof field !== 'string' || !field || !path.isAbsolute(field) || /[\0\r\n]/.test(field)) return null;
  }
  return record as HermesBridgeConfiguration;
}

async function readInstalledBridge(pluginDir: string): Promise<{
  config: HermesBridgeConfiguration;
  raw: Buffer;
} | null> {
  let raw: Buffer;
  try {
    raw = await fs.readFile(path.join(pluginDir, 'bridge.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error('bridge-config-invalid');
  }
  const config = bridgeConfiguration(parsed);
  if (!config) throw new Error('bridge-config-invalid');
  return { config, raw };
}

async function regularFile(target: string, executable = false): Promise<boolean> {
  try {
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) return false;
    if (executable) await fs.access(target, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function directory(target: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(target);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

async function frozenRuntimeValid(config: HermesBridgeConfiguration): Promise<boolean> {
  if (!await regularFile(config.node, true) || !await regularFile(config.bridge) ||
      !await directory(config.memoryRoot) || !await directory(config.stateRoot)) return false;
  const runtime = path.dirname(config.bridge);
  let manifest: { type?: unknown; integrity?: { files?: unknown } };
  try {
    manifest = JSON.parse(await fs.readFile(path.join(runtime, 'package.json'), 'utf8'));
  } catch {
    return false;
  }
  const files = manifest.integrity?.files;
  if (manifest.type !== 'module' || !files || typeof files !== 'object' || Array.isArray(files) ||
      Object.keys(files).length === 0) return false;
  for (const [relative, expected] of Object.entries(files as Record<string, unknown>)) {
    if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected) || path.isAbsolute(relative)) return false;
    const normalized = path.normalize(relative);
    if (normalized === '..' || normalized.startsWith(`..${path.sep}`) || normalized.split(path.sep).join('/') !== relative) return false;
    const target = path.join(runtime, normalized);
    if (!await regularFile(target) || sha(await fs.readFile(target)) !== expected) return false;
  }
  return (files as Record<string, unknown>)['hermes-bridge.js'] === sha(await fs.readFile(config.bridge));
}

async function executableOnPath(command: string): Promise<string | null> {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const target = path.join(directory, command);
    if (await regularFile(target, true)) return target;
  }
  return null;
}

async function inspectAdapter(
  home: string,
  name: string,
  required: readonly string[],
  selected: (config: string) => boolean,
  notSelectedReason: string,
): Promise<HermesLifecycleWiring> {
  const pluginDir = path.join(path.resolve(home), 'plugins', name);
  try {
    const stat = await fs.lstat(pluginDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return { state: 'broken', reason: 'plugin-not-directory' };
  } catch {
    return { state: 'missing' };
  }
  const parts: string[] = [];
  for (const file of required) {
    const target = path.join(pluginDir, file);
    if (!await regularFile(target)) return { state: 'broken', reason: `missing-${file}` };
    parts.push(`${file}\0${sha(await fs.readFile(target))}`);
  }
  if (!selected(await readHermesConfig(home))) return { state: 'broken', reason: notSelectedReason };

  const configuredOverride = process.env.IHOW_MEMORY_HERMES_BRIDGE?.trim();
  if (configuredOverride) {
    const bridge = path.resolve(configuredOverride);
    if (!await regularFile(bridge)) return { state: 'broken', reason: 'bridge-override-invalid' };
    parts.push(`bridge-override\0${sha(await fs.readFile(bridge))}`);
  } else {
    let installed: Awaited<ReturnType<typeof readInstalledBridge>>;
    try {
      installed = await readInstalledBridge(pluginDir);
    } catch (error) {
      return { state: 'broken', reason: (error as Error).message || 'bridge-config-invalid' };
    }
    if (installed) {
      if (!await frozenRuntimeValid(installed.config)) return { state: 'broken', reason: 'runtime-bundle-invalid' };
      parts.push(`bridge-config\0${sha(installed.raw)}`);
      parts.push(`runtime-bridge\0${sha(await fs.readFile(installed.config.bridge))}`);
    } else {
      const legacy = await executableOnPath('ihow-memory-hermes-bridge');
      if (!legacy) return { state: 'broken', reason: 'bridge-command-missing' };
      parts.push(`legacy-bridge-command\0${sha(await fs.readFile(legacy))}`);
    }
  }
  return { state: 'current', generationId: sha(parts.join('\n')) };
}

export async function hermesLifecycleConfigurationKey(home: string): Promise<string> {
  const wiring = await inspectHermesLifecycleWiring(home);
  if (wiring.state !== 'current' || !wiring.generationId) throw new Error(wiring.reason || 'hermes-lifecycle-wiring-not-current');
  return wiring.generationId;
}

export async function inspectHermesLifecycleWiring(home: string): Promise<HermesLifecycleWiring> {
  return inspectAdapter(home, 'ihow-memory', LIFECYCLE_FILES, lifecycleEnabled, 'not-enabled');
}

export async function inspectHermesCompactionWiring(home: string): Promise<HermesLifecycleWiring> {
  return inspectAdapter(
    home,
    'ihow-memory-compaction',
    COMPACTION_FILES,
    compactionSelected,
    'provider-not-selected',
  );
}

export async function inspectHermesInstallationWiring(home: string): Promise<HermesLifecycleWiring> {
  const [lifecycle, compaction] = await Promise.all([
    inspectHermesLifecycleWiring(home),
    inspectHermesCompactionWiring(home),
  ]);
  if (lifecycle.state === 'missing' && compaction.state === 'missing') return { state: 'missing' };
  if (lifecycle.state !== 'current' || !lifecycle.generationId) {
    return {
      state: 'broken',
      reason: `lifecycle-${lifecycle.reason || lifecycle.state}`,
    };
  }
  if (compaction.state !== 'current' || !compaction.generationId) {
    return {
      state: 'broken',
      reason: `compaction-${compaction.reason || compaction.state}`,
    };
  }
  return {
    state: 'current',
    generationId: sha([
      `lifecycle\0${lifecycle.generationId}`,
      `compaction\0${compaction.generationId}`,
    ].join('\n')),
  };
}

export function resolveHermesHome(explicit?: string): string | undefined {
  const raw = explicit?.trim() || process.env.HERMES_HOME?.trim();
  return raw ? path.resolve(raw) : undefined;
}