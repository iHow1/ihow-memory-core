<div align="center">

# iHow Memory Core

### Reference implementation scaffold for testing whether agent memory survives handoff

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Spec: iHow Memory Standard](https://img.shields.io/badge/spec-ihow--memory--standard-brightgreen.svg)](https://github.com/iHow1/ihow-memory-standard)

[中文](./README.zh-CN.md) · [Spec](https://github.com/iHow1/ihow-memory-standard) · [Protocol](https://github.com/iHow1/ihow-memory-standard/blob/main/spec/protocol-draft-v0.1.md) · [Scenarios](https://github.com/iHow1/ihow-memory-standard/blob/main/scenarios/reliability-scenarios-v0.1.md)

</div>

iHow Memory Core is an implementation repo for the public iHow Memory Standard. It provides local-first tools that produce protocol-shaped events, handoff samples, and self-conformance checks.

The spec source of truth is [`iHow1/ihow-memory-standard`](https://github.com/iHow1/ihow-memory-standard). This repo is code: CLI, local adapter audit logging, deploy shell, and conformance runners.

## What This Repo Includes

- `bin/ihow-memory`: local CLI scaffold.
- `tools/ihow-memory/event-log.sh`: append-only local audit log with protocol v0.1 event mapping.
- `deploy/local-pilot/`: secure local deploy shell for a static pilot Console.
- `conformance/runners/ihow-memory/`: self-runner for the five public reliability scenarios.

## Quick Start

```bash
npm exec --package . -- ihow-memory init /tmp/ihow-memory-demo --force
```

The generated workspace includes:

- `memory/recent/latest.md`
- `memory/_events/<today>.ndjson`
- `memory/scopes/project/sample.md`
- `memory/inbox/`
- `console/index.html`
- `conformance-samples/`

Run self-conformance:

```bash
npm run test:conformance
```

Expected result: `5/5 PASS`.

## Relationship to the Standard Repo

`ihow-memory-standard` defines the protocol draft and reliability scenarios. This repo implements a local scaffold that can be tested against those scenarios.

The protocol draft defines four interface semantics:

- `events`: workflow event ingestion
- `context`: bounded context package retrieval
- `writeback`: proposed durable memory and review
- `audit`: traceability and lifecycle control

The scenario set defines five acceptance-style tests:

1. Cross-Tool Handoff
2. Feedback Pattern Capture
3. Constraint Preservation
4. Human Team Handoff
5. Model Migration

## Local Deploy Shell

The local pilot compose file is a deploy shell, not the protocol sidecar API:

```bash
cd deploy/local-pilot
docker compose up -d
open http://127.0.0.1:8787
```

It serves a localhost-only static Console and mounts local files. It does not expose `/memory/events`, `/memory/context`, `/memory/writeback`, `/memory/pending`, or `/memory/audit`.

## Security Boundary

- Use synthetic data for public fixtures and conformance samples.
- Do not commit non-public project memory, customer material, tokens, keys, credentials, or account data.
- Keep customer deployment material outside this public repo unless Commander explicitly classifies it as public-safe.

## License

Apache-2.0. See [LICENSE](./LICENSE).
