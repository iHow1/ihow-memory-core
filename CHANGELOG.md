# Changelog

All notable changes to the `ihow-memory` npm package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
with pre-release tags.

## [Unreleased]

## [0.1.0-alpha.25] — 2026-07-08

### Added

- **Enterprise Gate Matrix v0 for Safe Memory Gardener.** Added deterministic local tests and docs for
  project, public, private, source, audit-only, source-local, and source-shared boundaries. The matrix
  checks that organize/export drafts stay inside the requested scope, redaction is applied before
  export, and organize/export audit events exist.
- **Blocked export fail-closed policy v0.** Markdown export now refuses drafts with `blocked_items` or
  `export_safe:false` instead of emitting a partial/sanitized subset silently, and records auditable
  refusal metadata with `status:refused`, `reason:blocked_items_present`, and
  `blockedItemsPolicy:fail-closed`.
- **Source Adapter Contract v0.** Added a local, fixture-only source-adapter contract for validating and
  rendering source-lane Markdown from adapter-produced documents. It requires typed adapter/source
  metadata, restricts visibility to `source-local` or `source-shared`, requires slug scopes, redacts
  content before rendering, and keeps source fixtures inside the Safe Memory Gardener boundary matrix.
- **Audit completeness baseline v0.** Added coverage expectations for candidate write, promote,
  durable-promote, journal append, rollback, organize, and export events so governance actions can be
  reconstructed from append-only audit data rather than trusting exported artifacts alone.
- **Durable write dedupe/stale/supersede baseline v0.** Write/promote/durable-promote surfaces now attach
  review-first policy metadata for duplicate body fingerprints, self-labeled stale/deprecated content,
  and possible supersede candidates; dry-run plans expose the same policy before writes.

### Changed

- **alpha.25 package prep.** Local package metadata is bumped to `0.1.0-alpha.25` for RC readiness only;
  no tag, publish, push, release, or deploy is part of this change.

### Notes

- alpha.25 remains an alpha release candidate. These are local governance gates and typed contracts, not
  an enterprise-ready RBAC/ABAC product.
- The source-adapter layer is fixture-only in this release: there are no real Feishu, Obsidian, ima, or
  other external adapters, no customer-data import, and no external credentials are read.
- Durable duplicate/stale/supersede handling is intentionally metadata/audit-only and review-first; it
  does not delete, merge, rewrite, or silently choose a new authoritative memory.

## [0.1.0-alpha.24] — 2026-07-08

### Added

- **Safe Memory Gardener RC proof fixture.** Added a deterministic, desensitized enterprise-style fixture
  that proves synthetic workflow events flowing into candidate/project memory state, then a review-first
  organize draft, an evidence-linked digest, a redaction-checked Markdown/Obsidian export, and
  organize/export audit events. The fixture uses generic Project Orchard content only and avoids customer
  data, private identifiers, production endpoints, and hardcoded customer ontology.
- **Safe Memory Gardener user docs.** Added `docs/safe-memory-gardener.md` plus README/README.zh-CN CLI
  references for `organize` and `export-vault`, including the source-of-truth boundary: exported Markdown
  is a view/editor artifact, not authoritative memory.

### Changed

- **alpha.24 package prep.** Local package metadata is bumped to `0.1.0-alpha.24` for RC readiness only;
  no tag, publish, push, release, or deploy is part of this change.

### Notes

- Safe Memory Gardener remains a narrow alpha MVP: review-first organize/export with safety checks and
  audit trail. It does not claim full enterprise policy automation such as RBAC/ABAC, namespace leak
  matrices, adapter frameworks, admin UI, or durable retention automation.

## [0.1.0-alpha.22] — 2026-07-05

### Added

- **Automation Reliability Pass.** Added `memory.context_probe`, a runtime-agnostic MCP trigger for
  no-hook and partial-hook agents. It supports `session_start`, `prompt`, `session_end`, and `tick`
  events; records append-only probe audit events; updates a freshness marker; and returns explicit
  actions such as `verify_anchors`, `journal`, or `none` instead of pretending every runtime has a
  native lifecycle hook.
- **Reviewed prompt recall for `context_probe(prompt)`.** Prompt probes can now return a bounded
  `<recalled-memory>` block with up to three cited reviewed/curated snippets. The path is fail-closed:
  flagged entries, `reviewed:false`, `tier:auto-promoted`, and journal/floor lanes are excluded by
  default, and empty prompt digests no-op.
- **Automation doctor matrix and metrics.** `doctor --json` now reports a cross-runtime automation
  matrix for Claude Code, Codex, OpenClaw, Hermes, and generic no-hook runtimes, plus audit-derived
  probe metrics such as probe calls by runtime, journal suggestions, probe→journal conversion, and
  floor capture sources.

### Changed

- **No-hook runtime write boundary is explicit.** WorkBuddy/OpenCode/Gemini-style runtimes never receive
  `floor_journaled` from `context_probe`; `session_end` returns `action: "journal"` so the agent must
  explicitly call `memory.journal` with a cooperative handoff. Automatic floor writing remains reserved
  for runtimes with a reliable transcript source and the existing redaction/audit/rollback path.
- **No-hook continuity protocol documented.** README now documents the alpha.22 continuity protocol:
  call `context_probe` at thread start, on continuation-style prompts, and at task completion; forgetting
  to call it does not corrupt memory, but doctor/metrics can reveal that automation is not actually firing.
- **Harness contract documented.** Added `docs/harness-contract.md` for Planner / Generator / Evaluator
  workflows: explicit role matrix, WorkBuddy/no-hook boundaries, review packet template, run ledger
  contents, and evaluator stop conditions.

## [0.1.0-alpha.21] — 2026-07-04

### Added

- **Codex native hook parity.** `setup --runtime codex`,
  `connect --runtime codex --easy` / `--yes`, and `install-hook --runtime codex`
  now install Codex `SessionStart` + `UserPromptSubmit` hooks into
  `~/.codex/hooks.json`, preserving existing hooks and refusing invalid JSON.
  `SessionStart` emits the resume-awareness pointer and triggers a Codex-only
  deterministic capture-floor sweep at thread boundaries (still protected by
  the normal idle gate so active/paused sessions are not captured prematurely);
  `UserPromptSubmit` runs the same bounded, relevance-gated recall path used by
  Claude Code. Codex `Stop` is intentionally not installed by default yet
  because Codex documents `Stop` as turn-scoped, so treating it as session-end
  needs a separate low-noise design pass.

### Changed

- **Codex setup now has both mechanics and policy.** Codex keeps the proactive
  `~/.codex/AGENTS.md` memory loop for continue/search/read/write/forget
  discipline, but no longer relies on instructions alone: the lifecycle hooks
  provide the mechanical trigger layer. README runtime-support/status language
  was updated to remove the stale "Codex lacks native lifecycle hooks" claim.

## [0.1.0-alpha.17] — 2026-06-30

The **first-run + standard-evidence** release: the README's governed-loop quickstart now copy-pastes
clean for a brand-new user, the retrieval numbers are corroborated on a public standard dataset on the
default engine, cross-tool resume widens to Gemini CLI and Cline, and the optional embedding sidecar now
ships inside the package.

### Fixed

- **Quickstart copy-paste was broken for new users (ship-blocker).** The README §"The governed loop in
  60 seconds" block errored: `write-candidate` auto-promotes by default, so `promote $CAND` hit
  `candidate_not_found`, `$PROMOTED` came back empty, and `read ""` resolved to the memory-root directory
  → a cryptic `EISDIR`. The block now passes `--no-auto-promote` to make the two-step gate explicit
  (matching its own narrative), `read` rejects an empty/missing path with a clean message + non-zero exit
  instead of `EISDIR`, `init` prints a governed-loop next step, and `status` surfaces the auto-promote
  mode. Locked by `tests/quickstart-governed-loop.test.mjs`.

### Added

- **Standard retrieval benchmark on the default engine (LongMemEval-oracle, MIT).** `scripts/standard-bench.mjs`
  runs a public, MIT-licensed dataset ([arXiv:2410.10813](https://arxiv.org/abs/2410.10813)) through the
  SAME `write → promote → search` scorer as the in-repo bench, on the **default zero-dependency FTS5
  engine** (`engine.id==='fts'`, `cloud=false`, `model=null`). `--download` fetches + **sha256-verifies**
  the corpus; a vendored N=8 slice runs offline in CI. Full-set figures: **Recall@5 = 0.788, Recall@10 =
  0.857, MRR = 0.651** over 419 usable instances / 831 session-docs (global-corpus retrieval — harder than
  the per-instance oracle; recall_any@k; MRR is ours, not LongMemEval's NDCG). The weak spots
  (assistant-answer / preference questions) stay visible.
- **Passive resume readers for Gemini CLI and Cline.** Cross-tool `continue` now reads two more runtimes'
  on-disk sessions (passive — resume/import, not real-time; only Claude Code has a live capture hook).
  Both route through the shared session path, so the locked summarizer scope + secret redaction are
  identical to every other runtime. **Gemini CLI** reads `~/.gemini/tmp/*/logs.json` (a user-prompt log —
  Gemini records no assistant turns to disk — so the handoff is the session topic + git anchors; verified
  against real local data). **Cline** reads `tasks/<id>/api_conversation_history.json` from VS Code-family
  globalStorage and `~/.cline/data` with cwd from `environment_details` (bounded discovery — no home-wide
  scan; fixture-tested). Aider is intentionally deferred: it keeps no global session registry, so global
  discovery would require a `$HOME` scan on the session-start hot path.
- **Optional embedding sidecar now ships in the tarball.** `examples/` is not in package.json `files[]`,
  so a published install could not find the sidecar; the build now copies it into `dist/providers/`
  (`dist/` is packaged) and a `providerScriptPath()` resolver locates it. The sidecar stays a SPAWNED
  subprocess on explicit opt-in only — never imported into the default graph, so the default engine
  remains zero-dependency FTS5 (`capabilities.semantic = false`). A red-line test forbids any default-graph
  module from importing it.

## [0.1.0-alpha.16] — 2026-06-30

### Added

- **Two more receiver runtimes: VS Code (Copilot) and Gemini CLI.** `connect --runtime vscode` writes the
  user-level VS Code `mcp.json` (`servers` key, `type: "stdio"` entry; macOS/Linux/Windows user-data dir)
  and `connect --runtime gemini` adds an `mcpServers` entry to `~/.gemini/settings.json`. Both back up an
  existing config and refuse to clobber an unparseable one, like the other JSON runtimes. They are
  receiver-only — no readable local session store to resume *from* — but reach `memory.search` /
  `memory.read` / `memory.continue`, so they can pull a verify-first handoff packet recorded by a capture
  runtime. `setup`/`connect --auto` now detect them (`code` / `gemini` on PATH, or their config dir).
- **Handoff schema doc.** [`docs/handoff-schema.md`](./docs/handoff-schema.md) formalizes the verify-first
  handoff contract: machine anchors are the only facts, the narrative is carried verbatim and unverified,
  and the GREEN/YELLOW/RED verdict is code-computed against live git (never a false GREEN).

## [0.1.0-alpha.14] — 2026-06-29

The **capture-experience** release: capturing memory is now fully automatic — nothing is blocked
except secrets and engine-falsified anchors — while the verify-first floor that keeps junk out of
authoritative, auto-recalled memory is preserved and hardened. The floor change was reviewed and
signed off by an external red team.

### Changed

- **Label, don't block.** Governance-flagged and unverified content no longer fails to capture: it
  auto-promotes into durable *yellow* tiers (verified / unverified / flagged) instead of staying a
  blocked candidate. Flagged entries are durable and findable on demand but are never auto-recalled and
  are excluded from default search; only human-promoted (and engine-anchor-verified) memory is
  authoritative. A misjudgment now costs a label, not your capture.
- **Sharper governance classifier.** Markers no longer scan the auto-derived slug/identifier title, so
  a factual handoff named like a file (`policy-…-root`) stops false-flagging; a genuine rule in a prose
  title or in the body still flags.
- **Provenance binding.** A `command`+`exitCode` keeps an entry durable but never recall-eligible; only
  a git anchor the engine verified against live HEAD earns auto-recall, and recall trusts the
  append-only event log rather than forgeable front-matter.

### Added

- **`promote` accepts a candidateId**, not just the candidate file path.
- **Flagged TTL expiry** — un-reviewed flagged memory auto-expires so the human-review backlog can't
  pile up silently; the session-end hook surfaces what is pending review.

### Fixed

- Two issues found by the external red-team review of the floor change: a stapled `command`+`exitCode`
  could mask a falsified git anchor (now a hard reject); recall could trust a hand-written
  `provenance_kind: anchor` front-matter (recall is now bound to the engine event log).

## [0.1.0-alpha.13] — 2026-06-27

The **verify-first wedge + import** release: a reproducible local proof of the trust guarantees, one
command to seed memory you already wrote elsewhere, and recall turned on by default — but only for
human-reviewed memory, with every injected item tagged by trust tier.

### Added

- **`verify` — a reproducible self-proof receipt.** Local store + each runtime's MCP reachability + this
  checkout's GREEN/YELLOW/RED resume verdict, every line carrying the exact command to re-run yourself.
  Exit non-zero if anything fails to round-trip. No trust required, local-only.
- **`benchmark` — a deterministic local proof of the verify-first guarantees.** Asserts, against
  adversarial scenarios, that the three-color resume verdict actually discriminates (GREEN only on a
  matching checkout; HEAD drift → RED; uncertainty → YELLOW) and that the no-false-green floor blocks
  unverified / secret / standing-rule / fabricated-anchor content from durable memory. Re-run for the
  same result; exit non-zero if any guarantee fails — it cannot false-green about itself.
- **`import` — bring existing memory into the searchable store.** One command imports memory you wrote
  elsewhere (Claude Code's native `MEMORY.md` + fact files, ai-memory markdown, or any folder of `.md`
  notes) into the low-weight journal lane: dry-run by default, `--apply` to write, reversible per entry,
  secret-refusing (body **and** title), and proven by searching a written item back out. `--update`
  supersedes an edited fact, archiving the stale copy to off-index history rather than leaving two
  contradictory versions searchable.

### Changed

- **`recall` is now ON by default — reviewed tier only.** A new prompt now recalls relevant prior memory
  by default, but injects only 🟢 **reviewed** (human-promoted) memory, relevance-gated (off-topic prompts
  inject nothing) and bounded. Each injected item is tagged by trust tier — 🟢 reviewed vs 🟡 auto
  (machine-gated by provenance, shown with its basis, e.g. "cites npm test exit 0"). The machine-judged
  🟡 auto tier stays opt-in (`IHOW_RECALL_INCLUDE_AUTO=1`). Disable with `--no-recall`, or `IHOW_RECALL_OFF=1`
  at runtime. Basis: a labeled recall-quality evaluation measured the reviewed tier at ~88% useful / 0
  harmful (off-topic prompts injected nothing; stale entries dropped); the auto tier at ~25%, hence opt-in.
- **A `tsc --noEmit` typecheck gate** is wired into the build and CI — it catches the "used-but-not-imported"
  dead-reference class that a transpile-only build would otherwise ship silently.

## [0.1.0-alpha.12] — 2026-06-25

A **trust-hardening** release. A pre-launch adversarial audit found that, while alpha.11 fixed the two
real first-user incidents (Windows `setup` crash, Hermes false-positive connect), it had in several
places shipped a *confident green that wasn't actually verified* — the exact trust-without-verify this
project exists to remove. Every fix below closes one of those, with a regression test, and each is the
engine enforcing the check rather than asking an agent (or a reader) to trust a claim.

### Fixed

- **`continue`: a GREEN now requires the receiver's own checkout.** The resume verdict trusted the
  project inferred from a session's edited files without checking where the receiver actually is —
  `continue --cwd /other-repo` against a session from repo A printed 🟢 "safe to pick up" while sitting
  in an unrelated repo B. The verdict now takes the caller's cwd and degrades to YELLOW when it resolves
  to a different git repo (CLI + MCP). The destructive-narrative downgrade was realigned with the
  envelope's GREEN-lane prohibition set, so `npm publish` / `gh release` / "send a message to the
  customer" / "rotate the credential" / "change the default" no longer reach a confident GREEN; and a
  recorded HEAD anchor shorter than 7 chars (which prefix-matched almost any live HEAD) is treated as
  unverifiable.
- **`connect` / `setup`: stop printing "verified" for runtimes only round-tripped.** A passing round-trip
  proves IHOW's own server starts — not that the receiving runtime (Cursor, WorkBuddy, OpenCode, Claude
  Desktop, OpenClaw) loaded it. Those are now reported `reachable` but not `verified` ("verify on first
  launch"); only a runtime whose own CLI confirms registration is `verified`. `connected[]` carries a
  per-runtime `verified` flag in `--json`.
- **`connect --runtime <x>` verifies too.** The single-runtime path (the README's first-recommended
  command) reported connected on write-success alone; it now runs the same verify-after-connect
  round-trip as `setup` and reports verified / reachable-pending / not-reachable (+ non-zero exit when
  unreachable). `--json` gains `reachable` / `verified` / `detail`.
- **`doctor --runtime <x>` verifies MCP reachability as a REQUIRED check.** doctor previously checked only
  the local store plus "a runtime flag was passed", so `doctor: ok` could mean healthy while the runtime's
  `mcp list` was empty. It now round-trips the configured server (+ CLI registration) as a required check.
- **`upgrade` re-handshakes; bundle skew is a required error.** The frozen-bundle skew check was a soft
  warning, so a connected runtime could keep running an old server after `npm update` with doctor still
  green — it is now a required error. `upgrade` probes a fresh server after re-stamping to confirm the new
  bundle round-trips (and still tells you to restart the runtime).
- **Auto-promoted durable memory is reversible.** `rollback` hard-coded "only journal entries", so an
  auto-promoted (machine-judged, no human gate) durable write could not be undone via the engine. It can
  now (`rollback` removes the promoted file and restores the candidate for review); a **human-confirmed**
  promotion stays out of scope and is refused.
- **`--json` output is no longer corrupted by the telemetry notice.** In non-interactive mode the one-time
  telemetry prompt printed to stdout, breaking any script parsing a `--json` payload; it now goes to stderr.

### Changed

- **Auto-promote provenance is engine-verified, not self-asserted.** The floor accepted any present
  provenance key, so `verified: true`, a free-text `evidence`, a lone `exitCode`, or a fabricated git
  anchor all auto-promoted into durable memory. It now requires structured, falsifiable evidence —
  `command` + `exitCode`, or a git anchor the engine checks against live HEAD (a HEAD claimed for an
  explicit repo path that doesn't match is rejected as a fabricated/stale anchor). `IHOW_AUTO_PROMOTE=0`
  globally forces every write to stay a candidate (full human gate). The one-call "remember this" UX is
  preserved for content that carries real evidence.
- **Recall injects only human-reviewed memory.** Unreviewed auto-promoted entries (`tier: auto-promoted`
  / `reviewed: false`) live under the curated paths, so the path allowlist alone would inject them as if
  vetted; recall now excludes them. (Recall remains default-off.)
- **Windows CI exercises the round-trip**, and the README's Windows wording is consistent (native Windows
  is experimental; WSL is the supported path) instead of also claiming "not yet a supported lane".

### Hardened (post pre-launch re-audit)

An adversarial re-audit of the above closures found four residual holes — three of them introduced by the
fixes themselves — all now closed with regression tests:

- **`continue`: a blank cwd is no longer a GREEN bypass.** The receiver-context gate was guarded on the
  truthiness of `cwd`, so an MCP client sending `{"cwd":""}` skipped it straight to a confident GREEN (more
  dangerous than omitting cwd, which correctly fell back). The gate now triggers on any *provided* cwd and
  treats a blank one as unverifiable (YELLOW); the MCP server normalizes a blank cwd to the launch dir.
- **`rollback` is idempotent.** Replaying a stale auto-promote rollback id — after its candidate had been
  re-promoted by a human at the same target — blind-deleted the now human-confirmed file, silently reversing
  a deliberate promotion. Rolling the same event back twice is now refused (`rollback_already_rolled_back`).
- **Recall's unreviewed-exclusion is case- and quote-tolerant.** The filter matched only the engine's exact
  `reviewed: false` / `tier: "auto-promoted"`; in a shared multi-agent vault an entry serialized as
  `reviewed: "false"` / `Reviewed: False` / `tier: 'auto-promoted'` slipped back in. Now recognized.
- **`connect` exits non-zero when unreachable, including `--json` and `--auto`.** The exit-code contract
  only held on the text path; `--json` and `--auto --write` returned 0 even when nothing reached — exactly
  the scripted callers the `--json` fields are for.

## [0.1.0-alpha.11] — 2026-06-25

### Fixed

- **Windows: `setup` no longer fails to prepare the workspace.** `packageDir()` resolved the
  package root via `new URL('..', import.meta.url).pathname`, which on Windows yields an invalid
  `/C:/…` path — so the CLI couldn't find its own `dist` (`setup` reported `could not prepare the
  workspace`, `connect` threw `runtime_bundle_missing`, `--version` showed `unknown`). Now resolved
  with `fileURLToPath`. Verified end-to-end on real Windows 11 (ARM64).

### Added

- **Windows CI lane** (`windows-latest`, Node 22 + 24): build + a version smoke that catches the
  `packageDir` regression + a `connect` smoke + the full test suite, so Windows can't silently break again.
- **Automatic promotion for qualifying memory.** `memory.write_candidate` is now the one call to
  remember something: the engine auto-promotes low-risk content that carries provenance (evidence /
  anchors / command / repo / verified in `metadata`) into durable memory, instead of leaving everything
  a candidate that must be promoted in a separate step. Pass `autoPromote: false` to only stage a candidate.
- **An enforced auto-promote floor.** What reaches durable memory is gated by the **engine, not the
  agent's self-judgment**: secret-like content, standing-rule / policy / access / identity / destructive
  statements, and content without provenance all stay candidates (with a reason). The floor scans the
  full candidate — title and metadata included, not just the body. Auto-promoted memory is tagged
  `tier: auto-promoted` / `reviewed: false` (audit actor `agent-auto`) so it stays distinguishable from
  human-confirmed memory. (Rank down-weighting of unreviewed entries in recall is a tracked follow-up.)
- **Verify-after-connect: `setup` reports a runtime "connected" only once it is actually reachable.**
  After writing the MCP config it round-trips the configured server (`initialize` + `memory.status`)
  and, for runtimes with an official CLI, confirms the server is really registered — never on
  write-success alone. A runtime whose configured server round-trips (including direct-config runtimes
  that have no CLI) is reported connected; one that fails the round-trip, or whose CLI says it isn't
  registered, is surfaced as `unverified` (config written but not reachable). `--json` gains an
  `unverified` list, and `connect --auto` verifies the same way. The Hermes connector now runs
  `hermes gateway start` so the add takes effect on the live gateway. (Catches the first-user incident
  where `setup` reported Hermes connected while `mcp list` was empty.)
- **Resume verdict on `continue`: a GREEN / YELLOW / RED handoff signal you can trust.** When an agent
  resumes via `memory.continue` (MCP) or `ihow-memory continue` (CLI), the engine now re-reads the
  **live git state** of the project and compares it against the anchors recorded at handoff time, then
  reports a verdict instead of asking you to trust the packet blind. **GREEN is deliberately narrow** —
  same repo, HEAD reachable and matching the recorded anchor; a different machine, a moved working
  directory, or a HEAD that has moved on yields **YELLOW** (resume with care) or **RED** (the recorded
  baseline is not what you're sitting on). It compares HEAD by prefix so a short recorded SHA against a
  longer live one is not mistaken for a mismatch, and it **never reports a fabricated GREEN**.
- **First-run handoff from a project STATE doc.** `continue` no longer comes up empty on a project that
  has no recorded session yet: if the project carries a `PROJECT_STATE.md`, the engine reads it as the
  resume narrative, cross-checks it against live git, and attaches the same verdict. A baseline *inferred*
  from a STATE doc (e.g. a `referencedHead` parsed out of prose) is **capped at YELLOW — never a false
  GREEN** — even when the parsed SHA happens to match the live HEAD, so an inferred baseline can never
  masquerade as a verified one.

### Changed

- `memory.promote` is now described as the explicit manual promotion path; `memory.durable_promote`
  still requires explicit `realWrite: true`.
- Skill + README guidance: the engine gates promotion — attach provenance to make something durable;
  high-risk content stays a candidate for human review.

## [0.1.0-alpha.4] — 2026-06-15 (experimental · Claude Code-first)

> Auto-capture is **experimental and Claude Code-first**. The Stop hook blocks once to request a
> session-end handoff into a low-weight journal — it is **not** a guaranteed autonomous capture
> loop; a real Claude Code app smoke has passed, but multi-session dogfood is still pending. Other runtimes remain
> connect + tool-description nudge.

### Added

- **Layered memory: an append-only, low-weight journal lane.** `memory.journal` (MCP) and
  `ihow-memory journal` (CLI) write directly into a daily journal that is searchable but always
  ranked **below** curated/promoted memory, so auto-capture cannot displace high-weight recall.
  Writes still pass the pre-write secret reject gate and emit audit events.
- **Session-end auto-capture for Claude Code (experimental).** `ihow-memory hook-stop` is a
  Stop-hook handler; `ihow-memory install-hook` wires it into this project's
  `.claude/settings.local.json` (or `--global-hook` for user-wide). At session end it asks the
  in-session agent to record a handoff via `memory.journal`. Best-effort at-least-once
  (re-prompts as the session grows, stops once a journal entry is recorded), recursion-guarded,
  skips trivial sessions.
- **One-command Claude Code setup.** `connect --runtime claude-code [--install-skill]
  [--install-hook]` registers the MCP server, optionally copies the skill, and optionally installs
  the Stop hook — each consent-gated, with backups, never clobbering user-modified files.
- **Audit + rollback.** `ihow-memory audit [--since]` lists the append-only event log;
  `ihow-memory rollback --event <id>` reverses one auto-captured journal entry.
- Expanded the pre-write secret reject gate (JWT, PEM private-key headers, Slack, Google, Stripe,
  Twilio, more GitHub token shapes) and added the curated anchors (preferences, active-anchors) to
  the protected paths so auto-writes can never clobber them.

### Honesty / security notes

- Auto-captured notes land in a **low-weight journal, not curated memory**: searchable, auditable,
  and reversible, but **unreviewed**. Use `promote` / `durable-promote` for trusted long-term memory.
- The secret gate is a **high-precision pre-write reject, not a full DLP guarantee**.

## [0.1.0-alpha.3] — 2026-06-13

### Added

- `connect` now covers seven runtimes one-command — claude-code, codex, cursor,
  Tencent WorkBuddy, Claude Desktop, OpenCode, and Hermes (NousResearch). Each writer
  was verified against a real install:
  - WorkBuddy 5.0.3 — `~/.workbuddy/mcp.json` (stdio, absolute node); never touches its
    runtime/connector/approval files.
  - Claude Desktop — OS config path; entry omits `type` to match its schema.
  - OpenCode — `~/.config/opencode/opencode.json`, the `mcp` container with a
    `{ type: "local", command: [...], enabled: true }` entry.
  - Hermes — via the official `hermes mcp add` CLI; roots passed through `--env`.
  - Any other MCP client works via the generic snippet from `init`.
- MCP tool descriptions now carry "when to use" guidance (search before answering /
  continuing; write_candidate after decisions, results, blockers, handoffs; no secrets;
  durable_promote defaults to dry-run) so agents use memory proactively across any client.
- Claude Code memory skill at `skills/ihow-memory/SKILL.md` — a thin policy layer (search
  at task start, propose candidates after decisions/handoffs, governed promote).
  `connect --runtime claude-code` points to it; no auto-install.
- Flagship walkthrough `examples/connect-workbuddy.md` and `examples/flagship-cross-tool-handoff.md`.
- Regression tests for every connect writer under `tests/`.

### Changed

- Windows: native support is **experimental**. Claude Code and Claude Desktop connect use
  cross-platform direct-write paths (`~/.claude.json`, `%APPDATA%\Claude`); CLI-based
  codex/hermes connect print manual-setup guidance on Windows. WSL is the supported path.

## [0.1.0-alpha.2] — 2026-06-11

### Added

- Public source release: this repository (`iHow1/ihow-memory-core`) now hosts the
  TypeScript sources behind the published npm package.
- Security-boundary regression tests under `tests/` (see Security below).
- Runnable examples under `examples/` (01 five-minute memory, 02 Claude Code
  over MCP, 03 two agents sharing one memory), synthetic data only.
- Repository infrastructure: CONTRIBUTING, SECURITY, CODE_OF_CONDUCT,
  issue/PR templates, CI workflow (build, tests, pack check, secret scan).

### Changed

- README rewritten as the single source of truth for the published package:
  `connect`-first quickstart, tested copy-pasteable CLI loop, retrieval-engine and
  benchmark statements aligned with the shipped zero-dependency FTS5 default,
  links to website / spec repo / evidence manifest. Chinese translation added
  (`README.zh-CN.md`).

### Security

- **Fixed: symlink-following read could leak files outside the memory root.**
  A symlink placed inside a memory workspace (e.g. via a shared or synced vault)
  was followed by `memory.read`/`read`, returning the content of arbitrary
  external files.
- **Fixed: a TOCTOU symlink-swap race on the read path.** Checking the resolved
  path and then re-opening it left a window where a symlink could be swapped
  between check and read (reproducible under a concurrent attacker on a
  shared/synced vault). The read path now opens with `O_NOFOLLOW` (a symlinked
  leaf is refused outright) and verifies the opened file descriptor's inode
  matches the containment-checked real path. Verified: 0 leaks across 200k+
  concurrent swap iterations. Memory files are real files and the index already
  ignores symlinks, so refusing symlinked leaves loses no real capability.
- **Fixed: promote and durable writes could escape the managed root through a
  symlinked directory.** Write paths now verify the resolved parent directory
  is contained in the managed root before writing.
- Added a security-boundary regression suite (`tests/security-boundary.test.mjs`,
  21 cases): path traversal, absolute paths, NUL bytes, scope escapes, protected
  paths, symlink file/directory escapes for read and write, the read-leaf
  O_NOFOLLOW guard, index-stage symlink handling, and `reset` safety. Index
  scanning was verified to ignore symlinks by design.

## [0.1.0-alpha.1] — 2026-06-09

### Added

- `--version` flag on the CLI.

### Fixed

- Version string unified to a single source across the CLI and the MCP server.
- The runtime bundle copied into `<space>/.runtime/` no longer reports a stale version.
- Suppressed the experimental `node:sqlite` warning in CLI output.

## [0.1.0-alpha.0] — 2026-06-08

### Added

- First published npm release.
- Local CLI: `init`, `status`, `doctor`, `proof`, `reindex`, `search`, `read`,
  `write-candidate`, `promote`, `durable-promote`, `feedback`, `reset`, `console`.
- stdio MCP server with six `memory.*` tools: `search`, `read`, `write_candidate`,
  `promote`, `durable_promote`, `status`.
- `connect` auto-configuration for three runtimes — claude-code, codex, cursor —
  using the runtime's official CLI where available, otherwise a backup-first
  atomic JSON merge.
- Governance flow: candidate inbox → explicit promote → append-only audit events;
  citation-bearing search and read.
- Zero-dependency retrieval engine: `node:sqlite` FTS5, with an optional local
  vector provider interface and visible fallback to FTS.
