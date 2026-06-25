# Changelog

All notable changes to the `ihow-memory` npm package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
with pre-release tags.

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
