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

const REQUIRED_FILES = ['plugin.yaml', '__init__.py', 'hermes-bridge.js'] as const;

function sha(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function readEnabled(home: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(home, 'config.yaml'), 'utf8');
  } catch {
    return false;
  }
  const enabledBlock = raw.match(/(?:^|\n)plugins\s*:\s*\n([\s\S]*?)(?=\n\S|$)/)?.[1] ?? '';
  const enabledList = enabledBlock.match(/(?:^|\n)\s+enabled\s*:\s*\n([\s\S]*?)(?=\n\s{0,2}\S|$)/)?.[1] ?? '';
  return /(?:^|\n)\s*-\s*ihow-memory\s*(?:#.*)?(?:\n|$)/.test(enabledList);
}

export async function hermesLifecycleConfigurationKey(home: string): Promise<string> {
  const pluginDir = path.join(path.resolve(home), 'plugins', 'ihow-memory');
  const parts: string[] = [];
  for (const file of REQUIRED_FILES) {
    const content = await fs.readFile(path.join(pluginDir, file));
    parts.push(`${file}\0${sha(content)}`);
  }
  return sha(parts.join('\n'));
}

export async function inspectHermesLifecycleWiring(home: string): Promise<HermesLifecycleWiring> {
  const pluginDir = path.join(path.resolve(home), 'plugins', 'ihow-memory');
  try {
    const stat = await fs.stat(pluginDir);
    if (!stat.isDirectory()) return { state: 'broken', reason: 'plugin-not-directory' };
  } catch {
    return { state: 'missing' };
  }
  for (const file of REQUIRED_FILES) {
    try {
      const stat = await fs.stat(path.join(pluginDir, file));
      if (!stat.isFile()) return { state: 'broken', reason: `missing-${file}` };
    } catch {
      return { state: 'broken', reason: `missing-${file}` };
    }
  }
  if (!await readEnabled(home)) return { state: 'broken', reason: 'not-enabled' };
  try {
    return { state: 'current', generationId: await hermesLifecycleConfigurationKey(home) };
  } catch {
    return { state: 'broken', reason: 'generation-unreadable' };
  }
}

export function resolveHermesHome(explicit?: string): string | undefined {
  const raw = explicit?.trim() || process.env.HERMES_HOME?.trim();
  return raw ? path.resolve(raw) : undefined;
}
