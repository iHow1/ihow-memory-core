# iHow Memory Core

**Reference implementation for the [iHow Memory spec](https://github.com/iHow1/ihow-memory-standard).**

Apache-2.0 · Local-first · File-protocol · Passes spec v0.1 conformance

[![Conformance](https://img.shields.io/badge/LongMemEval_S-retrieval_recall_all@10%3D1.0-brightgreen)](https://github.com/iHow1/ihow-memory-standard/blob/main/conformance/evidence/longmemeval-s-2026-05-11.md)
[![Self-Conformance](https://img.shields.io/badge/scenarios_v0.1-5%2F5_PASS-brightgreen)](https://github.com/iHow1/ihow-memory-standard/tree/main/conformance)
[![License](https://img.shields.io/badge/code-Apache--2.0-blue)](./LICENSE)

## What it is

The reference implementation behind the iHow Memory spec. Use it as:

- A working memory layer for your AI agent (file-protocol, no SaaS, no API keys)
- A baseline to compare your own memory system against
- The implementation behind the public LongMemEval_S 470/470 retrieval-stage benchmark

## Quickstart

To try it from a clone today:

```bash
git clone https://github.com/iHow1/ihow-memory-core.git
cd ihow-memory-core
npm install
npm exec --package . -- ihow-memory init my-project
cd my-project
# Read README.md to see the generated workspace layout
```

A polished published-package quickstart is on the v0.2 roadmap. Meanwhile the repo-local invocation works.

## Use it with your AI tool (vendor-neutral)

`init` drops the same read-first / write-back router as one front-door per AI tool, so a fresh workspace can be picked up without re-briefing:

- **Claude Code** reads `CLAUDE.md`; **Codex / AGENTS.md-convention tools** read `AGENTS.md`.
- **Cursor / Gemini CLI / Windsurf** → copy `memory/MEMORY-PROTOCOL.md` into the tool's rules file.
- **Any other tool** → paste `memory/MEMORY-PROTOCOL.md` into its system prompt.

Each router says the same thing: read `memory/recent/latest.md` first, then write progress back. Switch the tool, the session, or the person — the project memory doesn't drop. A fresh workspace also gets a `GETTING_STARTED.md`.

## Architecture

- Local file workspace as source of truth
- Append-only audit log (`memory/_events/*.ndjson`)
- Scoped memory per agent runtime (Claude Code / Codex / OpenClaw / your own)
- Retrieval via local vector + lexical hybrid with cluster-aware rerank

For full spec, see [iHow Memory standard](https://github.com/iHow1/ihow-memory-standard).

## Performance — retrieval layer

| Benchmark | Result |
|---|---|
| LongMemEval_S (470 effective samples) | `recall_all@10 = 1.0` |
| 5 spec scenarios v0.1 (self-conformance) | 5/5 PASS |

**Important**: this is retrieval recall, not end-to-end answer accuracy. For per-layer comparison context and methodology, see the [spec repo](https://github.com/iHow1/ihow-memory-standard) and its [evidence manifest](https://github.com/iHow1/ihow-memory-standard/blob/main/conformance/evidence/longmemeval-s-2026-05-11.md).

## Boundary between benchmark and production

Some techniques used in our benchmark harness port directly to production retrieval (original-query anchor preservation, cluster-aware rerank, bounded sibling expansion). Others are LongMemEval-shaped heuristics that remain benchmark-only.

The public evidence manifest summarizes this boundary. Benchmark-only heuristics are not packaged as general retrieval improvements.

## License

Apache-2.0. Spec (CC-BY) lives in the [standard repo](https://github.com/iHow1/ihow-memory-standard).

## Contribute

- Bug reports: [issues](../../issues)
- Discussion: [GitHub Discussions](../../discussions)
- Spec proposals: [standard repo](https://github.com/iHow1/ihow-memory-standard/discussions)
