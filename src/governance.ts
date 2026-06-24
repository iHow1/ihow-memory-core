// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  DurablePromoteOptions,
  DurablePromoteResult,
  JournalPayload,
  JournalResult,
  PromoteResult,
  PromoteTarget,
  Workspace,
  WriteCandidatePayload,
  WriteCandidateResult,
} from './types.ts';
import { absoluteFromMemoryPath, isMcpSandboxPath, relativeToMemory, relativeToSpace } from './workspace.ts';
import { appendEvent, readEvents } from './store/events.ts';
import { atomicWriteFile, nowCompact, readMemoryFile, safeFileSlug } from './store/files.ts';
import { withWorkspaceLock } from './store/lock.ts';
import { localDay } from './time.ts';

export const DEFAULT_PROTECTED_PATTERNS = [
  'SOUL.md',
  'USER.md',
  'IDENTITY.md',
  'MEMORY.md',
  'AGENTS.md',
  'memory/SOUL.md',
  'memory/USER.md',
  'memory/IDENTITY.md',
  'memory/MEMORY.md',
  'current.md',
  // Curated anchors — high-value, low-volume memory that auto-capture must never clobber.
  'preferences.md',
  'active-anchors.md',
  'anchors.md',
  'active-topics.md',
];

// High-precision secret detectors. These match secret *values* (or assignment-style
// `keyword: value`), not bare keywords, to keep the hard-reject low on false positives.
// NOTE: prose-style secrets ("the password is hunter2") and generic high-entropy blobs are
// intentionally NOT matched HERE (the hard-reject detector) — they carry a real false-positive cost.
// They ARE quarantined on the auto-capture path: see SECRET_QUARANTINE_PATTERNS + redactSecretLikeContent.
const SECRET_LIKE_PATTERNS = [
  // assignment-style: keyword followed by : or =
  /\b(api[_-]?key|secret|token|password|passwd|pwd|cookie|authorization|bearer|refresh[_-]?token|access[_-]?token|private[_-]?key|client[_-]?secret|aws[_-]?secret[_-]?access[_-]?key|aws[_-]?access[_-]?key[_-]?id)\b\s*[:=]/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\bsk-[A-Za-z0-9_-]{16,}\b/i, // OpenAI-style
  /\b(?:sk|rk)_live_[0-9A-Za-z]{16,}\b/, // Stripe live key
  /\b(?:github_pat_[0-9A-Za-z_]{20,}|gh[oprsu]_[0-9A-Za-z]{16,})\b/, // GitHub PAT / gho_/ghp_/ghr_/ghs_/ghu_
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}\b/, // Google API key
  /\bya29\.[0-9A-Za-z._-]{20,}/, // Google OAuth token
  /\bxox[baprs]-[0-9A-Za-z-]{10,}/, // Slack token
  /\bSK[0-9a-f]{32}\b/, // Twilio
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/, // JWT
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/, // PEM private key
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i, // email address
  /(?:账号|账户|邮箱|密码|密钥|令牌)\s*[:：=]\s*\S+/i, // CJK account/secret assignment
  // URL- / connection-string-embedded credentials: scheme://user:pass@host
  // (covers redis/postgres/mongodb/amqp/https…). Low false-positive, high signal, so it joins the
  // hard-reject detector — a creds-in-URL almost never appears legitimately in memory text.
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/:@]+@\S+/i,
];

// EXTRA patterns the auto-capture REDACTOR quarantines but the hard-reject detector does NOT use —
// they carry a non-trivial false-positive cost ("the token is valid") that is unacceptable for the
// candidate hard-throw, but fine on the auto-capture path where a false hit merely becomes a [redacted]
// marker in a low-weight, rollbackable journal. This is the "quarantine, not hard drop" call the
// SECRET_LIKE_PATTERNS comment deferred.
//
// NOTE: a generic high-entropy detector (>=N mixed-class chars) was tried and REMOVED — the base64/url-safe
// alphabet overlaps file paths and long camelCase identifiers (which include /, _, digits, mixed case), so
// it shredded ordinary handoff content ("src/Foo_Bar2026Baz.ts" -> "[redacted].ts"), defeating the whole
// point of a handoff. Real high-entropy secrets almost always appear either branded (sk-/ghp_/AKIA/JWT/PEM,
// caught by the detector), in a `key=value` assignment (caught), in a URL (caught), or led by a secret
// keyword (the prose rule below). A safe entropy classifier needs path/identifier-awareness — revisit then.
const SECRET_QUARANTINE_PATTERNS = [
  // prose-style secret: "the password is hunter2", "secret: …", "api key = …", "secret was <blob>"
  /\b(?:pass(?:word|phrase|wd)?|secret|passcode|credential|api[_-]?key|token)s?\s+(?:is|was|are|were|=|:|->)\s+["']?\S{4,}/i,
];

function candidateText(payload: WriteCandidatePayload): string {
  const text = payload.text ?? payload.content;
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('candidate_text_required');
  }
  assertNoSecretLikeContent(text);
  return text.trim();
}

export function containsSecretLikeContent(text: string): boolean {
  return SECRET_LIKE_PATTERNS.some((pattern) => pattern.test(text));
}

// SAME-SOURCE redactor for the auto-capture path (OpenClaw signing condition for automation v2):
// redact `text` so it carries no secret VALUE and containsSecretLikeContent() is guaranteed clean
// afterwards. Built from the SAME SECRET_LIKE_PATTERNS so detector and redactor cannot drift; the
// assignment-style detector (keyword[:=]) is extended to also consume the value — otherwise only the
// keyword would be stripped and the value would leak. Use THIS (never the narrower CLI redactSecrets)
// before journaling auto-ingested transcript text, so an email/account hit degrades to a redaction
// instead of an assertNoSecretLikeContent hard-throw (which the hook's no-throw contract would
// otherwise swallow as silent total capture loss).
export function redactSecretLikeContent(text: string): string {
  const asGlobal = (p: RegExp): RegExp => (p.flags.includes('g') ? p : new RegExp(p.source, `${p.flags}g`));
  let out = text;
  // assignment "keyword[:=] VALUE" — derive a value-swallowing variant from the same assignment detector
  const assignment = SECRET_LIKE_PATTERNS[0];
  out = out.replace(asGlobal(new RegExp(`${assignment.source}\\s*\\S+`, assignment.flags)), '[redacted]');
  // every detector (value-style + the CJK assignment already swallows its value), applied globally
  for (const pattern of SECRET_LIKE_PATTERNS) out = out.replace(asGlobal(pattern), '[redacted]');
  // plus the auto-capture-only quarantine set (high-entropy blobs, prose secrets) — these are NOT in
  // the detector, so post-redaction containsSecretLikeContent() is still guaranteed clean (the
  // redactor is a strict superset of the detector).
  for (const pattern of SECRET_QUARANTINE_PATTERNS) out = out.replace(asGlobal(pattern), '[redacted]');
  return out;
}

function assertNoSecretLikeContent(text: string): void {
  if (containsSecretLikeContent(text)) {
    throw new Error('candidate_contains_secret_like_content');
  }
}

function assertNoSecretLikeDurableCandidate(content: string): void {
  if (containsSecretLikeContent(content)) {
    throw new Error('redact_check_failed_candidate_contains_secret_like_content');
  }
}

function frontMatter(data: Record<string, unknown>): string {
  const lines = ['---'];
  for (const [key, value] of Object.entries(data)) {
    lines.push(`${key}: ${JSON.stringify(value)}`);
  }
  lines.push('---');
  return `${lines.join('\n')}\n`;
}

function markdownCandidate(candidateId: string, payload: WriteCandidatePayload): string {
  const title = payload.title || `Candidate ${candidateId}`;
  const sourceAgent = payload.sourceAgent || payload.source || 'unknown';
  const metadata = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};
  return `${frontMatter({
    type: 'memory_candidate',
    candidate_id: candidateId,
    status: 'candidate',
    source_agent: sourceAgent,
    created_at: new Date().toISOString(),
    ...metadata,
  })}\n# ${title}\n\n${candidateText(payload)}\n`;
}

export function isProtectedPath(ref: string): boolean {
  const normalized = ref.replace(/\\/g, '/').replace(/^\/+/, '');
  return DEFAULT_PROTECTED_PATTERNS.some((pattern) => normalized === pattern || normalized.endsWith(`/${pattern}`));
}

function normalizeRef(ref: string): string {
  return ref.replace(/\\/g, '/').replace(/^\/+/, '');
}

function stripMemoryPrefix(ref: string): string {
  const normalized = normalizeRef(ref);
  return normalized.startsWith('memory/') ? normalized.slice('memory/'.length) : normalized;
}

function resolveTargetPath(workspace: Workspace, candidateId: string, target: PromoteTarget = {}): string {
  if (workspace.mode === 'existing-memory-root') {
    const title = safeFileSlug(target.title || candidateId, candidateId);
    return path.join(workspace.promotedDir, `${nowCompact()}-${title}.md`);
  }

  const explicit = target.path?.trim();
  if (explicit) {
    if (isProtectedPath(explicit)) throw new Error('protected_core_path');
    const absolute = absoluteFromMemoryPath(workspace, explicit);
    return absolute;
  }

  const scope = safeFileSlug(target.scope || 'general', 'general');
  const title = safeFileSlug(target.title || candidateId, candidateId);
  const relative = path.join('scopes', scope, `${nowCompact()}-${title}.md`);
  if (isProtectedPath(relative)) throw new Error('protected_core_path');
  return path.join(workspace.memoryDir, relative);
}

function candidateDirForAgent(workspace: Workspace, sourceAgent: string): string {
  if (workspace.mode === 'existing-memory-root') {
    return path.join(workspace.candidatesDir, safeFileSlug(sourceAgent, 'unknown'));
  }
  return workspace.candidatesDir;
}

function isAllowedCandidatePath(workspace: Workspace, relativePath: string, absolutePath: string): boolean {
  if (workspace.mode === 'existing-memory-root') {
    return relativePath.startsWith('memory/_mcp/candidates/') && isMcpSandboxPath(workspace, absolutePath);
  }
  return relativePath.startsWith('memory/candidate/inbox/');
}

function isAllowedDurableTargetPath(relativePath: string): boolean {
  const normalized = normalizeRef(relativePath);
  const memoryRelative = stripMemoryPrefix(normalized);
  if (/^\d{4}-\d{2}-\d{2}\.md$/.test(memoryRelative)) return true;
  if (memoryRelative.startsWith('scopes/')) return true;
  if (memoryRelative.startsWith('inbox/')) return true;
  if (normalized.startsWith('projects/')) return true;
  return false;
}

function isForbiddenDurableTargetPath(relativePath: string): boolean {
  const memoryRelative = stripMemoryPrefix(relativePath);
  return (
    memoryRelative === 'recent/latest.md' ||
    memoryRelative === 'decisions.md' ||
    memoryRelative === 'workflows.md' ||
    memoryRelative === 'codex/current.md' ||
    memoryRelative === 'claude-code/current.md' ||
    memoryRelative.endsWith('/current.md')
  );
}

function resolveDurableTargetPath(workspace: Workspace, candidateId: string, target: PromoteTarget = {}): string {
  const explicit = target.path?.trim();
  if (explicit) {
    if (isProtectedPath(explicit)) throw new Error('protected_core_path');
    const normalized = normalizeRef(explicit);
    if (normalized.startsWith('projects/')) {
      const workspaceRoot = workspace.mode === 'existing-memory-root' ? path.dirname(workspace.memoryDir) : workspace.spaceDir;
      return path.resolve(workspaceRoot, normalized);
    }
    return absoluteFromMemoryPath(workspace, normalized);
  }

  const scope = safeFileSlug(target.scope || 'general', 'general');
  const title = safeFileSlug(target.title || candidateId, candidateId);
  return path.join(workspace.memoryDir, 'scopes', scope, `${nowCompact()}-${title}.md`);
}

function relativeDurableTarget(workspace: Workspace, targetPath: string): string {
  const resolved = path.resolve(targetPath);
  const memoryDir = path.resolve(workspace.memoryDir);
  if (resolved === memoryDir || resolved.startsWith(`${memoryDir}${path.sep}`)) {
    return relativeToSpace(workspace, resolved);
  }
  const workspaceRoot = workspace.mode === 'existing-memory-root' ? path.dirname(workspace.memoryDir) : workspace.spaceDir;
  const root = path.resolve(workspaceRoot);
  if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) {
    return path.relative(root, resolved).split(path.sep).join('/');
  }
  throw new Error('target_outside_workspace');
}

function durableAppendContent(candidateContent: string): string {
  return candidateContent
    .replace(/^status:\s*"candidate"\s*$/m, 'status: "promoted"')
    .replace(/^type:\s*"memory_candidate"\s*$/m, 'type: "memory"')
    .replace(/^---\n/, `---\npromoted_at: "${new Date().toISOString()}"\n`);
}

async function durableTargetContent(targetPath: string, appendContent: string): Promise<string> {
  try {
    const existing = await fs.readFile(targetPath, 'utf8');
    return `${existing.replace(/\s*$/, '\n\n')}${appendContent}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return appendContent;
    throw error;
  }
}

function assertCandidateFrontMatter(content: string): void {
  const hasCandidateType = /^type:\s*"memory_candidate"\s*$/m.test(content);
  const hasCandidateStatus = /^status:\s*"candidate"\s*$/m.test(content);
  if (!hasCandidateType || !hasCandidateStatus) {
    throw new Error('candidate_frontmatter_required');
  }
}

function journalFileHeader(day: string): string {
  return `${frontMatter({ type: 'memory_journal', weight: 'low', date: day })}\n# Journal ${day}\n\n> Auto-captured, append-only, low-weight. Searchable but ranked below curated memory.\n`;
}

async function readFileOrEmpty(targetPath: string): Promise<string> {
  try {
    return await fs.readFile(targetPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

// Auto-capture lane: append-only, low-weight daily journal. Bypasses the candidate->promote
// gate (so a session-end hook can capture without a human step), but STILL hard-rejects
// secret-like content and stays contained via withWorkspaceLock + atomicWriteFile. Journal
// entries are indexed and searchable, yet demoted below curated memory at query time (see
// engine/fts.ts), so automatic capture can never pollute high-weight retrieval.
export async function appendJournal(workspace: Workspace, payload: JournalPayload): Promise<JournalResult> {
  const text = payload.text ?? payload.content;
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('journal_text_required');
  }
  assertNoSecretLikeContent(text);
  const sourceAgent = payload.sourceAgent || payload.source || 'unknown';
  const title = payload.title?.trim();
  return await withWorkspaceLock(workspace, async () => {
    const at = new Date().toISOString();
    const day = localDay(new Date(at)); // LOCAL calendar day — matches the wall clock, not UTC (see time.ts)
    const targetPath = path.join(workspace.journalDir, `${day}.md`);
    const existing = await readFileOrEmpty(targetPath);
    const header = existing ? '' : journalFileHeader(day);
    const entry = `\n## ${at} · ${sourceAgent}${title ? ` · ${title}` : ''}\n\n${text.trim()}\n`;
    await atomicWriteFile(targetPath, `${header}${existing}${entry}`, workspace.memoryDir);
    const relativePath = relativeToSpace(workspace, targetPath);
    const event = await appendEvent(workspace, {
      type: 'memory.journal.appended',
      path: relativePath,
      actor: sourceAgent,
      metadata: { day, weight: 'low', auto: true, entryAt: at },
    });
    return { path: relativePath, status: 'journaled', eventId: event.id, day };
  });
}

export type RollbackResult = {
  eventId: string;
  type: string;
  path?: string;
  removed: boolean;
  rolledbackEventId: string;
};

// Remove one journal entry (identified by its ISO heading timestamp) from a daily journal file.
// Entries are delimited by "\n## <ISO> · ..."; the preamble and other entries are preserved.
function removeJournalEntry(content: string, entryAt: string): { content: string; removed: boolean } {
  const parts = content.split('\n## ');
  if (parts.length < 2) return { content, removed: false };
  const [preamble, ...entries] = parts;
  const kept = entries.filter((entry) => !entry.startsWith(`${entryAt} `));
  if (kept.length === entries.length) return { content, removed: false };
  const rebuilt = kept.length ? `${preamble}\n## ${kept.join('\n## ')}` : preamble;
  return { content: rebuilt, removed: true };
}

// Rollback a single auto-captured journal entry by its audit eventId — the auto-write lane's undo.
// Only journal entries are reversible this way; durable/promote writes are human-gated (not
// auto-written), so they are out of scope. Emits a memory.rolledback audit event either way.
export async function rollbackJournalEvent(workspace: Workspace, eventId: string): Promise<RollbackResult> {
  const target = (await readEvents(workspace)).find((event) => event.id === eventId);
  if (!target) throw new Error('rollback_event_not_found');
  if (target.type !== 'memory.journal.appended') throw new Error('rollback_unsupported_event_type');
  const entryAt = typeof target.metadata?.entryAt === 'string' ? target.metadata.entryAt : '';
  const relativePath = target.path;
  if (!entryAt || !relativePath) throw new Error('rollback_missing_entry_metadata');
  return await withWorkspaceLock(workspace, async () => {
    const absolute = absoluteFromMemoryPath(workspace, relativePath);
    const existing = await readFileOrEmpty(absolute);
    const { content, removed } = removeJournalEntry(existing, entryAt);
    if (removed) await atomicWriteFile(absolute, content, workspace.memoryDir);
    const event = await appendEvent(workspace, {
      type: 'memory.rolledback',
      path: relativePath,
      actor: 'core.rollback',
      metadata: { rolledBackEventId: eventId, entryAt, removed },
    });
    return { eventId, type: target.type, path: relativePath, removed, rolledbackEventId: event.id };
  });
}

export async function writeCandidate(
  workspace: Workspace,
  payload: WriteCandidatePayload,
): Promise<WriteCandidateResult> {
  return await withWorkspaceLock(workspace, async () => {
    const candidateId = crypto.randomUUID();
    const title = safeFileSlug(payload.title || candidateId, candidateId);
    const sourceAgent = payload.sourceAgent || payload.source || 'unknown';
    const filePath = path.join(candidateDirForAgent(workspace, sourceAgent), `${nowCompact()}-${title}.md`);
    const content = markdownCandidate(candidateId, payload);
    // Scan the FULL rendered candidate (title + metadata front-matter + body), not just the body
    // text candidateText() already checks — otherwise a secret tucked into title/metadata slips in.
    assertNoSecretLikeContent(content);
    await atomicWriteFile(filePath, content, workspace.memoryDir);
    const relativePath = relativeToSpace(workspace, filePath);
    await appendEvent(workspace, {
      type: 'candidate.created',
      path: relativePath,
      actor: sourceAgent,
      metadata: {
        candidateId,
        status: 'candidate',
        sandbox: workspace.mode === 'existing-memory-root' ? 'memory/_mcp' : undefined,
      },
    });
    return {
      candidateId,
      path: relativePath,
      status: 'candidate',
    };
  });
}

// ── Auto-promote floor ─────────────────────────────────────────────────────
// Decides whether a candidate qualifies for AUTOMATIC promotion to durable memory.
// Conservative by design: the safe failure is "stays a candidate", never "poisons
// durable memory". (OpenClaw red-team: the most dangerous poisoning is the content
// that looks like low-risk project state — so agent self-judgment alone never gates;
// the engine enforces this floor.) Enforced, not prompt-level.
export type AutoPromoteVerdict =
  | { allow: true }
  | { allow: false; reason: string; category: 'secret' | 'governance' | 'no-provenance' };

export type PromoteOptions = {
  actor?: string;
  auto?: boolean;
  provenance?: WriteCandidatePayload['metadata'];
};

// Standing-rule / policy / access / identity / destructive markers — content that must stay
// human-gated even when it reads "low risk". A denylist can be evaded, so this is one of THREE
// gates (secret-clean + not-governance + has-provenance) and the safe failure is "stays a
// candidate". Kept off the noisiest factual verbs (a fact that mentions "deploy"/"disabled X"
// is fine) but covers the clear high-signal directives.
const GOVERNANCE_MARKERS: RegExp[] = [
  // Standing rules / preferences / policy / imperatives — a durable directive, not a fact.
  /\b(always|never|from now on|going forward|by default|as a rule|policy|standing rule|guideline|convention|preference|make sure to|remember to|prefer\b.{0,24}\bover\b|auto[-\s]?approve)\b/i,
  /(以后|从现在起|今后|默认|始终|永远|一律|总是|策略|规则|规范|约定|偏好|方针|准则|务必|记住要|不要再)/,
  // Access / security / identity / credentials.
  /\b(permission|access control|credential|api[\s_-]?key|password|\bsecret\b|\btoken\b|grant|revoke|sudo|chmod|chown|\broot\b|identity|impersonate|whitelist|allowlist|2fa|mfa|bypass\s+(?:auth|review|checks?)|skip\s+(?:review|code\s*review|checks?))\b/i,
  /(权限|访问控制|凭据|令牌|密钥|密码|身份|授权|提权|管理员|吊销|跳过审核|免审|放行)/,
  // Destructive / high-blast-radius actions.
  /\b(delete|drop\s+(?:table|database)|destroy|wipe|rm\s+-rf|truncate|force[\s-]?push|reset\s+--hard|terraform\s+destroy|kubectl\s+delete)\b/i,
  /(删除|清除|销毁|抹除|格式化|覆盖线上|回滚|下线|停服)/,
];

function looksLikeGovernanceStatement(text: string): boolean {
  return GOVERNANCE_MARKERS.some((re) => re.test(text));
}

// Everything that will land on disk if promoted — body text + title + metadata values — so the
// floor scans what actually gets stored, not just the body. A secret or a standing rule tucked
// into title/metadata must not slip past.
function fullScanText(payload: WriteCandidatePayload): string {
  const parts: string[] = [payload.title || '', String(payload.text ?? payload.content ?? '')];
  const m = payload.metadata;
  if (m && typeof m === 'object') {
    for (const v of Object.values(m)) parts.push(typeof v === 'string' ? v : JSON.stringify(v));
  }
  return parts.join('\n');
}

// The agent must attach MEANINGFUL provenance to qualify for the auto lane — evidence/anchors
// that make the claim verifiable, not just a present-but-empty key (verified:false, result:'').
function hasProvenance(payload: WriteCandidatePayload): boolean {
  const m = payload.metadata;
  if (!m || typeof m !== 'object') return false;
  const meaningful = (v: unknown): boolean => {
    if (v == null) return false;
    if (typeof v === 'string') return v.trim().length > 0;
    if (typeof v === 'boolean') return v === true; // verified:false is not provenance
    if (typeof v === 'number') return Number.isFinite(v); // exitCode:0 is meaningful (success)
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'object') return Object.keys(v as object).length > 0;
    return false;
  };
  const keys = ['evidence', 'anchors', 'git', 'repo', 'verified', 'provenance', 'command', 'artifact', 'exitCode', 'result'];
  return keys.some((k) => k in m && meaningful((m as Record<string, unknown>)[k]));
}

export function evaluateAutoPromote(payload: WriteCandidatePayload): AutoPromoteVerdict {
  const scan = fullScanText(payload); // title + body + metadata — everything that gets stored
  if (containsSecretLikeContent(scan)) {
    return { allow: false, reason: 'contains secret-like content (text/title/metadata)', category: 'secret' };
  }
  if (looksLikeGovernanceStatement(scan)) {
    return {
      allow: false,
      reason: 'reads as a standing rule / policy / access / identity / destructive statement — needs human review',
      category: 'governance',
    };
  }
  if (!hasProvenance(payload)) {
    return {
      allow: false,
      reason: 'no meaningful provenance attached (evidence / anchors / verification) — staged as candidate',
      category: 'no-provenance',
    };
  }
  return { allow: true };
}
// ────────────────────────────────────────────────────────────────────────────

export async function promoteCandidate(
  workspace: Workspace,
  candidateRef: string,
  target: PromoteTarget = {},
  options: PromoteOptions = {},
): Promise<PromoteResult> {
  return await withWorkspaceLock(workspace, async () => {
    const candidate = await readMemoryFile(workspace, candidateRef);
    const candidateAbsolute = absoluteFromMemoryPath(workspace, candidate.path);
    if (!isAllowedCandidatePath(workspace, candidate.path, candidateAbsolute)) {
      throw new Error('candidate_must_be_from_inbox');
    }
    const candidateIdMatch = candidate.content.match(/^candidate_id:\s*"?(.*?)"?\s*$/m);
    const candidateId = candidateIdMatch?.[1] || path.basename(candidate.path, '.md');
    const targetPath = resolveTargetPath(workspace, candidateId, target);
    const targetRelative = relativeToSpace(workspace, targetPath);
    if (isProtectedPath(targetRelative)) throw new Error('protected_core_path');

    // Auto-promoted memory is tagged (tier/reviewed) so it can be told apart from human-confirmed
    // promotions and treated as machine-judged. (Recall strips these tags from injected snippets;
    // bm25 rank down-weighting of unreviewed entries is a tracked follow-up, not yet wired.)
    const autoFrontmatter = options.auto
      ? `tier: "auto-promoted"\nreviewed: false\npromoted_by: ${JSON.stringify(options.actor || 'agent-auto')}\n`
      : '';
    const body = candidate.content
      .replace(/^status:\s*"candidate"\s*$/m, 'status: "promoted"')
      .replace(/^type:\s*"memory_candidate"\s*$/m, 'type: "memory"')
      .replace(/^---\n/, `---\npromoted_at: "${new Date().toISOString()}"\n${autoFrontmatter}`);
    // Auto-promote happens without a human gate, so it must clear the same durable secret check
    // as durable_promote — a backstop on the full file content (title + metadata + body).
    if (options.auto) assertNoSecretLikeDurableCandidate(body);
    await atomicWriteFile(targetPath, body, workspace.memoryDir);

    if (workspace.mode === 'existing-memory-root') {
      if (!isMcpSandboxPath(workspace, targetPath)) throw new Error('target_outside_mcp_sandbox');
      await fs.rm(candidateAbsolute, { force: true });
    } else {
      const historyPath = path.join(workspace.historyDir, 'promoted-candidates', path.basename(candidate.path));
      await fs.mkdir(path.dirname(historyPath), { recursive: true });
      await fs.rename(candidateAbsolute, historyPath);
    }

    const event = await appendEvent(workspace, {
      type: 'memory.promoted',
      candidatePath: candidate.path,
      targetPath: targetRelative,
      actor: options.actor || 'core.promote',
      metadata: {
        candidateId,
        target,
        stagingOnly: workspace.mode === 'existing-memory-root',
        targetMemoryPath: relativeToMemory(workspace, targetPath),
        auto: options.auto || undefined,
        reviewed: options.auto ? false : undefined,
        provenance: options.provenance,
      },
    });
    return {
      candidateId,
      path: targetRelative,
      status: 'promoted',
      eventId: event.id,
    };
  });
}

export async function durablePromoteCandidate(
  workspace: Workspace,
  candidateRef: string,
  options: DurablePromoteOptions = {},
): Promise<DurablePromoteResult> {
  if (options.dryRun === true && options.realWrite === true) {
    throw new Error('durable_promote_mode_conflict');
  }
  if (options.dryRun !== true && options.realWrite !== true) {
    throw new Error('durable_promote_requires_explicit_dry_run_or_real_write');
  }

  return await withWorkspaceLock(workspace, async () => {
    const candidate = await readMemoryFile(workspace, candidateRef);
    const candidateAbsolute = absoluteFromMemoryPath(workspace, candidate.path);
    if (!isAllowedCandidatePath(workspace, candidate.path, candidateAbsolute)) {
      throw new Error('candidate_must_be_from_inbox');
    }
    assertCandidateFrontMatter(candidate.content);
    assertNoSecretLikeDurableCandidate(candidate.content);

    const candidateIdMatch = candidate.content.match(/^candidate_id:\s*"?(.*?)"?\s*$/m);
    const candidateId = candidateIdMatch?.[1] || path.basename(candidate.path, '.md');
    const targetPath = resolveDurableTargetPath(workspace, candidateId, options.target || {});
    const targetRelative = relativeDurableTarget(workspace, targetPath);

    if (isProtectedPath(targetRelative)) throw new Error('protected_core_path');
    if (isForbiddenDurableTargetPath(targetRelative)) throw new Error('durable_target_forbidden');
    if (!isAllowedDurableTargetPath(targetRelative)) throw new Error('durable_target_not_whitelisted');

    const appendContent = durableAppendContent(candidate.content);
    assertNoSecretLikeDurableCandidate(appendContent);

    const at = new Date().toISOString();
    const eventId = crypto.randomUUID();
    const actor = options.actor || 'core.durable-promote';
    const archiveCandidateTo = relativeToSpace(
      workspace,
      path.join(workspace.historyDir, 'promoted-candidates', path.basename(candidate.path)),
    );
    const auditEventPath = relativeToSpace(workspace, path.join(workspace.eventsDir, `${at.slice(0, 10)}.ndjson`));
    const dryRun = options.dryRun === true;
    const writeGuards = [
      'explicit-durable-promote-call',
      'candidate-inbox-source-only',
      'protected-core-blocked',
      'target-whitelist-enforced',
      'redact-check-before-write',
      'withWorkspaceLock',
      'atomicWriteFile-for-real-write',
      dryRun ? 'dry-run-no-write' : 'real-write-explicitly-enabled',
    ];
    const plan = {
      candidatePath: candidate.path,
      targetPath: targetRelative,
      targetAbsolutePath: targetPath,
      operation: 'append' as const,
      appendContent,
      archiveCandidateTo,
      auditEventPath,
      auditEvent: {
        id: eventId,
        type: 'memory.promoted.durable' as const,
        at,
        actor,
        candidatePath: candidate.path,
        targetPath: targetRelative,
        metadata: {
          candidateId,
          target: options.target || {},
          dryRun,
          source: 'candidate/inbox',
          archiveCandidateTo,
        },
      },
      writeGuards,
    };

    if (dryRun) {
      return {
        candidateId,
        status: 'dry-run',
        dryRun: true,
        plan,
        proof: {
          explicitDurableTrigger: true,
          sourceCandidateInboxOnly: true,
          protectedCoreBlocked: true,
          targetWhitelistEnforced: true,
          redactCheck: 'passed',
          dryRunNoWrites: true,
        },
      };
    }

    // Durable targets are whitelisted to memoryDir or the workspace root's projects/ tree, so the
    // containment root is the workspace root (it contains memoryDir in both workspace modes).
    const containmentRoot = workspace.mode === 'existing-memory-root' ? path.dirname(workspace.memoryDir) : workspace.spaceDir;
    await atomicWriteFile(targetPath, await durableTargetContent(targetPath, appendContent), containmentRoot);
    const archiveAbsolute = path.join(workspace.historyDir, 'promoted-candidates', path.basename(candidate.path));
    await fs.mkdir(path.dirname(archiveAbsolute), { recursive: true });
    await fs.rename(candidateAbsolute, archiveAbsolute);
    const event = await appendEvent(workspace, {
      type: 'memory.promoted.durable',
      candidatePath: candidate.path,
      targetPath: targetRelative,
      actor,
      metadata: {
        candidateId,
        target: options.target || {},
        dryRun: false,
        source: 'candidate/inbox',
        archiveCandidateTo,
      },
    });

    return {
      candidateId,
      status: 'promoted',
      dryRun: false,
      eventId: event.id,
      path: targetRelative,
      archivedCandidatePath: archiveCandidateTo,
      plan: {
        ...plan,
        auditEvent: {
          ...plan.auditEvent,
          id: event.id,
          at: event.at,
        },
      },
      proof: {
        explicitDurableTrigger: true,
        sourceCandidateInboxOnly: true,
        protectedCoreBlocked: true,
        targetWhitelistEnforced: true,
        redactCheck: 'passed',
        dryRunNoWrites: false,
      },
    };
  });
}
