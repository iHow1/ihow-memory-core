# iHow Memory

> Local shared-memory runtime for heterogeneous coding agents — one git-auditable Markdown memory they share and hand off through.

[![npm version](https://img.shields.io/npm/v/ihow-memory.svg)](https://www.npmjs.com/package/ihow-memory)
[![CI](https://github.com/iHow1/ihow-memory-core/actions/workflows/ci.yml/badge.svg)](https://github.com/iHow1/ihow-memory-core/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](./LICENSE)

[简体中文](./README.zh-CN.md)

**Requires Node.js >= 22.12 · macOS / Linux (alpha; Windows via WSL, native Windows experimental).** No account, no API key, no third-party runtime dependencies.

iHow Memory is a local, shared-memory runtime for heterogeneous coding agents — one human-readable, git-auditable memory that Claude Code, Codex, Cursor and other MCP clients share and hand off through. Memory is plain Markdown on disk that you read, diff and roll back with git. A pre-write check rejects candidates that look like they contain secrets, every promote is an audited event, and agents leave a handoff candidate — current state, evidence, blockers, next step — that the next agent reads. Agents talk to it over a stdio MCP server; you use the same flow from the CLI.

## Why it is different

1. **Cross-vendor by design.** One memory that Claude Code, Codex, Cursor, Tencent WorkBuddy, Claude Desktop, OpenCode and Hermes share — across vendors, on your machine, one command each. The big platforms have every reason to keep memory inside their own ecosystem; iHow is the neutral local layer between them.
2. **Safe writes + handoff.** Multiple agents share one memory, with writes serialized by a workspace lock so they never clobber each other. A pre-write check rejects candidates that look like they hold secrets (tokens, keys, credentials), and every promote is an audited event. A handoff is a candidate the next agent reads — current state, evidence, blockers, next step — not just a search hit.
3. **Human-readable and yours.** Memory is plain Markdown you read, diff and roll back with git — no vendor lock-in, no black-box vector store, no account, no telemetry by default. Governance (candidate → review → promote) is available when your team needs it, not a forced step.

## Quickstart

### 1. Connect a runtime

```bash
npx ihow-memory connect --runtime claude-code   # or: codex | cursor | workbuddy | claude-desktop | opencode | hermes
```

`connect` provisions a managed workspace under `~/.ihow-memory` (space name derived from the current directory unless you pass `--space`) and registers the `ihow-memory` MCP server with the selected runtime:

- Claude Code and Codex are configured through their official CLIs (`claude mcp add-json`, `codex mcp add`).
- Cursor is configured by merging `~/.cursor/mcp.json`, with a timestamped backup of the existing file first; an unparseable config is never overwritten.
- To preview without changing anything, append `--dry-run`:

```bash
npx ihow-memory connect --runtime claude-code --dry-run
```

If you prefer to edit runtime config by hand, `npx ihow-memory init --runtime <runtime>` prints the exact MCP snippet instead of applying it.

### 2. Verify

```bash
npx ihow-memory doctor --runtime claude-code
```

`doctor` checks the Node version, `node:sqlite` availability, memory-root writability, runtime setup, retrieval-engine readiness and the index manifest, and confirms cloud/sync are disabled.

### 3. The governed loop in 60 seconds

This is the same flow agents use over MCP, run from your shell. The block is copy-pasteable as a whole:

```bash
npx ihow-memory init --space demo
CAND=$(npx ihow-memory write-candidate "Decision: ship weekly release notes." --space demo | sed -n 's/.*"path": "\([^"]*\)".*/\1/p')
PROMOTED=$(npx ihow-memory promote "$CAND" --scope team --title "Release notes cadence" --space demo | sed -n 's/.*"path": "\([^"]*\)".*/\1/p')
npx ihow-memory search "release notes" --space demo
npx ihow-memory read "$PROMOTED" --space demo
```

What you should see:

- `write-candidate` returns a candidate path under `memory/candidate/inbox/` — proposed, not yet durable;
- `promote` returns the promoted path under `memory/scopes/team/` plus an `eventId` — the audit event;
- `search` and `read` return JSON whose `citation` field points at the exact Markdown file behind the answer.

Clean up the demo space when done:

```bash
npx ihow-memory reset --space demo
```

One-command version of the same proof, in a throwaway space:

```bash
npx ihow-memory proof
```

## Retrieval engine

The default retrieval engine is zero-dependency local full-text search — Node built-ins plus `node:sqlite` FTS5 only: no third-party runtime deps, no embedding downloads, no model or API key, with citation-bearing results. An optional local vector provider (separate process) adds semantic retrieval; if unconfigured or unhealthy, retrieval falls back visibly to FTS. Governance, write guards and audit behavior never change with the retrieval backend. The memory itself stays human-readable, editable, rollback-able Markdown.

### Retrieval-quality evidence

As honest evidence of retrieval quality — not the product's differentiator — we publish one LongMemEval_S retrieval-stage result: recall_all@10 = 1.0 across all 470 effective samples (500 raw; ndcg_any@10 0.946). Three boundaries: (1) this is retrieval-layer recall, not end-to-end LLM-judged answer accuracy — not directly comparable to the 90%+ figures reported by other vendors, which measure a different layer; (2) the score was produced on our experimental vector + lexical hybrid lane, while this published package defaults to zero-dependency FTS5 lexical search (with an optional local vector provider); (3) a one-command reproduction harness is WIP — until it lands, the public evidence manifest (metric definitions, run artifacts, full @5 disclosure incl. structural ceilings) is the auditable reference.

Evidence manifest: [LongMemEval_S retrieval-stage run, 2026-05-11](https://github.com/iHow1/ihow-memory-standard/blob/main/conformance/evidence/longmemeval-s-2026-05-11.md).

## MCP tools

The stdio MCP server (registered by `connect`, or manually via the `init` snippet) exposes seven tools:

| Tool | What it does |
| --- | --- |
| `memory.search` | Search local memory with FTS. Returns citation path and snippet. |
| `memory.read` | Read a memory Markdown file by path. Returns exact content plus citation. |
| `memory.write_candidate` | Write a candidate into the sandbox inbox. Does not write durable memory. |
| `memory.promote` | Promote a candidate into governed staging, with an audit event. |
| `memory.durable_promote` | Governed durable promote. Requires explicit `dryRun: true` or `realWrite: true`. |
| `memory.journal` | Append a low-weight, append-only journal entry (auto-capture lane). Searchable but ranked below curated memory. |
| `memory.status` | Report workspace, retrieval provider, index and sync status. |

## CLI reference

```text
ihow-memory init             create a managed workspace, print the MCP config snippet
ihow-memory connect          auto-configure a runtime (claude-code | codex | cursor | workbuddy | claude-desktop | opencode | hermes) [--dry-run]
ihow-memory install-skill    copy the Claude Code proactive-memory skill into ~/.claude/skills/
ihow-memory install-hook     add the auto-capture hooks — Stop (cooperative nudge) + SessionStart (deterministic floor) (Claude Code; --global-hook for user-wide)
ihow-memory doctor           environment + setup checks [--share-diagnostics for a redacted report]
ihow-memory status           workspace, engine, index and sync state [--json]
ihow-memory search <query>   citation-bearing local search [--limit n]
ihow-memory read <path>      read one memory file with citation
ihow-memory write-candidate  propose a memory candidate (sandbox inbox)
ihow-memory promote          promote a candidate (explicit, audited)
ihow-memory durable-promote  durable write — requires --dry-run or --real-write
ihow-memory journal <text>   append a low-weight auto-capture entry (searchable, ranked below curated)
ihow-memory audit            list the append-only event log [--since YYYY-MM-DD]
ihow-memory rollback         undo one auto-captured journal entry (--event <id>)
ihow-memory reindex          rebuild the SQLite index from Markdown
ihow-memory proof            one-command governed-loop proof in a throwaway space
ihow-memory feedback         print a prefilled GitHub issue + redacted diagnostics
ihow-memory reset            remove a managed demo space (requires --space)
ihow-memory console          read-only local web UI [--port 8788]
ihow-memory telemetry        on | off | status — anonymous counters, OFF by default
```

Defaults: root `~/.ihow-memory`; space derived from the current directory unless `--space` is given. Run `npx ihow-memory --help` for full flags.

## Memory layout and write boundaries

A managed space is plain files:

```text
~/.ihow-memory/<space>/
  memory/
    candidate/inbox/     # agent proposals land here, never durable by themselves
    scopes/<scope>/      # promoted, durable Markdown
    _events/             # append-only audit log (ndjson)
  history/               # archived candidates after durable promote
  index.sqlite           # FTS index (rebuildable via reindex)
  index-manifest.json
```

You can also point iHow Memory at an existing Markdown directory without moving it:

```bash
npx ihow-memory doctor --memory-root <memory-root> --state-root <state-root>
```

In that mode the write boundary is strict: existing durable Markdown is read-only by default; candidates go under `memory/_mcp/candidates/`, staged promotes under `memory/_mcp/promoted/`, audit events under `memory/_mcp/_events/`; SQLite state stays under `<state-root>`, outside the memory root. Durable writes into the existing tree happen only through `durable-promote`, which refuses to run without an explicit `--dry-run` (prints the full plan) or `--real-write`.

## Diagnostics, feedback, reset, uninstall

**Doctor report you can share.** `npx ihow-memory doctor --runtime <runtime> --share-diagnostics` prints a redacted report: local paths replaced with placeholders, secret-like values removed, memory content omitted. It is printed locally and never uploaded.

**Feedback.** `npx ihow-memory feedback --runtime <runtime>` prints a prefilled GitHub issue URL, a Markdown template and a redacted doctor summary. Nothing is submitted automatically.

**Reset.** `npx ihow-memory reset --space <name>` removes a managed space. It requires an explicit `--space`, only removes managed spaces, and refuses `--memory-root` — it cannot delete an existing shared memory root.

**Uninstall.**

1. Remove the `ihow-memory` entry from the runtime: `claude mcp remove ihow-memory --scope user`, `codex mcp remove ihow-memory`, or edit `~/.cursor/mcp.json` (a `*.ihow-bak-*` backup sits next to it if `connect` wrote it).
2. Delete demo spaces with `npx ihow-memory reset --space <name>`.
3. If installed globally: `npm uninstall -g ihow-memory`.
4. Delete any custom state root only after reviewing its contents.

## Proactive memory (Claude Code)

The MCP tools are available to any client, but agents use memory only if they decide to. iHow Memory
adds two layers to raise that on Claude Code:

- **Skill — recall + record discipline.** `ihow-memory install-skill` (or `connect --runtime
  claude-code --install-skill`) installs a thin policy layer ([`skills/ihow-memory/SKILL.md`](./skills/ihow-memory/SKILL.md))
  that nudges Claude Code to search at the start of a task and record a candidate after a decision or
  handoff. It changes *when* memory is used, not the mechanism. Other runtimes get the same nudge from
  the MCP tool descriptions.
- **Session-end auto-capture (cooperative) — experimental.** `connect --runtime claude-code --install-hook` adds a
  Stop hook that, at session end, asks the in-session agent to record a handoff into the low-weight
  `journal` lane via `memory.journal`. It is best-effort (re-prompts as the session grows, stops once
  an entry is recorded), **project-scoped by default** (`--global-hook` for user-wide), and reversible
  (`ihow-memory audit` / `rollback`).
- **Next-session floor (deterministic) — experimental, `next` only.** The same `install-hook` also wires a
  SessionStart hook: when a new session starts, it floors the **previous** session deterministically *iff*
  that session ended without a cooperative journal. It parses the prior transcript, composes a
  last-substantive-segment summary within a **locked scope** (assistant text + file paths + command binary
  names + first prompt — never tool output, never raw shell), redacts it, and writes a low-weight,
  auditable, rollback-able journal entry. It is the safety net under the cooperative nudge: **single-cwd**,
  silent (never injects context — recall stays off), and never throws. Offline evaluation on 22 real
  historical transcripts passed the backstop quality gate; live *natural* floor hits remain under dogfood
  because cooperative capture currently covers all observed sessions.

> **Experimental & Claude Code-first.** Auto-capture is two layers: a cooperative Stop-hook nudge (whether
> an entry is written depends on the agent following the prompt) and a deterministic SessionStart floor
> backstop (`next` only) that captures the prior session when the nudge was not honored. Both write
> **low-weight, unreviewed** notes — use `promote` / `durable-promote` for trusted long-term memory. The
> floor is offline-validated as a backstop; it is not yet promoted to a primary/default-weight path, and
> `recall` (reading memory back into a new session) stays **off** by default.

## Examples

Runnable, self-contained walkthroughs live in [`examples/`](./examples/) (numbered 01–03). All examples use synthetic data only.

## Privacy

- The open-source core runs locally: no account, no required network calls, cloud and sync are disabled and report as such in `status` and `doctor`.
- Telemetry is **off by default** and opt-in (`ihow-memory telemetry on`). When enabled it records only a fixed allow-list — event name, runtime, package version, error type, timestamp — never memory content, file names, queries, paths or prompts. In the current alpha, events are appended to a local file (`~/.ihow-memory/telemetry-events.jsonl`) and are not uploaded anywhere.
- Diagnostics are redacted by design; memory content is never included. `feedback` only prints a template — you decide whether to open the issue.

## Hosted runtime

A hosted runtime is not included in this npm package or this repository.

## Status

Alpha prerelease (`0.1.0-alpha` line — the npm badge above shows the latest published version; see [CHANGELOG.md](./CHANGELOG.md)). Validated on macOS and Linux; Windows is not yet a supported lane. The npm tarball ships the compiled CLI, the stdio MCP server and the read-only local console; the TypeScript sources live in this repository. Expect breaking changes between alpha releases.

**Which version has what (dist-tags).** Prereleases publish under the `next` dist-tag; `npm install ihow-memory` resolves `latest`.

| dist-tag | auto-capture |
| --- | --- |
| `latest` | cooperative Stop-hook nudge only (depends on the agent honoring it) |
| `next` | adds the **deterministic SessionStart floor** backstop (single-cwd, low-weight, offline-validated); `recall` still off |

To try the floor backstop: `npm install ihow-memory@next`. A plain `npm install ihow-memory` stays on the conservative `latest`.

## Limitations

- **Floor capture is single-cwd.** The SessionStart floor backs up only its designated workspace/cwd. If you `connect --auto` across multiple projects sharing one workspace, the floor covers one cwd; broad multi-cwd rollout is pending further dogfood.
- **Default retrieval is lexical, not semantic.** The shipped default is zero-dependency FTS5 lexical search. The vector + lexical hybrid (behind the published recall figures) is an *optional* local provider, not in the out-of-the-box binary.
- **Auto-capture notes are low-weight and unreviewed**, and the deterministic floor is a backstop, not yet a primary/default-weight path. `recall` (reading memory back into a session) is off by default. Use `promote` / `durable-promote` for trusted long-term memory.
- **Windows native is experimental** (use WSL); only macOS and Linux are validated lanes.

## Links

- Website: [ihowmemory.com](https://ihowmemory.com)
- Format & conformance (mechanism): [iHow1/ihow-memory-standard](https://github.com/iHow1/ihow-memory-standard)
- Benchmark evidence manifest: [conformance/evidence/longmemeval-s-2026-05-11.md](https://github.com/iHow1/ihow-memory-standard/blob/main/conformance/evidence/longmemeval-s-2026-05-11.md)
- npm package: [npmjs.com/package/ihow-memory](https://www.npmjs.com/package/ihow-memory)

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) (DCO sign-off required — [DCO.md](./DCO.md)). Security reports: [SECURITY.md](./SECURITY.md) — please do not open public issues for vulnerabilities.

## License

Apache License 2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE). The iHow / iHow Memory names and logos are trademarks; see [TRADEMARK.md](./TRADEMARK.md).
