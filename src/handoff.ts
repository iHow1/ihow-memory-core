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
import { parseTranscript, summarizeTranscript, type TranscriptRecord } from './transcript.ts';
import { gitAnchors, inferProjectDir, type GitAnchors } from './anchors.ts';
import { redactSecretLikeContent } from './governance.ts';
import { anchorConflicts } from './handoff-metrics.ts';
import { RECEIVER_INSTRUCTION } from './envelope.ts';

export type ResumableSession = {
  sessionId: string;
  tool: string; // which runtime recorded it: claude-code | codex | ...
  transcriptPath: string;
  projectDir?: string; // inferred from EDITED files only (never reads) — undefined => UNDETERMINED
  modifiedAt: string; // transcript file mtime, ISO — the "last activity" used for sort + display
  anchors: GitAnchors; // git facts for projectDir (machine-verified; free-text fields redacted)
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
  read: (file: string) => Promise<CaptureUnit | undefined>; // undefined => trivial/unreadable, skip
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

const SESSION_SOURCES: SessionSource[] = [claudeSource, codexSource, workbuddySource, openclawSource];

// Enumerate the most recent RESUMABLE sessions across EVERY recorded runtime (Claude, Codex, ...),
// newest activity first. Each source contributes a reader; project inference, anchors and redaction are
// shared. excludeSessionId guards self-replay. Read-only; never throws on a single bad file.
export async function listResumableSessions(
  limit: number,
  excludeSessionId?: string,
): Promise<ResumableSession[]> {
  const stamped: Array<{ file: string; mtimeMs: number; src: SessionSource }> = [];
  for (const src of SESSION_SOURCES) {
    for (const f of await src.list()) stamped.push({ ...f, src });
  }
  stamped.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest activity first across all tools
  const SCAN_CAP = Math.max(limit * 4, limit + 8); // bound parsing work
  const out: ResumableSession[] = [];
  const anchorCache = new Map<string, GitAnchors>(); // memoize per project — many sessions share one repo
  for (const { file, mtimeMs, src } of stamped.slice(0, SCAN_CAP)) {
    if (out.length >= limit) break;
    let unit: CaptureUnit | undefined;
    try { unit = await src.read(file); } catch { unit = undefined; }
    if (!unit) continue;
    if (excludeSessionId && unit.sessionId === excludeSessionId) continue; // no self-replay
    const projectDir = unit.projectDir ?? inferProjectDir(unit.editedList); // tool-recorded cwd wins; else edits-only
    // Compute git anchors ONLY for a real project (don't spawn git on the transcript-storage dir for an
    // undetermined session), and memoize per project so N sessions in one repo cost one anchor lookup.
    let anchors: GitAnchors = { isRepo: false };
    if (projectDir) {
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
    const body = redactSecretLikeContent(unit.body);
    const snippet = body.replace(/\s+/g, ' ').trim().slice(0, 160);
    out.push({
      sessionId: unit.sessionId,
      tool: src.tool,
      transcriptPath: file,
      projectDir,
      modifiedAt: new Date(mtimeMs).toISOString(),
      anchors,
      body,
      snippet,
    });
  }
  return out;
}

// ---- runtime-neutral handoff packet (the `memory.continue` MCP output) ----

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
};

export type HandoffPacket = {
  schemaVersion: number;
  generatedAt: string;
  query: { cwd?: string; projectHint?: string; limit: number };
  candidates: HandoffCandidate[]; // a LIST — project identification is ambiguous; never force a single pick
  receiverProtocol: string;
  note: string;
};

const STALE_HANDOFF_MS = 24 * 60 * 60 * 1000;

function projectIdFor(p?: string): string {
  if (!p) return 'undetermined';
  return crypto.createHash('sha256').update(path.resolve(p)).digest('hex').slice(0, 12);
}

// Assemble the cross-runtime handoff packet: candidate resumable projects, each with machine anchors
// (the only facts), the prior narrative VERBATIM + UNVERIFIED, code-computed freshness + anchor
// conflicts, and what to verify first. Read-only. The receiver (any MCP runtime) does the resuming.
export async function buildHandoffPacket(opts: {
  cwd?: string;
  projectHint?: string;
  limit?: number;
  excludeSessionId?: string;
}): Promise<HandoffPacket> {
  const limit = Number.isFinite(opts.limit) && (opts.limit as number) > 0 ? Math.min(Math.floor(opts.limit as number), 20) : 5;
  const needle = opts.projectHint?.trim().toLowerCase();
  // With a hint, scan a wider window before filtering so a match further back isn't missed; without one,
  // a small over-fetch is enough (we only return `limit`).
  let sessions = await listResumableSessions(needle ? 100 : limit * 3, opts.excludeSessionId);
  if (needle) sessions = sessions.filter((s) => `${s.projectDir ?? ''}\n${s.body}`.toLowerCase().includes(needle));
  sessions = sessions.slice(0, limit);
  const now = Date.now();
  const candidates: HandoffCandidate[] = sessions.map((s) => {
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
    };
  });
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    query: { cwd: opts.cwd, projectHint: opts.projectHint, limit },
    candidates,
    receiverProtocol: RECEIVER_INSTRUCTION,
    note: 'MACHINE ANCHORS are the only facts (git, code-computed). The narrative is the prior agent\'s VERBATIM, UNVERIFIED claim — verify before acting. This tool produces a handoff packet; it does not itself resume.',
  };
}
