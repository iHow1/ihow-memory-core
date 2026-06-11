// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import { spawn } from 'node:child_process';
import type {
  RetrievalEngine,
  RetrievalEngineStatus,
  SearchOptions,
  SearchResult,
  Workspace,
  WorkspaceOptions,
} from '../types.ts';
import { countIndexedDocuments, ftsEngine } from './fts.ts';
import { readProviderManifest, writeProviderManifest } from './manifest.ts';

type EngineConfig = {
  requestedId: string;
  vectorProviderCommand?: string;
  vectorModel?: string;
  vectorTimeoutMs: number;
};

type ProviderCall = 'status' | 'index' | 'search';

type FallbackInfo = {
  from: string;
  to: 'fts';
  reason: string;
};

export type EngineSearchResult = {
  hits: SearchResult[];
  fallback?: FallbackInfo;
};

const DEFAULT_VECTOR_TIMEOUT_MS = 1500;

function stringEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

function parseTimeout(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_VECTOR_TIMEOUT_MS;
  return Math.max(100, Math.min(parsed, 30000));
}

function requestedEngineId(options: WorkspaceOptions): string {
  const requested = options.engine || stringEnv('IHOW_MEMORY_ENGINE') || stringEnv('IHOW_MEMORY_PROVIDER') || 'fts';
  const normalized = requested.trim().toLowerCase();
  if (['vector', 'semantic', 'vector-process', 'vector-gguf'].includes(normalized)) return 'vector-gguf';
  return normalized || 'fts';
}

export function resolveEngineConfig(options: WorkspaceOptions = {}): EngineConfig {
  return {
    requestedId: requestedEngineId(options),
    vectorProviderCommand: options.vectorProviderCommand || stringEnv('IHOW_MEMORY_VECTOR_PROVIDER_COMMAND'),
    vectorModel: options.vectorModel || stringEnv('IHOW_MEMORY_VECTOR_MODEL') || null || undefined,
    vectorTimeoutMs: parseTimeout(options.vectorTimeoutMs || stringEnv('IHOW_MEMORY_VECTOR_TIMEOUT_MS')),
  };
}

function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, '[redacted]')
    .replace(/\b(token|password|secret|api[_-]?key)=\S+/gi, '$1=[redacted]')
    .slice(0, 500);
}

function splitCommand(input: string): string[] {
  return input.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => part.replace(/^["']|["']$/g, '')) || [];
}

class VectorProcessEngine implements RetrievalEngine {
  id = 'vector-gguf';

  capabilities = {
    lexical: false,
    semantic: true,
  };

  private readonly config: EngineConfig;

  constructor(config: EngineConfig) {
    this.config = config;
  }

  async index(workspace: Workspace): Promise<{ indexed: number }> {
    return (await this.callProvider('index', workspace)) as { indexed: number };
  }

  async search(workspace: Workspace, query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    const result = (await this.callProvider('search', workspace, { query, opts })) as {
      hits?: SearchResult[];
      results?: SearchResult[];
    };
    const hits = result.hits || result.results || [];
    return hits.map((hit) => ({
      ...hit,
      source: hit.source || this.id,
      citation: hit.citation || {
        path: hit.path,
        snippet: hit.snippet,
      },
    }));
  }

  async status(workspace: Workspace): Promise<RetrievalEngineStatus> {
    const status = (await this.callProvider('status', workspace)) as Partial<RetrievalEngineStatus>;
    return {
      id: String(status.id || this.id),
      model: typeof status.model === 'string' ? status.model : this.config.vectorModel || null,
      ready: status.ready === true,
      cloud: status.cloud === true,
      lastError: typeof status.lastError === 'string' ? status.lastError : undefined,
    };
  }

  private async callProvider(method: ProviderCall, workspace: Workspace, payload: Record<string, unknown> = {}) {
    if (!this.config.vectorProviderCommand) throw new Error('vector_provider_unconfigured');
    const parts = splitCommand(this.config.vectorProviderCommand);
    const [command, ...baseArgs] = parts;
    if (!command) throw new Error('vector_provider_unconfigured');

    const request = {
      method,
      workspace: {
        root: workspace.root,
        space: workspace.space,
        memoryDir: workspace.memoryDir,
        indexPath: workspace.indexPath,
        indexManifestPath: workspace.indexManifestPath,
      },
      provider: {
        id: this.id,
        model: this.config.vectorModel || null,
      },
      ...payload,
    };

    return await new Promise((resolve, reject) => {
      const child = spawn(command, [...baseArgs, method], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`vector_provider_timeout:${method}`));
      }, this.config.vectorTimeoutMs);

      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`vector_provider_exit_${code}:${stderr.trim() || method}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout.trim() || '{}'));
        } catch {
          reject(new Error(`vector_provider_invalid_json:${method}`));
        }
      });
      child.stdin.end(`${JSON.stringify(request)}\n`);
    });
  }
}

function isVectorRequested(config: EngineConfig): boolean {
  return config.requestedId === 'vector-gguf';
}

function vectorEngine(config: EngineConfig): RetrievalEngine {
  return new VectorProcessEngine(config);
}

async function writeReadyManifest(workspace: Workspace, status: RetrievalEngineStatus, documents?: number): Promise<void> {
  await writeProviderManifest(workspace, {
    providerId: status.id,
    modelId: status.model,
    dims: null,
    createdAt: new Date().toISOString(),
    corpusFingerprint: null,
    status: status.ready ? 'ready' : 'error',
    ready: status.ready,
    cloud: status.cloud,
    activeProviderId: status.id,
    lastError: status.lastError,
    providers: {
      fts: {
        id: 'fts',
        model: null,
        ready: documents === undefined ? true : documents >= 0,
        cloud: false,
        capabilities: ftsEngine.capabilities,
      },
      [status.id]: {
        id: status.id,
        model: status.model,
        ready: status.ready,
        cloud: status.cloud,
        lastError: status.lastError,
        capabilities: {
          semantic: true,
        },
      },
    },
  });
}

async function writeFallbackManifest(workspace: Workspace, fallback: FallbackInfo): Promise<void> {
  const documents = await countIndexedDocuments(workspace);
  await writeProviderManifest(workspace, {
    providerId: 'fts',
    modelId: null,
    dims: null,
    createdAt: new Date().toISOString(),
    corpusFingerprint: null,
    status: 'fallback',
    ready: true,
    cloud: false,
    activeProviderId: 'fts',
    fallbackFrom: fallback.from,
    fallbackTo: fallback.to,
    lastError: fallback.reason,
    providers: {
      fts: {
        id: 'fts',
        model: null,
        ready: true,
        cloud: false,
        capabilities: ftsEngine.capabilities,
      },
      [fallback.from]: {
        id: fallback.from,
        model: null,
        ready: false,
        cloud: false,
        lastError: fallback.reason,
        capabilities: {
          semantic: true,
        },
      },
    },
  });
  if (documents < 0) {
    throw new Error('unreachable_index_document_count');
  }
}

export async function indexWithEngineFallback(workspace: Workspace, config: EngineConfig): Promise<number> {
  const ftsIndexed = (await ftsEngine.index(workspace)).indexed;
  if (!isVectorRequested(config)) return ftsIndexed;

  try {
    const requested = vectorEngine(config);
    const status = await requested.status(workspace);
    if (!status.ready) throw new Error(status.lastError || 'vector_provider_not_ready');
    await requested.index(workspace);
    await writeReadyManifest(workspace, status, ftsIndexed);
    return ftsIndexed;
  } catch (error) {
    await writeFallbackManifest(workspace, {
      from: 'vector-gguf',
      to: 'fts',
      reason: safeErrorMessage(error),
    });
    return ftsIndexed;
  }
}

export async function searchWithEngineFallback(
  workspace: Workspace,
  config: EngineConfig,
  query: string,
  opts: SearchOptions = {},
): Promise<EngineSearchResult> {
  if (!isVectorRequested(config)) {
    return { hits: await ftsEngine.search(workspace, query, opts) };
  }

  const requested = vectorEngine(config);
  try {
    const status = await requested.status(workspace);
    if (!status.ready) throw new Error(status.lastError || 'vector_provider_not_ready');
    const hits = await requested.search(workspace, query, opts);
    await writeReadyManifest(workspace, status);
    return { hits };
  } catch (error) {
    const fallback = {
      from: requested.id,
      to: 'fts' as const,
      reason: safeErrorMessage(error),
    };
    const hits = await ftsEngine.search(workspace, query, opts);
    await writeFallbackManifest(workspace, fallback);
    return {
      hits: hits.map((hit) => ({
        ...hit,
        fallback,
      })),
      fallback,
    };
  }
}

export async function engineStatus(workspace: Workspace, config: EngineConfig): Promise<{
  provider: RetrievalEngineStatus & {
    fallback?: boolean;
    fallbackFrom?: string;
    requested?: RetrievalEngineStatus;
  };
  manifestLastError?: string;
}> {
  if (!isVectorRequested(config)) {
    const manifest = await readProviderManifest(workspace);
    return {
      provider: {
        id: 'fts',
        model: null,
        ready: true,
        cloud: false,
        lastError: manifest?.providerId === 'fts' ? manifest.lastError : undefined,
      },
      manifestLastError: manifest?.lastError,
    };
  }

  const requested = vectorEngine(config);
  try {
    const requestedStatus = await requested.status(workspace);
    if (!requestedStatus.ready) throw new Error(requestedStatus.lastError || 'vector_provider_not_ready');
    await writeReadyManifest(workspace, requestedStatus);
    return {
      provider: requestedStatus,
      manifestLastError: requestedStatus.lastError,
    };
  } catch (error) {
    const fallback = {
      from: requested.id,
      to: 'fts' as const,
      reason: safeErrorMessage(error),
    };
    await writeFallbackManifest(workspace, fallback);
    const requestedStatus = {
      id: requested.id,
      model: config.vectorModel || null,
      ready: false,
      cloud: false,
      lastError: fallback.reason,
    };
    return {
      provider: {
        id: 'fts',
        model: null,
        ready: true,
        cloud: false,
        lastError: fallback.reason,
        fallback: true,
        fallbackFrom: requested.id,
        requested: requestedStatus,
      },
      manifestLastError: fallback.reason,
    };
  }
}
