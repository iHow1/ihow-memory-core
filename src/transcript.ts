// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Deterministic transcript capture for the automation-v2 floor. Parses a Claude Code transcript
// (jsonl) and composes a low-weight handoff summary for SessionStart-next-session floor capture.
//
// SCOPE IS LOCKED (security red line, OpenClaw-approved 2026-06-16): the composed body draws ONLY
// from assistant TEXT + file PATHS (Read/Write/Edit/NotebookEdit) + Bash command BINARY NAMES +
// the first user prompt. It NEVER reads tool_result content (the largest leak surface) and never
// dumps raw Bash. The RAW body returned here MUST be passed through redactSecretLikeContent before
// it reaches the hard detector / journal — this module extracts within scope, the caller redacts.
//
// Segment selection is v2 "last substantive segment" (dogfood 2026-06-16, 12 real transcripts +
// adversarial grading: v1 "longest of last 10" scored misleading 42% because the longest segment
// is usually a MID-session progress report frozen as a false "done"; v2 scored misleading 0% /
// useful 83% by biasing toward the terminal handoff). The selector emits metadata so dogfood can
// audit which segment was chosen and a v3 can add handoff-signal weighting.

import os from 'node:os';

export type TranscriptRecord = { type: string; message?: { content?: unknown } };

export type SelectorMeta = {
  window: number; // trailing assistant segments considered
  threshold: number; // min chars to count a segment "substantive"
  chosenIndex: number; // index within the window from the end (negative); -1 when empty
  chosenChars: number; // length of the chosen segment after whitespace collapse + cap
  fallbackReason: '' | 'fallback_longest' | 'empty'; // '' = a substantive segment was found
  tailDistance: number; // segments from the end (0 = last); -1 when empty — for v3 audit
};

export type TranscriptSummary = {
  body: string; // RAW composed body (NOT yet redacted — caller MUST redact before journaling)
  selector: SelectorMeta;
  files: number;
  fileList: string[]; // raw absolute paths of touched files — for inferring which project this was
  editedList: string[]; // raw absolute paths of files WRITTEN/EDITED — the strongest project signal
  cmds: number;
  turns: number;
};

const MAX_BODY = 1600;
const MAX_FILES = 12;
const CLOSING_WINDOW = 8; // v2: consider the last 8 assistant segments
const CLOSING_MIN_CHARS = 160; // v2: first one (walking from the end) at/above this is the closing
const CLOSING_CAP = 500;
// shell glue that is never a meaningful "Did" binary
const GLUE = new Set(['cd', 'echo', 'then', 'fi', 'if', 'for', 'do', 'done', 'else', 'export', 'set', '[', 'test', 'sudo', 'env']);

// Strip heredoc bodies (`cmd <<TAG ... \nTAG`) before tokenizing. A heredoc body is literal data (a
// commit message, a file written via `cat <<EOF`, a node script) — NOT a sequence of commands — so its
// lines must not be split into fake "binaries" (dogfood 2026-06-17 saw `EOF` and content words like
// `workspace`/`memory` leak into the Did line). Quote-protected `node -e '...'` is already safe via
// splitTopLevel; this handles the unquoted heredoc case. Conservative: only well-formed <<TAG…TAG blocks.
function stripHeredocs(cmd: string): string {
  return cmd.replace(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1[\s\S]*?\n\s*\2\b[^\n]*/g, ' ');
}

// Split a shell command on TOP-LEVEL operators (& | ; newline) only — never inside single/double
// quotes. Without quote-awareness, a quoted regex such as `grep -E "marker|hook-stop|runStopHook"`
// would split on the alternation `|` and leak `marker`/`hook-stop`/`runStopHook` as fake "binaries"
// in the Did line (dogfood 2026-06-17 caught exactly this noise). Pipes/operators OUTSIDE quotes are
// real command separators and still split, so genuine pipelines still yield each stage's binary.
function splitTopLevel(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === '&' || ch === '|' || ch === ';' || ch === '\n') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// Extract plain text from a message.content that is a STRING or an ARRAY of blocks. Only text
// blocks count; tool_use / tool_result / thinking / image are skipped (the scope red line).
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type: string; text: string } => !!b && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
    .map((b) => b.text)
    .join('\n');
}

function blocksOf(content: unknown): Array<Record<string, unknown>> {
  return Array.isArray(content) ? (content as Array<Record<string, unknown>>) : [];
}

// Parse a transcript's raw jsonl into conversational records. Tolerant by design: content may be a
// string or a block array, non-conversational lines (attachment / queue-operation / ai-title / …)
// are skipped, and a malformed line never throws — it is skipped so capture never crashes a hook.
export function parseTranscript(raw: string): TranscriptRecord[] {
  const out: TranscriptRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // never throw per line
    }
    const r = rec as TranscriptRecord;
    if (r && r.message && (r.type === 'user' || r.type === 'assistant')) out.push(r);
  }
  return out;
}

// v2 closing selector: walk backward over the last CLOSING_WINDOW assistant segments and pick the
// first with >= CLOSING_MIN_CHARS chars. Rationale (dogfood-proven): the terminal handoff lives
// near the end, while the LONGEST segment is typically a mid-session milestone that later turns
// stale. If nothing qualifies, fall back to the longest of the window and record it so dogfood can
// see how often the fallback fires.
function pickClosing(assistantTexts: string[]): { text: string; meta: SelectorMeta } {
  const tail = assistantTexts.slice(-CLOSING_WINDOW).map((s) => s.replace(/\s+/g, ' ').trim());
  const window = tail.length;
  for (let i = tail.length - 1; i >= 0; i--) {
    if (tail[i].length >= CLOSING_MIN_CHARS) {
      const text = tail[i].slice(0, CLOSING_CAP);
      return {
        text,
        meta: { window, threshold: CLOSING_MIN_CHARS, chosenIndex: i - tail.length, chosenChars: text.length, fallbackReason: '', tailDistance: tail.length - 1 - i },
      };
    }
  }
  // fallback: longest of the window (last one wins ties, biasing slightly toward the end)
  let bestIdx = -1;
  let bestLen = -1;
  tail.forEach((s, i) => {
    if (s.length >= bestLen) {
      bestLen = s.length;
      bestIdx = i;
    }
  });
  const text = bestIdx >= 0 ? tail[bestIdx].slice(0, CLOSING_CAP) : '';
  return {
    text,
    meta: {
      window,
      threshold: CLOSING_MIN_CHARS,
      chosenIndex: bestIdx >= 0 ? bestIdx - tail.length : -1,
      chosenChars: text.length,
      fallbackReason: text ? 'fallback_longest' : 'empty',
      tailDistance: bestIdx >= 0 ? tail.length - 1 - bestIdx : -1,
    },
  };
}

// Compose a deterministic handoff summary within the LOCKED scope. Returns the RAW body plus
// selector metadata; the caller MUST run body through redactSecretLikeContent before journaling.
export function summarizeTranscript(records: TranscriptRecord[]): TranscriptSummary {
  // first user prompt = session topic (note: often a meta/greeting; v3 may skip to first substantive)
  let topic = '';
  for (const r of records) {
    if (r.type === 'user') {
      const t = textOf(r.message?.content).trim();
      if (t) {
        topic = t;
        break;
      }
    }
  }

  const files = new Set<string>();
  const edited = new Set<string>(); // Write/Edit/NotebookEdit only — the project being WORKED ON
  let cmdCount = 0;
  const cmdBins = new Set<string>();
  for (const r of records) {
    if (r.type !== 'assistant') continue;
    for (const b of blocksOf(r.message?.content)) {
      if (b && b.type === 'tool_use' && b.input && typeof b.input === 'object') {
        const input = b.input as Record<string, unknown>;
        if (['Read', 'Write', 'Edit', 'NotebookEdit'].includes(b.name as string) && typeof input.file_path === 'string') {
          files.add(input.file_path);
          if (b.name !== 'Read') edited.add(input.file_path); // a write/edit signals the active project
        } else if (b.name === 'Bash' && typeof input.command === 'string') {
          cmdCount += 1;
          // a raw command dump is both noise AND a leak surface; keep only meaningful binary names
          for (const seg of splitTopLevel(stripHeredocs(input.command))) {
            const tok = seg.trim().split(/\s+/)[0];
            if (!tok) continue;
            const bin = tok.replace(/^.*\//, '').replace(/['"]/g, '');
            if (bin && /^[A-Za-z][\w.-]*$/.test(bin) && !GLUE.has(bin)) cmdBins.add(bin);
          }
        }
      }
    }
  }

  const assistantTexts = records
    .filter((r) => r.type === 'assistant')
    .map((r) => textOf(r.message?.content).trim())
    .filter(Boolean);
  const { text: closing, meta } = pickClosing(assistantTexts);

  const parts: string[] = [];
  if (topic) parts.push(`Topic: ${topic.replace(/\s+/g, ' ').slice(0, 200)}`);
  if (files.size) parts.push(`Files: ${[...files].slice(0, MAX_FILES).map((f) => f.replace(os.homedir(), '~')).join(', ')}`);
  if (cmdCount) parts.push(`Did: ${cmdCount} shell commands (${[...cmdBins].slice(0, 10).join(', ')})`);
  if (closing) parts.push(`Summary: ${closing}`);

  return { body: parts.join('\n').slice(0, MAX_BODY), selector: meta, files: files.size, fileList: [...files].slice(0, MAX_FILES), editedList: [...edited].slice(0, 30), cmds: cmdCount, turns: assistantTexts.length };
}
