// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { RetrievalEngine, SearchOptions, SearchResult, Workspace } from '../types.ts';
import { listMarkdownFiles } from '../store/files.ts';
import { withWorkspaceLock } from '../store/lock.ts';
import { relativeToSpace } from '../workspace.ts';
import { defaultFtsManifest, writeProviderManifest } from './manifest.ts';

type IndexDocument = {
  path: string;
  content: string;
  flagged: boolean;
  unreviewed: boolean;
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
      USING fts5(path UNINDEXED, content, orig UNINDEXED, flagged UNINDEXED, reviewed UNINDEXED, tokenize = 'unicode61');
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

// --- CJK bigram tokenization (replaces the old single-char split that made "评价" match "评分") ---
// node:sqlite exposes no custom-tokenizer hook, so we pre-segment. We index unigrams + overlapping
// BIGRAMS, and query with bigrams for multi-char runs — so "评价" matches the "评价" 2-gram, never "评分".
const CJK_RUN = /[㐀-鿿豈-﫿]+/g;
const LATIN_WORD = /[\p{L}\p{N}_-]+/gu;

// Index side: each CJK run -> its unigrams AND overlapping bigrams (space-separated); Latin passes through.
function cjkIndexSegment(text: string): string {
  if (typeof text !== 'string' || !text) return text;
  return text.replace(CJK_RUN, (run) => {
    const toks: string[] = [];
    for (let i = 0; i < run.length; i++) {
      toks.push(run[i]); // unigram: keeps a 1-char query matching inside words
      if (i + 1 < run.length) toks.push(run[i] + run[i + 1]); // bigram: the precision win
    }
    return ` ${toks.join(' ')} `;
  });
}

// Query side: CJK run >= 2 chars -> overlapping bigrams (precise); lone CJK char -> unigram; Latin words
// pass through. OR-joined (generous recall; the calling agent reranks), but each token is a meaningful
// 2-gram, so the character-soup false matches are gone.
function queryToFts(query: string): string {
  if (typeof query !== 'string' || !query) return '""';
  const tokens: string[] = [];
  for (const m of query.matchAll(CJK_RUN)) {
    const run = m[0];
    if (run.length === 1) tokens.push(run);
    else for (let i = 0; i + 1 < run.length; i++) tokens.push(run[i] + run[i + 1]);
  }
  for (const w of query.replace(CJK_RUN, ' ').match(LATIN_WORD) || []) tokens.push(w);
  if (tokens.length === 0) return '""';
  return tokens.slice(0, 32).map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

// Readable snippet from the ORIGINAL text (the indexed column is bigram-segmented and renders garbled).
// Center a ~160-char window on the earliest query-term hit.
function frontmatterIsFlagged(content: string): boolean {
  const fm = content.match(/^﻿?\s*---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return false;
  return /^\s*flagged:\s*["']?true\b/im.test(fm[1]);
}

// RED-TEAM-NEEDED (governance.ts:839 follow-up): wires the long-tracked "down-weight unreviewed
// entries in bm25 rank". An entry is UNREVIEWED when the engine auto-promoted it WITHOUT a human
// review — frontmatter `reviewed: false` or `tier: auto-promoted` (machine-judged). This is RANKING
// ONLY: an unreviewed entry stays fully searchable and fully recall-eligible exactly as before; we
// only nudge it DOWN the bm25 order so a human-reviewed entry of comparable lexical match ranks
// first. The same case/quote-tolerant matchers recall uses (cli.ts recallTier) are mirrored here so
// the two cannot disagree on what "unreviewed" means.
function frontmatterIsUnreviewed(content: string): boolean {
  const fm = content.match(/^﻿?\s*---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return false;
  return /^\s*reviewed:\s*["']?false\b/im.test(fm[1]) || /^\s*tier:\s*["']?auto-promoted\b/im.test(fm[1]);
}

function buildSnippet(orig: string, query: string): string {
  let body = typeof orig === 'string' ? orig : '';
  // drop a leading YAML frontmatter block so the snippet is CONTENT, not metadata (candidate_id, timestamps)
  body = body.replace(/^﻿?\s*---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const flat = body.replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const low = flat.toLowerCase();
  let pos = -1;
  const consider = (i: number): void => { if (i >= 0 && (pos < 0 || i < pos)) pos = i; };
  // STRONG needles first: whole CJK runs (>=2 chars, e.g. "评价") and latin words (>=2) — center on the
  // real phrase hit, not a stray single char that may sit in an unrelated context (评估 / 评分).
  for (const m of query.matchAll(CJK_RUN)) if (m[0].length >= 2) consider(low.indexOf(m[0].toLowerCase()));
  for (const w of query.toLowerCase().replace(CJK_RUN, ' ').match(LATIN_WORD) || []) if (w.length >= 2) consider(low.indexOf(w));
  // WEAK fallback: single CJK chars only when no strong needle was found.
  if (pos < 0) for (const m of query.matchAll(CJK_RUN)) for (const ch of m[0]) consider(flat.indexOf(ch));
  if (pos < 0) return flat.slice(0, 160) + (flat.length > 160 ? '…' : '');
  const start = Math.max(0, pos - 40);
  const end = Math.min(flat.length, pos + 120);
  return (start > 0 ? '…' : '') + flat.slice(start, end) + (end < flat.length ? '…' : '');
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
    documents.push({ path: relative, content, flagged: frontmatterIsFlagged(content), unreviewed: frontmatterIsUnreviewed(content) });
  }
  return documents;
}

async function rebuildFtsIndexUnlocked(workspace: Workspace): Promise<number> {
  const documents = await collectDocuments(workspace);
  const db = openDatabase(workspace);
  try {
    // DROP+CREATE (not just DELETE) so an old-schema index (pre-bigram/pre-`reviewed`) migrates cleanly.
    db.exec('DROP TABLE IF EXISTS memory_fts');
    db.exec("CREATE VIRTUAL TABLE memory_fts USING fts5(path UNINDEXED, content, orig UNINDEXED, flagged UNINDEXED, reviewed UNINDEXED, tokenize = 'unicode61')");
    db.exec('BEGIN');
    const insert = db.prepare('INSERT INTO memory_fts(path, content, orig, flagged, reviewed) VALUES (?, ?, ?, ?, ?)');
    for (const document of documents) {
      // reviewed=1 when human-reviewed/plain; reviewed=0 when machine auto-promoted (down-weighted at rank time).
      insert.run(document.path, cjkIndexSegment(document.content), document.content, document.flagged ? 1 : 0, document.unreviewed ? 0 : 1);
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
    // selecting `orig`+`reviewed` also verifies the current schema — a pre-bigram / pre-reviewed index
    // lacks one of these columns, fails here, and is rebuilt with the current schema.
    db.prepare('SELECT orig, flagged, reviewed FROM memory_fts LIMIT 1').all();
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
  opts: SearchOptions = {},
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
          orig,
          bm25(memory_fts) AS rank,
          (CASE WHEN path LIKE 'memory/journal/%' OR path LIKE 'memory/_mcp/journal/%' THEN 1 ELSE 0 END) AS is_journal,
          -- RED-TEAM-NEEDED (governance.ts:839): bm25 is NEGATIVE (more-negative = better). Adding a small
          -- positive penalty to UNREVIEWED (machine auto-promoted) rows pushes them DOWN the order so a
          -- human-reviewed entry of comparable lexical match wins. Ranking only — eligibility is untouched
          -- (the row is still returned and still recall-gated downstream by the event log, not by rank).
          (CASE WHEN reviewed = 0 THEN 1.0 ELSE 0 END) AS rank_penalty,
          -- Phase-4 DETERMINISTIC SALIENCE DECAY for the SOFT (journal/floor) lane. Journal/floor files are
          -- day-named (memory/journal/YYYY-MM-DD.md); the date is a deterministic, model-free salience proxy
          -- — an older note has lower salience and sorts BELOW a newer one of equal lexical match. This is a
          -- TIEBREAKER applied ONLY among journal rows (is_journal=1): it orders newest-day first (DESC) so
          -- a stale low-weight note sinks. ARCHIVE/RANKING ONLY — same WHERE clause, same eligibility, never
          -- a delete; verified/flagged (the PINNED governance tiers) are not in the journal lane at all, so
          -- this can never touch them. Non-journal rows get '' here and are unaffected (constant key).
          (CASE WHEN path LIKE 'memory/journal/%' OR path LIKE 'memory/_mcp/journal/%'
                THEN substr(path, length(path) - 12, 10) ELSE '' END) AS journal_day
        FROM memory_fts
        WHERE memory_fts MATCH ? AND (? = 1 OR flagged != 1)
        ORDER BY is_journal ASC, (rank + rank_penalty), journal_day DESC
        LIMIT ?
      `)
      .all(queryToFts(query), opts.includeFlagged === true ? 1 : 0, limit) as Array<{ path: string; orig: string; rank: number; is_journal: number; rank_penalty: number; journal_day: string }>;
    return rows.map((row) => {
      const snippet = buildSnippet(row.orig, query); // clean window from the ORIGINAL text, not the segmented column
      return {
        path: row.path,
        snippet,
        score: Number(row.rank),
        source: 'fts',
        citation: { path: row.path, snippet },
      };
    });
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
