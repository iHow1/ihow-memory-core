// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Phase 4: DETERMINISTIC, MODEL-FREE forgetting + a time dimension. Two ranking signals, ZERO LLM, no
// network, no per-entry training — every output here is a closed-form function of the entry's own
// timestamps and a count read from the append-only event log. Re-running on the same inputs yields the
// same number (the project's "re-run for the same result" rule).
//
// WHAT THIS IS (and, more importantly, what it is NOT):
//   - It is a RANKING / ARCHIVE-ORDERING aid. Every function returns a score or a boolean PREFERENCE that
//     a caller folds into an EXISTING sort. Nothing here reads or writes the recall-eligibility gate, the
//     FTS `WHERE` clause, the curated-path allowlist, the flagged quarantine, or the engine-anchored set.
//     A decayed entry is sorted lower and may be surfaced for ARCHIVE — it is NEVER hard-deleted here and
//     NEVER removed from search/recall eligibility. (This is the explicit anti-pattern vs ai-memory's
//     `hard_delete_after_days` footgun: we down-rank toward archive, we do not silently drop.)
//   - The governance PINNED tier is EXEMPT. `verified`-tier and `flagged` entries never decay and are
//     never archive-eligible from here: isDecayExempt() short-circuits them to a no-op. So the moat's
//     hardest facts (engine-verified provenance) keep their full weight forever; decay only ever touches
//     the soft lanes (journal / floor) and the time-since-verification of NON-pinned curated entries.
//
// STRATEGIC POINT: time-since-verification is a NON-GIT freshness signal. verify-first already down-weights
// a code claim whose git anchor no longer matches HEAD; this extends the SAME "trust decays until
// re-verified" instinct to non-code facts (preferences / decisions) that have no git anchor at all — their
// relevance trends toward "needs re-verification" as the clock runs, purely by elapsed time, deterministically.

const DAY_MS = 24 * 60 * 60 * 1000;

// Half-life form. We express decay as a half-life (intuitive: "after H days a journal note is worth half")
// and convert to the rate constant lambda = ln 2 / H. exp(-lambda * dt) is then 1 at dt=0 and 0.5 at dt=H.
const DEFAULT_JOURNAL_HALF_LIFE_DAYS = 30; // a low-weight journal/floor note loses half its salience monthly
const DEFAULT_BASE_SALIENCE = 1; // journal/floor entries enter at unit salience; access reinforces above it
// Each prior recall/access adds a bounded, diminishing reinforcement so a frequently-used note resists
// decay without ever being able to outrank a curated entry (the reinforcement is capped well below the
// curated-vs-journal ordering gap the caller already enforces).
const ACCESS_REINFORCEMENT_PER_HIT = 0.15;
const ACCESS_REINFORCEMENT_CAP = 0.9;

// Time-since-verification penalty: a non-pinned curated fact's freshness erodes as elapsed time since its
// last verification grows, trending toward "needs re-verification". Bounded to [0, 1] so it can only ever
// REORDER within a tier — it can never push a curated entry below the journal lane or out of any gate.
const DEFAULT_VERIFICATION_HALF_LIFE_DAYS = 90; // a preference/decision is "half as fresh" after a quarter

function envPositiveNumber(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

// ln2 / halfLife, guarded so a bad/zero half-life can never produce Infinity/NaN.
function lambdaFromHalfLife(halfLifeDays: number): number {
  const h = Number.isFinite(halfLifeDays) && halfLifeDays > 0 ? halfLifeDays : DEFAULT_JOURNAL_HALF_LIFE_DAYS;
  return Math.LN2 / h;
}

// Elapsed days between two instants, floored at 0 (a future-dated stamp under clock skew reads as "now",
// never as negative time that would AMPLIFY salience). NaN-safe: an unparseable stamp yields 0 elapsed.
export function elapsedDays(fromMs: number, nowMs: number): number {
  if (!Number.isFinite(fromMs) || !Number.isFinite(nowMs)) return 0;
  return Math.max(0, (nowMs - fromMs) / DAY_MS);
}

// PINNED exemption. The single source of truth for "this entry never decays". Verified-tier and flagged
// entries are governance-pinned: callers MUST consult this before applying any decay/archive signal so the
// exemption can never drift between call sites. Frontmatter is read tolerantly (case/quote-insensitive,
// any runtime / hand-authored), matching governance.ts + cli.ts recallTier so the three cannot disagree.
//
// `verified` here means the human-reviewed / engine-verified curated tier, recognised by the ABSENCE of the
// machine-judged markers (reviewed:false / tier:auto-promoted). That is intentional and conservative: an
// entry is treated as PINNED (exempt) unless it positively declares itself unreviewed-auto or flagged. So
// the failure mode is "we under-decay" (keep something at full weight), never "we decayed a verified fact".
export function isDecayExempt(frontmatter: string): boolean {
  const front = typeof frontmatter === 'string' ? frontmatter : '';
  if (/^\s*flagged:\s*["']?true\b/im.test(front)) return true; // flagged: quarantined, governed by TTL, not decay
  const isAuto = /^\s*reviewed:\s*["']?false\b/im.test(front) || /^\s*tier:\s*["']?auto-promoted\b/im.test(front);
  return !isAuto; // not-auto => verified/human-reviewed => PINNED, exempt from decay
}

// Salience decay for the SOFT lanes (journal / floor). salience(t) = base * exp(-lambda * dt) + access.
// Returns a value in (0, base + ACCESS_REINFORCEMENT_CAP]. Deterministic, model-free. The caller uses this
// ONLY to order/triage within the low-weight lane and to flag archive candidates — never to gate recall.
export function salienceDecayScore(opts: {
  ageDays: number;
  accessCount?: number;
  baseSalience?: number;
  halfLifeDays?: number;
}): number {
  const base = Number.isFinite(opts.baseSalience) && (opts.baseSalience as number) > 0 ? (opts.baseSalience as number) : DEFAULT_BASE_SALIENCE;
  const halfLife = opts.halfLifeDays ?? envPositiveNumber('IHOW_DECAY_HALF_LIFE_DAYS', DEFAULT_JOURNAL_HALF_LIFE_DAYS);
  const lambda = lambdaFromHalfLife(halfLife);
  const age = Math.max(0, Number.isFinite(opts.ageDays) ? opts.ageDays : 0);
  const decayed = base * Math.exp(-lambda * age);
  const hits = Math.max(0, Math.floor(Number.isFinite(opts.accessCount as number) ? (opts.accessCount as number) : 0));
  // Diminishing, capped reinforcement: 1 - (1 - r)^hits saturates at ACCESS_REINFORCEMENT_CAP. A note that
  // keeps getting recalled resists decay; a note nobody touches sinks. Always strictly bounded.
  const reinforcement = ACCESS_REINFORCEMENT_CAP * (1 - Math.pow(1 - ACCESS_REINFORCEMENT_PER_HIT, hits));
  return decayed + reinforcement;
}

// Time-since-verification FRESHNESS penalty for NON-pinned curated entries. Returns a value in [0, 1]:
// 0 = just verified (full freshness), -> 1 as the fact ages far past its verification half-life ("needs
// re-verification"). The caller SUBTRACTS a small multiple of this from the entry's recency sort key, so a
// long-unverified preference/decision sorts below a freshly re-verified peer of equal lexical match. It can
// NEVER change eligibility — it is a bounded reorder term, and pinned/verified entries never reach it.
export function timeSinceVerificationPenalty(opts: { ageDaysSinceVerification: number; halfLifeDays?: number }): number {
  const halfLife = opts.halfLifeDays ?? envPositiveNumber('IHOW_VERIFY_HALF_LIFE_DAYS', DEFAULT_VERIFICATION_HALF_LIFE_DAYS);
  const lambda = lambdaFromHalfLife(halfLife);
  const age = Math.max(0, Number.isFinite(opts.ageDaysSinceVerification) ? opts.ageDaysSinceVerification : 0);
  // 1 - exp(-lambda*age): 0 at age 0, asymptotes to 1. Monotonic in age, bounded, deterministic.
  return 1 - Math.exp(-lambda * age);
}

// Convenience: parse the most relevant timestamp from an entry's frontmatter for the verification clock.
// "Last verification" for a curated fact is its last (re)promotion — promoted_at is stamped on every
// promote (governance.ts), so a re-promote after re-checking a preference resets the freshness clock,
// exactly mirroring verify-first's "re-verify to refresh trust". Falls back to created_at, then null.
export function lastVerificationMs(frontmatter: string): number | null {
  const front = typeof frontmatter === 'string' ? frontmatter : '';
  for (const key of ['promoted_at', 'created_at', 'verified_at', 'entryAt']) {
    const m = front.match(new RegExp(`^\\s*${key}:\\s*["']?([^"'\\n]+)`, 'im'));
    if (m) {
      const ms = Date.parse(m[1].trim());
      if (Number.isFinite(ms)) return ms;
    }
  }
  return null;
}

// Archive triage for the SOFT lanes. A journal/floor entry is an ARCHIVE CANDIDATE (sort it to the bottom /
// surface for off-index archival) once its decayed salience falls below a floor. This NEVER deletes and
// NEVER changes eligibility — it only marks the entry as low enough to move out of the hot ranked window.
// Returns false for anything the caller has already screened as pinned (defensive double-check).
const DEFAULT_ARCHIVE_SALIENCE_FLOOR = 0.25; // ~2 half-lives of untouched decay (0.25 = 0.5^2) with no access
export function isArchiveCandidate(opts: {
  ageDays: number;
  accessCount?: number;
  baseSalience?: number;
  halfLifeDays?: number;
  floor?: number;
}): boolean {
  const floor = Number.isFinite(opts.floor as number) && (opts.floor as number) > 0
    ? (opts.floor as number)
    : envPositiveNumber('IHOW_DECAY_ARCHIVE_FLOOR', DEFAULT_ARCHIVE_SALIENCE_FLOOR);
  return salienceDecayScore(opts) < floor;
}

export const DECAY_CONSTANTS = {
  DAY_MS,
  DEFAULT_JOURNAL_HALF_LIFE_DAYS,
  DEFAULT_VERIFICATION_HALF_LIFE_DAYS,
  ACCESS_REINFORCEMENT_PER_HIT,
  ACCESS_REINFORCEMENT_CAP,
  DEFAULT_ARCHIVE_SALIENCE_FLOOR,
} as const;
