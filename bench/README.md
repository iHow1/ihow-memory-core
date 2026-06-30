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
| `../scripts/retrieval-bench.mjs --semantic …` | see below | the **semantic lane's paraphrase lift**: same fixture, FTS-only **vs** FTS+semantic (RRF-fused), as a side-by-side delta on the paraphrase/synonym battery (the known FTS floor) | **architecture-proof path: yes** (offline, no deps). **real-model path: yes given a running Ollama**, not in CI |

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

### (a) Real-model benchmark — a genuine quality number

A **real learned embedding model** (`nomic-embed-text`) running locally via [Ollama](https://ollama.com),
$0 and offline-after-pull. This is a real retrieval-quality signal: the lane captures true synonymy.

```bash
ollama pull nomic-embed-text     # one-time, ~270 MB
node scripts/retrieval-bench.mjs --semantic "node examples/ollama-embedding-provider.mjs" \
     --proof real --model nomic-embed-text
```

Measured on this fixture (real `nomic-embed-text` vectors fused with FTS via the engine's `fuseRrf`):

| metric | FTS-only | FTS + semantic (fused) | Δ |
| --- | --- | --- | --- |
| **paraphrase recall@5** | **2/5** | **5/5** | **+3** |
| overall R@5 | 0.85 | 1.00 | +0.15 |
| overall MRR | 0.85 | 0.92 | +0.07 |
| keyword recall@5 | 12/12 | 12/12 | 0 (floor preserved) |
| partial recall@5 | 3/3 | 3/3 | 0 (floor preserved) |

The semantic lane recovers **all three paraphrase queries pure FTS5 missed**, while keyword/partial
recall is unchanged — fusion is **additive**, it never degrades the always-on lexical floor. (This is a
real model, so the exact decimals can shift by model version / quantization; the paraphrase 2/5 → 5/5
recovery is the stable, reproducible finding. The run is **not in CI** because it needs a live Ollama,
and it takes ~2 min — a local model serializes embeds, so 20 docs + 20 queries is ~40 round-trips.)

> **Engine note (why the harness pre-indexes the sidecar):** the engine applies one `vectorTimeoutMs`
> (hard-capped at 30 s) to *every* provider call, including the long index op. A real local model
> serializes embeds, so indexing ~20 docs can exceed 30 s — the engine then SIGTERMs index, the sidecar
> is never written, and search **silently degrades to FTS-only** (a 2/5 paraphrase no-op that *looks*
> like the lane ran). The comparison harness therefore warms the sidecar by calling the provider's
> `index` directly (uncapped), then measures **search + RRF fusion through the real engine path**. In
> production, give a slow local model a corpus-appropriate `vectorTimeoutMs`, or have the sidecar
> maintain its index incrementally rather than rebuilding per call.

### (b) Architecture proof — deterministic, offline, **not** a model-quality number

When you can't run a real model, prove the **wiring** instead: a controlled **synonym-oracle** sidecar
that returns the hand-curated true-synonym match for the fixture's paraphrase queries. It shows that
**when a semantic lane genuinely captures a synonym relation, RRF pulls the matching doc into top-K** —
which is the architectural claim. It is **NOT** a quality benchmark (its recall is a ceiling by
construction); the real-model number above is the quality measurement.

```bash
node scripts/retrieval-bench.mjs --semantic "node examples/synonym-oracle-provider.mjs" \
     --proof architecture          # deterministic · offline · zero deps
```

This reproduces the same **paraphrase recall@5: 2/5 → 5/5 (+3)** structurally, every run, with no
network and no model. It is gated by `tests/semantic-comparison.test.mjs`.

> ### Honesty note — why not the bundled `local-embedding-provider.mjs`?
> The repo's other reference sidecar, `examples/local-embedding-provider.mjs`, uses a **hashed
> char-n-gram "embedding"**. On English paraphrase queries it does **not** capture synonymy: it lands
> the right doc only by accidental sub-word overlap (`process`↔`processes`), and on true synonym pairs
> (`credentials`↔`tokens`, `invalid`↔`expire`) it ranks the answer **behind unrelated docs** (measured:
> rank 3, below `lock_serialize`/`pagination`). Reporting a "semantic gain" from it would be a
> **fabricated, misleading number**, so this harness does **not** use it for the gain claim. The two
> sanctioned paths are the **real model** (a) for the genuine number and the **declared oracle** (b)
> for the deterministic architecture proof — each labeled as such by the required `--proof` flag.

The `--proof <real|architecture>` flag is **mandatory** with `--semantic`: the tool refuses to print a
delta without you declaring which kind of claim it is, so a reader can never mistake the architecture
demo for a model benchmark. If the provider falls back to FTS (e.g. Ollama not running), the harness
reports `ran:false` and **claims no gain** instead of dressing up a no-op delta — and a `--proof real`
run that fell back exits non-zero.

Why this matters: the product's pitch is "don't trust our green — re-run it yourself." These let a
skeptic reproduce the deeper numbers, not just the headline benchmark. The judged usefulness split is
the one number that needs an LLM panel; everything load-bearing for **safety** is deterministic here.
