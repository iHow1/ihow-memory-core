// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Workspace } from './types.ts';

export const OMP_EXTENSION_OWNER = 'ihow-memory-v1';
const OMP_EXTENSION_MARKER = "const OMP_EXTENSION_OWNER = 'ihow-memory-v1'";

type OmpExtensionConfig = {
  schemaVersion: 1;
  managedBy: typeof OMP_EXTENSION_OWNER;
  command: string;
  cli: string;
  memoryRoot: string;
  stateRoot: string;
  space: string;
};

export type OmpWiring = {
  runtime: 'omp';
  state: 'current' | 'absent' | 'broken';
  managedPresent: boolean;
  generationId?: string;
  configPath?: string;
  notes: string[];
};

export type OmpInstallOutcome = 'installed' | 'already' | 'failed';

export function ompAgentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.omp', 'agent');
}

export function ompExtensionsDir(): string {
  return path.join(ompAgentDir(), 'extensions');
}

export function ompExtensionInstallPath(): string {
  return path.join(ompExtensionsDir(), 'ihow-memory.js');
}

export function ompExtensionConfigPath(): string {
  return path.join(ompAgentDir(), 'ihow-memory.json');
}

export function ompMcpConfigPath(): string {
  return path.join(ompAgentDir(), 'mcp.json');
}

export function ompRuntimeExtensionPath(workspace: Workspace): string {
  return path.join(workspace.spaceDir, '.runtime', 'omp-extension.js');
}

function desiredConfig(workspace: Workspace): OmpExtensionConfig {
  return {
    schemaVersion: 1,
    managedBy: OMP_EXTENSION_OWNER,
    command: process.execPath,
    cli: path.join(workspace.spaceDir, '.runtime', 'cli.js'),
    memoryRoot: workspace.memoryDir,
    stateRoot: workspace.root,
    space: workspace.space,
  };
}

function canonical(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function configTargetsForeignWorkspace(value: unknown, wanted: OmpExtensionConfig): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const parsed = value as Partial<OmpExtensionConfig>;
  if (parsed.managedBy !== OMP_EXTENSION_OWNER || typeof parsed.cli !== 'string') return false;
  // The frozen CLI is the workspace identity. A different CLI belongs to another valid OMP
  // workspace and must not make this workspace's doctor red. If the CLI matches, any other drift is
  // relevant damage and is classified as broken below.
  return path.resolve(parsed.cli) !== path.resolve(wanted.cli);
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

async function executable(file: string): Promise<boolean> {
  try {
    await fs.access(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function atomicWrite(file: string, content: string, mode?: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.ihow-tmp-${process.pid}-${crypto.randomUUID()}`;
  await fs.writeFile(temp, content, { encoding: 'utf8', ...(mode ? { mode } : {}) });
  await fs.rename(temp, file);
  if (mode) await fs.chmod(file, mode).catch(() => {});
}

export async function installOmpExtensionWiring(workspace: Workspace): Promise<OmpInstallOutcome> {
  const source = ompRuntimeExtensionPath(workspace);
  const destination = ompExtensionInstallPath();
  const configPath = ompExtensionConfigPath();
  const [sourceContent, existingExtension, existingConfig] = await Promise.all([
    readText(source),
    readText(destination),
    readText(configPath),
  ]);
  if (!sourceContent || !sourceContent.includes(OMP_EXTENSION_MARKER)) return 'failed';
  if (existingExtension && !existingExtension.includes(OMP_EXTENSION_MARKER)) return 'failed';
  if (existingConfig) {
    try {
      const parsed = JSON.parse(existingConfig) as { managedBy?: unknown };
      if (parsed.managedBy !== OMP_EXTENSION_OWNER) return 'failed';
    } catch {
      return 'failed';
    }
  }
  const wantedConfig = canonical(desiredConfig(workspace));
  if (existingExtension === sourceContent && existingConfig === wantedConfig) return 'already';
  try {
    if (existingExtension && existingExtension !== sourceContent) {
      await fs.copyFile(destination, `${destination}.ihow-bak-${Date.now()}`);
    }
    if (existingConfig && existingConfig !== wantedConfig) {
      await fs.copyFile(configPath, `${configPath}.ihow-bak-${Date.now()}`);
    }
    await atomicWrite(destination, sourceContent, 0o644);
    await atomicWrite(configPath, wantedConfig, 0o600);
    return 'installed';
  } catch {
    return 'failed';
  }
}

export async function verifyOmpExtensionWiring(workspace: Workspace): Promise<OmpWiring> {
  const destination = ompExtensionInstallPath();
  const configPath = ompExtensionConfigPath();
  const source = ompRuntimeExtensionPath(workspace);
  const wanted = desiredConfig(workspace);
  const [sourceContent, installedContent, configContent] = await Promise.all([
    readText(source),
    readText(destination),
    readText(configPath),
  ]);
  if (!installedContent && !configContent) {
    return { runtime: 'omp', state: 'absent', managedPresent: false, notes: [] };
  }
  const managedPresent = installedContent?.includes(OMP_EXTENSION_MARKER) === true
    || configContent?.includes(OMP_EXTENSION_OWNER) === true;
  let parsed: unknown;
  if (configContent) {
    try {
      parsed = JSON.parse(configContent);
    } catch {
      return { runtime: 'omp', state: 'broken', managedPresent, configPath, notes: ['managed OMP config is not valid JSON'] };
    }
    if (configTargetsForeignWorkspace(parsed, wanted)) {
      return { runtime: 'omp', state: 'absent', managedPresent: false, notes: [] };
    }
  }
  if (!sourceContent || !installedContent || !configContent) {
    return {
      runtime: 'omp', state: 'broken', managedPresent, configPath,
      notes: ['managed OMP extension, config, or frozen runtime source is missing'],
    };
  }
  if (!installedContent.includes(OMP_EXTENSION_MARKER) || installedContent !== sourceContent) {
    return {
      runtime: 'omp', state: 'broken', managedPresent, configPath,
      notes: ['managed OMP extension does not match the current frozen runtime generation'],
    };
  }
  if (canonical(parsed) !== canonical(wanted)) {
    return {
      runtime: 'omp', state: 'broken', managedPresent, configPath,
      notes: ['managed OMP config does not match the current workspace binding'],
    };
  }
  if (!(await executable(wanted.command)) || !(await executable(wanted.cli))) {
    return {
      runtime: 'omp', state: 'broken', managedPresent, configPath,
      notes: ['managed OMP command or frozen CLI is missing or not executable'],
    };
  }
  const generationId = hash(JSON.stringify({ extension: hash(installedContent), config: wanted }));
  return { runtime: 'omp', state: 'current', managedPresent: true, generationId, configPath, notes: [] };
}
