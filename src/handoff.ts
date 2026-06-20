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
import { parseTranscript, summarizeTranscript } from './transcript.ts';
import { gitAnchors, inferProjectDir, type GitAnchors } from './anchors.ts';
import { redactSecretLikeContent } from './governance.ts';
import { anchorConflicts } from './handoff-metrics.ts';
import { RECEIVER_INSTRUCTION } from './envelope.ts';

export type ResumableSession = {
  sessionId: string;
  transcriptPath: string;
  projectDir?: string; // inferred from EDITED files only (never reads) — undefined => UNDETERMINED
  modifiedAt: string; // transcript file mtime, ISO — the "last activity" used for sort + display
  anchors: GitAnchors; // git facts for projectDir (machine-verified; free-text fields redacted)
  body: string; // full redacted prior-session narrative (UNVERIFIED) — the handoff narrative source
  snippet: string; // single-line fragment of body for compact list rendering
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
    let raw: string;
    try {
      raw = await fs.readFile(full, 'utf8');
    } catch {
      continue; // skip an unreadable transcript
    }
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

// Enumerate the most recent RESUMABLE sessions across EVERY project recorded under
// ~/.claude/projects/*/, newest activity first. Reuses the same primitives as pickTranscriptHandoff:
// substantive threshold, edits-only inference (read-only session stays UNDETERMINED), excludeSessionId
// (no self-replay), redaction on every free-text field. Read-only; never throws on a single bad file.
export async function listResumableSessions(
  limit: number,
  excludeSessionId?: string,
): Promise<ResumableSession[]> {
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
  let projectDirs: string[];
  try {
    projectDirs = await fs.readdir(projectsRoot);
  } catch {
    return []; // no Claude Code projects dir at all -> nothing to list
  }
  const MIN_ENTRIES = 4; // skip trivial / freshly-cleared sessions (same threshold as pickTranscriptHandoff)
  const stamped: Array<{ full: string; sessionId: string; mtimeMs: number }> = [];
  for (const enc of projectDirs) {
    const dir = path.join(projectsRoot, enc);
    let files: string[];
    try {
      files = (await fs.readdir(dir)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue; // not a readable dir (or a stray file) -> skip
    }
    for (const f of files) {
      const sessionId = f.replace(/\.jsonl$/, '');
      // Never list the CURRENTLY-RUNNING session (self-replay guard, same as continue).
      if (excludeSessionId && sessionId === excludeSessionId) continue;
      const full = path.join(dir, f);
      try {
        stamped.push({ full, sessionId, mtimeMs: (await fs.stat(full)).mtimeMs });
      } catch {
        // skip an unstattable file
      }
    }
  }
  stamped.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest activity first
  const SCAN_CAP = Math.max(limit * 4, limit + 8); // bound parsing work
  const out: ResumableSession[] = [];
  for (const { full, sessionId, mtimeMs } of stamped.slice(0, SCAN_CAP)) {
    if (out.length >= limit) break;
    let raw: string;
    try {
      raw = await fs.readFile(full, 'utf8');
    } catch {
      continue; // unreadable transcript -> skip
    }
    const records = parseTranscript(raw);
    if (records.length < MIN_ENTRIES) continue; // trivial / freshly-cleared
    const summary = summarizeTranscript(records);
    const projectDir = inferProjectDir(summary.editedList); // EDITED files only
    const anchors = gitAnchors(projectDir ?? path.dirname(full));
    if (projectDir) {
      if (anchors.headSubject) anchors.headSubject = redactSecretLikeContent(anchors.headSubject);
      if (anchors.branch) anchors.branch = redactSecretLikeContent(anchors.branch);
      if (anchors.repo) anchors.repo = redactSecretLikeContent(anchors.repo);
      if (anchors.dirtyFiles) anchors.dirtyFiles = anchors.dirtyFiles.map(redactSecretLikeContent);
    }
    const body = redactSecretLikeContent(summary.body);
    const snippet = body.replace(/\s+/g, ' ').trim().slice(0, 160);
    out.push({
      sessionId,
      transcriptPath: full,
      projectDir,
      modifiedAt: new Date(mtimeMs).toISOString(),
      anchors: projectDir ? anchors : { isRepo: false },
      body,
      snippet,
    });
  }
  return out;
}

// ---- runtime-neutral handoff packet (the `memory.continue` MCP output) ----

export type HandoffCandidate = {
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
  let sessions = await listResumableSessions(limit * 3, opts.excludeSessionId); // over-fetch, then filter by hint
  const needle = opts.projectHint?.trim().toLowerCase();
  if (needle) sessions = sessions.filter((s) => `${s.projectDir ?? ''}\n${s.body}`.toLowerCase().includes(needle));
  sessions = sessions.slice(0, limit);
  const now = Date.now();
  const candidates: HandoffCandidate[] = sessions.map((s) => {
    const ageMs = now - Date.parse(s.modifiedAt);
    const conflict = anchorConflicts(s.body, s.anchors.isRepo ? s.anchors.head : undefined);
    const basename = s.projectDir ? path.basename(s.projectDir) : 'UNDETERMINED';
    return {
      project: { path: s.projectDir, basename, projectId: projectIdFor(s.projectDir) },
      confidence: s.projectDir ? 0.8 : 0.3,
      why: s.projectDir
        ? `inferred from files edited this session in ${basename}`
        : 'no files were edited this session — project undetermined',
      anchors: s.anchors,
      narrative: { text: s.body, source: 'claude-transcript', sessionId: s.sessionId, capturedAt: s.modifiedAt, unverified: true },
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
