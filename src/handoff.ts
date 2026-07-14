// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Handoff assembly — the UNIFIED, runtime-neutral layer behind both the `continue` CLI and the
// `memory.continue` MCP tool. Discovery + packet assembly live here (single source of truth) so the
// self-exclude guard, edits-only project inference, redaction, and conflict detection can't drift
// between the CLI and MCP paths.
//
// Design lock (n=12 A/B, 2026-06-18): MACHINE ANCHORS are the only facts (git, code-computed). The
// prior session's narrative is carried VERBATIM under an UNVERIFIED flag — it is NEVER parsed by an LLM
// into authoritative "open loops / next action" fields, because a structured + authoritative narrative
// is exactly what induces confident-wrong in the receiver. Structure lives in the MACHINE layer
// (anchors / provenance / freshness / conflicts); the narrative stays a quoted blob.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Workspace } from './types.ts';
import { parseTranscript, summarizeTranscript, type TranscriptRecord } from './transcript.ts';
import { gitAnchors, fileAnchors, inferProjectDir, repoRoot, type GitAnchors } from './anchors.ts';
import { redactSecretLikeContent } from './governance.ts';
import { anchorConflicts } from './handoff-metrics.ts';
import { RECEIVER_INSTRUCTION } from './envelope.ts';
import { loadDatabaseSync } from './engine/fts.ts';
import {
  readCheckpointArtifactSnapshot,
  resolveCheckpointProjectIdentity,
  type CheckpointArtifactSnapshot,
} from './checkpoints.ts';
import {
  canonicalCheckpointJson,
  type CheckpointArtifactV1,
  type CheckpointCoverage,
  type CheckpointEvidence,
} from './checkpoint-schema.ts';
import { readActivationEvidence } from './activation-ledger.ts';
import { readEventsAllLanes, type MemoryEvent } from './store/events.ts';
import { absoluteFromMemoryPath } from './workspace.ts';

export type ResumableSession = {
  sessionId: string;
  tool: string; // which runtime recorded it: claude-code | codex | ...
  transcriptPath: string;
  projectDir?: string; // inferred from EDITED files only (never reads) — undefined => UNDETERMINED
  modifiedAt: string; // transcript file mtime, ISO — the "last activity" used for sort + display
  anchors: GitAnchors; // git facts for projectDir (machine-verified; free-text fields redacted) — or file-fingerprint anchors when non-git
  editedList: string[]; // absolute paths the session edited — used to compute file anchors for a non-git resume
  body: string; // full redacted prior-session narrative (UNVERIFIED) — the handoff narrative source
  snippet: string; // single-line fragment of body for compact list rendering
};

// The runtime-neutral unit a per-tool reader produces from one session file. Downstream
// (inferProjectDir / gitAnchors / redaction / buildHandoffPacket) is identical for every tool — adding a
// runtime = one reader + one schema mapping, nothing in the core changes.
export type CaptureUnit = {
  sessionId: string;
  body: string; // raw (un-redacted) narrative — the caller redacts
  editedList: string[]; // absolute paths the session WROTE/EDITED — the strongest project signal
  projectDir?: string; // when the tool records cwd inline (Codex/WorkBuddy); else inferred from editedList
};

// A per-runtime session source: how to enumerate its session files and parse the latest session in one.
type SessionSource = {
  tool: string;
  list: () => Promise<Array<{ file: string; mtimeMs: number }>>;
  // opts.skipProject => don't spend a synchronous `git` probe inferring the project (the capture floor
  // never reads projectDir/anchors; running git on the MCP event loop at startup would block it).
  read: (file: string, opts?: { skipProject?: boolean }) => Promise<CaptureUnit | undefined>;
};

// Single-session handoff source for the cwd-scoped `continue`: the latest SUBSTANTIAL transcript under
// ~/.claude/projects/<encoded-cwd>/*.jsonl by mtime, excluding the live session. Returns the summary +
// inferred project (edits only) + mtime. Undefined when none (then the caller falls back to a marker).
export async function pickTranscriptHandoff(
  cwd: string,
  hint?: string,
  excludeSessionId?: string,
): Promise<{ transcriptPath: string; sessionId: string; summary: ReturnType<typeof summarizeTranscript>; projectDir?: string; mtimeMs: number } | undefined> {
  const encoded = path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
  const dir = path.join(os.homedir(), '.claude', 'projects', encoded);
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return undefined; // no project dir for this cwd -> fall back to Stop markers
  }
  const stamped: Array<{ file: string; mtimeMs: number }> = [];
  for (const f of files) {
    try {
      stamped.push({ file: f, mtimeMs: (await fs.stat(path.join(dir, f))).mtimeMs });
    } catch {
      // skip an unstattable file
    }
  }
  stamped.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
  const MIN_ENTRIES = 4; // skip a trivial / freshly-cleared session
  const SCAN = 25; // bound how many recent transcripts we parse when matching a hint
  const needle = hint?.trim().toLowerCase();
  for (const { file, mtimeMs } of stamped.slice(0, SCAN)) {
    // Never resume the CURRENTLY-RUNNING session: its own transcript is the newest file on disk.
    if (excludeSessionId && file.replace(/\.jsonl$/, '') === excludeSessionId) continue;
    const full = path.join(dir, file);
    const raw = await readSessionFile(full);
    if (raw === undefined) continue; // unreadable / too large
    const records = parseTranscript(raw);
    if (records.length < MIN_ENTRIES) continue;
    const summary = summarizeTranscript(records);
    // Infer the project ONLY from files this session WROTE/EDITED — never from incidental reads.
    const projectDir = inferProjectDir(summary.editedList);
    if (needle) {
      const hay = `${projectDir ?? ''}\n${summary.body}`.toLowerCase();
      if (!hay.includes(needle)) continue;
    }
    return { transcriptPath: full, sessionId: file.replace(/\.jsonl$/, ''), summary, projectDir, mtimeMs };
  }
  return undefined;
}

// A pathological session file (some Codex rollouts run to many MB) must not be read whole into memory.
const MAX_SESSION_FILE_BYTES = 25 * 1024 * 1024;
async function readSessionFile(file: string): Promise<string | undefined> {
  try {
    if ((await fs.stat(file)).size > MAX_SESSION_FILE_BYTES) return undefined; // skip — too large to parse safely
    return await fs.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

// ---- per-runtime session sources (each = a discovery list + a reader; downstream is shared) ----

// Claude Code: one session per ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl. No per-line cwd, so
// projectDir is inferred from edited files downstream.
const claudeSource: SessionSource = {
  tool: 'claude-code',
  list: async () => {
    const root = path.join(os.homedir(), '.claude', 'projects');
    const out: Array<{ file: string; mtimeMs: number }> = [];
    let dirs: string[];
    try { dirs = await fs.readdir(root); } catch { return out; }
    for (const enc of dirs) {
      let files: string[];
      try { files = (await fs.readdir(path.join(root, enc))).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
      for (const f of files) {
        const full = path.join(root, enc, f);
        try { out.push({ file: full, mtimeMs: (await fs.stat(full)).mtimeMs }); } catch { /* skip unstattable */ }
      }
    }
    return out;
  },
  read: async (file) => {
    const raw = await readSessionFile(file);
    if (raw === undefined) return undefined;
    const records = parseTranscript(raw);
    if (records.length < 4) return undefined; // trivial / freshly-cleared
    const summary = summarizeTranscript(records);
    return { sessionId: path.basename(file).replace(/\.jsonl$/, ''), body: summary.body, editedList: summary.editedList };
  },
};

// Codex: ~/.codex/{sessions,archived_sessions}/**/rollout-*.jsonl, each a STREAM of {timestamp,type,
// payload}. One file can hold MANY sessions delimited by `session_meta`; we surface the LATEST session
// per file (the resume-relevant one). cwd comes straight from session_meta (exact project mapping),
// editedList from apply_patch headers, narrative from response_item message texts.
const codexSource: SessionSource = {
  tool: 'codex',
  list: async () => {
    const base = path.join(os.homedir(), '.codex');
    const out: Array<{ file: string; mtimeMs: number }> = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 6) return;
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full, depth + 1);
        else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
          try { out.push({ file: full, mtimeMs: (await fs.stat(full)).mtimeMs }); } catch { /* skip */ }
        }
      }
    };
    await walk(path.join(base, 'sessions'), 0);
    await walk(path.join(base, 'archived_sessions'), 0);
    return out;
  },
  read: async (file) => parseCodexRollout(file),
};

// Extract the LATEST session from a Codex rollout file -> narrative + cwd + edited files. Each
// `session_meta` resets accumulation so only the final session's content remains.
async function parseCodexRollout(file: string): Promise<CaptureUnit | undefined> {
  const raw = await readSessionFile(file);
  if (raw === undefined) return undefined;
  let sessionId = '';
  let cwd: string | undefined;
  // Build synthetic Claude-shape records so the SHARED summarizeTranscript governs scope for EVERY tool:
  // only a capped Topic (first user prompt) + the closing assistant segment leave — never full user turns.
  let records: TranscriptRecord[] = [];
  let edited = new Set<string>();
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let rec: any;
    try { rec = JSON.parse(t); } catch { continue; }
    const p = rec?.payload;
    if (rec?.type === 'session_meta' && p) {
      sessionId = typeof p.id === 'string' ? p.id : sessionId; // new session starts -> keep only the LATEST
      cwd = typeof p.cwd === 'string' ? p.cwd : cwd;
      records = [];
      edited = new Set<string>();
    } else if (rec?.type === 'response_item' && p?.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
      const parts: string[] = [];
      for (const c of Array.isArray(p.content) ? p.content : []) {
        if (c && typeof c.text === 'string' && typeof c.type === 'string' && c.type.endsWith('text')) parts.push(c.text);
      }
      if (parts.length) records.push({ type: p.role, message: { content: [{ type: 'text', text: parts.join('\n') }] } });
    } else if (rec?.type === 'response_item' && typeof p?.type === 'string') {
      // apply_patch arrives as a function/tool call; pull edited file paths from its header lines.
      // Stop at the first quote/backslash/newline so a JSON-escaped patch body can't trail into the path.
      for (const m of JSON.stringify(p).matchAll(/\*\*\* (?:Add|Update|Delete) File: ([^"\\\n]+)/g)) {
        const fp = m[1].trim();
        if (fp) edited.add(cwd && !path.isAbsolute(fp) ? path.join(cwd, fp) : fp);
      }
    }
  }
  if (!sessionId || records.length < 2) return undefined; // trivial / unparseable
  const body = summarizeTranscript(records).body; // locked scope + MAX_BODY cap, shared with Claude
  if (!body) return undefined;
  return { sessionId, body, editedList: [...edited], projectDir: cwd };
}

// WorkBuddy (Tencent): ~/.workbuddy/projects/<encoded-cwd>/<sessionId>.jsonl, one session per file.
// Records are {id,timestamp,type,role,content,cwd,sessionId,...}; messages have type "message", a `role`
// and a TOP-LEVEL `content` list (NOT message.content), with cwd inline (exact project map). agent-*.jsonl
// are sub-agent noise (excluded). No hooks on this build, so capture is passive transcript-reading.
const workbuddySource: SessionSource = {
  tool: 'workbuddy',
  list: async () => {
    const root = path.join(os.homedir(), '.workbuddy', 'projects');
    const out: Array<{ file: string; mtimeMs: number }> = [];
    let dirs: string[];
    try { dirs = await fs.readdir(root); } catch { return out; }
    for (const enc of dirs) {
      let files: string[];
      try { files = (await fs.readdir(path.join(root, enc))).filter((f) => f.endsWith('.jsonl') && !f.startsWith('agent-')); } catch { continue; }
      for (const f of files) {
        const full = path.join(root, enc, f);
        try { out.push({ file: full, mtimeMs: (await fs.stat(full)).mtimeMs }); } catch { /* skip */ }
      }
    }
    return out;
  },
  read: async (file) => parseWorkbuddyThread(file),
};

async function parseWorkbuddyThread(file: string): Promise<CaptureUnit | undefined> {
  const raw = await readSessionFile(file);
  if (raw === undefined) return undefined;
  let cwd: string | undefined;
  let sessionId = path.basename(file).replace(/\.jsonl$/, '');
  const records: TranscriptRecord[] = []; // synthetic Claude-shape -> shared summarizeTranscript scope
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let rec: any;
    try { rec = JSON.parse(t); } catch { continue; }
    if (typeof rec?.cwd === 'string') cwd = rec.cwd;
    if (typeof rec?.sessionId === 'string') sessionId = rec.sessionId;
    if (rec?.type === 'message' && (rec.role === 'user' || rec.role === 'assistant')) {
      const parts: string[] = [];
      const content = Array.isArray(rec.content) ? rec.content : typeof rec.content === 'string' ? [rec.content] : [];
      for (const c of content) {
        // genuine text blocks only (real WorkBuddy uses input_text/output_text; also plain text) —
        // never image_blob_ref / tool-call / other block types.
        if (typeof c === 'string') parts.push(c);
        else if (c && typeof c.type === 'string' && c.type.endsWith('text') && typeof c.text === 'string') parts.push(c.text);
      }
      if (parts.length) records.push({ type: rec.role, message: { content: [{ type: 'text', text: parts.join('\n') }] } });
    }
  }
  if (records.length < 2) return undefined; // trivial
  const body = summarizeTranscript(records).body; // locked scope + MAX_BODY cap, shared with Claude
  if (!body) return undefined;
  // editedList left empty in v1: projectDir comes straight from the inline cwd, so project mapping does
  // not depend on it. (A v2 can mine file-history-snapshot records for the edited set.)
  return { sessionId, body, editedList: [], projectDir: cwd };
}

// OpenClaw: ~/.openclaw/agents/<agent>/sessions/<id>.trajectory.jsonl — an EVENT stream
// {type,ts,sessionId,workspaceDir,data,...}. User text is prompt.submitted.data.prompt; assistant text
// is model.completed.data.assistantTexts[]; workspaceDir is the project. One session per file.
const openclawSource: SessionSource = {
  tool: 'openclaw',
  list: async () => {
    const root = path.join(os.homedir(), '.openclaw', 'agents');
    const out: Array<{ file: string; mtimeMs: number }> = [];
    let agents: string[];
    try { agents = await fs.readdir(root); } catch { return out; }
    for (const a of agents) {
      const sdir = path.join(root, a, 'sessions');
      let files: string[];
      try { files = (await fs.readdir(sdir)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
      for (const f of files) {
        const full = path.join(sdir, f);
        try { out.push({ file: full, mtimeMs: (await fs.stat(full)).mtimeMs }); } catch { /* skip */ }
      }
    }
    return out;
  },
  read: async (file) => parseOpenclawTrajectory(file),
};

async function parseOpenclawTrajectory(file: string): Promise<CaptureUnit | undefined> {
  const raw = await readSessionFile(file);
  if (raw === undefined) return undefined;
  let cwd: string | undefined;
  let sessionId = path.basename(file).replace(/\.trajectory\.jsonl$/, '').replace(/\.jsonl$/, '');
  const records: TranscriptRecord[] = []; // synthetic Claude-shape -> shared summarizeTranscript scope
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let rec: any;
    try { rec = JSON.parse(t); } catch { continue; }
    if (typeof rec?.workspaceDir === 'string') cwd = rec.workspaceDir;
    if (typeof rec?.sessionId === 'string') sessionId = rec.sessionId;
    const data = rec?.data;
    if (rec?.type === 'prompt.submitted' && data && typeof data.prompt === 'string') {
      records.push({ type: 'user', message: { content: [{ type: 'text', text: data.prompt }] } });
    } else if (rec?.type === 'model.completed' && data && Array.isArray(data.assistantTexts)) {
      const text = data.assistantTexts.filter((x: unknown) => typeof x === 'string').join('\n');
      if (text) records.push({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    }
  }
  if (records.length < 2) return undefined; // trivial
  const body = summarizeTranscript(records).body; // locked scope + MAX_BODY cap, shared with all tools
  if (!body) return undefined;
  return { sessionId, body, editedList: [], projectDir: cwd };
}


// Hermes: ~/.hermes/sessions/session_*.json, one JSON object per session. Messages are OpenAI-like
// {role,content,tool_calls}. There is no top-level cwd; the strongest project signal is buried in
// tool-call arguments (notably terminal.workdir). We synthesize the same Claude-shape records used by
// the other readers so summarizeTranscript keeps the global scope lock: first user topic + assistant
// text + file paths + Bash binary names only, never tool result content.
const hermesSource: SessionSource = {
  tool: 'hermes',
  list: async () => {
    const dir = path.join(os.homedir(), '.hermes', 'sessions');
    const out: Array<{ file: string; mtimeMs: number }> = [];
    let files: string[];
    try { files = (await fs.readdir(dir)).filter((f) => f.startsWith('session_') && f.endsWith('.json')); } catch { return out; }
    for (const f of files) {
      const full = path.join(dir, f);
      try { out.push({ file: full, mtimeMs: (await fs.stat(full)).mtimeMs }); } catch { /* skip */ }
    }
    return out;
  },
  read: async (file, opts) => parseHermesSession(file, opts?.skipProject),
};

function hermesTextOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => {
      if (typeof b === 'string') return b;
      if (!b || typeof b !== 'object' || typeof (b as { text?: unknown }).text !== 'string') return '';
      const type = (b as { type?: unknown }).type;
      // Scope lock: text blocks only. Skip images, tool/function-call blocks, and any unknown typed
      // block that happens to carry a `text` field.
      if (typeof type === 'string' && !type.endsWith('text')) return '';
      return (b as { text: string }).text;
    })
    .filter(Boolean)
    .join('\n');
}

function parseToolArgs(args: unknown): Record<string, unknown> | undefined {
  if (args && typeof args === 'object' && !Array.isArray(args)) return args as Record<string, unknown>;
  if (typeof args !== 'string' || !args.trim()) return undefined;
  try {
    const parsed = JSON.parse(args);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function addHermesFileBlock(blocks: Array<Record<string, unknown>>, toolName: string, fp: unknown): void {
  if (typeof fp !== 'string' || !fp) return;
  const map: Record<string, string> = {
    read_file: 'Read',
    read: 'Read',
    write_file: 'Write',
    write: 'Write',
    edit_file: 'Edit',
    update_file: 'Edit',
    str_replace: 'Edit',
  };
  const name = map[toolName];
  if (name) blocks.push({ type: 'tool_use', name, input: { file_path: fp } });
}

function chooseHermesProject(workdirs: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const wd of workdirs) {
    if (!wd) continue;
    const expanded = wd.startsWith('~/') ? path.join(os.homedir(), wd.slice(2)) : wd;
    counts.set(expanded, (counts.get(expanded) ?? 0) + 1);
  }
  let bestRepo: string | undefined;
  let bestRepoN = 0;
  for (const [wd, n] of counts) {
    if (gitAnchors(wd).isRepo && n > bestRepoN) {
      bestRepoN = n;
      bestRepo = wd;
    }
  }
  return bestRepo;
}

// Shared core: turn an OpenAI-shaped Hermes message list (role/content/tool_calls[]) into a CaptureUnit.
// BOTH Hermes readers — legacy JSON file and current state.db — normalize their messages to this shape
// and call here, so scope-lock (first user topic + assistant text + file paths + Bash binary names, never
// tool-result content), project inference, and exclusions stay identical across stores. tool_calls must
// already be an array (the JSON store has it parsed; the state.db store JSON-parses its per-row string).
function hermesCaptureFromMessages(messages: unknown[], sessionId: string, skipProject = false): CaptureUnit | undefined {
  if (!Array.isArray(messages) || messages.length < 2) return undefined;
  const records: TranscriptRecord[] = [];
  const workdirs: string[] = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const role = (m as { role?: unknown }).role;
    if (role !== 'user' && role !== 'assistant') continue; // never ingest tool-result content
    const blocks: Array<Record<string, unknown>> = [];
    const text = hermesTextOf((m as { content?: unknown }).content).trim();
    if (text) blocks.push({ type: 'text', text });
    if (role === 'assistant' && Array.isArray((m as { tool_calls?: unknown }).tool_calls)) {
      for (const call of (m as { tool_calls: unknown[] }).tool_calls) {
        const fn = (call as any)?.function ?? call;
        const name = typeof fn?.name === 'string' ? fn.name : typeof (call as any)?.name === 'string' ? (call as any).name : '';
        const args = parseToolArgs(fn?.arguments ?? (call as any)?.arguments);
        if (!name || !args) continue;
        if (typeof args.workdir === 'string') workdirs.push(args.workdir);
        if (typeof args.cwd === 'string') workdirs.push(args.cwd);
        if (name === 'terminal' && typeof args.command === 'string') {
          blocks.push({ type: 'tool_use', name: 'Bash', input: { command: args.command } });
        }
        addHermesFileBlock(blocks, name, args.path ?? args.file_path ?? args.filename);
      }
    }
    if (blocks.length) records.push({ type: role, message: { content: blocks } });
  }
  if (records.length < 2) return undefined;
  const summary = summarizeTranscript(records);
  if (!summary.body) return undefined;
  // chooseHermesProject probes each workdir with a synchronous `git` — skip it when the caller (the
  // capture floor) does not need projectDir, so the sweep stays off the event-loop-blocking git path.
  return { sessionId, body: summary.body, editedList: summary.editedList, projectDir: skipProject ? undefined : chooseHermesProject(workdirs) };
}

async function parseHermesSession(file: string, skipProject = false): Promise<CaptureUnit | undefined> {
  const raw = await readSessionFile(file);
  if (raw === undefined) return undefined;
  let doc: any;
  try { doc = JSON.parse(raw); } catch { return undefined; }
  const messages = Array.isArray(doc?.messages) ? doc.messages : [];
  const sessionId = typeof doc?.session_id === 'string' ? doc.session_id : path.basename(file).replace(/^session_/, '').replace(/\.json$/, '');
  return hermesCaptureFromMessages(messages, sessionId, skipProject);
}

// Hermes CURRENT store: ~/.hermes/state.db (SQLite). The 2026.5 desktop build moved sessions out of the
// legacy JSON files (which stop at the last pre-migration session) into state.db — tables
// `sessions(id, started_at, ...)` and `messages(session_id, role, content, tool_calls, timestamp)`. Without
// this source, a runtime's RECENT Hermes work would never surface as resumable. Read-only via node:sqlite
// (the same engine the FTS index uses); one synthetic "file" per session = `<db-path>#<sessionId>`.
type RoSqlite = { prepare(sql: string): { all(...p: unknown[]): unknown[] }; close(): void };

// Open any SQLite file read-only via node:sqlite (the same engine the FTS index uses). Returns undefined
// when the file is absent or sqlite is unavailable, so a runtime whose store isn't present simply
// contributes no sessions. Read-only is safe against a live WAL db another process holds open.
function openSqliteReadonly(dbPath: string): RoSqlite | undefined {
  try {
    const DatabaseSync = loadDatabaseSync();
    return new DatabaseSync(dbPath, { readOnly: true }) as unknown as RoSqlite;
  } catch {
    return undefined;
  }
}

function openHermesStateDb(): { db: RoSqlite; path: string } | undefined {
  const dbPath = path.join(os.homedir(), '.hermes', 'state.db');
  const db = openSqliteReadonly(dbPath);
  return db ? { db, path: dbPath } : undefined;
}

function parseJsonArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string' || !v.trim()) return [];
  try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
}

async function parseHermesStateDbSession(file: string, skipProject = false): Promise<CaptureUnit | undefined> {
  const hash = file.lastIndexOf('#');
  if (hash < 0) return undefined;
  const sessionId = file.slice(hash + 1);
  const handle = openHermesStateDb();
  if (!handle) return undefined;
  try {
    const rows = handle.db
      .prepare('SELECT role, content, tool_calls AS toolCalls FROM messages WHERE session_id = ? ORDER BY timestamp')
      .all(sessionId) as Array<{ role: unknown; content: unknown; toolCalls: unknown }>;
    // Normalize to the shared shape: the JSON store keeps tool_calls parsed; state.db keeps a JSON string.
    const messages = rows.map((r) => ({ role: r.role, content: r.content, tool_calls: parseJsonArray(r.toolCalls) }));
    return hermesCaptureFromMessages(messages, sessionId, skipProject);
  } catch {
    return undefined;
  } finally {
    try { handle.db.close(); } catch { /* ignore */ }
  }
}

const hermesStateDbSource: SessionSource = {
  tool: 'hermes',
  list: async () => {
    const out: Array<{ file: string; mtimeMs: number }> = [];
    const handle = openHermesStateDb();
    if (!handle) return out;
    try {
      // last activity per session = newest message timestamp (epoch SECONDS, float) -> ms for the sort
      const rows = handle.db
        .prepare('SELECT session_id AS sid, MAX(timestamp) AS lastTs FROM messages GROUP BY session_id')
        .all() as Array<{ sid: unknown; lastTs: unknown }>;
      for (const r of rows) {
        if (!r || typeof r.sid !== 'string' || typeof r.lastTs !== 'number') continue;
        out.push({ file: `${handle.path}#${r.sid}`, mtimeMs: r.lastTs * 1000 });
      }
    } catch {
      /* unreadable schema -> contribute nothing */
    } finally {
      try { handle.db.close(); } catch { /* ignore */ }
    }
    return out;
  },
  read: async (file, opts) => parseHermesStateDbSession(file, opts?.skipProject),
};

// OpenCode (SST): ~/.local/share/opencode/opencode.db (SQLite, Drizzle). A `session` row carries the cwd
// directly in `directory` (exact project — no tool-arg mining), and `parent_id` NULL marks a top-level
// thread (non-NULL = a subagent run, excluded as noise like WorkBuddy's agent-* files). A message's role
// is in `message.data` (JSON); its visible text is in linked `part` rows of type "text" (reasoning / tool
// / step-* parts are skipped — scope lock + no tool output). Read-only via node:sqlite; one file/session.
function safeJsonObject(v: unknown): Record<string, any> | undefined {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, any>;
  if (typeof v !== 'string' || !v.trim()) return undefined;
  try { const p = JSON.parse(v); return p && typeof p === 'object' && !Array.isArray(p) ? p : undefined; } catch { return undefined; }
}

const opencodeSource: SessionSource = {
  tool: 'opencode',
  list: async () => {
    const out: Array<{ file: string; mtimeMs: number }> = [];
    const dbPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
    const db = openSqliteReadonly(dbPath);
    if (!db) return out;
    try {
      // top-level sessions only (subagent runs have a parent_id); time_updated is epoch MS already
      const rows = db
        .prepare('SELECT id AS sid, time_updated AS ts FROM session WHERE parent_id IS NULL')
        .all() as Array<{ sid: unknown; ts: unknown }>;
      for (const r of rows) {
        const ts = typeof r.ts === 'number' ? r.ts : typeof r.ts === 'string' ? Number(r.ts) : NaN;
        if (typeof r.sid !== 'string' || !Number.isFinite(ts)) continue;
        out.push({ file: `${dbPath}#${r.sid}`, mtimeMs: ts });
      }
    } catch {
      /* unreadable schema -> contribute nothing */
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
    return out;
  },
  read: async (file) => parseOpencodeSession(file),
};

async function parseOpencodeSession(file: string): Promise<CaptureUnit | undefined> {
  const hash = file.lastIndexOf('#');
  if (hash < 0) return undefined;
  const sessionId = file.slice(hash + 1);
  const db = openSqliteReadonly(file.slice(0, hash));
  if (!db) return undefined;
  try {
    const srow = db.prepare('SELECT directory FROM session WHERE id = ?').all(sessionId)[0] as { directory?: unknown } | undefined;
    const projectDir = srow && typeof srow.directory === 'string' && srow.directory ? srow.directory : undefined;
    // Bucket each message's visible text from its "text" parts (one query, grouped by message_id).
    const textByMsg = new Map<string, string[]>();
    const partRows = db
      .prepare('SELECT message_id AS mid, data FROM part WHERE session_id = ? ORDER BY time_created')
      .all(sessionId) as Array<{ mid: unknown; data: unknown }>;
    for (const p of partRows) {
      if (typeof p.mid !== 'string') continue;
      const pd = safeJsonObject(p.data);
      if (pd && pd.type === 'text' && typeof pd.text === 'string' && pd.text.trim()) {
        const arr = textByMsg.get(p.mid) ?? [];
        arr.push(pd.text);
        textByMsg.set(p.mid, arr);
      }
    }
    const msgRows = db
      .prepare('SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created')
      .all(sessionId) as Array<{ id: unknown; data: unknown }>;
    const records: TranscriptRecord[] = [];
    for (const m of msgRows) {
      if (typeof m.id !== 'string') continue;
      const role = safeJsonObject(m.data)?.role;
      if (role !== 'user' && role !== 'assistant') continue;
      const text = (textByMsg.get(m.id) ?? []).join('\n').trim();
      if (text) records.push({ type: role, message: { content: [{ type: 'text', text }] } });
    }
    if (records.length < 2) return undefined;
    const summary = summarizeTranscript(records);
    if (!summary.body) return undefined;
    // editedList stays empty: projectDir is the session's recorded cwd, so project mapping doesn't need it.
    return { sessionId, body: summary.body, editedList: [], projectDir };
  } catch {
    return undefined;
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

// Gemini CLI: ~/.gemini/tmp/<projectKey>/logs.json is an append-only ARRAY of {sessionId, messageId,
// type, message, timestamp}. PASSIVE reader (resume/import, NOT real-time). Honest ceiling: Gemini CLI
// persists ONLY user prompts to logs.json (no assistant turns on disk), so the handoff body is the
// session's topic/intent + git anchors — lighter than a tool that records full transcripts. One file
// holds MANY sessions; we surface the LATEST (newest entry) per project, mirroring Codex. The sibling
// .project_root file holds the absolute project path. Routed through the SHARED summarizeTranscript so
// the locked scope (Topic only here) + downstream redaction are identical to every other runtime.
const geminiSource: SessionSource = {
  tool: 'gemini',
  list: async () => {
    const root = path.join(os.homedir(), '.gemini', 'tmp');
    const out: Array<{ file: string; mtimeMs: number }> = [];
    let entries;
    try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(root, e.name, 'logs.json');
      try { out.push({ file: full, mtimeMs: (await fs.stat(full)).mtimeMs }); } catch { /* no logs.json here */ }
    }
    return out;
  },
  read: async (file) => parseGeminiLogs(file),
};

async function parseGeminiLogs(file: string): Promise<CaptureUnit | undefined> {
  const raw = await readSessionFile(file);
  if (raw === undefined) return undefined;
  let entries: unknown;
  try { entries = JSON.parse(raw); } catch { return undefined; }
  if (!Array.isArray(entries) || entries.length === 0) return undefined;
  // Group user prompts by sessionId; track each session's newest timestamp so we surface the LATEST.
  const byId = new Map<string, { msgs: Array<{ messageId: number; message: string }>; ts: number }>();
  for (const e of entries as Array<Record<string, unknown>>) {
    if (!e || typeof e.sessionId !== 'string' || e.type !== 'user' || typeof e.message !== 'string') continue;
    const messageId = typeof e.messageId === 'number' ? e.messageId : 0;
    // messageId 0 is Gemini's launch-mode marker ("cli" / "tui" / ...), not a real prompt — drop it.
    if (messageId === 0 && /^(cli|tui|interactive|screen-reader)$/i.test(e.message.trim())) continue;
    if (!e.message.trim()) continue;
    const ts = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) || 0 : 0;
    const cur = byId.get(e.sessionId) ?? { msgs: [], ts: 0 };
    cur.msgs.push({ messageId, message: e.message });
    if (ts > cur.ts) cur.ts = ts;
    byId.set(e.sessionId, cur);
  }
  if (byId.size === 0) return undefined;
  let sessionId = '';
  let best = -1;
  let chosen: { msgs: Array<{ messageId: number; message: string }>; ts: number } | undefined;
  for (const [id, v] of byId) {
    if (v.ts > best) { best = v.ts; sessionId = id; chosen = v; }
  }
  if (!chosen || chosen.msgs.length < 2) return undefined; // trivial / freshly-started — skip
  chosen.msgs.sort((a, b) => a.messageId - b.messageId);
  // user-only records => summarizeTranscript yields a Topic-only body (no assistant Summary). That is the
  // honest ceiling for a tool that records only user prompts.
  const records: TranscriptRecord[] = chosen.msgs.map((m) => ({
    type: 'user',
    message: { content: [{ type: 'text', text: m.message }] },
  }));
  const body = summarizeTranscript(records).body;
  if (!body) return undefined;
  // .project_root sibling holds the absolute project path (authoritative cwd); none => UNDETERMINED.
  let projectDir: string | undefined;
  try {
    const pr = (await fs.readFile(path.join(path.dirname(file), '.project_root'), 'utf8')).trim();
    if (pr) projectDir = pr;
  } catch { /* no .project_root — leave the project undetermined */ }
  return { sessionId, body, editedList: [], projectDir };
}

// Cline (VS Code extension, publisher id saoudrizwan.claude-dev): each task lives at
// <globalStorage>/saoudrizwan.claude-dev/tasks/<taskId>/api_conversation_history.json — an Anthropic-shape
// MessageParam[] — plus ui_messages.json. PASSIVE reader (resume/import, NOT real-time). Discovery is
// BOUNDED: a fixed set of VS Code-family globalStorage roots (cross-OS + common forks) and the SDK data
// dir (~/.cline/data or $CLINE_DATA_DIR) — never a home-wide scan, so it stays cheap on the session-start
// floor path. cwd comes from the environment_details header Cline injects into the first user message.
// Routed through the SHARED summarizeTranscript so the locked scope + downstream redaction are identical.
function clineTaskRoots(): string[] {
  const home = os.homedir();
  const roots: string[] = [];
  const apps = ['Code', 'Code - Insiders', 'VSCodium', 'Cursor', 'Windsurf'];
  const bases: string[] = [];
  if (process.platform === 'darwin') {
    for (const app of apps) bases.push(path.join(home, 'Library', 'Application Support', app, 'User', 'globalStorage'));
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    for (const app of apps) bases.push(path.join(appData, app, 'User', 'globalStorage'));
  } else {
    const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    for (const app of apps) bases.push(path.join(xdg, app, 'User', 'globalStorage'));
  }
  for (const b of bases) roots.push(path.join(b, 'saoudrizwan.claude-dev', 'tasks'));
  // SDK data dir (current Cline also writes here): $CLINE_DATA_DIR or $CLINE_DIR/data or ~/.cline/data.
  const sdkBase = process.env.CLINE_DATA_DIR || path.join(process.env.CLINE_DIR || path.join(home, '.cline'), 'data');
  roots.push(path.join(sdkBase, 'tasks'));
  return roots;
}

const clineSource: SessionSource = {
  tool: 'cline',
  list: async () => {
    const out: Array<{ file: string; mtimeMs: number }> = [];
    for (const tasksDir of clineTaskRoots()) {
      let ids;
      try { ids = await fs.readdir(tasksDir, { withFileTypes: true }); } catch { continue; }
      for (const e of ids) {
        if (!e.isDirectory()) continue;
        const file = path.join(tasksDir, e.name, 'api_conversation_history.json');
        try { out.push({ file, mtimeMs: (await fs.stat(file)).mtimeMs }); } catch { /* no history in this task dir */ }
      }
    }
    return out;
  },
  read: async (file) => parseClineTask(file),
};

// Pull visible assistant/user text out of an Anthropic MessageParam.content (string | block[]).
function clineMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content) {
    if (b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string') {
      parts.push((b as { text: string }).text);
    }
  }
  return parts.join('\n');
}

async function parseClineTask(file: string): Promise<CaptureUnit | undefined> {
  const raw = await readSessionFile(file);
  if (raw === undefined) return undefined;
  let messages: unknown;
  try { messages = JSON.parse(raw); } catch { return undefined; }
  if (!Array.isArray(messages) || messages.length === 0) return undefined;
  // cwd: Cline injects "# Current Working Directory (/abs/path) Files" into the first user message's
  // environment_details. Pull it from the first user message's RAW text before we strip the wrappers.
  let projectDir: string | undefined;
  const records: TranscriptRecord[] = [];
  for (const m of messages as Array<Record<string, unknown>>) {
    const role = m?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    let text = clineMessageText(m.content).trim();
    if (!text) continue;
    if (role === 'user' && !projectDir) {
      const cwd = text.match(/# Current Working Directory \((.+?)\) Files/);
      if (cwd) projectDir = cwd[1].trim();
    }
    // Strip Cline's machine wrappers: environment_details is noise (and a file-listing leak surface);
    // unwrap <task>…</task> so the topic is the user's actual ask, not the XML tag.
    text = text
      .replace(/<environment_details>[\s\S]*?<\/environment_details>/g, '')
      .replace(/<\/?task>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) records.push({ type: role, message: { content: [{ type: 'text', text }] } });
  }
  if (records.length < 2) return undefined; // trivial / unparseable
  const body = summarizeTranscript(records).body;
  if (!body) return undefined;
  // taskId (the parent dir name) is the stable session id.
  const sessionId = path.basename(path.dirname(file));
  return { sessionId, body, editedList: [], projectDir };
}

const SESSION_SOURCES: SessionSource[] = [claudeSource, codexSource, workbuddySource, openclawSource, hermesSource, hermesStateDbSource, opencodeSource, geminiSource, clineSource];

// Enumerate the most recent RESUMABLE sessions across EVERY recorded runtime (Claude, Codex, ...),
// newest activity first. Each source contributes a reader; project inference, anchors and redaction are
// shared. excludeSessionId guards self-replay. Read-only; never throws on a single bad file.
export async function listResumableSessions(
  limit: number,
  excludeSessionId?: string,
  opts: { skipAnchors?: boolean; resolveProject?: boolean; runtimes?: ReadonlySet<string> } = {},
): Promise<ResumableSession[]> {
  const stamped: Array<{ file: string; mtimeMs: number; src: SessionSource }> = [];
  for (const src of SESSION_SOURCES) {
    if (opts.runtimes && !opts.runtimes.has(src.tool)) continue;
    for (const f of await src.list()) stamped.push({ ...f, src });
  }
  stamped.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest activity first across all tools
  const SCAN_CAP = Math.max(limit * 4, limit + 8); // bound parsing work
  const out: ResumableSession[] = [];
  const anchorCache = new Map<string, GitAnchors>(); // memoize per project — many sessions share one repo
  for (const { file, mtimeMs, src } of stamped.slice(0, SCAN_CAP)) {
    if (out.length >= limit) break;
    let unit: CaptureUnit | undefined;
    try {
      unit = await src.read(file, { skipProject: opts.skipAnchors && !opts.resolveProject });
    } catch {
      unit = undefined;
    }
    if (!unit) continue;
    if (excludeSessionId && unit.sessionId === excludeSessionId) continue; // no self-replay
    // skipAnchors (the capture-floor path): never run `git` — neither to INFER the project (inferProjectDir
    // probes git per edited file) nor to compute anchors. The floor reads only tool/sessionId/mtime/body,
    // so a synchronous git probe on the MCP event loop at startup would block it for zero benefit.
    const projectDir = opts.skipAnchors && !opts.resolveProject
      ? unit.projectDir
      : (unit.projectDir ?? inferProjectDir(unit.editedList));
    // Compute git anchors ONLY for a real project (don't spawn git on the transcript-storage dir for an
    // undetermined session), and memoize per project so N sessions in one repo cost one anchor lookup.
    let anchors: GitAnchors = { isRepo: false };
    if (!opts.skipAnchors && projectDir) {
      const cached = anchorCache.get(projectDir);
      if (cached) anchors = cached;
      else {
        anchors = gitAnchors(projectDir);
        if (anchors.headSubject) anchors.headSubject = redactSecretLikeContent(anchors.headSubject);
        if (anchors.branch) anchors.branch = redactSecretLikeContent(anchors.branch);
        if (anchors.repo) anchors.repo = redactSecretLikeContent(anchors.repo);
        if (anchors.dirtyFiles) anchors.dirtyFiles = anchors.dirtyFiles.map(redactSecretLikeContent);
        anchorCache.set(projectDir, anchors);
      }
    }
    // Non-git fallback: when there's no git repo, fingerprint the files this session edited so a non-git
    // project still gets verify-first anchors. Spread into a fresh object — never mutate the shared
    // (per-projectDir) anchor cache, since file anchors are per-session. (Skipped on the floor path.)
    if (!opts.skipAnchors && !anchors.isRepo && unit.editedList.length) {
      const files = fileAnchors(unit.editedList);
      if (files.length) anchors = { ...anchors, files };
    }
    const body = redactSecretLikeContent(unit.body);
    const snippet = body.replace(/\s+/g, ' ').trim().slice(0, 160);
    out.push({
      sessionId: unit.sessionId,
      tool: src.tool,
      transcriptPath: file,
      projectDir,
      modifiedAt: new Date(mtimeMs).toISOString(),
      anchors,
      editedList: unit.editedList,
      body,
      snippet,
    });
  }
  return out;
}

// ---- runtime-neutral handoff packet (the `memory.continue` MCP output) ----

// Code-computed resume verdict — GREEN only when the live repo genuinely matches the recorded
// anchors. The narrowness is deliberate (OpenClaw red-team: a confidently-wrong structured GREEN is
// MORE dangerous than prose). Any uncertainty (no project, can't read git, branch drift, destructive
// narrative) is YELLOW; an actual anchor mismatch / missing repo is RED. Never a false GREEN.
export type ContinueVerdict = {
  state: 'GREEN' | 'YELLOW' | 'RED';
  reason: string;
  recordedHead?: string;
  liveHead?: string;
};

export type HandoffCandidate = {
  tool: string; // which runtime recorded this session (claude-code | codex | ...)
  project: { path?: string; basename: string; projectId: string };
  confidence: number; // heuristic: edits-inferred project = high; undetermined = low
  why: string;
  anchors: GitAnchors; // provenance: CODE (the only facts)
  narrative: { text: string; source: string; sessionId: string; capturedAt: string; unverified: true }; // VERBATIM, never LLM-parsed into authoritative fields
  freshness: { ageMs: number; stale: boolean };
  conflicts: { staleShaRefs: number; referencesCurrentHead: boolean }; // machine-computed: narrative git-claims vs live HEAD
  verifyFirst: string[];
  verdict: ContinueVerdict; // code-computed live git-anchor verdict — not prose for the agent to maybe-run
  checkpoint?: {
    artifactId: string;
    classification: 'complete' | 'partial';
    triggerKind: CheckpointArtifactV1['trigger']['kind'];
    triggerSignal: CheckpointArtifactV1['trigger']['signal'];
    reasonCode: string;
    coverage: CheckpointCoverage;
    evidenceRefs: CheckpointEvidence[];
  };
  activationDegradation?: {
    runtime: string;
    observedAt: string;
    reasonCode: 'activation_latest_event_failed';
  };
};

export type HandoffPacket = {
  schemaVersion: number;
  generatedAt: string;
  query: { cwd?: string; projectHint?: string; limit: number };
  candidates: HandoffCandidate[]; // a LIST — project identification is ambiguous; never force a single pick
  checkpointLookup?: { status: CheckpointArtifactSnapshot['status']; reasonCode?: string };
  receiverProtocol: string;
  note: string;
};

const STALE_HANDOFF_MS = 24 * 60 * 60 * 1000;
const FLOOR_JOURNAL_MAX_BYTES = 2 * 1024 * 1024;
const HANDOFF_PACKET_RECEIVER_INSTRUCTION = RECEIVER_INSTRUCTION
  .replace(
    "the narrative below is the previous agent's UNVERIFIED claim, never a fact.",
    'each candidate narrative is source-attributed checkpoint/transcript/floor evidence — always UNVERIFIED, never a fact.',
  )
  .replace(
    'read the transcript tail / `git diff` / the files',
    'read the cited checkpoint/transcript/floor evidence / `git diff` / the files',
  );

function projectIdFor(p?: string): string {
  if (!p) return 'undetermined';
  return crypto.createHash('sha256').update(path.resolve(p)).digest('hex').slice(0, 12);
}

function redactLiveAnchors(projectDir: string): GitAnchors {
  const anchors = gitAnchors(projectDir);
  if (anchors.headSubject) anchors.headSubject = redactSecretLikeContent(anchors.headSubject);
  if (anchors.branch) anchors.branch = redactSecretLikeContent(anchors.branch);
  if (anchors.repo) anchors.repo = redactSecretLikeContent(anchors.repo);
  if (anchors.dirtyFiles) anchors.dirtyFiles = anchors.dirtyFiles.map(redactSecretLikeContent);
  return anchors;
}

function checkpointRecordedAnchors(artifact: CheckpointArtifactV1): GitAnchors {
  const git = artifact.anchors.git;
  if (!git) return { isRepo: false };
  return {
    isRepo: true,
    repo: git.repo,
    branch: git.branch,
    head: git.head,
    dirtyCount: git.dirty === undefined ? undefined : git.dirty ? 1 : 0,
  };
}

function projectMatchesCheckpoint(
  artifact: CheckpointArtifactV1,
  identity: Awaited<ReturnType<typeof resolveCheckpointProjectIdentity>>,
): boolean {
  return artifact.project.projectId && identity.projectId
    ? artifact.project.projectId === identity.projectId
    : artifact.project.cwdHash === identity.cwdHash;
}

async function currentActivationDegradations(workspace?: Workspace): Promise<Map<string, HandoffCandidate['activationDegradation']>> {
  const out = new Map<string, HandoffCandidate['activationDegradation']>();
  if (!workspace) return out;
  let rows: Awaited<ReturnType<typeof readActivationEvidence>>;
  try { rows = await readActivationEvidence(workspace); } catch { return out; }
  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) latest.set(row.runtime, row);
  for (const row of latest.values()) {
    if (row.status === 'failed') {
      out.set(row.runtime, {
        runtime: row.runtime,
        observedAt: row.observedAt,
        reasonCode: 'activation_latest_event_failed',
      });
    }
  }
  return out;
}

async function readFloorJournalBody(workspace: Workspace, event: MemoryEvent): Promise<string | undefined> {
  const entryAt = typeof event.metadata?.entryAt === 'string' ? event.metadata.entryAt : '';
  const expectedHash = typeof event.metadata?.entryHash === 'string' ? event.metadata.entryHash : '';
  if (!event.path || !entryAt || !expectedHash) return undefined;
  try {
    const file = absoluteFromMemoryPath(workspace, event.path);
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > FLOOR_JOURNAL_MAX_BYTES) return undefined;
    const raw = await fs.readFile(file, 'utf8');
    const marker = `\n## ${entryAt} ·`;
    let start = raw.indexOf(marker);
    while (start >= 0) {
      const next = raw.indexOf('\n## ', start + marker.length);
      const block = raw.slice(start + 1, next < 0 ? raw.length : next);
      const split = block.indexOf('\n\n');
      if (split >= 0) {
        const body = block.slice(split + 2).trim();
        const actualHash = crypto.createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 16);
        if (actualHash === expectedHash) return redactSecretLikeContent(body);
      }
      start = raw.indexOf(marker, start + marker.length);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function floorJournalCandidates(
  workspace: Workspace | undefined,
  sessions: ResumableSession[],
  needle: string | undefined,
  now: number,
): Promise<HandoffCandidate[]> {
  if (!workspace) return [];
  let events: MemoryEvent[];
  try { events = await readEventsAllLanes(workspace); } catch { return []; }
  const transcriptKeys = new Set(sessions.map((session) => `${session.tool}::${session.sessionId}`));
  const recent = events
    .filter((event) => event.type === 'memory.journal.appended' && event.metadata?.floor === true)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, 20);
  const out: HandoffCandidate[] = [];
  for (const event of recent) {
    const runtime = typeof event.metadata?.floorRuntime === 'string' ? event.metadata.floorRuntime : 'unknown';
    const sessionId = typeof event.metadata?.sessionId === 'string' ? event.metadata.sessionId : '';
    if (!sessionId || transcriptKeys.has(`${runtime}::${sessionId}`)) continue;
    const body = await readFloorJournalBody(workspace, event);
    if (!body || (needle && !body.toLowerCase().includes(needle))) continue;
    const capturedAt = Date.parse(event.at);
    if (!Number.isFinite(capturedAt)) continue;
    const ageMs = Math.max(0, now - capturedAt);
    out.push({
      tool: runtime,
      project: { basename: 'UNDETERMINED', projectId: 'undetermined' },
      confidence: 0.2,
      why: 'low-weight floor journal has no trustworthy project-path binding',
      anchors: { isRepo: false },
      narrative: { text: body, source: `${runtime}-floor-journal`, sessionId, capturedAt: event.at, unverified: true },
      freshness: { ageMs, stale: ageMs > STALE_HANDOFF_MS },
      conflicts: { staleShaRefs: 0, referencesCurrentHead: false },
      verifyFirst: [
        'confirm which project this floor journal belongs to before acting',
        'treat every floor-journal statement as an unverified low-weight claim',
      ],
      verdict: computeContinueVerdict({ isRepo: false }, undefined, body),
    });
  }
  return out;
}

// Pull a git SHA referenced near a HEAD/baseline marker out of a hand-written STATE doc — the verdict
// baseline for the first-run handoff (C1). Anchored on a marker so a random hex blob (a uuid fragment,
// a hash in prose) isn't mistaken for the project's HEAD.
export function referencedHead(text: string): string | undefined {
  // ASCII markers get \b (so HEAD doesn't match inside "ahead"/"forehead", commit inside "precommit");
  // the CJK 基线 can't take a \b (JS \b is ASCII-only) but is distinctive on its own. The negative
  // lookbehind keeps us off a sha256:/longer-hex tail (a docker digest is not a git commit). No bare
  // `@` — it matched emails / npm versions / digests and fabricated bogus baselines.
  const m = text.match(/(?:\bHEAD\b|\bbaseline\b|基线|\bcommit\b|\brev\b)[^\n]{0,24}?(?<![0-9a-f:])([0-9a-f]{7,40})\b/i);
  return m ? m[1].slice(0, 7) : undefined;
}

// Narrative imperatives that must never be acted on blind — kept in lockstep with the envelope's GREEN-lane
// prohibition set (envelope.ts: "no push/force/delete/publish/external-message/credential/change-a-default").
// If the prior session text contains any of these, even a matching-anchor resume is downgraded to YELLOW
// (verify intent before any irreversible or outward-facing action). The previous, narrower regex let
// `npm publish` / `gh release` / "send a message to the customer" / "rotate the credential" / "change the
// default" slip through to a confident GREEN — exactly the trust-without-verify this product exists to kill.
const DESTRUCTIVE_NARRATIVE =
  /\b(?:force[\s-]?push|git\s+push|push\s+(?:to|origin|upstream|--)|reset\s+--hard|rm\s+-rf|drop\s+(?:table|database)|delete\s+the|deploy(?:\s+to\s+prod|\b)|npm\s+publish|gh\s+release|publish\s+(?:the|a|to|it|this|release|package|version)|revoke|rotate\s+(?:the\s+)?(?:credential|secret|token|key|api|password)|send\s+(?:a\s+|an\s+)?(?:message|email|slack|dm|note|notification)|(?:message|notify|email|dm)\s+(?:the\s+)?(?:customer|client|user|team|them|everyone)|change\s+(?:a|the)\s+default)/i;

// Compute the resume verdict by re-reading the project's LIVE git state and comparing it to the anchors
// recorded when the session was captured. GREEN is narrow on purpose; on a different machine/checkout the
// recorded path won't match and we degrade to RED/YELLOW rather than a false GREEN.
export function computeContinueVerdict(
  recorded: GitAnchors,
  projectDir: string | undefined,
  narrative: string,
  opts: { inferred?: boolean; cwd?: string } = {},
): ContinueVerdict {
  // `inferred` = the baseline was guessed from a STATE doc (C1), not captured from a real session.
  // A doc-grepped hash is NOT a recorded snapshot, so it can never earn a confident GREEN or a hard
  // RED — cap it at YELLOW so the verdict's trust isn't architected away.
  const cap = (v: ContinueVerdict): ContinueVerdict =>
    opts.inferred && v.state !== 'YELLOW'
      ? { ...v, state: 'YELLOW', reason: `baseline inferred from a STATE doc, not a recorded session — ${v.reason}` }
      : v;
  if (!projectDir) {
    return { state: 'YELLOW', reason: 'project undetermined (no files edited) — confirm which project this resumes before acting' };
  }
  const live = gitAnchors(projectDir);
  if (!recorded.isRepo && !live.isRepo) {
    return { state: 'YELLOW', reason: 'no git anchors to verify against — read the project state live before relying on the narrative' };
  }
  if (recorded.isRepo && !live.isRepo) {
    return cap({ state: 'RED', reason: `recorded a git project, but ${projectDir} is not a git repo here (wrong checkout / moved / different machine) — do not assume the prior state` });
  }
  // RECEIVER-CONTEXT GATE (go/no-go #4): projectDir is INFERRED from the files the prior session edited —
  // it is NOT necessarily where the caller is sitting. If the caller passed a cwd that resolves to a
  // DIFFERENT git repo (or to no repo at all), we cannot vouch this is the same checkout, so we never hand
  // back a confident GREEN — a receiver that trusts the verdict could act in the wrong working tree. The
  // anchor match against projectDir may still hold, hence YELLOW (verify you're in the right place), not RED.
  // NOTE: gate on `opts.cwd !== undefined`, NOT on truthiness — an explicitly-provided but BLANK cwd
  // ("") is "I don't know where I am", which must NOT earn GREEN. (A falsy `&& opts.cwd` check let an
  // MCP client send {"cwd":""} and skip the gate straight to a confident GREEN.) An omitted cwd
  // (undefined) keeps the back-compat path for direct callers/tests that don't use the receiver gate.
  if (opts.cwd !== undefined && live.isRepo) {
    const projRoot = repoRoot(projectDir);
    const cwdRoot = opts.cwd.trim() ? repoRoot(opts.cwd) : null; // blank cwd → unverifiable → mismatch
    if (projRoot && cwdRoot !== projRoot) {
      return {
        state: 'YELLOW',
        reason: `your current directory is a different checkout than the recorded project (${projectDir}) — cd there (or pass the matching project) and re-verify before acting on this resume`,
        recordedHead: recorded.head,
        liveHead: live.head,
      };
    }
  }
  const rHead = recorded.head;
  const lHead = live.head;
  // A recorded HEAD too short to be a real abbreviated commit (git gives ≥7) can't be trusted to match —
  // a 1–2 char "anchor" prefix-matches almost any live HEAD into a false GREEN. Treat as unverifiable.
  if (rHead && lHead && Math.min(rHead.length, lHead.length) < 7) {
    return cap({ state: 'YELLOW', reason: `recorded HEAD anchor (${rHead}) is too short to verify against ${lHead} — confirm the checkout manually`, recordedHead: rHead, liveHead: lHead });
  }
  // Prefix-aware: git short-hashes can differ in length (git lengthens them in big repos to disambiguate),
  // so compare by common prefix, not ===, or the SAME commit reads as drift.
  const headMatch = !!rHead && !!lHead && (rHead.startsWith(lHead) || lHead.startsWith(rHead));
  if (rHead && lHead && !headMatch) {
    return cap({ state: 'RED', reason: `HEAD drifted: recorded ${rHead}, now ${lHead} — someone committed since; read the diff before continuing`, recordedHead: rHead, liveHead: lHead });
  }
  if (!rHead || !lHead) {
    return { state: 'YELLOW', reason: 'could not read HEAD on both sides — verify the project state live', recordedHead: rHead, liveHead: lHead };
  }
  if (recorded.branch && live.branch && recorded.branch !== live.branch) {
    return { state: 'YELLOW', reason: `same HEAD but on a different branch (recorded ${recorded.branch}, now ${live.branch}) — confirm you're where you meant to be`, recordedHead: rHead, liveHead: lHead };
  }
  if (DESTRUCTIVE_NARRATIVE.test(narrative)) {
    return { state: 'YELLOW', reason: `anchors match (HEAD ${lHead}), but the prior narrative mentions a push/force/delete — verify intent before any destructive action`, recordedHead: rHead, liveHead: lHead };
  }
  const dirty = live.dirtyCount ? ` · ${live.dirtyCount} uncommitted change(s)` : '';
  return cap({ state: 'GREEN', reason: `anchors match: HEAD ${lHead}${live.branch ? ` on ${live.branch}` : ''}${dirty} — safe to pick up (the narrative itself is still an unverified claim)`, recordedHead: rHead, liveHead: lHead });
}

// Assemble the cross-runtime handoff packet: candidate resumable projects, each with machine anchors
// (the only facts), the prior narrative VERBATIM + UNVERIFIED, code-computed freshness + anchor
// conflicts, and what to verify first. Read-only. The receiver (any MCP runtime) does the resuming.
export async function buildHandoffPacket(opts: {
  cwd?: string;
  projectHint?: string;
  limit?: number;
  excludeSessionId?: string;
  workspace?: Workspace;
}): Promise<HandoffPacket> {
  const limit = Number.isFinite(opts.limit) && (opts.limit as number) > 0 ? Math.min(Math.floor(opts.limit as number), 20) : 5;
  const needle = opts.projectHint?.trim().toLowerCase();
  // With a hint, scan a wider window before filtering so a match further back isn't missed; without one,
  // a small over-fetch is enough (we only return `limit`).
  let sessions = await listResumableSessions(needle ? 100 : limit * 3, opts.excludeSessionId);
  if (needle) sessions = sessions.filter((s) => `${s.projectDir ?? ''}\n${s.body}`.toLowerCase().includes(needle));
  const now = Date.now();
  const transcriptCandidates: HandoffCandidate[] = sessions.map((s) => {
    const ageMs = now - Date.parse(s.modifiedAt);
    const conflict = anchorConflicts(s.body, s.anchors.isRepo ? s.anchors.head : undefined);
    const basename = s.projectDir ? path.basename(s.projectDir) : 'UNDETERMINED';
    return {
      tool: s.tool,
      project: { path: s.projectDir, basename, projectId: projectIdFor(s.projectDir) },
      confidence: s.projectDir ? 0.8 : 0.3,
      why: s.projectDir
        ? `inferred from files edited this session in ${basename}`
        : 'no files were edited this session — project undetermined',
      anchors: s.anchors,
      narrative: { text: s.body, source: `${s.tool}-transcript`, sessionId: s.sessionId, capturedAt: s.modifiedAt, unverified: true },
      freshness: { ageMs, stale: ageMs > STALE_HANDOFF_MS },
      conflicts: { staleShaRefs: conflict.stale, referencesCurrentHead: conflict.referencesHead },
      verifyFirst: [
        s.anchors.isRepo
          ? `run \`git -C ${s.projectDir} rev-parse --short HEAD\` and compare to anchors.head (${s.anchors.head ?? '?'})`
          : 'no git project inferred — confirm which project this is before acting',
        'check that files/paths the narrative mentions actually exist',
        'treat any "done / passing / shipped / approved" in the narrative as a claim to verify, not a fact',
      ],
      verdict: computeContinueVerdict(s.anchors, s.projectDir, s.body, { cwd: opts.cwd }),
    };
  });
  let checkpointLookup: HandoffPacket['checkpointLookup'];
  const checkpointCandidates: HandoffCandidate[] = [];
  const degradation = await currentActivationDegradations(opts.workspace);
  if (opts.workspace) {
    const snapshot = await readCheckpointArtifactSnapshot(opts.workspace);
    checkpointLookup = {
      status: snapshot.status,
      ...(snapshot.reasonCode ? { reasonCode: snapshot.reasonCode } : {}),
    };
    // A degraded namespace may be missing a newer/canonical artifact. Fall back to transcript/floor
    // rather than presenting a partial scan as checkpoint authority.
    if (snapshot.status === 'ok') {
      const projectPaths = new Set<string>();
      const addProjectPath = (value: string): void => {
        const resolved = path.resolve(value);
        projectPaths.add(repoRoot(resolved) ?? resolved);
      };
      if (typeof opts.cwd === 'string' && opts.cwd.trim()) addProjectPath(opts.cwd);
      for (const session of sessions) if (session.projectDir) addProjectPath(session.projectDir);
      const seenArtifacts = new Set<string>();
      for (const projectDir of projectPaths) {
        let identity: Awaited<ReturnType<typeof resolveCheckpointProjectIdentity>>;
        try { identity = await resolveCheckpointProjectIdentity({ cwd: projectDir }, opts.workspace); } catch { continue; }
        const matches = snapshot.artifacts
          .filter((artifact) => projectMatchesCheckpoint(artifact, identity))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
        const selected = [
          matches.find((artifact) => artifact.coverage.complete),
          matches.find((artifact) => !artifact.coverage.complete),
        ].filter((artifact): artifact is CheckpointArtifactV1 => !!artifact);
        for (const artifact of selected) {
          if (seenArtifacts.has(artifact.id)) continue;
          const narrative = canonicalCheckpointJson(artifact.state);
          if (needle && !`${projectDir}\n${narrative}`.toLowerCase().includes(needle)) continue;
          seenArtifacts.add(artifact.id);
          const anchors = redactLiveAnchors(projectDir);
          const conflict = anchorConflicts(narrative, anchors.isRepo ? anchors.head : undefined);
          const ageMs = Math.max(0, now - Date.parse(artifact.createdAt));
          const classification = artifact.coverage.complete ? 'complete' : 'partial';
          const activationDegradation = degradation.get(artifact.session.runtime);
          checkpointCandidates.push({
            tool: artifact.session.runtime,
            project: { path: projectDir, basename: path.basename(projectDir), projectId: projectIdFor(projectDir) },
            confidence: 0.95,
            why: `same-project immutable ${classification} checkpoint`,
            anchors,
            narrative: {
              text: narrative,
              source: `checkpoint-${classification}`,
              sessionId: artifact.session.sessionIdHash ?? artifact.id,
              capturedAt: artifact.createdAt,
              unverified: true,
            },
            freshness: { ageMs, stale: ageMs > STALE_HANDOFF_MS },
            conflicts: { staleShaRefs: conflict.stale, referencesCurrentHead: conflict.referencesHead },
            verifyFirst: [
              artifact.anchors.git?.head
                ? `compare live HEAD to recorded checkpoint HEAD (${artifact.anchors.git.head})`
                : 'checkpoint has no recorded git HEAD — inspect the project state live',
              'treat the checkpoint state JSON as bounded UNVERIFIED claims, not authoritative next actions',
              'inspect the checkpoint evidence refs before relying on completion claims',
            ],
            verdict: computeContinueVerdict(
              checkpointRecordedAnchors(artifact),
              projectDir,
              narrative,
              { cwd: opts.cwd },
            ),
            checkpoint: {
              artifactId: artifact.id,
              classification,
              triggerKind: artifact.trigger.kind,
              triggerSignal: artifact.trigger.signal,
              reasonCode: artifact.trigger.reasonCode,
              coverage: structuredClone(artifact.coverage),
              evidenceRefs: structuredClone(artifact.evidence),
            },
            ...(activationDegradation ? { activationDegradation } : {}),
          });
        }
      }
      checkpointCandidates.sort((a, b) => (
        (a.checkpoint?.classification === b.checkpoint?.classification
          ? b.narrative.capturedAt.localeCompare(a.narrative.capturedAt)
          : a.checkpoint?.classification === 'complete' ? -1 : 1)
      ));
    }
  }
  const floorCandidates = await floorJournalCandidates(opts.workspace, sessions, needle, now);
  for (const candidate of [...transcriptCandidates, ...floorCandidates]) {
    const activationDegradation = degradation.get(candidate.tool);
    if (activationDegradation) candidate.activationDegradation = activationDegradation;
  }
  const candidates = [...checkpointCandidates, ...transcriptCandidates, ...floorCandidates].slice(0, limit);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    query: { cwd: opts.cwd, projectHint: opts.projectHint, limit },
    candidates,
    ...(checkpointLookup ? { checkpointLookup } : {}),
    receiverProtocol: HANDOFF_PACKET_RECEIVER_INSTRUCTION,
    note: 'MACHINE ANCHORS are the only facts (git, code-computed). Every candidate narrative is source-attributed, bounded, and UNVERIFIED — verify before acting. This tool produces a handoff packet; it does not itself resume.',
  };
}
