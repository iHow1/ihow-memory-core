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
import { gitAnchors } from './anchors.ts';
import { absoluteFromMemoryPath, isMcpSandboxPath, relativeToMemory, relativeToSpace } from './workspace.ts';
import { appendEvent, readEvents, readEventsAllLanes, type MemoryEvent } from './store/events.ts';
import { atomicWriteFile, listMarkdownFiles, nowCompact, readMemoryFile, safeFileSlug } from './store/files.ts';
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

// An email address. PII, not a credential — so on the INGEST path (write_candidate / journal) it is
// REDACTED-IN-PLACE rather than used to reject the whole entry (see REDACT_IN_PLACE_INGEST_PATTERNS and
// redactIngestBenign). It is STILL a member of the detector/redactor set below so that (a) the floor's
// redaction-before-persist invariant keeps stripping it and (b) post-redaction containsSecretLikeContent()
// stays clean. The split is "reject vs redact", NOT "detect vs ignore" — the value never lands on disk.
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

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
  EMAIL_PATTERN, // email address (PII) — detected + redacted, but REDACT-IN-PLACE (not reject) on ingest
  /(?:账号|账户|邮箱|密码|密钥|令牌)\s*[:：=]\s*\S+/i, // CJK account/secret assignment
  // URL- / connection-string-embedded credentials: scheme://user:pass@host
  // (covers redis/postgres/mongodb/amqp/https…). Low false-positive, high signal, so it joins the
  // hard-reject detector — a creds-in-URL almost never appears legitimately in memory text.
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/:@]+@\S+/i,
];

// Patterns that, on the candidate/journal INGEST path, degrade to a [redacted] marker instead of
// hard-rejecting the whole entry. These are PII / friction matches (an email in a legitimate handoff),
// NOT credentials — a false hard-reject here pushes a clean handoff back to a manual gate (the P0-C
// friction bug). Every member is ALSO in SECRET_LIKE_PATTERNS, so after redactIngestBenign() the hard
// detector is guaranteed clean for them. The invariant is "real secret → reject; PII → redact-in-place".
const REDACT_IN_PLACE_INGEST_PATTERNS = [
  EMAIL_PATTERN,
];

// The REAL-secret detectors — the hard-reject set MINUS the redact-in-place (PII) set. A match here means
// a credential is present and the WHOLE entry must hard-reject; a match only in the PII set is redacted in
// place. This split is what makes "redact email, but never let an email-shaped redaction mask a real
// secret" safe: redactIngestBenign refuses to run when a real secret is present (see below). Email is the
// dangerous overlap — its broad `local@host.tld` shape also matches the `pass@host` tail of a URL-embedded
// credential (redis://u:p@h) and the body of a Bearer/JWT token; redacting that tail would erase the very
// `@`/structure the URL-cred / Bearer detectors key on and silently downgrade a real secret to "clean".
const REAL_SECRET_PATTERNS = SECRET_LIKE_PATTERNS.filter((p) => !REDACT_IN_PLACE_INGEST_PATTERNS.includes(p));

// WIDE, low-false-positive prechecks for the redact-in-place NO-OP guard (red-team Blocker 3). The narrow
// `Bearer [A-Za-z0-9._~+/=-]{12,}` detector keys on a STRICT RFC token alphabet, so an adversarial
// `Bearer xxx@yyy.com` (a credential-shaped value whose body is also email-shaped) misses the Bearer
// detector, matches ONLY EMAIL_PATTERN, and would be silently downgraded to `Bearer [redacted]` → clean by
// redactIngestBenign. These guards make redactIngestBenign a NO-OP on such inputs so the value survives to
// the hard gate instead of being masked. Kept separate from the strict SECRET_LIKE_PATTERNS Bearer detector
// so the hard-reject detector's false-positive profile is unchanged — these gate ONLY the redact no-op.
//
// FALSE-POSITIVE TUNING (do not widen to a bare `Bearer \S+`): English prose contains "the bearer of bad
// news" — `Bearer \S+` would match `bearer of`, no-op the redactor, and bounce a LEGITIMATE email-bearing
// handoff to a hard reject (breaks the P0-C friction-fix invariant). So:
//  • `Authorization: Bearer <anything non-empty>` — the `Authorization:` prefix essentially never appears in
//    prose, so a bare `\S+` value is safe here and catches the full header form.
//  • bare `Bearer <value>` ONLY when the value is credential-SHAPED: it contains an `@` (the email-shaped
//    adversarial case + creds-in-URL tails) OR it is a ≥8-char token from the RFC Bearer alphabet that is
//    NOT a plain alphabetic word (so `Bearer of`/`Bearer bad` do not match, but `Bearer xxx@yyy.com`,
//    `Bearer ey....`, `Bearer a1b2c3d4e5` do). This keeps the email-shaped downgrade closed without
//    swallowing ordinary prose that uses the word "bearer".
const REAL_SECRET_PRECHECK_PATTERNS = [
  /\bAuthorization\s*:\s*Bearer\s+\S+/i, // `Authorization: Bearer <anything non-empty>`
  /\bBearer\s+\S*@\S+/i, // `Bearer <…@…>` — email-shaped / creds-in-URL value (the named adversarial case)
  // ≥8-char token, not a plain word. The right boundary is "not another Bearer-alphabet char" (a negative
  // lookahead) — NOT \b: a token ending in `- ~ + / =` (RFC 6750 / base64url tails) has no word boundary after
  // it, so the old \b silently missed `Bearer abc1234-` and the redactor (which shares this pattern) drifted
  // with it (red-team r3 Blocker 1). `Bearer of`/`Bearer marched` still don't match (need ≥8 chars AND a
  // non-alpha char via the second lookahead), so ordinary prose using "bearer" stays unflagged.
  /\bBearer\s+(?=[A-Za-z0-9._~+/=-]{8,}(?![A-Za-z0-9._~+/=-]))(?=\S*[0-9._~+/=-])[A-Za-z0-9._~+/=-]{8,}(?![A-Za-z0-9._~+/=-])/i,
];

function containsRealSecret(text: string): boolean {
  if (REAL_SECRET_PRECHECK_PATTERNS.some((pattern) => pattern.test(text))) return true;
  return REAL_SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

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
  // Redact-in-place the "redact, don't reject" set (email/PII) BEFORE the hard check, so a legitimate
  // handoff that mentions an email lands as [redacted] instead of being rejected (P0-C). A REAL secret is
  // untouched by this pass and still trips assertNoSecretLikeContent below — reject-vs-redact, never ignore.
  const redacted = redactIngestBenign(text);
  assertNoSecretLikeContent(redacted);
  return redacted.trim();
}

export function containsSecretLikeContent(text: string): boolean {
  // Hard-reject the credential-SHAPED Bearer/Authorization values too (red-team r2 Blocker 2): the strict
  // 12+ SECRET_LIKE Bearer detector misses `Bearer <8-11 token-ish>`, which the precheck DOES match. These
  // are mirrored into redactSecretLikeContent below so detector and redactor never drift.
  return SECRET_LIKE_PATTERNS.some((pattern) => pattern.test(text))
    || REAL_SECRET_PRECHECK_PATTERNS.some((pattern) => pattern.test(text));
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
  // the credential-shaped Bearer/Authorization prechecks the strict 12+ detector misses — kept in lockstep
  // with containsSecretLikeContent (which now flags these), so the redactor stays a superset of the detector.
  for (const pattern of REAL_SECRET_PRECHECK_PATTERNS) out = out.replace(asGlobal(pattern), '[redacted]');
  // plus the auto-capture-only quarantine set (high-entropy blobs, prose secrets) — these are NOT in
  // the detector, so post-redaction containsSecretLikeContent() is still guaranteed clean (the
  // redactor is a strict superset of the detector).
  for (const pattern of SECRET_QUARANTINE_PATTERNS) out = out.replace(asGlobal(pattern), '[redacted]');
  return out;
}

// INGEST-path redaction-before-persist for the "redact, don't reject" set (currently: email). Strips ONLY
// REDACT_IN_PLACE_INGEST_PATTERNS to a [redacted] marker. This is the P0-C friction fix: a legitimate
// write_candidate / journal body that mentions an email lands as [redacted] instead of being bounced to a
// manual gate. Built from the SAME EMAIL_PATTERN the detector uses (no drift), so containsSecretLikeContent()
// is clean for the redacted matches afterwards. NOT a substitute for redactSecretLikeContent (full set).
//
// HARD SAFETY GUARD (red-team blocker): if the text contains a REAL secret, this is a NO-OP — the entry is
// left untouched so the hard-reject gate still fires. Without this, the broad email regex would rewrite the
// `pass@host.tld` tail of a URL-embedded credential (redis://u:p@h) or a Bearer/JWT body to [redacted],
// erasing the `@`/structure the URL-cred / Bearer detectors rely on and DOWNGRADING a real secret to
// "clean" — a silent weakening of the real-secret hard-reject. Email-in-place redaction is only applied to
// text that carries NO real secret, so it can never mask one.
export function redactIngestBenign(text: string): string {
  if (containsRealSecret(text)) return text; // a real secret is present → never redact-mask it; let it reject
  const asGlobal = (p: RegExp): RegExp => (p.flags.includes('g') ? p : new RegExp(p.source, `${p.flags}g`));
  let out = text;
  for (const pattern of REDACT_IN_PLACE_INGEST_PATTERNS) out = out.replace(asGlobal(pattern), '[redacted]');
  return out;
}

function assertNoSecretLikeContent(text: string): void {
  if (containsSecretLikeContent(text)) {
    throw new Error('candidate_contains_secret_like_content');
  }
}

// Ingest-safe view of a free-text HEADING field (journal title) that gets persisted into a markdown
// heading — a derived persistence surface the body redaction did NOT cover (red-team Blocker 2). Runs the
// SAME redact-in-place (email -> [redacted]) + hard gate as the body: a benign email degrades to
// [redacted], a real secret throws (so the whole entry rejects rather than leaking a raw secret into the
// heading). Returns undefined for empty input so the caller can omit the heading segment entirely.
function safeHeadingTitle(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const redacted = redactIngestBenign(trimmed);
  assertNoSecretLikeContent(redacted); // real secret in the title -> reject (never lands in the heading)
  return redacted;
}

// Collapse a free-text actor / sourceAgent label down to a SAFE id before it lands in a journal heading or
// audit actor field (red-team Blocker 2: sourceAgent='alice@example.com' previously wrote the raw email
// into the heading). Whitelist charset [a-z0-9._-], lowercased, length-capped; anything else is dropped to
// '-'. An email/secret-shaped sourceAgent therefore cannot carry its value through — `alice@example.com`
// becomes `alice-example.com` is NOT acceptable here (still leaks local+domain), so we go further: any '@'
// or run of illegal chars collapses to a single '-' AND if the result is empty we fall back to 'unknown'.
// This is intentionally stricter than safeFileSlug — a sourceAgent is an identifier, not free text.
// Derive a filesystem slug from a free-text title WITHOUT letting any PII/secret VALUE reach the path
// (red-team Blocker 1). safeFileSlug alone is NOT enough: it only swaps illegal chars, so an email title
// `alice@example.com` becomes the slug `alice-example.com`, leaking local+domain into filename/path/audit.
// Here we FIRST run the ingest redactor (email -> [redacted]); if the redacted form is STILL detector-dirty
// (a real secret made redactIngestBenign a no-op) we DROP the title entirely and fall back to candidateId,
// so a credential can never be slugged into a path either. Result: path/filename derive only from a
// redacted, detector-clean title (or the opaque candidateId), never from a raw PII/secret value.
function safeRedactedSlug(title: string | undefined, candidateId: string): string {
  const trimmed = title?.trim();
  if (!trimmed) return safeFileSlug(candidateId, candidateId);
  const redacted = redactIngestBenign(trimmed);
  if (containsSecretLikeContent(redacted)) return safeFileSlug(candidateId, candidateId);
  return safeFileSlug(redacted, candidateId);
}

// A scope becomes a durable DIRECTORY name AND the raw `event.targetPath` in the _events audit log AND an
// index.sqlite row — none of them redactable after the fact. safeFileSlug alone only swaps illegal chars
// (scope-pii@corp.example -> scope-pii-corp.example, keeping the email local-part+domain; an sk- key survives
// byte-intact), so scope must get the SAME redact-before-slug treatment as the title (r4 self-audit round 2:
// the metadata.target.scope copy was redacted but the sibling targetPath it mirrors was not). Falls back to
// 'general' on a real secret, mirroring safeRedactedSlug's drop-to-candidateId.
function safeScopeSlug(scope: string | undefined): string {
  const trimmed = scope?.trim();
  if (!trimmed) return safeFileSlug('general', 'general');
  const redacted = redactIngestBenign(trimmed);
  if (containsSecretLikeContent(redacted)) return safeFileSlug('general', 'general');
  return safeFileSlug(redacted, 'general');
}

// Ingest-safe copy of a PromoteTarget for the AUDIT metadata surface. EVERY user-controlled field
// (scope / path / title) is free text and is NOT redacted upstream — resolveTargetPath only slugs scope/title
// into a filename, and an explicit path is rejected (not redacted) at resolve time — so a raw PII/secret in
// ANY of them would otherwise land verbatim in the _events ndjson audit log. Route the whole target through
// the recursive full-set audit redactor (proven in lockstep with the detector). r2 covered only title; the
// r4 self-audit found scope (and path) still passed through raw via the `{ ...target }` spread.
function safeAuditTarget(target: PromoteTarget): PromoteTarget {
  return safeAuditMetadata(target);
}

// Deep-sanitize a provenance/metadata object before it lands in an audit EVENT (red-team r2 Blocker 1):
// raw payload.metadata (e.g. { contact: 'carol@example.net' }) flowed verbatim into _events/*.ndjson — a
// persistence surface (backed up, grep-able, surfaced by audit/diagnostic reads). Recursively redact every
// string value with the full-set redactor; a value still detector-dirty after redaction (a real secret) is
// dropped to [redacted], never logged. Only the AUDIT copy is sanitized — the gate logic still sees the raw
// provenance (it must, to verify git anchors / command exit codes).
function safeAuditMetadata<T>(value: T): T {
  if (typeof value === 'string') {
    const redacted = redactSecretLikeContent(value);
    return (containsSecretLikeContent(redacted) ? '[redacted]' : redacted) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((entry) => safeAuditMetadata(entry)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      // Redact KEYS too, not just values: a PII/secret used as an object KEY (e.g. { 'carol@example.net': v })
      // otherwise lands raw in the _events audit ndjson, while the markdown frontmatter — which redacts the
      // rendered JSON string — masks it. That asymmetry is a detector/redactor drift (r4 self-audit: key-leak).
      out[safeAuditMetadata(key) as string] = safeAuditMetadata(entry);
    }
    return out as unknown as T;
  }
  return value;
}

function safeActorId(raw: string | undefined): string {
  const cleaned = (raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 40);
  // If after whitelisting the label still parses as an email/secret (e.g. it was 'a.b-example.com' from an
  // email), null it out — an actor id must never carry an exfiltratable value. The detector catches the
  // dotted domain tail; on any hit we drop to the neutral fallback.
  if (!cleaned || containsSecretLikeContent(raw ?? '')) return 'unknown';
  return cleaned;
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
    const title = safeRedactedSlug(target.title, candidateId); // Blocker 1: no raw PII/secret in path
    return path.join(workspace.promotedDir, `${nowCompact()}-${title}.md`);
  }

  const explicit = target.path?.trim();
  if (explicit) {
    if (isProtectedPath(explicit)) throw new Error('protected_core_path');
    // A PII/secret in an explicit path becomes the durable FILENAME and the raw event.targetPath in the audit
    // log — neither is redactable after the fact — so reject it at resolve time (r4 self-audit: target.path leak).
    if (containsSecretLikeContent(normalizeRef(explicit))) throw new Error('target_path_contains_secret_like_content');
    const absolute = absoluteFromMemoryPath(workspace, explicit);
    return absolute;
  }

  const scope = safeScopeSlug(target.scope); // r4 self-audit: redact PII/secret BEFORE it becomes a dir name / raw targetPath / sqlite row
  const title = safeRedactedSlug(target.title, candidateId); // Blocker 1: no raw PII/secret in path
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
    // PII/secret in an explicit path leaks into the durable filename + the raw audit targetPath (r4 self-audit).
    if (containsSecretLikeContent(normalizeRef(explicit))) throw new Error('target_path_contains_secret_like_content');
    const normalized = normalizeRef(explicit);
    if (normalized.startsWith('projects/')) {
      const workspaceRoot = workspace.mode === 'existing-memory-root' ? path.dirname(workspace.memoryDir) : workspace.spaceDir;
      return path.resolve(workspaceRoot, normalized);
    }
    return absoluteFromMemoryPath(workspace, normalized);
  }

  const scope = safeScopeSlug(target.scope); // r4 self-audit: redact PII/secret BEFORE it becomes a dir name / raw targetPath / sqlite row
  const title = safeRedactedSlug(target.title, candidateId); // Blocker 1: no raw PII/secret in path
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

// Content-addressed idempotency id for a journal entry: sha256 over the entry body as written to disk.
// This DERIVES a stable, replay-convergent handle that disambiguates two appends sharing the same ISO
// `entryAt` (same-millisecond writes), which the timestamp alone cannot — so a rollback removes EXACTLY
// the intended entry instead of over-removing every same-timestamp block (a latent replay/idempotency
// bug). The body is hashed verbatim (post-redaction, post-trim) so it is reproducible from on-disk text
// at rollback time, with NO change to the on-disk heading format and NO impact on the floor's composite
// (runtime, sessionId) dedup, which stays the sole capture-floor idempotency key.
function journalEntryHash(body: string): string {
  return crypto.createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 16);
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
  const raw = payload.text ?? payload.content;
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('journal_text_required');
  }
  // Redact-in-place benign PII (email) BEFORE the hard gate, same as the candidate path (P0-C). A real
  // secret is untouched here and still hard-rejects below; only an email/PII match degrades to [redacted].
  const text = redactIngestBenign(raw);
  assertNoSecretLikeContent(text);
  // Heading-derived persistence surfaces (red-team Blocker 2): the title goes through the SAME
  // redact-in-place + hard gate as the body, and the sourceAgent is collapsed to a safe actor id, so
  // neither a PII email nor a raw secret can leak through the journal heading or the audit actor field.
  const sourceAgent = safeActorId(payload.sourceAgent || payload.source || 'unknown');
  const title = safeHeadingTitle(payload.title);
  return await withWorkspaceLock(workspace, async () => {
    const at = new Date().toISOString();
    const day = localDay(new Date(at)); // LOCAL calendar day — matches the wall clock, not UTC (see time.ts)
    const targetPath = path.join(workspace.journalDir, `${day}.md`);
    const existing = await readFileOrEmpty(targetPath);
    const header = existing ? '' : journalFileHeader(day);
    const body = text.trim();
    const entryHash = journalEntryHash(body); // content-addressed handle for precise rollback (replay-safe)
    const entry = `\n## ${at} · ${sourceAgent}${title ? ` · ${title}` : ''}\n\n${body}\n`;
    await atomicWriteFile(targetPath, `${header}${existing}${entry}`, workspace.memoryDir);
    const relativePath = relativeToSpace(workspace, targetPath);
    const event = await appendEvent(workspace, {
      type: 'memory.journal.appended',
      path: relativePath,
      actor: sourceAgent,
      metadata: { day, weight: 'low', auto: true, entryAt: at, entryHash },
    });
    return { path: relativePath, status: 'journaled', eventId: event.id, day };
  });
}

export type FloorJournalResult = { status: 'journaled' | 'skipped-duplicate'; path?: string; eventId?: string; day?: string };

// Crash-safe, idempotent single-shot writer for the CROSS-RUNTIME capture floor (src/floor.ts). Unlike
// appendJournal (which unconditionally appends — correct for the cooperative lane), this does the dedup
// CHECK and the WRITE under ONE workspace lock, so two MCP servers sweeping the SAME memory-root
// concurrently cannot both write the same session (the lock carries the read-decision across the write).
// The idempotency key is COMPOSITE (runtime + sessionId), because sessionId is NOT globally unique across
// runtimes (WorkBuddy/OpenClaw derive it from a file basename). The audit event is appended BEFORE the
// markdown body, so a crash in the gap leaves a dedup key with no body (under-capture, recoverable) rather
// than a body the next sweep would re-floor into a duplicate.
export async function appendFloorJournalOnce(
  workspace: Workspace,
  payload: { text: string; runtime: string; sessionId: string; title?: string },
): Promise<FloorJournalResult> {
  const text = payload.text;
  if (typeof text !== 'string' || !text.trim()) throw new Error('journal_text_required');
  assertNoSecretLikeContent(text); // already redacted upstream; this is the hard gate (defence in depth)
  // Heading/actor display strings are collapsed to safe ids + redacted-title (red-team Blocker 2, same
  // class as appendJournal). NOTE: the dedup composite key still uses the RAW payload.runtime via
  // metadata.floorRuntime below, so idempotency is unchanged — only the rendered heading/actor are safed.
  const actor = `${safeActorId(payload.runtime)}-floor`;
  const title = safeHeadingTitle(payload.title);
  return await withWorkspaceLock(workspace, async () => {
    // Under the lock: re-read the audit log and bail if THIS (runtime, sessionId) was already floored.
    // Reading inside the lock is what makes the check-then-write atomic against a concurrent sweep.
    let already = false;
    try {
      already = (await readEventsAllLanes(workspace)).some((event) => {
        if (event.type !== 'memory.journal.appended') return false;
        const meta = (event.metadata ?? {}) as { floor?: unknown; sessionId?: unknown; floorRuntime?: unknown };
        return meta.floor === true && meta.sessionId === payload.sessionId && meta.floorRuntime === payload.runtime;
      });
    } catch {
      already = false; // unreadable audit -> fall through and write (a rare duplicate beats a crash)
    }
    if (already) return { status: 'skipped-duplicate' as const };

    const at = new Date().toISOString();
    const day = localDay(new Date(at)); // LOCAL calendar day — matches the wall clock (see time.ts)
    const targetPath = path.join(workspace.journalDir, `${day}.md`);
    const relativePath = relativeToSpace(workspace, targetPath);
    // Audit FIRST (the dedup key), THEN the body. A crash between the two under-captures (the session is
    // marked floored but has no body — recoverable via a later cooperative journal / explicit continue)
    // instead of orphaning a body with no key that every future sweep would re-floor.
    const body = text.trim();
    const entryHash = journalEntryHash(body); // content-addressed handle for precise rollback (replay-safe)
    const event = await appendEvent(workspace, {
      type: 'memory.journal.appended',
      path: relativePath,
      actor,
      metadata: { floor: true, sessionId: payload.sessionId, floorRuntime: payload.runtime, day, weight: 'low', auto: true, entryAt: at, entryHash },
    });
    const existing = await readFileOrEmpty(targetPath);
    const header = existing ? '' : journalFileHeader(day);
    const entry = `\n## ${at} · ${actor}${title ? ` · ${title}` : ''}\n\n${body}\n`;
    await atomicWriteFile(targetPath, `${header}${existing}${entry}`, workspace.memoryDir);
    return { status: 'journaled' as const, path: relativePath, eventId: event.id, day };
  });
}

export type RollbackResult = {
  eventId: string;
  type: string;
  path?: string;
  removed: boolean;
  rolledbackEventId: string;
};

// The body of an on-disk journal block (the text after the "## <heading>" line, before the trailing
// newline) — reconstructed so journalEntryHash() over it reproduces the hash stored at append time.
function journalBlockBody(block: string): string {
  const nl = block.indexOf('\n');
  if (nl === -1) return '';
  // block = "<heading>\n\n<body>\n" → after the heading line a blank line precedes the body.
  return block.slice(nl + 1).replace(/^\n/, '').replace(/\n$/, '');
}

// Remove ONE journal entry from a daily journal file. Entries are delimited by "\n## <ISO> · ...".
// Removal is keyed by the content-addressed `entryHash` when present (precise even when two entries share
// the same ISO `entryAt` — same-millisecond appends), and FALLS BACK to the ISO timestamp for legacy
// entries written before the hash existed (backward compatible). Matching by hash removes exactly the one
// intended block; the timestamp fallback preserves the prior behavior for un-hashed entries.
function removeJournalEntry(content: string, entryAt: string, entryHash?: string): { content: string; removed: boolean } {
  const parts = content.split('\n## ');
  if (parts.length < 2) return { content, removed: false };
  const [preamble, ...entries] = parts;
  let dropped = false;
  const kept = entries.filter((entry) => {
    if (dropped) return true; // remove at most ONE block, even on a hash/timestamp tie
    const sameStamp = entry.startsWith(`${entryAt} `);
    if (entryHash) {
      // Precise: only the block whose body hashes to entryHash AND carries the right timestamp is removed.
      if (sameStamp && journalEntryHash(journalBlockBody(entry)) === entryHash) { dropped = true; return false; }
      return true;
    }
    // Legacy fallback: timestamp-only match (pre-hash entries) — removes the first same-timestamp block.
    if (sameStamp) { dropped = true; return false; }
    return true;
  });
  if (!dropped) return { content, removed: false };
  const rebuilt = kept.length ? `${preamble}\n## ${kept.join('\n## ')}` : preamble;
  return { content: rebuilt, removed: true };
}

// Rollback a single REVERSIBLE event by its audit eventId — the engine's undo. Two kinds are reversible:
//  • memory.journal.appended — the low-weight auto-capture lane.
//  • memory.promoted with metadata.auto — an AUTO-promoted durable memory. Auto-promote happens without a
//    human gate (engine floor only), so it MUST be undoable (go/no-go #6): without this, a wrong machine
//    judgment is stuck in durable memory with no engine recourse — only a manual file delete, with the
//    candidate already archived to history. Human-CONFIRMED promotions are intentional and stay out of
//    scope (refused). Always emits a memory.rolledback audit event.
export async function rollbackEvent(workspace: Workspace, eventId: string): Promise<RollbackResult> {
  const events = await readEvents(workspace);
  const target = events.find((event) => event.id === eventId);
  if (!target) throw new Error('rollback_event_not_found');
  // Replay guard: the event log is append-only, so a rolled-back event's id lives forever. Rolling the
  // SAME id back twice must be refused — otherwise replaying a stale auto-promote rollback id (after its
  // candidate was re-promoted by a human at the same target) would blind-delete the now human-confirmed
  // durable file, silently reversing a deliberate promotion. Idempotent at the engine, not the caller.
  if (events.some((e) => e.type === 'memory.rolledback' && e.metadata?.rolledBackEventId === eventId)) {
    throw new Error('rollback_already_rolled_back');
  }
  if (target.type === 'memory.journal.appended') return rollbackJournalAppend(workspace, target, eventId);
  if (target.type === 'memory.promoted') return rollbackAutoPromote(workspace, target, eventId);
  throw new Error('rollback_unsupported_event_type');
}

async function rollbackJournalAppend(workspace: Workspace, target: MemoryEvent, eventId: string): Promise<RollbackResult> {
  const entryAt = typeof target.metadata?.entryAt === 'string' ? target.metadata.entryAt : '';
  // Content-addressed handle (when the entry was written by hash-aware code) → removes EXACTLY this block
  // even if another append shares its ISO timestamp. Absent (legacy entry) → timestamp-only fallback.
  const entryHash = typeof target.metadata?.entryHash === 'string' ? target.metadata.entryHash : undefined;
  const relativePath = target.path;
  if (!entryAt || !relativePath) throw new Error('rollback_missing_entry_metadata');
  return await withWorkspaceLock(workspace, async () => {
    const absolute = absoluteFromMemoryPath(workspace, relativePath);
    const existing = await readFileOrEmpty(absolute);
    const { content, removed } = removeJournalEntry(existing, entryAt, entryHash);
    if (removed) await atomicWriteFile(absolute, content, workspace.memoryDir);
    const event = await appendEvent(workspace, {
      type: 'memory.rolledback',
      path: relativePath,
      actor: 'core.rollback',
      metadata: { rolledBackEventId: eventId, entryAt, entryHash, removed },
    });
    return { eventId, type: target.type, path: relativePath, removed, rolledbackEventId: event.id };
  });
}

// Undo an AUTO-promoted durable memory: delete the promoted file and (managed mode) restore the candidate
// to the inbox so the rolled-back item returns to pending review instead of vanishing. Refuses a
// human-confirmed promotion — those are deliberate and not the engine's to silently reverse.
async function rollbackAutoPromote(workspace: Workspace, target: MemoryEvent, eventId: string): Promise<RollbackResult> {
  if (!target.metadata?.auto) throw new Error('rollback_human_promote_out_of_scope');
  // The promoted FILE is addressed memory-relative via metadata.targetMemoryPath; the top-level
  // event.targetPath is space-relative and must NOT be used for filesystem ops.
  const memoryRelative = typeof target.metadata?.targetMemoryPath === 'string' ? target.metadata.targetMemoryPath : '';
  if (!memoryRelative) throw new Error('rollback_missing_target_metadata');
  return await withWorkspaceLock(workspace, async () => {
    const absolute = absoluteFromMemoryPath(workspace, memoryRelative);
    let removed = false;
    try { await fs.rm(absolute, { force: true }); removed = true; } catch { /* already gone */ }
    // Best-effort: return the candidate to the inbox. Managed mode archived it under history at promote
    // time; existing-memory-root mode rm'd it (stagingOnly), so there is nothing to restore there.
    let restoredCandidate = false;
    const candidatePath = target.candidatePath;
    if (!target.metadata?.stagingOnly && candidatePath) {
      const historyPath = path.join(workspace.historyDir, 'promoted-candidates', path.basename(candidatePath));
      try {
        await fs.rename(historyPath, absoluteFromMemoryPath(workspace, candidatePath));
        restoredCandidate = true;
      } catch { /* history entry missing — leave the removal standing */ }
    }
    const event = await appendEvent(workspace, {
      type: 'memory.rolledback',
      path: memoryRelative,
      actor: 'core.rollback',
      metadata: { rolledBackEventId: eventId, removed, restoredCandidate, auto: true },
    });
    return { eventId, type: target.type, path: memoryRelative, removed, rolledbackEventId: event.id };
  });
}

export async function writeCandidate(
  workspace: Workspace,
  payload: WriteCandidatePayload,
): Promise<WriteCandidateResult> {
  return await withWorkspaceLock(workspace, async () => {
    const candidateId = crypto.randomUUID();
    // Filename slug derives from the REDACTED title (red-team Blocker 1): a raw email/secret in the title
    // must never reach the path. safeRedactedSlug drops to candidateId if a real secret is present.
    const title = safeRedactedSlug(payload.title, candidateId);
    // The candidate sub-dir is keyed by sourceAgent; collapse it to a safe actor id so a PII/secret
    // sourceAgent (e.g. 'alice@example.com') cannot land in the directory path either.
    const sourceAgent = payload.sourceAgent || payload.source || 'unknown';
    const filePath = path.join(candidateDirForAgent(workspace, safeActorId(sourceAgent)), `${nowCompact()}-${title}.md`);
    // markdownCandidate's body is already benign-redacted via candidateText(); redact-in-place the FULL
    // rendered candidate so an email tucked into the title/metadata also degrades to [redacted] rather
    // than rejecting the entry (P0-C), and the redacted form is what we persist.
    const content = redactIngestBenign(markdownCandidate(candidateId, payload));
    // Scan the FULL rendered candidate (title + metadata front-matter + body), not just the body
    // text candidateText() already checks — otherwise a REAL secret tucked into title/metadata slips in.
    // (Benign PII is already [redacted] above; only real-secret patterns can still trip this.)
    assertNoSecretLikeContent(content);
    await atomicWriteFile(filePath, content, workspace.memoryDir);
    const relativePath = relativeToSpace(workspace, filePath);
    await appendEvent(workspace, {
      type: 'candidate.created',
      path: relativePath,
      actor: safeActorId(sourceAgent), // audit actor must not carry a PII/secret sourceAgent value either
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
// Decides whether a candidate lands in durable yellow memory and which sub-tier it
// gets. Only secrets and engine-falsified anchors hard-reject. The floor remains
// engine-enforced, not prompt-level: self-asserted provenance can land durable, but
// only as unverified, never recall-eligible verified.
export type AutoPromoteVerdict =
  | { allow: true; tier: 'verified' | 'unverified' | 'flagged'; reason?: string; provenanceKind?: 'anchor' | 'command' }
  | { allow: false; reason: string; category: 'secret' | 'conflict' };

export type PromoteOptions = {
  actor?: string;
  auto?: boolean;
  tier?: 'verified' | 'unverified' | 'flagged';
  flagReason?: string;
  provenanceKind?: 'anchor' | 'command';
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

// The GOVERNANCE marker scan includes the title ONLY when it reads as PROSE (contains whitespace).
// A slug/identifier-style title ("policy-assistant-s07-a-3-root-fast-forwarded") is an auto/file NAME
// whose hyphen-joined tokens ("policy"/"root") were the dominant false-positive — flagging a clean
// factual handoff. A natural-language title ("Always force push to main") IS a real assertion and
// stays in scope, so a genuine rule in a prose title still flags and there is NO title-evasion. The
// BODY and explicit metadata are always scanned in full. (The SECRET check above still scans the
// title in ALL cases — a token tucked into a slug-style title must never slip.)
function governanceScanText(payload: WriteCandidatePayload): string {
  const parts: string[] = [String(payload.text ?? payload.content ?? '')];
  const title = (payload.title ?? '').toString();
  if (/\s/.test(title.trim())) parts.push(title);
  const m = payload.metadata;
  if (m && typeof m === 'object') {
    for (const v of Object.values(m)) parts.push(typeof v === 'string' ? v : JSON.stringify(v));
  }
  return parts.join('\n');
}

// A git SHA shape: hex, short-hash (7) to full (40). Tighter than "any hex" so a uuid fragment / digest
// tail isn't mistaken for a commit.
const GIT_SHA = /\b[0-9a-f]{7,40}\b/i;

// Pull a claimed HEAD sha out of metadata — metadata.head, or a HEAD-ish entry in metadata.anchors
// (e.g. "HEAD=abc1234" or a bare sha). Returns the normalized sha or undefined.
function claimedHead(m: Record<string, unknown>): string | undefined {
  if (typeof m.head === 'string') { const mm = m.head.match(GIT_SHA); if (mm) return mm[0].toLowerCase(); }
  const anchors = m.anchors;
  const arr = Array.isArray(anchors) ? anchors : typeof anchors === 'string' ? [anchors] : [];
  for (const a of arr) {
    if (typeof a === 'string') { const mm = a.match(GIT_SHA); if (mm) return mm[0].toLowerCase(); }
  }
  return undefined;
}

// Which repo dir an anchor claims to describe. An EXPLICIT absolute path (repoPath/projectDir/repoDir, or
// an absolute metadata.repo) is authoritative — a mismatch there is a fabricated/stale anchor we reject.
// The caller cwd is a best-effort fallback only (a mismatch there just fails to qualify, never hard-rejects,
// since we can't be sure the agent meant cwd). A bare label like repo:"anything" is NOT a path → ignored.
function claimedRepoDir(m: Record<string, unknown>, cwd?: string): { dir: string; explicit: boolean } | undefined {
  for (const k of ['repoPath', 'projectDir', 'repoDir', 'repo']) {
    const v = m[k];
    if (typeof v === 'string' && path.isAbsolute(v)) return { dir: v, explicit: true };
  }
  if (cwd) return { dir: cwd, explicit: false };
  return undefined;
}

// ENGINE-VERIFIED provenance — the gate that keeps auto-promote off agent self-judgment (OpenClaw: the
// engine, not the agent, decides; "verified:true" is the agent grading its own homework). A present-but-
// self-asserted key (verified:true, evidence:"I ran it", a lone exitCode) NO LONGER qualifies. Two
// structured, falsifiable forms do:
//   (1) command + exitCode together — "ran <command>, got exit <code>": machine-shaped evidence.
//   (2) a git anchor the engine CHECKS against live git — a claimed HEAD that matches a resolvable repo's
//       live HEAD. A HEAD that is claimed for an EXPLICIT repo path but does not match is rejected
//       outright (a fabricated/stale anchor — exactly the "looks-low-risk" poisoning OpenClaw flagged).
// Returns ok:true to qualify, or ok:false with a `conflict` category to reject outright.
function verifyProvenance(payload: WriteCandidatePayload, cwd?: string): { ok: boolean; reason?: string; conflict?: boolean; kind?: 'anchor' | 'command' } {
  const m = payload.metadata;
  if (!m || typeof m !== 'object') return { ok: false };
  const meta = m as Record<string, unknown>;

  const command = typeof meta.command === 'string' ? meta.command.trim() : '';
  const hasExit = typeof meta.exitCode === 'number' && Number.isFinite(meta.exitCode as number);

  // (1) A claimed EXPLICIT git anchor is checked FIRST. A falsified explicit anchor HARD-REJECTS as a
  // conflict — even when a real-but-unrelated command+exitCode is stapled alongside it. (Red-team blocker:
  // command evidence must NEVER be able to mask a fabricated explicit anchor.)
  let anchorVerified = false;
  const head = claimedHead(meta);
  if (head) {
    const resolved = claimedRepoDir(meta, cwd);
    if (resolved) {
      const live = gitAnchors(resolved.dir);
      if (live.isRepo && live.head) {
        const lHead = live.head.toLowerCase();
        if (lHead.startsWith(head) || head.startsWith(lHead)) anchorVerified = true;
        else if (resolved.explicit) {
          return { ok: false, conflict: true, reason: `claimed git anchor ${head} does not match the live HEAD ${live.head} in ${resolved.dir} — refusing to auto-promote a fabricated or stale anchor` };
        }
      }
    }
    // A sha-shaped anchor with no resolvable/matching repo can't be engine-verified → does not qualify.
  }

  // (2) a verified anchor is the STRONG, recall-eligible provenance kind.
  if (anchorVerified) return { ok: true, kind: 'anchor' };
  // (3) only then does structured command+exitCode qualify — WEAK provenance: durable but never
  // recall-eligible (see recall's anchored-only gate), so stapling one can't launder anything.
  if (command.length > 0 && hasExit) return { ok: true, kind: 'command' };
  return { ok: false };
}

export function evaluateAutoPromote(payload: WriteCandidatePayload, opts: { cwd?: string } = {}): AutoPromoteVerdict {
  // Scan the benign-redacted view (email/PII already → [redacted], matching what writeCandidate persists),
  // so the secret gate fires ONLY on a REAL credential — an email no longer mislabels a clean handoff as a
  // hard 'secret' rejection (P0-C). redactIngestBenign leaves real secrets untouched, so the gate below is
  // exactly as strict for them as before; this only stops email from masquerading as a hard secret here.
  const scan = redactIngestBenign(fullScanText(payload)); // title + body + metadata — everything that gets stored
  if (containsSecretLikeContent(scan)) {
    return { allow: false, reason: 'contains secret-like content (text/title/metadata)', category: 'secret' };
  }
  const prov = verifyProvenance(payload, opts.cwd);
  if (prov.conflict) {
    return { allow: false, reason: prov.reason ?? 'claimed anchor conflicts with live state', category: 'conflict' };
  }
  if (looksLikeGovernanceStatement(governanceScanText(payload))) {
    return {
      allow: true,
      tier: 'flagged',
      reason: 'reads as a standing rule / policy / access / identity / destructive statement',
    };
  }
  if (!prov.ok) {
    return {
      allow: true,
      tier: 'unverified',
      reason: 'no engine-verifiable provenance — searchable durable memory, but never recall-eligible until reviewed',
    };
  }
  // T3: record HOW the engine verified — 'anchor' (a live-HEAD-matched git anchor the engine actually
  // re-checked) vs 'command' (a structured-but-self-reported command+exitCode). Only 'anchor' earns
  // recall-eligibility under the opt-in knob; a stapled-but-unverified command+exitCode lands durable
  // 'verified' yet stays out of recall (closes the provenance-theater path).
  return { allow: true, tier: 'verified', provenanceKind: prov.kind };
}
// ────────────────────────────────────────────────────────────────────────────

// T4: flagged 🟡 entries are durable but quarantined (never recalled, out of default search). If nobody
// upgrades one to 🟢 within the TTL, it auto-EXPIRES — so a human-review backlog can't pile up silently
// and "optional async upgrade" never quietly becomes "never happens". Expiry DELETES the entry (it was
// never trusted) and logs an audit event; it does NOT restore the candidate (that would just re-surface
// the same un-reviewed item forever). Best-effort: one bad file never aborts the sweep.
const FLAGGED_TTL_DAYS_DEFAULT = 14;

export async function expireStaleFlagged(
  workspace: Workspace,
  opts: { now?: number; ttlDays?: number } = {},
): Promise<{ expired: string[] }> {
  const ttlEnv = Number(process.env.IHOW_FLAGGED_TTL_DAYS);
  const ttlDays = opts.ttlDays ?? (Number.isFinite(ttlEnv) && ttlEnv > 0 ? ttlEnv : FLAGGED_TTL_DAYS_DEFAULT);
  const now = opts.now ?? Date.now();
  const cutoff = now - ttlDays * 24 * 60 * 60 * 1000;
  const expired: string[] = [];
  let files: string[];
  try {
    files = await listMarkdownFiles(workspace.memoryDir);
  } catch {
    return { expired };
  }
  const stale: Array<{ filePath: string; relative: string; promotedAt: string }> = [];
  for (const filePath of files) {
    const relative = relativeToSpace(workspace, filePath);
    // durable promoted memory ONLY — never candidates / events / history
    if (relative.startsWith('memory/_mcp/_events/') || relative.startsWith('memory/_mcp/history/')
      || relative.startsWith('memory/_mcp/candidates/') || relative.startsWith('memory/candidate/')) continue;
    let content: string;
    try {
      content = (await fs.readFile(filePath, 'utf8')).slice(0, 1024);
    } catch {
      continue;
    }
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    const front = fmMatch ? fmMatch[1] : '';
    if (!/^\s*flagged:\s*["']?true\b/im.test(front)) continue;
    const stamp = front.match(/^\s*promoted_at:\s*["']?([^"'\n]+)/im);
    const at = stamp ? Date.parse(stamp[1].trim()) : NaN;
    if (!Number.isFinite(at) || at > cutoff) continue; // missing or still-fresh timestamp -> keep
    stale.push({ filePath, relative, promotedAt: stamp![1].trim() });
  }
  if (!stale.length) return { expired };
  await withWorkspaceLock(workspace, async () => {
    for (const s of stale) {
      try {
        await fs.rm(s.filePath, { force: true });
        await appendEvent(workspace, {
          type: 'memory.flagged.expired',
          path: s.relative,
          actor: 'flagged-ttl',
          metadata: { ttlDays, promotedAt: s.promotedAt },
        });
        expired.push(s.relative);
      } catch {
        // best-effort — keep sweeping
      }
    }
  });
  return { expired };
}

// T5: surface the human-review backlog. Flagged 🟡 entries are durable but NOT authoritative (never
// recalled). They wait for a human to either upgrade the keepers to 🟢 or let them expire (T4). The
// stop hook reads this so a session never ends silently sitting on un-reviewed flagged memory.
export async function pendingFlaggedReview(
  workspace: Workspace,
  limit = 5,
): Promise<{ count: number; sample: string[] }> {
  let files: string[];
  try {
    files = await listMarkdownFiles(workspace.memoryDir);
  } catch {
    return { count: 0, sample: [] };
  }
  const flagged: string[] = [];
  for (const filePath of files) {
    const relative = relativeToSpace(workspace, filePath);
    if (relative.startsWith('memory/_mcp/_events/') || relative.startsWith('memory/_mcp/history/')
      || relative.startsWith('memory/_mcp/candidates/') || relative.startsWith('memory/candidate/')) continue;
    let front = '';
    try {
      const c = (await fs.readFile(filePath, 'utf8')).slice(0, 512);
      const m = c.match(/^---\n([\s\S]*?)\n---/);
      front = m ? m[1] : '';
    } catch {
      continue;
    }
    if (/^\s*flagged:\s*["']?true\b/im.test(front)) flagged.push(relative);
  }
  return { count: flagged.length, sample: flagged.slice(0, limit) };
}
// ────────────────────────────────────────────────────────────────────────────

// A candidate can be referenced by its memory PATH (what write_candidate returns as `path`) OR by
// its `candidateId` (the UUID write_candidate returns first). An agent naturally reaches for the id,
// so resolve it to a path here instead of failing. A readable path is returned untouched (preserves
// existing behavior); a bare token is matched against each candidate's `candidate_id` front-matter
// (or filename) under the candidates dir.
async function resolveCandidateRef(workspace: Workspace, candidateRef: string): Promise<string> {
  const trimmed = (candidateRef || '').trim();
  if (!trimmed) throw new Error('candidate_ref_required');
  // Fast path: already a readable memory path → use as-is.
  try {
    await readMemoryFile(workspace, trimmed);
    return trimmed;
  } catch { /* not a direct path — fall through to candidateId resolution */ }
  // Only a bare token (no path separators) is treated as a candidateId.
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    throw new Error(`candidate_not_found: ${candidateRef}`);
  }
  let names: string[];
  try {
    names = (await fs.readdir(workspace.candidatesDir, { recursive: true })) as string[];
  } catch {
    throw new Error(`candidate_not_found: ${candidateRef}`);
  }
  for (const name of names) {
    if (typeof name !== 'string' || !name.endsWith('.md')) continue;
    const candidatePath = relativeToSpace(workspace, path.join(workspace.candidatesDir, name));
    let file: { path: string; content: string };
    try {
      file = await readMemoryFile(workspace, candidatePath);
    } catch {
      continue;
    }
    const idMatch = file.content.match(/^candidate_id:\s*"?(.*?)"?\s*$/m);
    if (idMatch?.[1] === trimmed || path.basename(name, '.md') === trimmed) return candidatePath;
  }
  throw new Error(`candidate_not_found: ${candidateRef} — pass the candidate path or candidateId returned by write_candidate`);
}

export async function promoteCandidate(
  workspace: Workspace,
  candidateRef: string,
  target: PromoteTarget = {},
  options: PromoteOptions = {},
): Promise<PromoteResult> {
  return await withWorkspaceLock(workspace, async () => {
    const resolvedRef = await resolveCandidateRef(workspace, candidateRef);
    const candidate = await readMemoryFile(workspace, resolvedRef);
    const candidateAbsolute = absoluteFromMemoryPath(workspace, candidate.path);
    if (!isAllowedCandidatePath(workspace, candidate.path, candidateAbsolute)) {
      throw new Error('candidate_must_be_from_inbox');
    }
    // r5: the candidate's OWN path/filename flows raw into the _events `candidatePath` field, the
    // history/promoted-candidates archive filename, AND the returned plan — none redactable after the fact.
    // A write_candidate-generated path is always slugged safe; reject an out-of-band PII/secret-named file
    // (mirrors the explicit target.path reject) so it never reaches any of those persistence surfaces.
    if (containsSecretLikeContent(normalizeRef(candidate.path))) {
      throw new Error('candidate_path_contains_secret_like_content');
    }
    const candidateIdMatch = candidate.content.match(/^candidate_id:\s*"?(.*?)"?\s*$/m);
    const candidateId = candidateIdMatch?.[1] || path.basename(candidate.path, '.md');
    const targetPath = resolveTargetPath(workspace, candidateId, target);
    const targetRelative = relativeToSpace(workspace, targetPath);
    if (isProtectedPath(targetRelative)) throw new Error('protected_core_path');

    // Auto-promoted memory is tagged (tier/reviewed) so it can be told apart from human-confirmed
    // promotions and treated as machine-judged. (Recall strips these tags from injected snippets.)
    // RED-TEAM-NEEDED: bm25 rank down-weighting of these unreviewed entries is now WIRED at search time
    // (src/engine/fts.ts: `reviewed` UNINDEXED column + rank_penalty in searchFts). It is RANKING ONLY —
    // an unreviewed entry stays fully searchable and fully recall-eligible; it just sorts below a
    // human-reviewed entry of comparable lexical match. No eligibility/gate change here.
    const flaggedFrontmatter = options.tier === 'flagged'
      ? `flagged: true\nflag_reason: ${JSON.stringify(options.flagReason || 'governance marker')}\n`
      : '';
    // T3: record which provenance form the engine actually verified, so recall can admit only the
    // anchor-verified ('anchor') tier under the knob — never command+exitCode alone.
    const provenanceKindFrontmatter = options.provenanceKind
      ? `provenance_kind: ${JSON.stringify(options.provenanceKind)}\n`
      : '';
    const autoFrontmatter = options.auto
      ? `tier: "auto-promoted"\nreviewed: false\nauto_tier: ${JSON.stringify(options.tier || 'verified')}\npromoted_by: ${JSON.stringify(safeActorId(options.actor || 'agent-auto'))}\n${provenanceKindFrontmatter}${flaggedFrontmatter}`
      : '';
    const body = candidate.content
      .replace(/^status:\s*"candidate"\s*$/m, 'status: "promoted"')
      .replace(/^type:\s*"memory_candidate"\s*$/m, 'type: "memory"')
      .replace(/^---\n/, `---\npromoted_at: "${new Date().toISOString()}"\n${autoFrontmatter}`);
    // EVERY promote (not just auto) must clear the durable secret check — a backstop on the FULL file content
    // (title + metadata + body + the frontmatter candidate_id). An out-of-band candidate can carry raw
    // PII/secret in a frontmatter field (e.g. candidate_id) that would otherwise flow into the _events
    // candidateId AND the durable filename slug; gating here rejects it before any surface is written.
    // write_candidate already redacts its output, so a normally-created candidate always passes (r5 self-audit).
    assertNoSecretLikeDurableCandidate(body);
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
      actor: safeActorId(options.actor || 'core.promote'), // audit actor must be PII/secret-safe (defense-in-depth; mirrors the durable lane)
      metadata: {
        candidateId,
        target: safeAuditTarget(target), // Blocker 1: a PII/secret target.title must not land in the audit log
        stagingOnly: workspace.mode === 'existing-memory-root',
        targetMemoryPath: relativeToMemory(workspace, targetPath),
        auto: options.auto || undefined,
        autoTier: options.tier,
        provenanceKind: options.provenanceKind,
        flagReason: options.flagReason,
        reviewed: options.auto ? false : undefined,
        provenance: safeAuditMetadata(options.provenance), // r2 Blocker 1: no raw PII/secret in the audit log
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
    const resolvedRef = await resolveCandidateRef(workspace, candidateRef);
    const candidate = await readMemoryFile(workspace, resolvedRef);
    const candidateAbsolute = absoluteFromMemoryPath(workspace, candidate.path);
    if (!isAllowedCandidatePath(workspace, candidate.path, candidateAbsolute)) {
      throw new Error('candidate_must_be_from_inbox');
    }
    // r5: the candidate's OWN path/filename flows raw into the _events `candidatePath` field, the
    // history/promoted-candidates archive filename, AND the returned plan — none redactable after the fact.
    // A write_candidate-generated path is always slugged safe; reject an out-of-band PII/secret-named file
    // (mirrors the explicit target.path reject) so it never reaches any of those persistence surfaces.
    if (containsSecretLikeContent(normalizeRef(candidate.path))) {
      throw new Error('candidate_path_contains_secret_like_content');
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
    // r4 Blocker: actor is EXTERNAL input (CLI `--actor`, MCP `args.actor`, API `options.actor`) and flows
    // into both the dry-run plan and the real-write _events audit event — collapse it to a safe id so a
    // PII/secret-shaped actor never lands raw in the ndjson audit log (same policy as journal/candidate).
    const actor = safeActorId(options.actor || 'core.durable-promote');
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
          target: safeAuditTarget(options.target || {}), // Blocker 1: no PII/secret title in the audit log
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
        // r3 Blocker 2: the real-write audit event must match the dry-run plan (line ~1200) — a raw PII/
        // secret-shaped target.title must never land in the _events ndjson (a backed-up/grep-able surface).
        target: safeAuditTarget(options.target || {}),
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
