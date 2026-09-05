# Security Policy

iHow Memory is a local-first memory layer for AI agents. Its security promises are concrete: engine-governed writes and recall eligibility, strict write boundaries around existing memory roots, redacted diagnostics, and no default network surface. Reports that break any of those promises are exactly what we want to hear about.

## Supported versions

| Version | Supported |
| --- | --- |
| Latest published stable `0.1.x` release (`latest`) | Yes |
| Latest published prerelease (`next`) | Yes — prerelease evidence boundaries apply |
| Older releases and prereleases | No — please reproduce on the latest version in the affected channel |

## How to report a vulnerability

**Please do not open a public issue for vulnerabilities.**

Report privately via GitHub Security Advisories:

1. Go to <https://github.com/iHow1/ihow-memory-core/security/advisories/new> (the "Report a vulnerability" button on the repository's Security tab).
2. Include: affected version (`npx ihow-memory --version`), OS, Node version, reproduction steps, and impact.
3. If diagnostics help, attach the output of `npx ihow-memory doctor --share-diagnostics` — it is redacted by design. Never attach real memory content, real paths you consider sensitive, or secrets.

We aim to acknowledge reports within 7 days. This project is maintained on a best-effort basis; we will keep you updated on triage and coordinate disclosure with you before any public detail is released. Please give us reasonable time to ship a fix before publishing. A stable `0.1.x` package is not a `1.0` API compatibility guarantee or production security certification.

There is currently no bug bounty program.

## Governed persistence and recall

`memory.write_candidate` enables automatic promotion by default. Persistence is not a claim that the content is true, human-reviewed, or eligible for automatic recall:

- Detected secret-like content and claimed anchors that conflict with an explicitly identified live repository are rejected by the automatic promotion gate. Secret detection is pattern-based, not a guarantee of detecting every possible credential.
- Non-directive content with qualifying provenance becomes durable `verified` memory. A live Git anchor is checked against the repository; a `command` + `exitCode` pair is structured, self-reported evidence, not a command the engine re-executes or proof that the prose is true.
- Content without qualifying provenance becomes durable `unverified` memory, never `verified` merely because the caller supplied `verified: true`. Relevant soft facts may be recalled under the prompt-recall policy; unreviewed status or bypass claims remain excluded.
- Governance, access, identity, and destructive statements become durable `flagged` memory. They are excluded from default search and automatic prompt recall pending review. Explicit `includeFlagged` search or a direct read can inspect them without granting recall eligibility.

Use `autoPromote: false` to stage an inbox candidate for explicit promotion. `memory.promote` is the explicit review path. The separate `memory.durable_promote` operation requires an explicit preview or real-write choice; `realWrite: true` / `--real-write` is required for its real writes, not for every ordinary memory write. The automatic journal lane also persists bounded, low-weight entries without a manual promotion step.

Filesystem containment, secret handling, tier assignment, recall eligibility, and audit records remain enforced on their respective paths. Human confirmation for review actions is a host/operator responsibility, not cryptographic proof of a human decision; a caller running as the same OS user is within the local trust boundary.

## In scope (examples we care about most)

- Write-guard or recall-policy bypass: writes escaping the applicable containment, secret-handling, tier, or audit controls; automatic recall of quarantined `flagged` content; or real writes through `memory.durable_promote` without its explicit real-write option. Engine-governed automatic promotion and low-weight journaling are intentional, not bypasses solely because no manual `promote` occurred.
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

- Keep Node at or above 22.12 and update `ihow-memory` to the latest supported version in the affected channel before reporting.
- Use `connect --dry-run` to preview configuration changes; backups (`*.ihow-bak-*`) are written before direct config edits.
- Point agents at a demo space first; `reset` only removes managed spaces and refuses `--memory-root`.
