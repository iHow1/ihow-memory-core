# Codex for Open Source Maintainer Workload

This document summarizes why `ihow-memory-core` is applying for maintainer support and how Codex would be used for core open-source work.

## Repository

- Repository: <https://github.com/iHow1/ihow-memory-core>
- Role: reference implementation scaffold for iHow Memory protocol conformance
- License: Apache-2.0
- Maintainer: iHow1

## Maintainer responsibilities

The current maintainer workload is not driven by a large issue queue yet. It is driven by the need to keep a new reliability-focused OSS project honest, reproducible, and safe:

1. **Conformance review** — changes to scenarios and runners must not silently overclaim protocol support.
2. **Release evidence** — every release should include what was tested, what passed, and what remains partial or out of scope.
3. **Issue triage** — incoming feedback needs routing across spec, core implementation, docs, examples, and security boundaries.
4. **Local-first security review** — file-backed memory workflows must avoid path traversal, symlink escape, and accidental private-data exposure.
5. **Documentation upkeep** — docs must stay clear for OSS maintainers without turning draft evidence into marketing claims.

## Planned Codex usage

Codex support would be used for:

- PR review assistance for conformance runner changes;
- issue triage summaries and label suggestions;
- release workflow automation and changelog drafting;
- local-file security test generation;
- documentation review for overclaiming or unclear maintenance boundaries;
- small adapter examples for maintainers using multiple AI tools in review workflows.

## Boundaries

We will not use Codex support to fabricate adoption claims. Current public adoption is early. The support request is based on the project’s maintainer relevance and the growing OSS problem of AI-assisted workflows losing context across tools, sessions, and agents.
