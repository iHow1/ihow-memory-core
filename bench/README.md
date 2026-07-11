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
| `../scripts/retrieval-bench.mjs` | `node scripts/retrieval-bench.mjs` | the **default FTS5 engine's** retrieval quality: R@5 / R@10 / MRR + tokens-per-query on a labeled in-repo fixture (20 docs / 20 queries — **not** LongMemEval_S), and the honest lexical shape (keyword strong, paraphrase weak). Drives the real `write → promote → search` path. | **yes** — identical numbers every run; `--json` for machine output |
| `../scripts/retrieval-bench.mjs --semantic …` | see below | measures the semantic lane's paraphrase result: same fixture, FTS-only **vs** FTS+semantic (RRF-fused), with an explicit observed delta rather than assuming lift from provider/model identity | **architecture-proof path: yes** (offline, no deps). **real-model path: environment-dependent given a running Ollama**, not in CI |

Both require Node ≥ 22.12 (the engine's `node:sqlite`); `autopromote-precision.mjs` also needs `git`
on PATH for the anchor-provenance cases. Each prints a report and exits non-zero if a guarantee fails —
so they double as regression detectors, not just marketing.

## Does the semantic lane actually fix paraphrase recall? (FTS-only → fused delta)

The default FTS5 engine recalls keyword/partial queries well but **misses paraphrase/synonym queries
that share no surface tokens with the answer** — a documented `2/5` floor on the fixture's paraphrase
battery (e.g. *"how long until login credentials become invalid"* → the doc that says *"auth tokens
expire after 15 minutes"*). The optional vector lane is supposed to lift exactly that. This harness
measures whether it does, on the **same fixture, through the same `write → promote → search` path and
the same RRF fusion the product uses** — and it is scrupulous about labeling **what kind of number**
you are looking at:

### (a) Real-model benchmark — measure; do not assume lift

A **real learned embedding model** (`nomic-embed-text`) running locally via [Ollama](https://ollama.com),
$0 and offline-after-pull. This proves that a real-model ranking sidecar can run, but model identity and
provider readiness do not by themselves prove that the fused ranking improves this fixture.

```bash
ollama pull nomic-embed-text     # one-time, ~270 MB
node scripts/retrieval-bench.mjs --semantic "node examples/ollama-embedding-provider.mjs" \
     --proof real --model nomic-embed-text
```

Current live recheck on this fixture (real `nomic-embed-text` vectors fused with FTS via the engine's
`fuseRrf`; provider `ran:true`, `fallback:false`):

| metric | FTS-only | FTS + semantic (fused) | Δ |
| --- | --- | --- | --- |
| **paraphrase recall@5** | **2/5** | **2/5** | **0** |
| overall R@5 | 0.85 | 0.85 | 0 |
| overall R@10 | 0.85 | 0.85 | 0 |
| overall MRR | 0.85 | 0.85 | 0 |
| keyword recall@5 | 12/12 | 12/12 | 0 (floor preserved) |
| partial recall@5 | 3/3 | 3/3 | 0 (floor preserved) |

The provider ran successfully, but this recheck found **no observed paraphrase lift** and no headline
metric delta. That is the quality conclusion for this model/fixture run; do not substitute the oracle's
numbers below. The run is **not in CI** because it needs a live Ollama, and model version,
quantization, hardware, and provider behavior may change results. Reproduce the machine-readable
result with:

```bash
node scripts/retrieval-bench.mjs --semantic "node examples/ollama-embedding-provider.mjs" \
     --proof real --model nomic-embed-text --json
```

> **Engine timeout note:** index work uses the independent `vectorIndexTimeoutMs` budget — **10 minutes
> by default**, configurable up to 1 hour — rather than the interactive `vectorTimeoutMs` used by
> status/search (default 1.5 s, capped at 30 s). The harness calls the product's normal `rebuild()` path.
> A provider that cannot become active reports `ran:false`; a provider that runs but produces a zero
> paraphrase delta reports `observedQualityLift:false`.

### (b) Architecture proof — deterministic, offline, **not** a model-quality number

When you can't run a real model, prove the **wiring** instead: a controlled **synonym-oracle** sidecar
that returns the hand-curated true-synonym match for the fixture's paraphrase queries. It shows that
**when a semantic lane genuinely captures a synonym relation, RRF pulls the matching doc into top-K** —
which is the architectural claim. It is **NOT** a quality benchmark (its recall is a ceiling by
construction) and it says nothing about `nomic-embed-text` or any other learned model.

```bash
node scripts/retrieval-bench.mjs --semantic "node examples/synonym-oracle-provider.mjs" \
     --proof architecture          # deterministic · offline · zero deps
```

This produces **paraphrase recall@5: 2/5 → 5/5 (+3)** structurally, every run, with no network and no
model. The number demonstrates wiring only; it must not be attributed to the default model, the real
Ollama provider, or production quality. It is gated by `tests/semantic-comparison.test.mjs`.

> ### Honesty note — why not the bundled `local-embedding-provider.mjs`?
> The repo's other reference sidecar, `examples/local-embedding-provider.mjs`, uses a **hashed
> char-n-gram "embedding"**. On English paraphrase queries it does **not** capture synonymy: it lands
> the right doc only by accidental sub-word overlap (`process`↔`processes`), and on true synonym pairs
> (`credentials`↔`tokens`, `invalid`↔`expire`) it ranks the answer **behind unrelated docs** (measured:
> rank 3, below `lock_serialize`/`pagination`). Reporting a "semantic gain" from it would be a
> **fabricated, misleading number**, so this harness does **not** use it for a quality claim. The two
> sanctioned paths are the **real model** (a) for an observed, possibly zero delta and the **declared
> oracle** (b) for the deterministic architecture proof — each labeled by the required `--proof` flag.

The `--proof <real|architecture>` flag is **mandatory** with `--semantic`: the tool refuses to print a
delta without you declaring which kind of claim it is, so a reader can never mistake the architecture
demo for a model benchmark. If the provider falls back to FTS (e.g. Ollama not running), the harness
reports `ran:false` and **claims no gain** instead of dressing up a no-op delta — and a `--proof real`
run that fell back exits non-zero.

Why this matters: the product's pitch is "don't trust our green — re-run it yourself." These let a
skeptic reproduce the deeper numbers, not just the headline benchmark. The judged usefulness split is
the one number that needs an LLM panel; everything load-bearing for **safety** is deterministic here.
