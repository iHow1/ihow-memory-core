// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import fs from 'node:fs/promises';
import type { Workspace } from '../types.ts';

export type ProviderManifest = {
  providerId: string;
  modelId: string | null;
  dims: number | null;
  createdAt: string;
  updatedAt?: string;
  corpusFingerprint: string | null;
  status: 'ready' | 'missing' | 'stale' | 'fallback' | 'error';
  ready?: boolean;
  cloud?: boolean;
  activeProviderId?: string;
  fallbackFrom?: string;
  fallbackTo?: string;
  lastError?: string;
  providers?: Record<
    string,
    {
      id: string;
      model: string | null;
      ready: boolean;
      cloud: boolean;
      lastError?: string;
      capabilities?: {
        lexical?: boolean;
        semantic?: boolean;
      };
    }
  >;
};

export function defaultFtsManifest(status: ProviderManifest['status'] = 'ready'): ProviderManifest {
  return {
    providerId: 'fts',
    modelId: null,
    dims: null,
    createdAt: new Date().toISOString(),
    corpusFingerprint: null,
    status,
    ready: status === 'ready',
    cloud: false,
    activeProviderId: 'fts',
    providers: {
      fts: {
        id: 'fts',
        model: null,
        ready: status === 'ready',
        cloud: false,
        capabilities: {
          lexical: true,
          semantic: false,
        },
      },
    },
  };
}

export async function readProviderManifest(workspace: Workspace): Promise<ProviderManifest | null> {
  try {
    return JSON.parse(await fs.readFile(workspace.indexManifestPath, 'utf8')) as ProviderManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null;
  }
}

export async function writeProviderManifest(workspace: Workspace, manifest: ProviderManifest): Promise<void> {
  const existing = await readProviderManifest(workspace);
  await fs.writeFile(
    workspace.indexManifestPath,
    `${JSON.stringify(
      {
        ...manifest,
        // createdAt AFTER the spread so it isn't overwritten: preserve the original creation time across
        // rewrites (was a real latent bug — the spread clobbered this line; the tsc gate surfaced it).
        createdAt: existing?.createdAt || manifest.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}
