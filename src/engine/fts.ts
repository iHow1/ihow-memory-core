// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { RetrievalEngine, SearchResult, Workspace } from '../types.ts';
import { listMarkdownFiles } from '../store/files.ts';
import { withWorkspaceLock } from '../store/lock.ts';
import { relativeToSpace } from '../workspace.ts';
import { defaultFtsManifest, writeProviderManifest } from './manifest.ts';

type IndexDocument = {
  path: string;
  content: string;
};

const BUSY_TIMEOUT_MS = 10000;
const requireBuiltin = createRequire(import.meta.url);

type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
  close(): void;
};

let databaseSyncConstructor: (new (path: string, opts?: Record<string, unknown>) => SqliteDatabase) | undefined;

function sqliteErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').slice(0, 300);
}

export function loadDatabaseSync(): new (path: string, opts?: Record<string, unknown>) => SqliteDatabase {
  if (databaseSyncConstructor) return databaseSyncConstructor;
  try {
    const sqlite = requireBuiltin('node:sqlite') as {
      DatabaseSync?: new (path: string, opts?: Record<string, unknown>) => SqliteDatabase;
    };
    if (!sqlite.DatabaseSync) throw new Error('DatabaseSync export missing');
    databaseSyncConstructor = sqlite.DatabaseSync;
    return databaseSyncConstructor;
  } catch (error) {
    throw new Error(`sqlite_unavailable:${sqliteErrorMessage(error)}`);
  }
}

export function sqliteRuntimeStatus(): { ok: true; detail: string } | { ok: false; detail: string } {
  try {
    loadDatabaseSync();
    return { ok: true, detail: 'node:sqlite DatabaseSync available' };
  } catch (error) {
    return { ok: false, detail: sqliteErrorMessage(error) };
  }
}

function openDatabase(workspace: Workspace, opts: { initialize?: boolean } = {}): SqliteDatabase {
  fs.mkdirSync(path.dirname(workspace.indexPath), { recursive: true });
  const DatabaseSync = loadDatabaseSync();
  const db = new DatabaseSync(workspace.indexPath, { timeout: BUSY_TIMEOUT_MS });
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
  if (opts.initialize !== false) {
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts
      USING fts5(path UNINDEXED, content, tokenize = 'unicode61');
    `);
  }
  return db;
}

// CJK segmentation: unicode61 treats a run of Han characters as a single long token,
// which breaks substring search for CJK text. Apply this both before indexing and
// before query parsing so each CJK ideograph becomes its own token. Only CJK
// ideographs are affected; ASCII / Latin / digits are untouched (backward compatible).
function cjkSegment(text: string): string {
  if (typeof text !== 'string' || !text) return text;
  return text.replace(/[㐀-鿿豈-﫿]/g, (char) => ` ${char} `);
}

function queryToFts(query: string): string {
  const terms = cjkSegment(query).match(/[\p{L}\p{N}_-]+/gu) || [];
  if (terms.length === 0) return '""';
  return terms
    .slice(0, 12)
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(' OR ');
}

async function collectDocuments(workspace: Workspace): Promise<IndexDocument[]> {
  const files = await listMarkdownFiles(workspace.memoryDir);
  const documents: IndexDocument[] = [];
  for (const filePath of files) {
    const relative = relativeToSpace(workspace, filePath);
    if (relative.startsWith('memory/candidate/')) continue;
    if (relative.startsWith('memory/_mcp/_events/')) continue;
    if (relative.startsWith('memory/_mcp/history/')) continue;
    const content = await fsp.readFile(filePath, 'utf8');
    documents.push({ path: relative, content });
  }
  return documents;
}

async function rebuildFtsIndexUnlocked(workspace: Workspace): Promise<number> {
  const documents = await collectDocuments(workspace);
  const db = openDatabase(workspace);
  try {
    db.exec('BEGIN');
    db.exec('DELETE FROM memory_fts');
    const insert = db.prepare('INSERT INTO memory_fts(path, content) VALUES (?, ?)');
    for (const document of documents) {
      insert.run(document.path, cjkSegment(document.content));
    }
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore rollback failures
    }
    throw error;
  } finally {
    db.close();
  }
  await writeProviderManifest(workspace, defaultFtsManifest('ready'));
  return documents.length;
}

async function hasUsableIndex(workspace: Workspace): Promise<boolean> {
  if (!fs.existsSync(workspace.indexPath)) return false;
  const db = openDatabase(workspace, { initialize: false });
  try {
    db.prepare('SELECT rowid FROM memory_fts LIMIT 1').all();
    return true;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

async function ensureFtsIndex(workspace: Workspace): Promise<void> {
  if (await hasUsableIndex(workspace)) return;
  await withWorkspaceLock(workspace, async () => {
    if (await hasUsableIndex(workspace)) return;
    await rebuildFtsIndexUnlocked(workspace);
  });
}

export async function rebuildFtsIndex(workspace: Workspace): Promise<number> {
  return await withWorkspaceLock(workspace, async () => await rebuildFtsIndexUnlocked(workspace));
}

export async function searchFts(
  workspace: Workspace,
  query: string,
  opts: { limit?: number; rebuild?: boolean } = {},
): Promise<SearchResult[]> {
  if (opts.rebuild === true) {
    await rebuildFtsIndex(workspace);
  } else {
    await ensureFtsIndex(workspace);
  }
  const limit = Math.max(1, Math.min(Number(opts.limit || 5), 25));
  const db = openDatabase(workspace, { initialize: false });
  try {
    const rows = db
      .prepare(`
        SELECT
          path,
          snippet(memory_fts, 1, '[', ']', '...', 24) AS snippet,
          bm25(memory_fts) AS rank,
          (CASE WHEN path LIKE 'memory/journal/%' OR path LIKE 'memory/_mcp/journal/%' THEN 1 ELSE 0 END) AS is_journal
        FROM memory_fts
        WHERE memory_fts MATCH ?
        ORDER BY is_journal ASC, rank
        LIMIT ?
      `)
      .all(queryToFts(query), limit) as Array<{ path: string; snippet: string; rank: number; is_journal: number }>;
    return rows.map((row) => ({
      path: row.path,
      snippet: row.snippet,
      score: Number(row.rank),
      source: 'fts',
      citation: {
        path: row.path,
        snippet: row.snippet,
      },
    }));
  } finally {
    db.close();
  }
}

export async function countIndexedDocuments(workspace: Workspace): Promise<number> {
  if (!fs.existsSync(workspace.indexPath)) return 0;
  let db: SqliteDatabase;
  try {
    db = openDatabase(workspace, { initialize: false });
  } catch {
    return 0;
  }
  try {
    const row = db.prepare('SELECT count(*) AS count FROM memory_fts').get() as { count: number };
    return Number(row.count || 0);
  } catch {
    return 0;
  } finally {
    db.close();
  }
}

export const ftsEngine: RetrievalEngine = {
  id: 'fts',
  capabilities: {
    lexical: true,
    semantic: false,
  },
  async index(workspace) {
    return { indexed: await rebuildFtsIndex(workspace) };
  },
  async search(workspace, query, opts = {}) {
    return await searchFts(workspace, query, opts);
  },
  async status() {
    return {
      id: 'fts',
      model: null,
      ready: true,
      cloud: false,
    };
  },
};
