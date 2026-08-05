# Security Policy

iHow Memory is a local-first memory layer for AI agents. Its security promises are concrete: governed writes (candidate → explicit promote), strict write boundaries around existing memory roots, redacted diagnostics, and no default network surface. Reports that break any of those promises are exactly what we want to hear about.

## Supported versions

| Version | Supported |
| --- | --- |
| Latest published `0.1.x` alpha | Yes |
| Older pre-releases | No — please reproduce on the latest version |

## How to report a vulnerability

**Please do not open a public issue for vulnerabilities.**

Report privately via GitHub Security Advisories:

1. Go to <https://github.com/iHow1/ihow-memory-core/security/advisories/new> (the "Report a vulnerability" button on the repository's Security tab).
2. Include: affected version (`npx ihow-memory --version`), OS, Node version, reproduction steps, and impact.
3. If diagnostics help, attach the output of `npx ihow-memory doctor --share-diagnostics` — it is redacted by design. Never attach real memory content, real paths you consider sensitive, or secrets.

We aim to acknowledge reports within 7 days. This is an alpha project maintained on a best-effort basis; we will keep you updated on triage and coordinate disclosure with you before any public detail is released. Please give us reasonable time to ship a fix before publishing.

There is currently no bug bounty program.

## In scope (examples we care about most)

- Write-guard bypass: any way to create or modify durable memory without an explicit `promote`, or a durable write without `--real-write` / `realWrite: true`.
- Path traversal: reads or writes escaping the configured memory root or state root (CLI args, MCP tool inputs, candidate paths).
- Redaction failures: secrets, local paths, or memory content leaking through `doctor --share-diagnostics` or `feedback` output.
- `connect` damaging runtime configuration: clobbering or corrupting config files without a backup, or writing outside the documented targets.
- Audit integrity: promotes that do not produce audit events, or ways to tamper with `_events/` silently.
- Privacy contract violations: any data leaving the machine by default, or telemetry recording fields outside the documented allow-list.
- `reset` deleting data outside managed spaces.

## Out of scope

- Vulnerabilities in the connected AI runtimes themselves (Claude Code, Codex, Cursor) — report those upstream.
- Attacks requiring an already-compromised local user account or arbitrary local code execution.
- The hosted runtime: it is not part of this package or repository.
- Social engineering, physical access, and denial of service against your own local machine.

## Hardening notes for users

- Keep Node at or above 22.12 and update `ihow-memory` to the latest alpha before reporting.
- Use `connect --dry-run` to preview configuration changes; backups (`*.ihow-bak-*`) are written before direct config edits.
- Point agents at a demo space first; `reset` only removes managed spaces and refuses `--memory-root`.
