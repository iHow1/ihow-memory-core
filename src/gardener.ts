// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { JsonRecord, Workspace } from './types.ts';
import { appendEvent } from './store/events.ts';
import { atomicWriteFile, listMarkdownFiles, safeFileSlug } from './store/files.ts';
import { containsSecretLikeContent, redactSecretLikeContent } from './governance.ts';
import { withWorkspaceLock } from './store/lock.ts';
import { relativeToSpace } from './workspace.ts';

export type GardenerEvidence = {
  source: string;
  lineStart: number;
  lineEnd: number;
  quote: string;
};

export type GardenerClaimKind = 'evidence' | 'inference' | 'open-question';
export type GardenerItemType = 'decision' | 'fact' | 'next_action' | 'open_question';

export type GardenerItem = {
  id: string;
  type: GardenerItemType;
  text: string;
  claim_kind: GardenerClaimKind;
  evidence: GardenerEvidence[];
  flags: Array<'duplicate_candidate' | 'stale_candidate'>;
  duplicateOf?: string;
};

export type GardenerFlag = {
  id: string;
  kind: 'duplicate_candidate' | 'stale_candidate';
  targetIds: string[];
  reason: string;
  destructive: false;
  evidence: GardenerEvidence[];
};

export type GardenerDraft = {
  schema_version: 'alpha24.gardener.v1';
  draft_id: string;
  mode: 'review-first';
  source_of_truth: 'draft artifact only; curated memory is not rewritten';
  created_at: string;
  scope_label: string;
  source_window: { since: string | null };
  current_state_summary: {
    kind: 'inference';
    text: string;
    evidence: GardenerEvidence[];
  };
  decisions_facts: GardenerItem[];
  next_actions_open_questions: GardenerItem[];
  duplicate_stale_flags: GardenerFlag[];
  sources: Array<{ source: string; sha256: string; lines: number; visibility: 'project' | 'private' | 'audit-only' | 'source-local' | 'source-shared' }>;
  safety: {
    secret_redaction: 'passed' | 'redacted';
    redacted_items: number;
    blocked_items: number;
    export_safe: boolean;
    out_of_scope_sources_excluded: number;
  };
  audit_event_id: string;
  draft_path: string;
};

export type OrganizeDraftOptions = {
  scope?: string;
  since?: string;
  actor?: string;
};

export type OrganizeReportTickOptions = OrganizeDraftOptions & {
  ttlMs?: number;
  nowMs?: number;
};

export type OrganizeReportTickResult = {
  schema_version: 'alpha31.gardener-report-tick.v1';
  status: 'created' | 'reused';
  run_id: string;
  draft_id: string;
  draft_path: string;
  source_manifest_sha256: string;
  window_started_at: string;
  expires_at: string;
  safety: {
    mode: 'report-only';
    authority_writes: 0;
    rollback_required: false;
  };
};

export type ExportVaultBlockedItemsPolicy = 'fail-closed';

export type ExportVaultOptions = {
  actor?: string;
  format?: 'markdown';
  blockedItemsPolicy?: ExportVaultBlockedItemsPolicy;
};

export type ExportVaultResult = {
  ok: true;
  draft_id: string;
  format: 'markdown';
  path: string;
  audit_event_id: string;
  safety: {
    secret_redaction: 'passed';
    export_safe: true;
    blocked_items: 0;
    blocked_items_policy: ExportVaultBlockedItemsPolicy;
  };
  source_of_truth: 'view/export artifact only; draft and source memory remain authoritative';
};

export class ExportBlockedItemsError extends Error {
  readonly code = 'export_blocked_items_fail_closed';
  readonly draft_id: string;
  readonly blocked_items: number;
  readonly audit_event_id: string;

  constructor(draftId: string, blockedItems: number, auditEventId: string) {
    super(`export_blocked_items_fail_closed: draft ${draftId} has blocked_items=${blockedItems}; export refused by fail-closed policy`);
    this.name = 'ExportBlockedItemsError';
    this.draft_id = draftId;
    this.blocked_items = blockedItems;
    this.audit_event_id = auditEventId;
  }
}

const EXPORT_BLOCKED_ITEMS_POLICY: ExportVaultBlockedItemsPolicy = 'fail-closed';

type CandidateLine = {
  type: GardenerItemType;
  text: string;
  evidence: GardenerEvidence;
  redacted: boolean;
};

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

function stableId(prefix: string, input: string): string {
  return `${prefix}_${sha256(input).slice(0, 16)}`;
}

function gardenerRoot(workspace: Workspace): string {
  return path.join(workspace.spaceDir, 'gardener');
}

function draftDir(workspace: Workspace): string {
  return path.join(gardenerRoot(workspace), 'drafts');
}

function exportRoot(workspace: Workspace): string {
  return path.join(gardenerRoot(workspace), 'exports');
}

function runRoot(workspace: Workspace): string {
  return path.join(gardenerRoot(workspace), 'runs');
}

function reportTickPath(workspace: Workspace, runId: string): string {
  return path.join(runRoot(workspace), `${safeFileSlug(runId, 'run')}.json`);
}

export function gardenerDraftPath(workspace: Workspace, draftId: string): string {
  return path.join(draftDir(workspace), `${safeFileSlug(draftId, 'draft')}.json`);
}

function parseSinceMs(since?: string): number | null {
  if (!since) return null;
  const trimmed = since.trim();
  const relative = trimmed.match(/^(\d+)([dhw])$/i);
  if (relative) {
    const n = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const mult = unit === 'd' ? 86_400_000 : unit === 'h' ? 3_600_000 : 7 * 86_400_000;
    return Date.now() - n * mult;
  }
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : date;
}

function stripFrontMatter(content: string): { body: string; frontMatter: string } {
  const match = content.match(/^\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { body: content, frontMatter: '' };
  return { body: content.slice(match[0].length), frontMatter: match[1] };
}

function visibilityFor(memoryRelativePath: string, frontMatter: string): GardenerDraft['sources'][number]['visibility'] {
  const p = memoryRelativePath.toLowerCase();
  const fm = frontMatter.toLowerCase();
  if (p.startsWith('_events/') || p.includes('/_events/') || p.includes('/audit/') || /\b(visibility|scope)\s*:\s*["']?audit/.test(fm)) return 'audit-only';
  if (p.startsWith('sources/local/') || p.includes('/source-local/') || /\b(source_visibility|visibility|scope)\s*:\s*["']?(source[-_ ]?local|local[-_ ]?source)/.test(fm)) return 'source-local';
  if (p.startsWith('sources/shared/') || p.includes('/source-shared/') || /\b(source_visibility|visibility|scope)\s*:\s*["']?(source[-_ ]?shared|shared[-_ ]?source)/.test(fm)) return 'source-shared';
  if (p.includes('/private/') || p.startsWith('private/') || /\b(visibility|scope)\s*:\s*["']?private/.test(fm)) return 'private';
  return 'project';
}

function includeVisibility(scope: string, visibility: GardenerDraft['sources'][number]['visibility']): boolean {
  if (visibility === 'audit-only') return false;
  if (scope === 'all') return true;
  if (scope === 'source') return visibility === 'source-local' || visibility === 'source-shared';
  if (scope === 'private') return visibility === 'private';
  if (visibility === 'source-local') return false;
  if (visibility === 'source-shared') return scope !== 'public';
  if (visibility === 'private') return false;
  return visibility === 'project';
}

function genericScope(scope: string): boolean {
  return ['project', 'public', 'private', 'source', 'all'].includes(scope);
}

function namespaceMatches(scope: string, memoryRelativePath: string): boolean {
  if (genericScope(scope)) return true;
  const ns = safeFileSlug(scope, 'scope').toLowerCase();
  const p = memoryRelativePath.toLowerCase();
  return p.startsWith(`scopes/${ns}/`) || p.startsWith(`sources/shared/${ns}/`) || p.startsWith(`sources/local/${ns}/`);
}

function normalizeClaim(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_#[\]()]/g, '')
    .replace(/\b(the|a|an|and|or|to|of|for|in|on|with|is|are|was|were)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function cleanMarkdownLine(line: string): string {
  return line
    .replace(/^\s{0,3}[-*+]\s+/, '')
    .replace(/^\s{0,3}\d+[.)]\s+/, '')
    .replace(/^\s{0,3}>\s?/, '')
    .replace(/^\s{0,6}#+\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function classifyLine(raw: string): GardenerItemType | null {
  const line = cleanMarkdownLine(raw);
  if (!line || line.length < 8) return null;
  if (/^```/.test(line) || /^---+$/.test(line)) return null;
  if (/\b(todo|next|action|follow[- ]?up|blocked|blocker|open question|question)\b/i.test(line) || /\?$/.test(line)) {
    return /\?$|\b(open question|question)\b/i.test(line) ? 'open_question' : 'next_action';
  }
  if (/\b(decision|decided|choose|chose|selected|use|must|will|ship|mvp|requirement)\b/i.test(line)) return 'decision';
  if (/^[-*+]|^\d+[.)]/.test(raw) || /^[A-Z][^.!?]{12,}[.!?]?$/.test(line)) return 'fact';
  return null;
}

function sanitizeText(text: string): { text: string | null; redacted: boolean; blocked: boolean } {
  const redacted = redactSecretLikeContent(text);
  if (containsSecretLikeContent(redacted)) return { text: null, redacted: redacted !== text, blocked: true };
  const compact = redacted.replace(/\s+/g, ' ').trim();
  if (!compact) return { text: null, redacted: redacted !== text, blocked: false };
  return { text: compact, redacted: compact !== text.trim(), blocked: false };
}

async function readSourceCandidates(workspace: Workspace, opts: OrganizeDraftOptions): Promise<{
  candidates: CandidateLine[];
  sources: GardenerDraft['sources'];
  redactedItems: number;
  blockedItems: number;
  outOfScopeExcluded: number;
}> {
  const scope = (opts.scope || 'project').trim().toLowerCase() || 'project';
  const sinceMs = parseSinceMs(opts.since);
  const files = await listMarkdownFiles(workspace.memoryDir);
  const candidates: CandidateLine[] = [];
  const sources: GardenerDraft['sources'] = [];
  let redactedItems = 0;
  let blockedItems = 0;
  let outOfScopeExcluded = 0;

  for (const file of files) {
    const relMemory = path.relative(workspace.memoryDir, file).split(path.sep).join('/');
    if (relMemory.startsWith('_events/') || relMemory.startsWith('history/') || relMemory.includes('/history/')) continue;
    if (!namespaceMatches(scope, relMemory)) {
      outOfScopeExcluded += 1;
      continue;
    }
    const stat = await fs.stat(file);
    if (sinceMs !== null && stat.mtimeMs < sinceMs) continue;
    const raw = await fs.readFile(file, 'utf8');
    const { body, frontMatter } = stripFrontMatter(raw);
    const visibility = visibilityFor(relMemory, frontMatter);
    if (!includeVisibility(scope, visibility)) {
      outOfScopeExcluded += 1;
      continue;
    }
    const source = `memory/${relMemory}`;
    const safeSource = redactSecretLikeContent(source);
    if (containsSecretLikeContent(safeSource)) {
      blockedItems += 1;
      continue;
    }
    const lines = body.split(/\r?\n/);
    let sourceUsed = false;
    lines.forEach((rawLine, idx) => {
      const type = classifyLine(rawLine);
      if (!type) return;
      const original = cleanMarkdownLine(rawLine);
      const sanitized = sanitizeText(original);
      if (sanitized.redacted) redactedItems += 1;
      if (sanitized.blocked) blockedItems += 1;
      if (!sanitized.text) return;
      const quote = sanitized.text.slice(0, 500);
      candidates.push({
        type,
        text: quote,
        redacted: sanitized.redacted,
        evidence: { source: safeSource, lineStart: idx + 1, lineEnd: idx + 1, quote },
      });
      sourceUsed = true;
    });
    if (sourceUsed) sources.push({ source: safeSource, sha256: sha256(raw), lines: lines.length, visibility });
  }

  return { candidates, sources, redactedItems, blockedItems, outOfScopeExcluded };
}

function buildItemsAndFlags(candidates: CandidateLine[]): { items: GardenerItem[]; flags: GardenerFlag[] } {
  const items: GardenerItem[] = candidates.map((c) => ({
    id: stableId('item', `${c.evidence.source}:${c.evidence.lineStart}:${c.text}`),
    type: c.type,
    text: c.text,
    claim_kind: c.type === 'open_question' ? 'open-question' : 'evidence',
    evidence: [c.evidence],
    flags: [],
  }));

  const flags: GardenerFlag[] = [];
  const seen = new Map<string, GardenerItem>();
  for (const item of items) {
    const key = normalizeClaim(item.text);
    if (key.length < 12) continue;
    const prior = seen.get(key);
    if (!prior) {
      seen.set(key, item);
      continue;
    }
    item.flags.push('duplicate_candidate');
    item.duplicateOf = prior.id;
    flags.push({
      id: stableId('flag', `dup:${prior.id}:${item.id}`),
      kind: 'duplicate_candidate',
      targetIds: [prior.id, item.id],
      reason: 'Same normalized claim appears in more than one source line. Review manually; no files were changed.',
      destructive: false,
      evidence: [...prior.evidence, ...item.evidence],
    });
  }

  for (const item of items) {
    if (!/\b(stale|deprecated|superseded|outdated|obsolete|replaced by|no longer)\b/i.test(item.text)) continue;
    item.flags.push('stale_candidate');
    flags.push({
      id: stableId('flag', `stale:${item.id}`),
      kind: 'stale_candidate',
      targetIds: [item.id],
      reason: 'Source text is self-labeled stale/deprecated/superseded. Review manually; no files were changed.',
      destructive: false,
      evidence: item.evidence,
    });
  }
  return { items, flags };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function draftHashPayload(draft: Omit<GardenerDraft, 'draft_id' | 'created_at' | 'audit_event_id' | 'draft_path'>): string {
  return stableStringify(draft);
}

function storedDraftBase(draft: GardenerDraft): Omit<GardenerDraft, 'draft_id' | 'created_at' | 'audit_event_id' | 'draft_path'> {
  const { draft_id: _draftId, created_at: _createdAt, audit_event_id: _auditEventId, draft_path: _draftPath, ...base } = draft;
  return base;
}

async function buildDraftBase(workspace: Workspace, opts: OrganizeDraftOptions): Promise<{
  base: Omit<GardenerDraft, 'draft_id' | 'created_at' | 'audit_event_id' | 'draft_path'>;
  draftId: string;
  read: Awaited<ReturnType<typeof readSourceCandidates>>;
}> {
  const scope = (opts.scope || 'project').trim().toLowerCase() || 'project';
  const read = await readSourceCandidates(workspace, { ...opts, scope });
  const { items, flags } = buildItemsAndFlags(read.candidates);
  const decisionsFacts = items.filter((i) => i.type === 'decision' || i.type === 'fact');
  const nextActions = items.filter((i) => i.type === 'next_action' || i.type === 'open_question');
  const summaryEvidence = read.sources.slice(0, 5).map((s) => ({ source: s.source, lineStart: 1, lineEnd: 1, quote: `Source included in ${scope} organize draft` }));
  const base = {
    schema_version: 'alpha24.gardener.v1' as const,
    mode: 'review-first' as const,
    source_of_truth: 'draft artifact only; curated memory is not rewritten' as const,
    scope_label: scope,
    source_window: { since: opts.since ?? null },
    current_state_summary: {
      kind: 'inference' as const,
      text: `${read.sources.length} source file(s), ${decisionsFacts.length} decision/fact item(s), ${nextActions.length} next-action/open-question item(s), ${flags.length} non-destructive duplicate/stale flag(s).`,
      evidence: summaryEvidence,
    },
    decisions_facts: decisionsFacts,
    next_actions_open_questions: nextActions,
    duplicate_stale_flags: flags,
    sources: read.sources,
    safety: {
      secret_redaction: read.redactedItems > 0 ? 'redacted' as const : 'passed' as const,
      redacted_items: read.redactedItems,
      blocked_items: read.blockedItems,
      export_safe: read.blockedItems === 0,
      out_of_scope_sources_excluded: read.outOfScopeExcluded,
    },
  };
  return { base, draftId: stableId('draft', draftHashPayload(base)).replace(/^draft_/, 'gdr_'), read };
}

async function persistDraft(
  workspace: Workspace,
  opts: OrganizeDraftOptions,
  built: Awaited<ReturnType<typeof buildDraftBase>>,
): Promise<GardenerDraft> {
  const { base, draftId } = built;
  const event = await appendEvent(workspace, {
    type: 'memory.organized',
    actor: opts.actor || 'gardener',
    metadata: {
      draftId,
      scope: base.scope_label,
      mode: 'review-first',
      decisionsFacts: base.decisions_facts.length,
      nextActionsOpenQuestions: base.next_actions_open_questions.length,
      duplicateStaleFlags: base.duplicate_stale_flags.length,
      outOfScopeSourcesExcluded: base.safety.out_of_scope_sources_excluded,
      curatedRewrite: false,
    },
  });
  const draftPathAbs = gardenerDraftPath(workspace, draftId);
  const draft: GardenerDraft = {
    ...base,
    draft_id: draftId,
    created_at: event.at,
    audit_event_id: event.id,
    draft_path: relativeToSpace(workspace, draftPathAbs),
  };
  await atomicWriteFile(draftPathAbs, `${JSON.stringify(draft, null, 2)}\n`, workspace.spaceDir);
  return draft;
}

export async function organizeDraft(workspace: Workspace, opts: OrganizeDraftOptions = {}): Promise<GardenerDraft> {
  return await persistDraft(workspace, opts, await buildDraftBase(workspace, opts));
}

export async function organizeReportTick(
  workspace: Workspace,
  opts: OrganizeReportTickOptions = {},
): Promise<OrganizeReportTickResult> {
  const rawTtlMs = Number.isFinite(opts.ttlMs) ? Math.trunc(opts.ttlMs as number) : 3_600_000;
  const ttlMs = Math.max(1_000, Math.min(7 * 86_400_000, rawTtlMs));
  const nowMs = Number.isFinite(opts.nowMs) ? Math.trunc(opts.nowMs as number) : Date.now();
  const windowStartMs = Math.floor(nowMs / ttlMs) * ttlMs;
  const built = await buildDraftBase(workspace, opts);
  const sourceManifestSha256 = sha256(stableStringify(built.base.sources.map((source) => ({
    source: source.source,
    sha256: source.sha256,
    lines: source.lines,
    visibility: source.visibility,
  }))));
  const runId = stableId('run', stableStringify({
    scope: built.base.scope_label,
    since: built.base.source_window.since,
    sourceManifestSha256,
    draftId: built.draftId,
    windowStartMs,
    ttlMs,
  }));
  const receiptPath = reportTickPath(workspace, runId);

  return await withWorkspaceLock(workspace, async () => {
    try {
      const existing = JSON.parse(await fs.readFile(receiptPath, 'utf8')) as OrganizeReportTickResult;
      const canonicalDraftPath = relativeToSpace(workspace, gardenerDraftPath(workspace, built.draftId));
      const valid = existing.schema_version === 'alpha31.gardener-report-tick.v1'
        && existing.run_id === runId
        && existing.source_manifest_sha256 === sourceManifestSha256
        && existing.safety?.mode === 'report-only'
        && existing.safety?.authority_writes === 0
        && existing.safety?.rollback_required === false
        && existing.draft_id === built.draftId
        && existing.draft_path === canonicalDraftPath;
      if (!valid) throw new Error('gardener_report_receipt_invalid');
      try {
        const draft = JSON.parse(await fs.readFile(gardenerDraftPath(workspace, built.draftId), 'utf8')) as GardenerDraft;
        const computedDraftId = stableId('draft', draftHashPayload(storedDraftBase(draft))).replace(/^draft_/, 'gdr_');
        if (draft.draft_id !== existing.draft_id || draft.mode !== 'review-first' || computedDraftId !== existing.draft_id) {
          throw new Error('gardener_report_draft_invalid');
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('gardener_report_draft_missing');
        throw error;
      }
      return {
        schema_version: 'alpha31.gardener-report-tick.v1',
        status: 'reused',
        run_id: runId,
        draft_id: built.draftId,
        draft_path: canonicalDraftPath,
        source_manifest_sha256: sourceManifestSha256,
        window_started_at: new Date(windowStartMs).toISOString(),
        expires_at: new Date(windowStartMs + ttlMs).toISOString(),
        safety: { mode: 'report-only', authority_writes: 0, rollback_required: false },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const draft = await persistDraft(workspace, opts, built);
    const receipt: OrganizeReportTickResult = {
      schema_version: 'alpha31.gardener-report-tick.v1',
      status: 'created',
      run_id: runId,
      draft_id: draft.draft_id,
      draft_path: draft.draft_path,
      source_manifest_sha256: sourceManifestSha256,
      window_started_at: new Date(windowStartMs).toISOString(),
      expires_at: new Date(windowStartMs + ttlMs).toISOString(),
      safety: { mode: 'report-only', authority_writes: 0, rollback_required: false },
    };
    await atomicWriteFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, workspace.spaceDir);
    return receipt;
  });
}

async function readDraft(workspace: Workspace, draftId: string): Promise<GardenerDraft> {
  const file = gardenerDraftPath(workspace, draftId);
  const raw = await fs.readFile(file, 'utf8');
  return JSON.parse(raw) as GardenerDraft;
}

function evidenceLink(workspace: Workspace, exportDir: string, evidence: GardenerEvidence): string {
  const memRel = evidence.source.replace(/^memory\//, '');
  const sourceAbs = path.join(workspace.memoryDir, memRel);
  const rel = path.relative(exportDir, sourceAbs).split(path.sep).join('/');
  const href = encodeURI(rel);
  return `[${evidence.source}:L${evidence.lineStart}](${href})`;
}

function renderItem(workspace: Workspace, exportDir: string, item: GardenerItem): string {
  const badges = [item.claim_kind, ...item.flags].map((f) => `\`${f}\``).join(' ');
  const ev = item.evidence.length ? item.evidence.map((e) => evidenceLink(workspace, exportDir, e)).join(', ') : '_inference; no direct source_';
  const duplicate = item.duplicateOf ? ` Duplicate of candidate ${item.duplicateOf}.` : '';
  return `- ${badges} ${item.text}${duplicate}\n  - Evidence: ${ev}`;
}

function renderFlag(workspace: Workspace, exportDir: string, flag: GardenerFlag): string {
  const ev = flag.evidence.map((e) => evidenceLink(workspace, exportDir, e)).join(', ');
  return `- \`${flag.kind}\` ${flag.reason}\n  - Targets: ${flag.targetIds.join(', ')}\n  - Non-destructive: ${flag.destructive === false ? 'yes' : 'no'}\n  - Evidence: ${ev}`;
}

export async function exportVaultFromDraft(workspace: Workspace, draftId: string, opts: ExportVaultOptions = {}): Promise<ExportVaultResult> {
  if (opts.format && opts.format !== 'markdown') throw new Error('unsupported_export_format');
  if (opts.blockedItemsPolicy && opts.blockedItemsPolicy !== EXPORT_BLOCKED_ITEMS_POLICY) throw new Error('unsupported_blocked_items_policy');
  const draft = await readDraft(workspace, draftId);
  const blockedItems = Number(draft.safety?.blocked_items ?? 0);
  if (blockedItems > 0 || draft.safety?.export_safe === false) {
    const event = await appendEvent(workspace, {
      type: 'memory.exported',
      actor: opts.actor || 'gardener',
      metadata: {
        draftId: draft.draft_id,
        format: 'markdown',
        exportPath: null,
        sourceOfTruth: 'view/export artifact only',
        status: 'refused',
        reason: 'blocked_items_present',
        blockedItems,
        blockedItemsPolicy: EXPORT_BLOCKED_ITEMS_POLICY,
      } as JsonRecord,
    });
    throw new ExportBlockedItemsError(draft.draft_id, blockedItems, event.id);
  }
  const outDir = path.join(exportRoot(workspace), safeFileSlug(draft.draft_id, 'draft'));
  const outPath = path.join(outDir, 'memory-gardener-digest.md');
  const lines = [
    `# Safe Memory Gardener Draft ${draft.draft_id}`,
    '',
    '> Export artifact only. This Markdown view is not source of truth and does not rewrite curated memory.',
    '',
    `- Scope: ${draft.scope_label}`,
    `- Organize audit event: ${draft.audit_event_id}`,
    `- Source window: ${draft.source_window.since ?? 'all'}`,
    `- Redaction/export safety: ${draft.safety.secret_redaction}; blocked=${draft.safety.blocked_items}; out-of-scope excluded=${draft.safety.out_of_scope_sources_excluded}`,
    '',
    '## Current state summary',
    '',
    `- \`inference\` ${draft.current_state_summary.text}`,
    '',
    '## Decisions / facts',
    '',
    ...(draft.decisions_facts.length ? draft.decisions_facts.map((i) => renderItem(workspace, outDir, i)) : ['_No decision/fact candidates found._']),
    '',
    '## Next actions / open questions',
    '',
    ...(draft.next_actions_open_questions.length ? draft.next_actions_open_questions.map((i) => renderItem(workspace, outDir, i)) : ['_No next-action/open-question candidates found._']),
    '',
    '## Duplicate / stale candidates (review-only)',
    '',
    ...(draft.duplicate_stale_flags.length ? draft.duplicate_stale_flags.map((f) => renderFlag(workspace, outDir, f)) : ['_No duplicate/stale candidates flagged._']),
    '',
    '## Sources',
    '',
    ...draft.sources.map((s) => `- ${s.source} (${s.visibility}, sha256:${s.sha256.slice(0, 12)}, ${s.lines} lines)`),
    '',
  ];
  const markdown = redactSecretLikeContent(lines.join('\n'));
  if (containsSecretLikeContent(markdown)) throw new Error('export_contains_secret_like_content');
  await atomicWriteFile(outPath, `${markdown.replace(/\s+$/u, '')}\n`, workspace.spaceDir);
  const event = await appendEvent(workspace, {
    type: 'memory.exported',
    actor: opts.actor || 'gardener',
    path: relativeToSpace(workspace, outPath),
    metadata: {
      draftId: draft.draft_id,
      format: 'markdown',
      exportPath: relativeToSpace(workspace, outPath),
      sourceOfTruth: 'view/export artifact only',
      status: 'exported',
      blockedItems: 0,
      blockedItemsPolicy: EXPORT_BLOCKED_ITEMS_POLICY,
    } as JsonRecord,
  });
  return {
    ok: true,
    draft_id: draft.draft_id,
    format: 'markdown',
    path: relativeToSpace(workspace, outPath),
    audit_event_id: event.id,
    safety: { secret_redaction: 'passed', export_safe: true, blocked_items: 0, blocked_items_policy: EXPORT_BLOCKED_ITEMS_POLICY },
    source_of_truth: 'view/export artifact only; draft and source memory remain authoritative',
  };
}
