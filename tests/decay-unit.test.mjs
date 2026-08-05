// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Phase-4 DETERMINISTIC DECAY — unit-level invariants on the pure math/exemption module (src/decay.ts).
// These pin the hard contract WITHOUT a workspace: the functions are model-free, deterministic, bounded,
// and the PINNED governance tiers (verified/flagged) are EXEMPT. The integration test (decay-ranking)
// proves the wiring; this proves the primitives the wiring trusts.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  elapsedDays,
  isArchiveCandidate,
  isDecayExempt,
  lastVerificationMs,
  salienceDecayScore,
  timeSinceVerificationPenalty,
  DECAY_CONSTANTS,
} from '../src/decay.ts';

test('decay is DETERMINISTIC and model-free: same inputs -> bit-identical outputs', () => {
  const a = salienceDecayScore({ ageDays: 17, accessCount: 3, halfLifeDays: 30 });
  const b = salienceDecayScore({ ageDays: 17, accessCount: 3, halfLifeDays: 30 });
  assert.equal(a, b, 'salience is a pure function of its inputs');
  const p1 = timeSinceVerificationPenalty({ ageDaysSinceVerification: 45, halfLifeDays: 90 });
  const p2 = timeSinceVerificationPenalty({ ageDaysSinceVerification: 45, halfLifeDays: 90 });
  assert.equal(p1, p2, 'verification penalty is deterministic');
});

test('salience decays monotonically with age and HALVES at the half-life', () => {
  const fresh = salienceDecayScore({ ageDays: 0, halfLifeDays: 30 });
  const oneHalfLife = salienceDecayScore({ ageDays: 30, halfLifeDays: 30 });
  const twoHalfLives = salienceDecayScore({ ageDays: 60, halfLifeDays: 30 });
  assert.ok(Math.abs(fresh - 1) < 1e-9, 'unit salience at age 0 (no access)');
  assert.ok(Math.abs(oneHalfLife - 0.5) < 1e-9, 'half salience after one half-life');
  assert.ok(Math.abs(twoHalfLives - 0.25) < 1e-9, 'quarter salience after two half-lives');
  assert.ok(oneHalfLife < fresh && twoHalfLives < oneHalfLife, 'strictly monotone decreasing in age');
});

test('access reinforcement is bounded, PER-HIT diminishing, and never unbounded', () => {
  const noAccess = salienceDecayScore({ ageDays: 30, accessCount: 0, halfLifeDays: 30 });
  const oneHit = salienceDecayScore({ ageDays: 30, accessCount: 1, halfLifeDays: 30 });
  const twoHits = salienceDecayScore({ ageDays: 30, accessCount: 2, halfLifeDays: 30 });
  const threeHits = salienceDecayScore({ ageDays: 30, accessCount: 3, halfLifeDays: 30 });
  const lotsAccess = salienceDecayScore({ ageDays: 30, accessCount: 1000, halfLifeDays: 30 });
  assert.ok(oneHit > noAccess, 'access reinforces a decayed note');
  // PER-HIT diminishing returns: each additional hit adds strictly less than the previous one.
  const firstHitGain = oneHit - noAccess;
  const secondHitGain = twoHits - oneHit;
  const thirdHitGain = threeHits - twoHits;
  assert.ok(secondHitGain < firstHitGain, 'the 2nd hit adds less than the 1st (diminishing)');
  assert.ok(thirdHitGain < secondHitGain, 'the 3rd hit adds less than the 2nd (diminishing)');
  // hard cap: reinforcement (the part above the decayed base) can never exceed the configured ceiling.
  const decayedBase = noAccess; // age-30 / half-life-30 with 0 access == base decayed to 0.5
  assert.ok(lotsAccess - decayedBase <= DECAY_CONSTANTS.ACCESS_REINFORCEMENT_CAP + 1e-9, 'reinforcement is capped');
});

test('time-since-verification penalty is bounded [0,1], 0 when fresh, rising toward needs-reverification', () => {
  const justVerified = timeSinceVerificationPenalty({ ageDaysSinceVerification: 0, halfLifeDays: 90 });
  const aQuarterOld = timeSinceVerificationPenalty({ ageDaysSinceVerification: 90, halfLifeDays: 90 });
  const ancient = timeSinceVerificationPenalty({ ageDaysSinceVerification: 100000, halfLifeDays: 90 });
  assert.equal(justVerified, 0, 'a just-verified fact has zero penalty');
  assert.ok(Math.abs(aQuarterOld - 0.5) < 1e-9, 'half-penalty at the verification half-life');
  assert.ok(ancient <= 1 && ancient > 0.999, 'saturates to (at most) 1, never exceeds it');
  assert.ok(aQuarterOld > justVerified && ancient >= aQuarterOld, 'monotone non-decreasing in elapsed time');
});

test('elapsedDays floors at 0 — a future-dated stamp (clock skew) reads as "now", never negative', () => {
  const now = Date.parse('2026-06-30T00:00:00Z');
  assert.equal(elapsedDays(now + 5 * DECAY_CONSTANTS.DAY_MS, now), 0, 'future stamp => 0 elapsed (no amplification)');
  assert.equal(elapsedDays(NaN, now), 0, 'unparseable stamp => 0 elapsed (NaN-safe)');
  assert.ok(Math.abs(elapsedDays(now - 2 * DECAY_CONSTANTS.DAY_MS, now) - 2) < 1e-9, 'two days elapsed');
});

test('PINNED EXEMPTION: verified/human-reviewed and flagged entries are EXEMPT from decay', () => {
  // flagged 🟡 — quarantined, governed by TTL not decay
  assert.equal(isDecayExempt('flagged: true\nflag_reason: "x"'), true, 'flagged is exempt');
  // verified / human-reviewed — the absence of machine-judged markers => PINNED
  assert.equal(isDecayExempt('scope: "team"\npromoted_at: "2026-01-01T00:00:00Z"'), true, 'plain promoted (verified) is exempt');
  assert.equal(isDecayExempt(''), true, 'no frontmatter => treated as verified/pinned (conservative under-decay)');
  // ONLY the machine-judged auto tier is NON-exempt (eligible to decay)
  assert.equal(isDecayExempt('tier: "auto-promoted"\nreviewed: false'), false, 'auto-promoted reviewed:false can decay');
  assert.equal(isDecayExempt('reviewed: false'), false, 'reviewed:false can decay');
  // case/quote tolerant (shared multi-agent vault) — but a flagged auto entry is STILL exempt (flag wins)
  assert.equal(isDecayExempt("Reviewed: False\nflagged: 'true'"), true, 'flagged wins even over auto markers');
});

test('isArchiveCandidate marks a long-untouched soft note for archive — but only past the floor', () => {
  // fresh, no access -> not an archive candidate
  assert.equal(isArchiveCandidate({ ageDays: 0, accessCount: 0, halfLifeDays: 30 }), false, 'fresh note is not archived');
  // two half-lives untouched -> salience 0.25 == floor -> not strictly below -> not yet
  assert.equal(isArchiveCandidate({ ageDays: 60, accessCount: 0, halfLifeDays: 30, floor: 0.25 }), false, 'at the floor, not below');
  // well past -> below floor -> archive candidate
  assert.equal(isArchiveCandidate({ ageDays: 200, accessCount: 0, halfLifeDays: 30, floor: 0.25 }), true, 'deeply decayed note is an archive candidate');
  // access keeps a frequently-used note OUT of archive even when old
  assert.equal(isArchiveCandidate({ ageDays: 200, accessCount: 50, halfLifeDays: 30, floor: 0.25 }), false, 'a reinforced note resists archival');
});

test('lastVerificationMs reads the freshness clock from frontmatter; missing -> null (no false freshness)', () => {
  assert.equal(lastVerificationMs('promoted_at: "2026-06-01T00:00:00Z"'), Date.parse('2026-06-01T00:00:00Z'));
  // promoted_at wins over created_at (a re-promote = re-verification resets the clock)
  assert.equal(
    lastVerificationMs('created_at: "2025-01-01T00:00:00Z"\npromoted_at: "2026-06-01T00:00:00Z"'),
    Date.parse('2026-06-01T00:00:00Z'),
    'promoted_at (re-verification) takes precedence over created_at',
  );
  assert.equal(lastVerificationMs('scope: "team"'), null, 'no timestamp => null, caller applies no penalty');
});
