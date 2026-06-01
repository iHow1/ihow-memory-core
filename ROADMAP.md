# iHow Memory Core Roadmap

This roadmap documents the public maintenance work for `ihow-memory-core`, the reference implementation scaffold for the iHow Memory protocol conformance work.

## Current status

- Public repository: <https://github.com/iHow1/ihow-memory-core>
- License: Apache-2.0
- Current conformance smoke gate: `npm test`
- Current baseline: 5/5 local conformance scenarios pass for the reference runner.

## v0.1 maintenance goals

1. Keep the reference workspace initializer stable and reproducible.
2. Keep the event log schema small, local-first, and auditable.
3. Maintain the first five conformance scenarios:
   - S1 Cross-Tool Handoff
   - S2 Feedback Pattern Capture
   - S3 Constraint Preservation
   - S4 Human Team Handoff
   - S5 Model Migration
4. Publish small releases with clear evidence, not broad unverifiable claims.

## v0.2 planned work

- Add fixture-based regression tests for local-file boundary preservation.
- Add a machine-readable conformance result format for downstream projects.
- Add release automation that attaches conformance summaries to GitHub releases.
- Add example adapters for tool-assisted PR review and issue triage workflows.
- Document security boundaries for local-first memory directories.

## How Codex helps maintenance

Codex is useful for this project in narrowly scoped maintainer workflows:

- reviewing conformance runner changes before release;
- triaging issues into spec, reference implementation, docs, or security-boundary work;
- generating release notes from commits and conformance evidence;
- checking that examples do not overclaim protocol support;
- assisting with local-file security review and regression tests.

See also: `docs/codex-for-oss-maintainer-workload.md`.
