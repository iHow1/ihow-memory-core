# Changelog

All notable changes to the `ihow-memory` npm package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
with pre-release tags.

## [0.1.0-alpha.2] — 2026-06-11

### Added

- Public source release: this repository (`iHow1/ihow-memory-core`) now hosts the
  TypeScript sources behind the published npm package.
- Security-boundary regression tests under `tests/` (see Security below).
- Runnable examples under `examples/` (01 five-minute memory, 02 Claude Code
  over MCP, 03 two agents sharing one memory), synthetic data only.
- Repository infrastructure: CONTRIBUTING, SECURITY, CODE_OF_CONDUCT,
  issue/PR templates, CI workflow (build, tests, pack check, secret scan).
- `connect --runtime workbuddy`: one-command MCP setup for Tencent WorkBuddy
  (safe backup + merge write to `~/.workbuddy/mcp.json`, stdio entry with an
  absolute node path; never touches WorkBuddy's runtime/connector/approval files).
  Connect guide: `examples/connect-workbuddy.md`.

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
