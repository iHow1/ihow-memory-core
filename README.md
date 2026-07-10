# iHow Memory

> Local shared-memory runtime for heterogeneous coding agents — one git-auditable Markdown memory they share and hand off through.

[![npm version](https://img.shields.io/npm/v/ihow-memory.svg)](https://www.npmjs.com/package/ihow-memory)
[![CI](https://github.com/iHow1/ihow-memory-core/actions/workflows/ci.yml/badge.svg)](https://github.com/iHow1/ihow-memory-core/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](./LICENSE)

[简体中文](./README.zh-CN.md)

**Requires Node.js >= 22.12 · macOS / Linux (alpha; Windows via WSL, native Windows experimental).** No account, no API key, no third-party runtime dependencies. (Node >= 22.12 is a hard requirement — the engine uses `node:sqlite`.)

**Who this is for:** best for git-using coding workflows, where the verify-first handoff gets the strongest anchors; usable beyond git too, with file-fingerprint anchors instead (see below).

iHow Memory is a local, shared-memory runtime for heterogeneous coding agents — one human-readable, git-auditable memory that Claude Code, Codex, Cursor and other MCP clients share and hand off through. Memory is plain Markdown on disk that you read, diff and roll back with git. A pre-write check rejects candidates that look like they contain secrets, every promote is an audited event, and agents leave a handoff candidate — current state, evidence, blockers, next step — that the next agent reads. Agents talk to it over a stdio MCP server; you use the same flow from the CLI.

## Why it is different

1. **Verify-first handoff — resume without re-briefing.** After `/clear`, or when a *different* tool picks up the work, run `memory.continue` (or `ihow-memory continue`). You get the prior session's handoff together with **live git anchors the receiver re-checks (GREEN / RED) before trusting the narrative** — so a fresh agent continues where you left off without you re-explaining, and without acting on a stale "done / shipped" claim. Other memory tools retrieve *facts*; this is a cross-tool resume with a built-in trust check. This is the point of iHow Memory. In a git repo you get the strongest verify-first anchors (branch / HEAD / dirty). In a non-git project, the handoff still works — you get the prior session's narrative plus file-fingerprint anchors (the receiver re-hashes the touched files to detect drift) — just without git's commit-level GREEN/RED.
2. **Cross-vendor by design.** One memory that Claude Code, Codex, Cursor, Tencent WorkBuddy, Claude Desktop, OpenCode, Hermes and OpenClaw can share — across vendors, on your machine, one command each. The big platforms have every reason to keep memory inside their own ecosystem; iHow is the neutral local layer between them. In this alpha only Claude Code is dogfooded daily; the others are single-machine real-app smoke, and Cursor and Claude Desktop are receive-only (they call the tools but cannot resume) — see [Runtime support](#runtime-support).
3. **Safe writes + governance.** Multiple agents share one memory, with writes serialized by a workspace lock so they never clobber each other. A pre-write check rejects candidates that look like they hold secrets (tokens, keys, credentials), and every promote is an audited event.
4. **Human-readable and yours.** Memory is plain Markdown you read, diff and roll back with git — no vendor lock-in, no black-box vector store, no account, no telemetry by default. Governance (candidate → review → promote) is available when your team needs it, not a forced step.

## Quickstart — first success in about 3 minutes

### 1. Set up locally

```bash
npx ihow-memory@next setup
```

`setup` detects installed runtimes, connects the local MCP server, installs proactive memory behavior only where the runtime exposes a stable surface, and runs `doctor`. It is idempotent, backs up edited config, and ends with one result card: what connected, what is verified or pending, whether a restart is required, where local data lives, and the one next command.

Want a zero-write preview first?

```bash
npx ihow-memory@next setup --dry-run
```

### 2. See the verify-first difference immediately

```bash
npx ihow-memory@next proof
```

The proof runs in a throwaway git repo and temporary memory workspace. It shows:

```text
prior agent narrative: UNVERIFIED
recorded anchors == live anchors  -> GREEN
checkout changes after recording  -> RED
```

It also proves the governed local-memory path — candidate → promote → search/read with citation + audit — without touching your project or runtime configuration. The default retrieval lane is honest zero-dependency lexical FTS; optional semantic recall is separate and is not presented as state of the art.

### 3. Resume real work

After `/clear`, a new session, or a switch to another supported runtime:

```bash
npx ihow-memory@next continue            # optional repo keyword: continue <name>
```

`continue` carries the previous narrative as **UNVERIFIED** and gives the receiver machine anchors to re-check before acting. GREEN is deliberately narrow; drift or conflict forces RED. If this is your first run and there is no captured session yet, the CLI says that plainly and points back to `proof` instead of printing an empty handoff envelope. In Claude Code you can simply say “continue” / “继续”.

### 4. Correct a wrong memory

```bash
npx ihow-memory@next forget "text or memory/path.md"
# reversible:
npx ihow-memory@next remember "text or memory/path.md"
```

`forget` tombstones one unambiguous match so it stops surfacing in search and recall; the file is untouched and the action is reversible and audited.

### What `setup` connects

Claude Code is the daily-dogfooded path. Codex, OpenClaw, Hermes, OpenCode and WorkBuddy have single-machine real-app smoke. Cursor, Claude Desktop and VS Code are receiver-only because they do not expose a resumable local session store. See [Runtime support](#runtime-support) before making production assumptions.

To connect only one runtime, or to inspect the exact config instead of applying it:

```bash
npx ihow-memory@next connect --runtime claude-code --dry-run
npx ihow-memory@next connect --runtime claude-code
npx ihow-memory@next init --runtime claude-code       # print the MCP snippet only
npx ihow-memory@next doctor --runtime claude-code
```

### The governed loop, explicitly

Agents use the same path over MCP. This shell version makes the review gate visible:

```bash
npx ihow-memory@next init --space demo
CAND=$(npx ihow-memory@next write-candidate "Decision: ship weekly release notes." --no-auto-promote --space demo | sed -n 's/.*"path": "\([^"]*\)".*/\1/p')
PROMOTED=$(npx ihow-memory@next promote "$CAND" --scope team --title "Release notes cadence" --space demo | sed -n 's/.*"path": "\([^"]*\)".*/\1/p')
npx ihow-memory@next search "release notes" --space demo
npx ihow-memory@next read "$PROMOTED" --space demo
npx ihow-memory@next reset --space demo
```

Without `--no-auto-promote`, a clean write can auto-promote into a durable yellow tier; secrets and falsified anchors are still blocked. Search/read results cite the exact Markdown source, and promote creates an audit event.

### Updating

`connect` freezes a runtime copy of the server into the workspace, so `npm update` does **not** refresh the running MCP server by itself. After updating the package, run `npx ihow-memory@next upgrade` (then restart the runtime) to refresh the connected server. `doctor` warns when the connected server is older than the installed package (a "runtime-bundle" check).

## Runtime support

`connect` registers the MCP server for ten runtimes; `setup` wires every detected one in a single command and, where the runtime has an instructions file, injects a "call `memory.continue` on resume" nudge. Two sides matter: **connect** (the runtime can call the memory tools) and a **resume reader** (that runtime's own past sessions can be picked up by `memory.continue`). Verification below is single-machine real-app smoke unless noted — this is alpha.

| Runtime | connect | resume reader | Notes |
| --- | --- | --- | --- |
| Claude Code | ✓ (`claude mcp add-json`) | ✓ | real-app + ongoing dogfood; skill + auto-capture hooks |
| Codex | ✓ (`codex mcp add`) | ✓ | native SessionStart/UserPromptSubmit hooks + proactive `~/.codex/AGENTS.md` memory loop; single-machine real-app smoke |
| OpenClaw | ✓ (`~/.openclaw/openclaw.json`) | ✓ | single-machine real-app smoke (memory.continue + git preflight) |
| Hermes | ✓ (`hermes mcp add`) | ✓ (JSON + `state.db`) | single-machine real-app smoke |
| OpenCode | ✓ (`~/.config/opencode`) | ✓ (`opencode.db`) | single-machine real-app smoke |
| WorkBuddy | ✓ (`~/.workbuddy/mcp.json`) | ✓ | single-machine real-app smoke |
| Cursor | ✓ (merges `~/.cursor/mcp.json`) | ✗ | receiver-only — Cursor keeps chats in a binary IndexedDB, not readable for resume |
| Claude Desktop | ✓ | ✗ | receiver-only (chat app; no resumable local sessions) |
| VS Code (Copilot) | ✓ (user `mcp.json`, `servers` key) | ✗ | receiver-only — reaches `memory.search`/`read`/`continue`; no readable local session store to resume from |
| Gemini CLI | ✓ (`~/.gemini/settings.json`) | ✓ (`~/.gemini/tmp/*/logs.json`) | passive reader of Gemini's on-disk **user-prompt log** (Gemini records no assistant turns) → session topic + git anchors; manual `GEMINI.md` nudge. Verified against real local data |
| Cline (VS Code) | — (add via Cline's own MCP settings) | ✓ (`globalStorage` / `~/.cline/data`) | passive reader of `tasks/<id>/api_conversation_history.json`; cwd from `environment_details`. Fixture-tested, not yet real-app smoke |

The MCP tools and governed loop are runtime-agnostic. Claude Code uses a skill plus Stop / SessionStart / UserPromptSubmit hooks. Codex uses native SessionStart / UserPromptSubmit hooks plus an auto-injected `~/.codex/AGENTS.md` proactive memory loop (continue/search/read/write/forget discipline); the Codex SessionStart hook also triggers the Codex capture-floor sweep at thread boundaries, with the normal idle gate still protecting active sessions. Resume guidance is also auto-injected for WorkBuddy, OpenClaw, Hermes and OpenCode.

### Runtimes wired without an auto-injected resume nudge (Cursor · Claude Desktop · VS Code Copilot · Gemini CLI)

For these, `connect` wires the shared MCP server but iHow does **not** auto-write a global rules file (their instruction surface is app- or project-managed), so add the resume nudge yourself once. Cursor, Claude Desktop and VS Code Copilot are also **receiver-only** — no readable local session store, so iHow cannot resume *their* past sessions; they instead pull a [verify-first handoff packet](./docs/handoff-schema.md) (query + GREEN/YELLOW/RED verdict + verbatim-unverified narrative) recorded by any *capture* runtime (Claude Code, Codex, …), e.g. pick up in VS Code work that Claude Code left off. Gemini CLI is now a **passive reader** (its on-disk user-prompt log — see the table above) but still needs the manual `GEMINI.md` nudge:

- **Cursor** — `npx ihow-memory@next connect --runtime cursor` (merges `~/.cursor/mcp.json`, backed up; never clobbers an unparseable file). Add a User Rule like: *"On resume / when I say 继续, call the `memory.continue` MCP tool first; treat its narrative as UNVERIFIED and run its git preflight before acting."*
- **Claude Desktop** — `npx ihow-memory@next connect --runtime claude-desktop` (writes `claude_desktop_config.json`; macOS `~/Library/Application Support/Claude/`, Linux `~/.config/Claude/`, Windows `%APPDATA%\Claude\`). Restart the app to load the tools.
- **VS Code (Copilot)** — `npx ihow-memory@next connect --runtime vscode` writes the **user** `mcp.json` (macOS `~/Library/Application Support/Code/User/mcp.json`, Linux `~/.config/Code/User/mcp.json`, Windows `%APPDATA%\Code\User\mcp.json`) under the `servers` key with a `type: "stdio"` entry, backed up; an unparseable file is never overwritten. Reload the window, then enable the server in Copilot agent mode. Add a line to `.github/copilot-instructions.md`: *"On resume, call the `memory.continue` MCP tool first and verify its anchors before acting."*
- **Gemini CLI** — `npx ihow-memory@next connect --runtime gemini` adds an `mcpServers` entry to `~/.gemini/settings.json` (backed up; unparseable file left untouched). Restart `gemini`, confirm with `/mcp list`. Add the same nudge to your `GEMINI.md`.

For any of these, `npx ihow-memory@next init --runtime <name>` prints the exact snippet to paste by hand instead of writing it, and `npx ihow-memory@next doctor --runtime <name>` round-trips the configured server to confirm it is reachable.

## Retrieval engine

The default retrieval engine is zero-dependency local full-text search — Node built-ins plus `node:sqlite` FTS5 only: no third-party runtime deps, no embedding downloads, no model or API key, with citation-bearing results. An optional local vector provider (separate process) adds semantic retrieval; if unconfigured or unhealthy, retrieval falls back visibly to FTS. Governance, write guards and audit behavior never change with the retrieval backend. The memory itself stays human-readable, editable, rollback-able Markdown.

### Retrieval-quality evidence

Retrieval recall is **not** iHow's differentiator — verify-first governance is. We publish the honest shipped numbers anyway, because "claimed vs observed" must never diverge for a tool whose whole pitch is *don't trust green*.

The headline numbers are the ones you actually get out of the box — the **default zero-dependency FTS5 lexical engine** (BM25). On the in-repo reproducible fixture (`node scripts/retrieval-bench.mjs`):

| Metric | Default FTS5 (shipped, zero-dependency) |
| --- | --- |
| R@5 | **0.85** |
| R@10 | **0.85** |
| MRR | **0.85** |
| tokens/query | **~5.7** |

This is a deterministic, stranger-reproducible harness: `node scripts/retrieval-bench.mjs` seeds a labeled fixture through the same `write → promote → search` path the product uses and scores R@5/R@10/MRR + tokens-per-query, with no cloud, no LLM and no third-party deps.

**The honest floor: paraphrase recall is the weak spot.** Keyword and partial-keyword queries recall well (15/15 in the fixture), but **paraphrase / synonym queries that share no surface tokens score 2/5 = 0.40** — a reworded query exposes a lexical engine's lack of semantics. That gap is exactly what an optional semantic provider is meant to lift.

The fixture above is a **self-authored 20-doc / 20-query** set. So that the numbers don't rest on our own data, there is also a stranger-reproducible run on a **public, MIT-licensed standard dataset** — LongMemEval (oracle variant, [arXiv:2410.10813](https://arxiv.org/abs/2410.10813)) — on the **same default FTS5 binary**:

| Metric (default FTS5 · global-corpus · recall_any@k) | LongMemEval-oracle |
| --- | --- |
| Recall@5 | **0.788** |
| Recall@10 | **0.857** |
| MRR | **0.651** |

`node scripts/standard-bench.mjs --download` fetches + **sha256-verifies** the dataset and runs all 419 usable instances (831 session-docs) on the default engine; the vendored N=8 slice runs offline (`node scripts/standard-bench.mjs`). This is **global-corpus** retrieval — find the gold evidence session among *every* instance's sessions, which is **harder** than the paper's per-instance oracle setup. Recall@k is recall_any@k (the official reading); MRR is our own metric (LongMemEval reports NDCG), so it is **not** directly comparable to the paper's tables. The weak spots stay visible: assistant-answer and preference questions — where the evidence lives in the assistant's turn or is implicit, so the indexed user turns share little surface with the query — recall worst, the same lexical gap an optional semantic provider lifts.

#### Optional semantic sidecar (not the default binary)

Higher recall figures exist, but they come from a different lane and must not be read as the shipped default:

| Figure | Provenance |
| --- | --- |
| recall_all@10 = 1.0, ndcg_any@10 ≈ 0.946 | **OPT-IN semantic sidecar** (not the default binary), **EXPERIMENTAL hybrid lane**, from an **EXTERNAL evidence manifest** (repo `iHow1/ihow-memory-standard`, dated 2026-05-11), **RETRIEVAL-STAGE recall only** (NOT end-to-end LLM-judged). |

Not directly comparable to vendor end-to-end LLM-judged figures.

Semantic recall requires a **user-provided embedding sidecar** (e.g. Ollama `nomic-embed-text`) running as a separate local process. The default install is **lexical-only and zero-dependency by design** — that is the moat, not an omission. If the sidecar is unconfigured or unhealthy, retrieval falls back visibly to FTS.

Turn it on per space with one command — it **probes your local Ollama and only enables if the model is actually pulled**, then persists the opt-in so `connect`/`setup` launch the server with the (bundled) sidecar:

```bash
ollama pull nomic-embed-text            # once
npx ihow-memory@next enable-semantic    # probes Ollama; writes <space>/.runtime/semantic.json
# re-run `setup`/`connect` + restart your runtime to apply · reverse anytime: disable-semantic
```

`enable-semantic` **refuses** (non-zero, with guidance) if Ollama is unreachable or the model isn't pulled — it never enables a lane that would only fall back. `doctor` then reports semantic health as a **warning, never a failure** (the lane is additive). On the in-repo fixture this lifts paraphrase recall from **2/5 → 5/5** (fused R@5 0.85 → 1.0); the default binary stays lexical-only with `capabilities.semantic=false` until you opt in.

Evidence manifest: [LongMemEval_S retrieval-stage run, 2026-05-11](https://github.com/iHow1/ihow-memory-standard/blob/main/conformance/evidence/longmemeval-s-2026-05-11.md).

## MCP tools

The stdio MCP server (registered by `connect`, or manually via the `init` snippet) exposes these tools:

| Tool | What it does |
| --- | --- |
| `memory.search` | Search local memory with FTS. Returns citation path and snippet. |
| `memory.read` | Read a memory Markdown file by path. Returns exact content plus citation. |
| `memory.write_candidate` | Record a memory. Clean content auto-promotes into durable yellow tiers: verified, unverified, or flagged. Secrets and falsified anchors are rejected. |
| `memory.promote` | Explicit manual promote of a candidate into governed staging, with an audit event. |
| `memory.durable_promote` | Governed durable promote. Requires explicit `dryRun: true` or `realWrite: true`. |
| `memory.journal` | Append a low-weight, append-only journal entry (auto-capture lane). Searchable but ranked below curated memory. |
| `memory.forget` | One-gesture correction: tombstone the matching memory so it stops surfacing in search and recall everywhere. Reversible, audited, file untouched; human-reviewed entries need explicit confirmation. |
| `memory.remember` | Reverse a `memory.forget` — the entry surfaces again. |
| `memory.status` | Report workspace, retrieval provider, index and sync status. |
| `memory.continue` | Return a verify-first handoff packet with live anchors and an UNVERIFIED prior narrative. |
| `memory.context_probe` | Automation trigger probe for no-hook runtimes. It can return verify-first handoff text or `action: "journal"`; it does not auto-write for WorkBuddy/OpenCode/Gemini/unknown. |

## CLI reference

```text
ihow-memory setup            zero-config: detect runtimes -> wire MCP + skill + auto-capture/recall hooks -> verify (recommended; idempotent, local-only) [--dry-run] [--json]
ihow-memory init             create a managed workspace, print the MCP config snippet
ihow-memory connect          auto-configure a runtime (claude-code | codex | cursor | workbuddy | claude-desktop | opencode | hermes | openclaw | vscode | gemini) [--easy] [--dry-run] [--json]
ihow-memory continue         resume after a context boundary — verify-first handoff with live git anchors (GREEN/YELLOW/RED) [project-keyword] [--list] [--json]
ihow-memory install-skill    copy the Claude Code proactive-memory skill into ~/.claude/skills/
ihow-memory install-hook     add runtime hooks — Claude Code: Stop + SessionStart + UserPromptSubmit (project-local by default; --global-hook for user-wide). Codex: SessionStart + UserPromptSubmit in ~/.codex/hooks.json. Recall is on by default; --no-recall skips it.
ihow-memory doctor           environment + setup checks [--share-diagnostics for a redacted report]
ihow-memory verify           reproducible self-proof receipt: local store + each runtime's reachability + this checkout's resume verdict, every line re-runnable [--runtime name] [--json]
ihow-memory status           workspace, engine, index and sync state [--json]
ihow-memory search <query>   citation-bearing local search [--limit n]
ihow-memory read <path>      read one memory file with citation
ihow-memory write-candidate  propose a memory candidate (sandbox inbox)
ihow-memory promote          promote a candidate (explicit, audited)
ihow-memory durable-promote  durable write — requires --dry-run or --real-write
ihow-memory journal <text>   append a low-weight auto-capture entry (searchable, ranked below curated)
ihow-memory organize         Safe Memory Gardener: create a review-first JSON draft with source evidence, safety status, duplicate/stale review flags, and an organize audit event [--scope project] [--since 7d] [--draft] [--json]
ihow-memory export-vault     export a gardener draft to an Obsidian-compatible Markdown view artifact with evidence links and an export audit event; the export is not source of truth [--from-draft <draft_id>] [--format markdown]
ihow-memory import           import existing memory you wrote elsewhere (Claude Code MEMORY.md, ai-memory markdown, any .md folder) into the searchable journal lane [--from path] [--apply] [--update]
ihow-memory audit            list the append-only event log [--since YYYY-MM-DD]
ihow-memory rollback         undo one auto-captured journal entry (--event <id>)
ihow-memory forget <text|path>  one-gesture correction: stop a memory surfacing in search AND recall everywhere (reversible tombstone; file untouched; reviewed entries need --yes; --list shows what's forgotten)
ihow-memory remember <text|path>  reverse a forget — the entry surfaces again
ihow-memory reindex          rebuild the SQLite index from Markdown
ihow-memory migrate-local-day  one-time: re-bucket UTC-named journal/event files to local-day (dry-run unless --apply)
ihow-memory upgrade          refresh the workspace's frozen server copy after updating the package (then restart the runtime)
ihow-memory proof            one-command governed-loop proof in a throwaway space
ihow-memory benchmark        deterministic local proof of the verify-first guarantees (the three-color verdict discriminates; the floor blocks junk) — re-run for the same result
ihow-memory feedback         print a prefilled GitHub issue + redacted diagnostics
ihow-memory reset            remove a managed demo space (requires --space)
ihow-memory console          read-only local web UI [--port 8788]
ihow-memory telemetry        on | off | status — anonymous counters, OFF by default
```

Defaults: root `~/.ihow-memory`; space derived from the current directory unless `--space` is given. Run `npx ihow-memory@next --help` for full flags.

The `console` is **read-only, loopback-only, and single-user / trusted-machine by design** — there is no auth token yet, so do not run it on a shared or multi-user host.

## Safe Memory Gardener (alpha.24)

Safe Memory Gardener adds a review-first organize/export path for local workspaces:

```bash
npx ihow-memory@next organize --scope project --draft --json
npx ihow-memory@next export-vault --from-draft <draft_id> --format markdown
```

`organize` scans in-scope Markdown memory, writes a deterministic JSON draft under `gardener/drafts/`, links every evidence-backed item to source files and line numbers, flags duplicate/stale-looking claims for manual review, records a `memory.organized` audit event, and never rewrites curated memory. `export-vault` renders that draft as an Obsidian-compatible Markdown digest under `gardener/exports/`, runs the redaction/secret detector on the rendered Markdown, preserves evidence links, and records a `memory.exported` audit event.

The exported Markdown is a **view/editor artifact only**: it is not the source of truth, and editing it does not update governed memory. The source of truth remains the governed Markdown memory store plus the append-only audit trail. This alpha.24 feature is deliberately narrow; it does not claim full enterprise memory policy automation (no RBAC/ABAC, namespace leak matrix, adapter framework, admin UI, or durable retention automation).

See [`docs/safe-memory-gardener.md`](./docs/safe-memory-gardener.md) for the command contract and the sanitized enterprise-style fixture.

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
npx ihow-memory@next doctor --memory-root <memory-root> --state-root <state-root>
```

In that mode the write boundary is strict: existing durable Markdown is read-only by default; candidates go under `memory/_mcp/candidates/`, staged promotes under `memory/_mcp/promoted/`, audit events under `memory/_mcp/_events/`; SQLite state stays under `<state-root>`, outside the memory root. Durable writes into the existing tree happen only through `durable-promote`, which refuses to run without an explicit `--dry-run` (prints the full plan) or `--real-write`.

## Diagnostics, feedback, reset, uninstall

**Doctor report you can share.** `npx ihow-memory@next doctor --runtime <runtime> --share-diagnostics` prints a redacted report: local paths replaced with placeholders, secret-like values removed, memory content omitted. It is printed locally and never uploaded.

**Feedback.** `npx ihow-memory@next feedback --runtime <runtime>` prints a prefilled GitHub issue URL, a Markdown template and a redacted doctor summary. Nothing is submitted automatically.

**Reset.** `npx ihow-memory@next reset --space <name>` removes a managed space. It requires an explicit `--space`, only removes managed spaces, and refuses `--memory-root` — it cannot delete an existing shared memory root.

**Uninstall.**

1. Remove the `ihow-memory` entry from the runtime: `claude mcp remove ihow-memory --scope user`, `codex mcp remove ihow-memory`, or edit `~/.cursor/mcp.json` (a `*.ihow-bak-*` backup sits next to it if `connect` wrote it).
2. Delete demo spaces with `npx ihow-memory@next reset --space <name>`.
3. If installed globally: `npm uninstall -g ihow-memory`.
4. Delete any custom state root only after reviewing its contents.

## Troubleshooting

- **A write was rejected as secret-like but isn't.** The pre-write check is deliberately conservative (it pattern-matches tokens/keys/credentials). Rephrase to drop the secret-shaped substring, or keep the value out of memory entirely. Auto-capture redacts rather than rejects, so this affects manual `write-candidate` / `promote`.
- **`search` finds nothing you just wrote.** The FTS index rebuilds on write, but if it looks stale run `npx ihow-memory@next reindex` to rebuild from Markdown. Confirm the index status with `npx ihow-memory@next status`.
- **`doctor` flags `node:sqlite`.** You need Node.js ≥ 22.12 (the version that ships `node:sqlite`). Check with `node -v`.
- **Hook installed but nothing captured (Claude Code).** Restart Claude Code after `install-hook` so it loads the settings. The cooperative Stop hook depends on the agent honoring the prompt; the deterministic SessionStart floor only fires for a *previous* session that ended without a cooperative journal (so a session that already journaled is correctly skipped). Inspect outcomes with `npx ihow-memory@next audit`.
- **Codex hooks installed but not firing.** Restart Codex after `connect --runtime codex --easy` / `install-hook --runtime codex`. If Codex asks you to review hooks, open `/hooks` and trust the iHow Memory command hooks; writing `hooks.json` is the installation step, while Codex still owns the trust gate.
- **`connect --auto` across projects only backs up one.** Floor capture is single-cwd (see Limitations).
- **npx cache cleared / hook command broke.** Installing from an `npx` cache path can be wiped; for a durable hook install globally (`npm i -g ihow-memory`) then re-run `install-hook`.
- **Windows.** Use WSL; native Windows is experimental.

## Proactive memory

The MCP tools are available to any client, but agents use memory only if they decide to. iHow Memory
adds runtime-specific layers where the host exposes stable hooks or instruction files:

- **Skill — recall + record discipline.** `ihow-memory install-skill` (or `connect --runtime
  claude-code --install-skill`) installs a thin policy layer ([`skills/ihow-memory/SKILL.md`](./skills/ihow-memory/SKILL.md))
  that nudges Claude Code to search at the start of a task and record a candidate after a decision or
  handoff. It changes *when* memory is used, not the mechanism. Other runtimes get the same nudge from
  the MCP tool descriptions.
- **Claude Code session-end auto-capture (cooperative) — experimental.** `connect --runtime claude-code --install-hook` adds a
  Stop hook that, at session end, asks the in-session agent to record a handoff into the low-weight
  `journal` lane via `memory.journal`. It is best-effort (re-prompts as the session grows, stops once
  an entry is recorded), **project-scoped by default** (`--global-hook` for user-wide), and reversible
  (`ihow-memory audit` / `rollback`).
- **Next-session floor (deterministic) — experimental, `next` only.** The same Claude Code `install-hook` also wires a
  SessionStart hook: when a new session starts, it floors the **previous** session deterministically *iff*
  that session ended without a cooperative journal. It parses the prior transcript, composes a
  last-substantive-segment summary within a **locked scope** (assistant text + file paths + command binary
  names + first prompt — never tool output, never raw shell), redacts it, and writes a low-weight,
  auditable, rollback-able journal entry. It is the safety net under the cooperative nudge: **single-cwd**,
  silent (it only captures — the floor itself injects nothing), and never throws. Offline evaluation on 22 real
  historical transcripts passed the backstop quality gate; live *natural* floor hits remain under dogfood
  because cooperative capture currently covers all observed sessions.
- **Codex native hooks — experimental.** `connect --runtime codex --easy` (or `install-hook --runtime codex`)
  writes `~/.codex/hooks.json` with SessionStart + UserPromptSubmit hooks. SessionStart adds the same
  resumable-session pointer and triggers the Codex capture-floor sweep at thread boundaries while keeping
  the normal idle gate; UserPromptSubmit runs the same bounded, relevance-gated recall path. Codex Stop is
  not installed by default yet because Codex documents Stop as turn-scoped, so treating it as "session end"
  would be too noisy. After install, restart Codex and use `/hooks` to review/trust the command hooks if
  Codex prompts for approval.

## iHow Memory — continuity protocol (alpha.22)

1. Thread start: call `memory.context_probe({eventHint:'session_start', cwd, runtime:'workbuddy'})`. Read returned packet. Treat narrative as UNVERIFIED — verify anchors before acting.
2. User says 继续/进度/上次/接手/之前/Codex/Claude/OpenClaw: call `memory.context_probe({eventHint:'prompt', cwd, promptDigest:'<summary>'})` before answering.
3. Task done: call `memory.context_probe({eventHint:'session_end', cwd})`. If `action='journal'`, call `memory.journal` with a brief entry.
4. If you forgot steps 1-3, no data loss — next `session_start` will detect stale marker and catch up.
5. `context_probe` does NOT auto-write for no-hook runtimes. You must call `memory.journal` yourself when `action='journal'`.

For no-hook runtimes, `session_end` means task completion or delivery, not process close. For multi-agent work, use the [Harness Contract](./docs/harness-contract.md): OpenClaw/human as Planner, Codex-style runtimes as Generators, Hermes-style reviewers as Evaluators, and WorkBuddy-style no-hook runtimes as cooperative reviewers that return structured review packets instead of being assumed callable.

> **Experimental & Claude Code-first.** Auto-capture is two layers: a cooperative Stop-hook nudge (whether
> an entry is written depends on the agent following the prompt) and a deterministic SessionStart floor
> backstop (`next` only) that captures the prior session when the nudge was not honored. Both write
> **low-weight, unreviewed** notes — use `promote` / `durable-promote` for trusted long-term memory. The
> floor is offline-validated as a backstop; it is not yet promoted to a primary/default-weight path, and
> `recall` (reading memory back into a new session) is **on** by default and relevance-gated (off-topic prompts get nothing). Since alpha.19 it surfaces reviewed decisions **and** auto-captured soft facts (preferences, configs) seamlessly, while unverified status claims ("all green") and risky behavior-priors ("skip approval") are excluded from the ambient default surface — ask about status explicitly and the unverified note is shown, fenced as reference. Remembered something wrong? `ihow-memory forget <what you'd say>` stops it surfacing everywhere, reversibly (`remember` undoes it). Disable recall with `--no-recall` or `IHOW_RECALL_OFF=1`; restore reviewed-only with `IHOW_RECALL_AUTO_DEFAULT=0`.

## Examples

Runnable, self-contained walkthroughs live in [`examples/`](./examples/) (numbered 01–03). All examples use synthetic data only.

## Privacy

- The open-source core runs locally: no account, no required network calls, cloud and sync are disabled and report as such in `status` and `doctor`.
- Telemetry is **off by default** and opt-in (`ihow-memory telemetry on`). When enabled it records only a fixed allow-list — event name, runtime, package version, error type, timestamp — never memory content, file names, queries, paths or prompts. In the current alpha, events are appended to a local file (`~/.ihow-memory/telemetry-events.jsonl`) and are not uploaded anywhere.
- Diagnostics are redacted by design; memory content is never included. `feedback` only prints a template — you decide whether to open the issue.

## Hosted runtime

A hosted runtime is not included in this npm package or this repository.

## Status

Alpha prerelease (`0.1.0-alpha` line — the npm badge above shows the latest published version; see [CHANGELOG.md](./CHANGELOG.md)). Maturity is **alpha + single-machine real-app smoke**: Claude Code is dogfooded daily and has the richest native-hook path; Codex now has native SessionStart/UserPromptSubmit hooks plus a proactive AGENTS memory loop; the other runtimes are single-machine real-app smoke, and Cursor and Claude Desktop are receive-only (they can call the tools but cannot resume). Node >= 22.12 is a hard requirement (`node:sqlite`). Validated daily on macOS and Linux; native Windows is **experimental** — the `packageDir` path bug is fixed and a `windows-latest` CI lane covers build + a connect/doctor reachability smoke + the full test suite, with WSL as the supported path. The npm tarball ships the compiled CLI, the stdio MCP server and the read-only local console; the TypeScript sources live in this repository. Expect breaking changes between alpha releases.

**Which version has what (dist-tags).** Prereleases publish under the `next` dist-tag; `npm install ihow-memory` resolves `latest`.

| dist-tag | auto-capture |
| --- | --- |
| `latest` | cooperative Stop-hook nudge only (depends on the agent honoring it) |
| `next` | adds the **deterministic SessionStart floor** backstop (single-cwd, low-weight, offline-validated), turns **recall on** (reviewed + guard-railed auto soft facts since alpha.19; status/bypass claims held back), and ships **one-gesture `forget`/`remember`** |

To try the floor backstop: `npm install ihow-memory@next`. A plain `npm install ihow-memory` stays on the conservative `latest`.

## Limitations

- **Floor capture is single-cwd.** The SessionStart floor backs up only its designated workspace/cwd. If you `connect --auto` across multiple projects sharing one workspace, the floor covers one cwd; broad multi-cwd rollout is pending further dogfood.
- **Default retrieval is lexical, not semantic.** The shipped default is zero-dependency FTS5 lexical search. The vector + lexical hybrid (behind the published recall figures) is an *optional* local provider, not in the out-of-the-box binary.
- **Auto-tier memory is machine-judged, not human-reviewed.** Since alpha.19 relevant auto-captured SOFT facts do surface by default — but behind measured guardrails: status/completion claims and actionability-bypass priors are excluded from the ambient surface (red-team gated), the journal/floor lanes are still never auto-injected, and `IHOW_RECALL_AUTO_DEFAULT=0` restores reviewed-only. The keyword guardrails are deliberately broad, not a perfect classifier — a wrongly held-back soft fact just doesn't surface, and `ihow-memory forget` reversibly silences anything that surfaced wrongly. Use `promote` / `durable-promote` for trusted long-term memory.
- **Storage grows without bound (no rotation/compaction/GC yet).** Journals, the audit ndjson log and `*.ihow-bak-*` backups currently accumulate, and every write rebuilds the full FTS index — rotation/compaction/GC is planned but not shipped. Fine for normal use; heavy long-running use will pile up. Manual mitigation: occasional `ihow-memory reindex` and pruning of old backups by hand.
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
