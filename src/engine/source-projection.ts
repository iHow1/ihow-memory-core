// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory

// This generation is part of the FTS table's schema, not a separate marker that
// an older writer could leave behind when it drops/recreates memory_fts.
export const FTS_SOURCE_TEXT_COLUMN = 'source_text_v1';

// Exact operational fields, removed ONLY from a recognizable Core envelope.
// No names are globally reserved on user-authored Markdown.
const OPERATIONAL_FIELDS = new Set([
  'created_at', 'promoted_at', 'candidate_id',
  'flagged', 'reviewed', 'tier', 'auto_tier',
]);
const TOP_LEVEL_FIELD = /^(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([A-Za-z_][A-Za-z0-9_.-]*))[ \t]*:[ \t]*(.*)$/;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

function scalar(raw: string): string | undefined {
  const value = raw.trim();
  if (value.startsWith('"')) {
    try { const parsed: unknown = JSON.parse(value); return typeof parsed === 'string' ? parsed : undefined; }
    catch { return undefined; }
  }
  if (value.startsWith("'")) return value.endsWith("'") ? value.slice(1, -1).replace(/''/g, "'") : undefined;
  return value;
}

export function projectFtsSourceText(original: string): string {
  // Only a complete leading block with a standalone closing delimiter is metadata.
  const opening = /^\uFEFF?[ \t]*(?:\r?\n[ \t]*)*---[ \t]*\r?\n/.exec(original);
  if (!opening) return original;
  const remainder = original.slice(opening[0].length);
  const closing = /^---[ \t]*(?:\r?\n|$)/m.exec(remainder);
  if (!closing) return original;
  const metadata = remainder.slice(0, closing.index);
  let content = remainder.slice(closing.index + closing[0].length);
  const fields = new Map<string, string | undefined>();
  for (const line of metadata.split(/\r?\n/)) {
    const field = TOP_LEVEL_FIELD.exec(line);
    if (field) fields.set((field[1] ?? field[2] ?? field[3]).toLowerCase(), scalar(field[4]));
  }
  const candidateId = fields.get('candidate_id');
  const type = fields.get('type');
  const status = fields.get('status');
  // markdownCandidate emits this combination, and promote preserves it while
  // changing type/status together. Dates alone or generic keys are insufficient.
  const owned = candidateId !== undefined && new RegExp(`^${UUID}$`, 'i').test(candidateId)
    && ((type === 'memory_candidate' && status === 'candidate') || (type === 'memory' && status === 'promoted'))
    && Boolean(fields.get('source_agent')) && Boolean(fields.get('created_at'));
  if (!owned) return original;
  const kept: string[] = [];
  let skip = false;
  for (const line of metadata.split(/\r?\n/)) {
    const field = TOP_LEVEL_FIELD.exec(line);
    if (field) {
      const name = (field[1] ?? field[2] ?? field[3]).toLowerCase();
      skip = OPERATIONAL_FIELDS.has(name) || name.startsWith('durable_write_');
    }
    // Keep unknown fields as raw blocks: nested objects, arrays, multiline
    // values and custom business dates remain searchable without a YAML parser.
    if (!skip) kept.push(line);
  }
  const heading = new RegExp(`^\\s*# Candidate (${UUID})[ \\t]*(?:\\r?\\n|$)`, 'i').exec(content);
  if (heading && candidateId?.toLowerCase() === heading[1].toLowerCase()) {
    content = content.slice(heading[0].length);
  }
  return `${kept.join('\n')}\n${content}`;
}
