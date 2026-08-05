# Trust Eval — the "should I believe this?" benchmark for agent memory

> Status: design (alpha16-trusteval). Companion runnable skeleton: `scripts/trust-eval.mjs`.
> Scope owner: handoff / governance layer (`src/handoff.ts`, `src/governance.ts`, `src/handoff-metrics.ts`).

## Why this eval exists

The whole memory field benchmarks the same axis: **recall quality** — did the
retriever surface the right chunk (R@5 / R@10 / MRR on LongMemEval, LoCoMo, …).
That axis answers *"can the system FIND the fact?"* Nobody benchmarks the axis
that actually causes agent failures in practice:

> *Given that a fact was surfaced, SHOULD the agent have believed it?*

A retriever can score 97% R@5 and still drive a confident-wrong action, because
the top-1 hit was **stale** ("HEAD is 9cd4dc2, 16 commits to push" — but HEAD
moved three days ago), **contradicted** by a newer fact, or **asserted without
evidence** ("tests pass ✅" with nothing behind the checkmark). Recall is
necessary; it is not the trust decision. The trust decision is what this product
is built around (code-computed GREEN/YELLOW/RED resume verdicts, provenance-gated
recall eligibility, pseudo-anchor conflict rejection) — so it is the axis where
we have something to measure that competitors structurally cannot.

**This eval measures the moat firing, not recall.** It is deliberately
orthogonal to LongMemEval/LoCoMo: those stay the recall-quality benchmark; this
is the trust-calibration benchmark. We publish both, honestly, side by side.

## Honest scope limit (read this before quoting any number)

The verify-first moat is **strongest, and only fully load-bearing, for facts that
are anchored to code or commands** — a git HEAD the engine can re-read
(`computeContinueVerdict` re-runs `gitAnchors` against the live repo), a
`command + exitCode` pair (`verifyProvenance` kind `command`), a file fingerprint
(`fileAnchors`). For these, the engine re-derives ground truth at decision time;
belief is earned against reality, not against the agent's own assertion.

For **non-code facts** — a preference ("user likes terse summaries"), a decision
("we chose Postgres over Mongo"), a plan — there is no live oracle to re-run. The
honest behavior, and what the engine actually does, is to fall back to the
ordinary **"unverified"** tier (`evaluateAutoPromote` → `tier: 'unverified'`,
never recall-eligible until reviewed) rather than pretend to verify. The narrative
is carried **verbatim under an UNVERIFIED flag and is never parsed into
authoritative fields** (`handoff.ts` design lock).

So this eval is split into two domains, and **we never average across them into a
single headline**:

- **Domain A — code/command-anchored facts (moat domain).** Here we expect, and
  measure, strong numbers: staleness caught, contradictions resolved toward
  ground truth, confidence tracking real evidence. This is where we make the
  competitive claim.
- **Domain B — non-code facts (honest-floor domain).** Here the *correct* score
  is not "we verify everything" — it is **"we never emit a false GREEN / a false
  recall-eligible-verified"**. The target metric is *calibrated abstention*: when
  there is no oracle, the system must degrade to YELLOW / unverified, not
  confidently assert. A Domain-B "win" is a correct *I-can't-verify-this*, not a
  correct *yes*.

Marketing rule that follows from this: we advertise verify-first as
**"code-anchored re-verification,"** never as "we verify your memory." The eval's
job is to keep that claim true with numbers, and to make the boundary visible
rather than papered over.

## The three metrics

Each metric is computed **deterministically, no LLM judge** — the same lock as
the rest of the system: code does the equality/ordering check, a model never
grades "right/wrong." That is what makes the eval reproducible and what keeps it
honest (no model marking our own homework).

### 1. Staleness detection — `staleness_recall` / `staleness_precision`

**Question:** when a surfaced fact has gone stale against live ground truth, does
the system flag it instead of serving it as current?

**Signal (Domain A):** reuse `anchorConflicts(narrative, liveHead)` from
`handoff-metrics.ts` — count git-SHA-shaped tokens the narrative cites that do
**not** prefix-match the live HEAD. A fixture provides a narrative + a recorded
anchor + a (possibly drifted) live HEAD; the engine must classify FRESH vs STALE.
The full verdict path (`computeContinueVerdict`) must return **RED** on a drifted
HEAD and **GREEN** only on a true match.

- `staleness_recall` = caught_stale / actually_stale (did we catch the stale ones)
- `staleness_precision` = correctly_stale / flagged_stale (did we cry wolf)
- A false GREEN on a stale fact is the **cardinal sin** and is reported
  separately as `false_green_count` — target **0**, always.

### 2. Contradiction-resolution win-rate — `contradiction_winrate`

**Question:** given two facts that disagree, does the system resolve toward the
one with the stronger, engine-checkable provenance — rather than toward whichever
was written more confidently or more recently by clock alone?

**Signal:** rank the two candidates by provenance kind, using the real ordering
from `verifyProvenance` / `evaluateAutoPromote`:

```
anchor-verified (live-HEAD matched)   >   command+exitCode   >   unverified self-assertion
```

A "win" = the engine picks the candidate whose claim is backed by the stronger
**falsifiable** provenance, AND, when one side's anchor conflicts with live state,
the conflicting side is *rejected outright* (`evaluateAutoPromote` →
`category: 'conflict'`), not merely down-ranked. The adversarial fixtures are the
point: the *wrong* answer is always the one a naive "trust the confident /
trust the newest" system would pick.

- `contradiction_winrate` = wins / total_pairs
- Domain-B pairs (two non-code facts, neither anchorable) are scored on the honest
  floor: a "win" is **declining to crown a winner** (both stay unverified, surfaced
  with the conflict flagged) — *not* fabricating a resolution.

### 3. Confidence-tracks-evidence — `confidence_monotonicity`

**Question:** does the system's stated confidence move **with** the strength of
evidence, and never exceed what the evidence supports?

**Signal:** map each fact to the tier the engine assigns and assert a monotone
relationship between evidence strength and emitted confidence:

| evidence | engine tier / verdict | confidence band |
|---|---|---|
| live-HEAD-matched anchor | `verified` / GREEN | high |
| command+exitCode | `verified`(command) / not recall-eligible | medium |
| self-asserted "verified:true", lone exitCode, prose "tests pass" | `unverified` / YELLOW | low |
| anchor conflicts with live HEAD | `conflict` (rejected) / RED | **zero — refused** |

- `confidence_monotonicity` = fraction of fixtures where
  `confidence(stronger_evidence) >= confidence(weaker_evidence)` holds AND no
  fixture emits high confidence on self-asserted-only evidence.
- The killer assertion: a fact carrying **only** `verified:true` (the agent
  grading its own homework) must **never** land in the high band. This is the
  single behavior the rest of the field does not implement, so it is the headline
  fixture.

## What a passing run looks like

```
DOMAIN A (code/command-anchored — moat domain)
  staleness_recall        1.00   (every drifted HEAD flagged)
  staleness_precision     1.00   (no fresh fact mis-flagged)
  false_green_count       0      (cardinal — must be 0)
  contradiction_winrate   1.00   (stronger provenance always wins; conflicts rejected)
  confidence_monotonicity 1.00   (self-asserted never reaches high band)

DOMAIN B (non-code — honest-floor domain)
  calibrated_abstention   1.00   (no oracle ⇒ YELLOW/unverified, never false GREEN)
```

The Domain-A numbers are the competitive claim. The Domain-B number is the
*honesty* claim — it proves we don't overreach into facts we can't verify.

## Provenance / reproducibility discipline

Mirrors the governance floor the system already enforces on its own memory:

- Every metric is recomputed from fixtures on each run; **no stored score is
  trusted** (same principle as `ihow-memory verify`'s "every line is
  reproducible").
- Fixtures that assert a git-anchor outcome build a **real throwaway git repo**
  and drive HEAD drift with real commits (see the harness `tmpRepo` helper) — the
  staleness/contradiction checks run against actual `gitAnchors`, not a mock, so
  the eval exercises the same code path production does. (The skeleton ships
  pure-data stubs too, so it runs with zero deps even where git is unavailable;
  those are labeled `stub` in output.)
- No network, no third-party deps — consistent with the zero-dependency moat.
- Headline numbers must always be published **per domain**; a cross-domain
  average is forbidden because it would launder the honest-floor limit into a
  fake "we verify everything" number.

## Non-goals

- Not a recall benchmark (LongMemEval/LoCoMo remain that lane).
- Not an LLM-judge eval — no model decides correctness here.
- Not a claim that we verify non-code facts. Domain B exists precisely to bound
  the claim.

## Roadmap hooks (where this plugs into the moat-into-numbers plan)

- Extends naturally to the planned **time-since-verification penalty** (a non-git
  trust signal): a Domain-B fact's confidence should *decay* with staleness even
  without an oracle — a future `staleness_recall` variant for preferences/decisions.
- Feeds the **repro harness** deliverable: published alongside the default-binary
  recall numbers, this is the column competitors leave blank.
