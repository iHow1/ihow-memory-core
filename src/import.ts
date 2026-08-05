// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// C2 — single-command import of EXISTING memory from other tools into the searchable store.
// The 30-second wedge: point it at memory you already wrote elsewhere (the biggest stock source is
// Claude Code's native auto-memory: a MEMORY.md index + per-fact files), and it lands every item in
// the LOW-WEIGHT journal lane — searchable now, but ranked below curated memory on purpose.
//
// Why the journal lane (and not curated): imported foreign memory has NOT passed THIS engine's
// promote gate. Writing it straight into curated lanes would let unreviewed external content
// masquerade as reviewed — exactly the false-green this product exists to kill. The journal lane is
// the honest home: indexed + searchable (so `search`/recall surface it), demoted below curated, and
// individually reversible via `rollback` (each entry is its own audit event). Promote the ones you
// trust later, deliberately. appendJournal also hard-rejects secret-like content in the body, and we
// additionally scan the TITLE here (it becomes the entry heading) so a secret hiding in a foreign
// frontmatter `name`/`description` is refused too, never silently stored.
//
// Identity vs content markers: each written entry carries TWO fingerprints — a CONTENT marker (hash
// of kind+path+title+body) for exact-duplicate skipping, and an IDENTITY marker (hash of kind+path)
// that is stable across edits of the same source fact. So a byte-identical re-import is skipped, and
// an EDITED fact is recognized as a change (reported honestly, and superseded under --update instead
// of silently double-storing two contradictory copies).
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Workspace } from './types.ts';
import { appendJournal, containsSecretLikeContent } from './governance.ts';
import { atomicWriteFile, appendFileAtomic } from './store/files.ts';
import { withWorkspaceLock } from './store/lock.ts';

export type ImportSourceKind = 'claude-code' | 'markdown';

export type ImportItem = {
  title: string;
  text: string;
  sourceFile: string; // absolute path the item was parsed from (provenance + identity)
  sourceKind: ImportSourceKind;
  tags: string[];
};

export type SkippedSource = { file: string; reason: string };

export type ImportPlan = {
  source: ImportSourceKind;
  from: string; // the resolved absolute path we scanned
  scanned: string[]; // every file we looked at (absolute), for an honest "what did it read" line
  items: ImportItem[];
  skipped: SkippedSource[]; // files we looked at but produced no item from, WITH the reason (never silent)
};

// A per-entry length cap: a pathological multi-megabyte source file should not become one giant
// journal entry. 20k chars is far above any real memory note; oversize content is truncated with a
// visible marker (never silently cut) and the source path is kept so the user can read the original.
const MAX_ITEM_CHARS = 20_000;

// ── frontmatter ────────────────────────────────────────────────────────────────────────────────
// Split a leading `---\n…\n---` YAML-ish block off a markdown file. We support flat `key: value`
// pairs AND one level of nesting (Claude Code's real format is nested:
//   metadata:
//     type: reference
// ), which we flatten to a dotted key `metadata.type`. Deeper nesting is ignored rather than
// mis-parsed. Returns the raw body (everything after the closing fence) untouched.
export function splitFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  if (!raw.startsWith('---\n') && !raw.startsWith('---\r\n')) return { meta: {}, body: raw };
  const rest = raw.replace(/^---\r?\n/, '');
  const end = rest.search(/\r?\n---\r?\n/);
  if (end === -1) return { meta: {}, body: raw }; // unterminated fence -> treat the whole thing as body
  const block = rest.slice(0, end);
  const body = rest.slice(end).replace(/^\r?\n---\r?\n/, '');
  const meta: Record<string, string> = {};
  let parent: string | null = null;
  for (const rawLine of block.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    const indented = /^\s+\S/.test(rawLine);
    const m = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(rawLine.trim());
    if (!m) continue;
    const key = m[1];
    const value = m[2].trim().replace(/^["']|["']$/g, '');
    if (indented && parent) {
      // a child line under a `parent:` block header -> dotted key (e.g. metadata.type)
      if (value) meta[`${parent}.${key}`] = value;
    } else if (!value) {
      // a top-level `key:` with no value opens a nested block (its children become dotted keys)
      parent = key;
    } else {
      meta[key] = value;
      parent = null;
    }
  }
  return { meta, body };
}

function clampText(text: string, sourceFile: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_ITEM_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_ITEM_CHARS)}\n\n…[truncated on import — read the full source at ${sourceFile}]`;
}

function firstHeading(body: string): string | undefined {
  for (const line of body.split(/\r?\n/)) {
    const m = /^#{1,6}\s+(.+?)\s*#*$/.exec(line.trim());
    if (m) return m[1].trim();
  }
  return undefined;
}

// CONTENT fingerprint: changes whenever the source fact's body/title/path/kind changes — used to skip
// a byte-identical re-import. IDENTITY fingerprint: stable across edits of the same source fact (kind
// + path) — used to recognize an EDITED fact so it can supersede its old entry instead of doubling.
// Separators are '\n' (plain text — never NUL: a NUL would make this file binary and invisible to
// grep / secret scanners that a no-false-green product depends on).
export function contentMarker(item: { sourceKind: string; sourceFile: string; title: string; text: string }): string {
  return crypto.createHash('sha256').update(`${item.sourceKind}\n${item.sourceFile}\n${item.title}\n${item.text}`).digest('hex').slice(0, 12);
}

export function identityMarker(item: { sourceKind: string; sourceFile: string }): string {
  return crypto.createHash('sha256').update(`${item.sourceKind}\n${item.sourceFile}`).digest('hex').slice(0, 12);
}

const CONTENT_MARKER_RE = /ihow-import:([0-9a-f]{6,16})/g;
const IDENTITY_MARKER_RE = /\biid:([0-9a-f]{6,16})/g;

function entryComment(cm: string, im: string, kind: string): string {
  return `<!-- ihow-import:${cm} iid:${im} source:${kind} -->`;
}

// ── file reading (UTF-8 guard) ───────────────────────────────────────────────────────────────
// Read a file as text ONLY if it is valid UTF-8 with no NUL bytes. A binary/mislabeled .md must be
// skipped with an honest reason — never decoded lossily into U+FFFD/NUL junk that then lands in the
// journal as a "written" item (the "scanned N, skipped M with reason" contract must not swallow it).
async function readTextFile(file: string): Promise<{ text: string } | { error: string }> {
  let buf: Buffer;
  try {
    buf = await fs.readFile(file);
  } catch (e) {
    return { error: `unreadable (${(e as Error).message})` };
  }
  if (buf.includes(0)) return { error: 'not valid UTF-8 text (contains NUL bytes)' };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf) };
  } catch {
    return { error: 'not valid UTF-8 text' };
  }
}

// ── file walking ─────────────────────────────────────────────────────────────────────────────
async function listMarkdownFilesRecursive(root: string): Promise<string[]> {
  const out: string[] = [];
  async function visit(dir: string): Promise<void> {
    // No explicit `Awaited<ReturnType<typeof fs.readdir>>` annotation: it resolves to the Buffer
    // overload (Dirent<NonSharedBuffer>) and breaks entry.name as a string. Inferring from the call
    // (with the `.catch(() => [])` union) keeps the string overload. Same trap as store/files.ts.
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      return [];
    });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue; // skip dotdirs (.git, .premigrate-*, etc.)
        await visit(abs);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        out.push(abs);
      }
    }
  }
  await visit(root);
  return out.sort();
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

// ── source detection ─────────────────────────────────────────────────────────────────────────
// Decide which adapter to use for a path the user pointed at. A directory containing a MEMORY.md, or
// a path that IS a MEMORY.md, is Claude Code's native auto-memory layout. Everything else is treated
// as generic markdown (covers ai-memory handoffs, hand-written STATE/handover docs, plain notes).
export async function detectSource(fromPath: string): Promise<ImportSourceKind> {
  const base = path.basename(fromPath);
  if (base === 'MEMORY.md') return 'claude-code';
  if (await isDirectory(fromPath)) {
    if (await fileExists(path.join(fromPath, 'MEMORY.md'))) return 'claude-code';
  }
  return 'markdown';
}

// ── adapters ─────────────────────────────────────────────────────────────────────────────────
type ParseResult = { items: ImportItem[]; scanned: string[]; skipped: SkippedSource[] };

// Claude Code native auto-memory: a MEMORY.md index plus one markdown file per fact, each with
// `name` / `description` / `metadata.type` frontmatter and a markdown body. We import the FACT files
// (the real content), not MEMORY.md itself (a pointer index) — unless the dir has only MEMORY.md, in
// which case we fall back to importing it so the user is never left with an empty result.
async function parseClaudeCode(fromPath: string): Promise<ParseResult> {
  let dir = fromPath;
  if (path.basename(fromPath) === 'MEMORY.md' && (await fileExists(fromPath))) dir = path.dirname(fromPath);
  if (!(await isDirectory(dir))) {
    // A single non-MEMORY file pointed at with --source claude-code: parse it as one fact file.
    return parseFactFiles([fromPath]);
  }
  const all = await listMarkdownFilesRecursive(dir);
  const factFiles = all.filter((f) => path.basename(f) !== 'MEMORY.md');
  if (factFiles.length === 0) {
    // Only an index, no fact files — import the index itself rather than return empty.
    const memoryIndex = path.join(dir, 'MEMORY.md');
    if (await fileExists(memoryIndex)) return parseGenericFiles([memoryIndex]);
    return { items: [], scanned: [], skipped: [] };
  }
  return parseFactFiles(factFiles);
}

async function parseFactFiles(files: string[]): Promise<ParseResult> {
  const items: ImportItem[] = [];
  const scanned: string[] = [];
  const skipped: SkippedSource[] = [];
  for (const file of files) {
    scanned.push(file);
    const read = await readTextFile(file);
    if ('error' in read) {
      skipped.push({ file, reason: read.error });
      continue;
    }
    const { meta, body } = splitFrontmatter(read.text);
    const text = body.trim();
    if (!text) {
      skipped.push({ file, reason: 'empty body' });
      continue;
    }
    const title = meta.name || meta.description || firstHeading(body) || path.basename(file, '.md');
    const tags = ['import:claude-code'];
    const type = meta['metadata.type'] || meta.type;
    if (type) tags.push(type);
    items.push({ title: title.slice(0, 120), text: clampText(text, file), sourceFile: file, sourceKind: 'claude-code', tags });
  }
  return { items, scanned, skipped };
}

// Generic markdown: one item per .md file. Title is the first heading or the filename. Frontmatter,
// if present, is stripped from the body but its `title`/`name` wins for the heading.
async function parseGenericFiles(files: string[]): Promise<ParseResult> {
  const items: ImportItem[] = [];
  const scanned: string[] = [];
  const skipped: SkippedSource[] = [];
  for (const file of files) {
    scanned.push(file);
    const read = await readTextFile(file);
    if ('error' in read) {
      skipped.push({ file, reason: read.error });
      continue;
    }
    const { meta, body } = splitFrontmatter(read.text);
    const text = body.trim();
    if (!text) {
      skipped.push({ file, reason: 'empty body' });
      continue;
    }
    const title = meta.title || meta.name || firstHeading(body) || path.basename(file, '.md');
    items.push({ title: title.slice(0, 120), text: clampText(text, file), sourceFile: file, sourceKind: 'markdown', tags: ['import:markdown'] });
  }
  return { items, scanned, skipped };
}

async function parseMarkdown(fromPath: string): Promise<ParseResult> {
  if (await isDirectory(fromPath)) return parseGenericFiles(await listMarkdownFilesRecursive(fromPath));
  if (await fileExists(fromPath)) return parseGenericFiles([fromPath]);
  return { items: [], scanned: [], skipped: [] };
}

// ── plan ───────────────────────────────────────────────────────────────────────────────────────
// Read-only: detect the source kind, parse it, return the full plan. No workspace, no writes — this
// is exactly what `import` (no --apply) prints, and what tests assert against.
export async function planImport(opts: { from: string; source?: ImportSourceKind }): Promise<ImportPlan> {
  const from = path.resolve(opts.from);
  const source = opts.source ?? (await detectSource(from));
  const parsed = source === 'claude-code' ? await parseClaudeCode(from) : await parseMarkdown(from);
  return { source, from, scanned: parsed.scanned, items: parsed.items, skipped: parsed.skipped };
}

// ── existing-marker scan (idempotency) ───────────────────────────────────────────────────────
export type ExistingMarkers = { content: Set<string>; identity: Set<string> };

// Scan every journal file across the workspace's lanes for already-imported markers, so re-running
// `import` recognizes unchanged items (content marker) and edited facts (identity marker) instead of
// blindly doubling. Best-effort: an unreadable lane just yields no markers.
export async function collectExistingImports(journalDirs: string[]): Promise<ExistingMarkers> {
  const content = new Set<string>();
  const identity = new Set<string>();
  for (const dir of journalDirs) {
    let files: string[] = [];
    try {
      files = (await fs.readdir(dir)).filter((n) => n.endsWith('.md'));
    } catch {
      continue;
    }
    for (const name of files) {
      let raw: string;
      try {
        raw = await fs.readFile(path.join(dir, name), 'utf8');
      } catch {
        continue;
      }
      for (const m of raw.matchAll(CONTENT_MARKER_RE)) content.add(m[1]);
      for (const m of raw.matchAll(IDENTITY_MARKER_RE)) identity.add(m[1]);
    }
  }
  return { content, identity };
}

// Retire every journal entry carrying a given identity marker, across all lanes, lock-safe and atomic.
// Used by --update to supersede the stale copy of an edited fact before writing the new one — so the
// two contradictory versions never coexist in the SEARCHABLE journal lane. The stale entry is not
// destroyed: it is ARCHIVED to historyDir (which lives outside memoryDir, so it is never indexed,
// searched, or recalled), preserving an audit trail of what a fact used to say without it surfacing as
// a live, contradictory answer. (Borrowed from ai-memory's keep-history supersession, adapted to our
// per-FILE-indexed markdown model where keeping the old block in place would re-expose it to search.)
// Returns how many entries were archived.
async function supersedeByIdentity(workspace: Workspace, journalDirs: string[], im: string): Promise<number> {
  const marker = `iid:${im}`;
  return await withWorkspaceLock(workspace, async () => {
    let archivedCount = 0;
    const archivedBlocks: string[] = [];
    for (const dir of journalDirs) {
      let files: string[] = [];
      try {
        files = (await fs.readdir(dir)).filter((n) => n.endsWith('.md'));
      } catch {
        continue;
      }
      for (const name of files) {
        const p = path.join(dir, name);
        let raw: string;
        try {
          raw = await fs.readFile(p, 'utf8');
        } catch {
          continue;
        }
        if (!raw.includes(marker)) continue;
        // Entries are delimited by "\n## "; keep the preamble + every entry NOT carrying this identity,
        // and set the matching entries aside to archive.
        const [preamble, ...entries] = raw.split('\n## ');
        const kept: string[] = [];
        for (const entry of entries) {
          if (entry.includes(marker)) archivedBlocks.push(`## ${entry.replace(/\s*$/, '')}`);
          else kept.push(entry);
        }
        const dropped = entries.length - kept.length;
        if (!dropped) continue;
        const rebuilt = kept.length ? `${preamble}\n## ${kept.join('\n## ')}` : preamble;
        await atomicWriteFile(p, rebuilt, workspace.memoryDir);
        archivedCount += dropped;
      }
    }
    if (archivedBlocks.length) {
      // historyDir is OUTSIDE memoryDir -> never indexed/searched/recalled. Append-only audit trail.
      const histPath = path.join(workspace.historyDir, 'superseded-import.md');
      const header = `\n<!-- superseded by import --update at ${new Date().toISOString()} · identity ${im} · kept for audit, NOT indexed/searchable -->\n`;
      await appendFileAtomic(histPath, `${header}${archivedBlocks.join('\n')}\n`);
    }
    return archivedCount;
  });
}

// ── apply ──────────────────────────────────────────────────────────────────────────────────────
export type AppliedStatus = 'written' | 'updated' | 'skipped-duplicate' | 'skipped-changed' | 'skipped-secret' | 'skipped-error';

export type AppliedItem = {
  title: string;
  sourceFile: string;
  status: AppliedStatus;
  path?: string;
  eventId?: string;
  contentMarker: string;
  identityMarker: string;
  supersededCount?: number; // for 'updated': how many stale entries were removed
  reason?: string;
};

export type ApplyOptions = {
  existing?: ExistingMarkers;
  journalDirs?: string[]; // lanes to supersede across when update=true (defaults to workspace.journalDir)
  update?: boolean; // re-import edited facts: retire the stale entry, write the new one
};

// Write each planned item into the journal lane via appendJournal (lock-safe, atomic, secret-rejecting,
// reversible). We do NOT index here — the caller reindexes ONCE after the loop, then proves the import
// by searching a written item's unique marker back out.
//
//  • content marker already present            -> skipped-duplicate (byte-identical, unchanged)
//  • identity present, content changed, !update -> skipped-changed  (honest: "pass --update to refresh")
//  • identity present, content changed, update  -> updated          (supersede stale, write new)
//  • secret-like title OR body                  -> skipped-secret   (refused, never stored)
//  • otherwise                                  -> written
export async function applyImport(workspace: Workspace, items: ImportItem[], opts: ApplyOptions = {}): Promise<AppliedItem[]> {
  const results: AppliedItem[] = [];
  const seenContent = new Set(opts.existing?.content ?? []);
  const seenIdentity = new Set(opts.existing?.identity ?? []);
  const journalDirs = opts.journalDirs ?? [workspace.journalDir];

  for (const item of items) {
    const cm = contentMarker(item);
    const im = identityMarker(item);
    const base = { title: item.title, sourceFile: item.sourceFile, contentMarker: cm, identityMarker: im };

    // Secret guard FIRST: appendJournal scans the body, but the TITLE becomes the entry heading and is
    // NOT scanned by appendJournal — so a secret in a foreign `name`/`description` would slip through.
    // Scan the title here and refuse the whole item if it (or the body) looks secret-like.
    if (containsSecretLikeContent(item.title)) {
      results.push({ ...base, status: 'skipped-secret', reason: 'secret-like content in title' });
      continue;
    }

    if (seenContent.has(cm)) {
      results.push({ ...base, status: 'skipped-duplicate', reason: 'already imported (unchanged)' });
      continue;
    }

    const changed = seenIdentity.has(im);
    if (changed && !opts.update) {
      results.push({ ...base, status: 'skipped-changed', reason: 'source changed since last import — pass --update to refresh' });
      continue;
    }

    let supersededCount = 0;
    if (changed && opts.update) {
      try {
        supersededCount = await supersedeByIdentity(workspace, journalDirs, im);
      } catch (e) {
        results.push({ ...base, status: 'skipped-error', reason: `supersede failed: ${e instanceof Error ? e.message : String(e)}` });
        continue;
      }
    }

    const text = `${item.text}\n\n${entryComment(cm, im, item.sourceKind)}`;
    try {
      const r = await appendJournal(workspace, { text, title: item.title, sourceAgent: `import:${item.sourceKind}` });
      seenContent.add(cm);
      seenIdentity.add(im);
      results.push({ ...base, status: changed ? 'updated' : 'written', path: r.path, eventId: r.eventId, supersededCount: changed ? supersededCount : undefined });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // appendJournal throws on secret-like BODY content (hard red line). Classify so the receipt is
      // honest about WHY an item didn't land — never a silent drop, never a stored secret.
      const status: AppliedStatus = /secret/i.test(msg) ? 'skipped-secret' : 'skipped-error';
      results.push({ ...base, status, reason: msg });
    }
  }
  return results;
}
