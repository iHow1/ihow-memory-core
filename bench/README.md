# bench/ — reproducible evidence harnesses

These are the **deeper measurement harnesses** behind the claims in
[`docs/verify-benchmark.md`](../docs/verify-benchmark.md). They are not part of the shipped npm package
(dev-only), and they drive the **same engine functions the product uses** — not a separate demo path.

The one-command, fully-deterministic proof of the headline guarantees is the shipped command itself:

```bash
ihow-memory benchmark        # three-color verdict discriminates · floor blocks junk · 11/11
```

The harnesses here go deeper, with numbers:

| Harness | Run | Proves | Deterministic? |
| --- | --- | --- | --- |
| `autopromote-precision.mjs` | `node bench/autopromote-precision.mjs` | the auto-promote floor allows only clean + non-directive + engine-verifiable-provenance content (14/14, 0 false-positive); the precision ceiling (provenanced ≠ true); coverage (~33% of realistic facts) | **yes** — exit non-zero if the safety contract is ever violated |
| `recall-quality.mjs` | `node bench/recall-quality.mjs` | recall's deterministic safety guarantees: off-topic prompts inject nothing; a stale/superseded entry is never injected; plus injection rates and the reviewed-vs-auto delta | **safety part: yes** (gates the exit). The "useful vs noise" split (reviewed ~88% / auto ~25%) is LLM-judged and documented, not rerun here. |

Both require Node ≥ 22.12 (the engine's `node:sqlite`); `autopromote-precision.mjs` also needs `git`
on PATH for the anchor-provenance cases. Each prints a report and exits non-zero if a guarantee fails —
so they double as regression detectors, not just marketing.

Why this matters: the product's pitch is "don't trust our green — re-run it yourself." These let a
skeptic reproduce the deeper numbers, not just the headline benchmark. The judged usefulness split is
the one number that needs an LLM panel; everything load-bearing for **safety** is deterministic here.
