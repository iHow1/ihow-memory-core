---
type: spec
version: v0
status: draft
created_at: 2026-05-21T19:58:00+08:00
owner: codex
---

# iHow Memory Event Log Schema v0

## Purpose

The event log is the append-only audit trail for iHow Memory. It records what a runtime did to the local memory truth source, without storing private source content.

Default location:

```text
memory/_events/YYYY-MM-DD.ndjson
```

Each line is one JSON object. Writers append a single line per event and never rewrite previous lines.

## Required Fields

```json
{
  "schema_version": "ihow.events.v0",
  "event_id": "uuid",
  "ts": "2026-05-21T19:58:00+08:00",
  "runtime": "codex",
  "op": "write",
  "anchor": "memory/recent/latest.md",
  "hash_before": null,
  "hash_after": "sha256-or-null",
  "source_session": "agent:main:main",
  "extra": {},
  "protocol_event": {
    "event_id": "evt_01",
    "namespace": {
      "tenant_id": "local",
      "customer_id": "local",
      "project_id": "project_01",
      "user_id": "operator"
    },
    "event_type": "handoff",
    "actor": {
      "type": "agent",
      "name": "Codex"
    },
    "occurred_at": "2026-05-21T19:58:00+08:00",
    "summary": "A short factual summary of what happened.",
    "source": {
      "kind": "file",
      "uri": "memory/recent/latest.md",
      "reference": "memory/recent/latest.md"
    },
    "sensitivity": "normal",
    "metadata": {
      "anchor": "memory/recent/latest.md",
      "local_op": "handoff"
    }
  }
}
```

Field notes:

- `schema_version`: fixed to `ihow.events.v0` for this draft.
- `event_id`: globally unique event id.
- `ts`: local timezone ISO8601 timestamp.
- `runtime`: runtime or adapter name, for example `openclaw`, `codex`, `claude-code`.
- `op`: operation name. Core ops are `read`, `write`, `commit`, `handoff`, `rollback`, `restore`, and `init`; third-party runtimes may add custom ops.
- `anchor`: workspace-relative file path or named anchor. Absolute paths are only accepted by tooling when they resolve inside the workspace and are normalized to relative paths.
- `hash_before`: sha256 of the previous anchor content, or `null`.
- `hash_after`: sha256 of the new anchor content, or `null`.
- `source_session`: runtime-specific session id, or `null`.
- `extra`: op-specific JSON object. Keep it small and avoid raw source content.
- `protocol_event`: protocol v0.1 Event Object mapping for conformance-facing readers.

## Protocol v0.1 Mapping

The local audit schema stays stable for adapter diagnostics, while `protocol_event` exposes the public protocol-shaped event.

Mapping rules:

- local `op` -> protocol `event_type`
- local `anchor` -> protocol `source.uri`, `source.reference`, and `metadata.anchor`
- local `ts` -> protocol `occurred_at`
- local `runtime` -> protocol `actor.name` by default
- local `hash_before`, `hash_after`, `source_session`, and `extra` -> protocol `metadata`

Required protocol fields emitted by `event-log.sh`:

- `namespace.project_id`
- `event_type`
- `actor`
- `occurred_at`
- `summary`
- `source`
- `sensitivity`
- `metadata.anchor`

## Privacy Rules

Events must not contain secrets, tokens, keys, passwords, cookies, account credentials, or raw customer data.

Allowed:

- relative paths
- hashes
- task ids
- short human-readable reasons
- artifact names
- non-sensitive runtime/session ids

Not allowed:

- token or API key values
- passwords or cookies
- full customer source text
- private account lists
- credentials embedded in URLs

`tools/ihow-memory/event-log.sh` performs a conservative redact-check before appending.

## Writer Contract

Use the local helper:

```bash
tools/ihow-memory/event-log.sh \
  --runtime codex \
  --op handoff \
  --anchor memory/recent/latest.md \
  --project-id ihow-memory-core \
  --actor-name Codex \
  --summary 'Mapped local audit entry to a protocol v0.1 handoff event.' \
  --source-session agent:main:main \
  --extra-json '{"reason":"updated latest handoff checkpoint"}'
```

The helper:

- creates `memory/_events/` if missing
- appends to today's NDJSON file by default
- computes `hash_after` automatically when `anchor` is a regular file
- rejects anchors escaping the workspace root
- validates `extra` as a JSON object
- emits a nested `protocol_event` object with protocol v0.1 field names
- runs redact-check before writing

## Health Check

`tools/ihow-memory/check-writeback-consistency.sh` treats `memory/_events/<today>.ndjson` as a required anchor once event logging is enabled.

For W1, health means:

1. The event file exists.
2. It is non-empty.
3. Every line parses as JSON.
4. Every event has `schema_version = ihow.events.v0`.
