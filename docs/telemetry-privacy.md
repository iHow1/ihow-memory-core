# Metrics and Privacy Contract

This document is the product contract for the optional metrics subsystem. Code and tests must fail
closed if they disagree with it.

## Consent

- Metrics are off by default.
- Interactive setup or verified wiring may present one three-way choice: opt in, no send, or ask later.
  No choice is preselected.
- Noninteractive and `--json` execution never prompt and never save a consent decision.
- `ask later` writes nothing. `no send` saves only the disabled decision. Opt-in creates a random UUID
  installation identifier; it is not derived from a user, host, account, network, or hardware value.
- `ihow-memory telemetry off` removes queued events and the installation identifier. A later opt-in
  receives a new identifier.

## Allowed Data

Every queued or transmitted row uses schema version 1 and contains only:

- an allowlisted event name;
- the random installation identifier;
- an ISO timestamp;
- event-specific categorical `runtime` or `errorClass` values from fixed allowlists.

The event-name allowlist is:

```text
setup_completed
activation_completed
checkpoint_created
continue_attempted
continue_verified_green
continue_verified_yellow
continue_verified_red
active_week
upgrade_completed
error_class
```

Arbitrary caller properties are discarded before serialization. Memory content, prompts, queries,
file or directory paths, git data, user or host names, hardware or MAC identifiers, environment values,
free-form errors, and event payloads are not accepted. Synthetic checks, handler-started state, and
wiring/configuration state are not telemetry events.

## Event Semantics

- `setup_completed` is queued only after a successful non-dry setup and only when consent existed
  before that setup. A choice made by the post-setup prompt is not retroactive.
- `activation_completed` is reserved in the versioned schema and has no production producer in this
  candidate. The current managed Hook code does not emit or queue `activation_completed`.
- The workspace-frozen CLI and exact managed wiring can create bounded local `managed-hook` audit rows,
  but a same-OS-user process can replay that command and therefore cannot authenticate or attest the host.
  Such completion does not promote `doctor` to `ACTIVE`; it remains `READY — WAITING FOR FIRST ACTIVITY`
  with reason `ACTIVATION_COMPLETION_UNATTESTED`. A future producer requires a host provenance boundary
  that a direct bridge/CLI caller cannot reproduce, plus focused privacy and anti-forgery tests.
- Other allowlisted names are reserved schema contracts. Adding a producer requires focused tests that
  prove its trigger and privacy boundary; callers cannot introduce a new name dynamically.

## Storage and Transport

- Consent is stored in `~/.ihow-memory/telemetry.json`. Enabled events use a bounded local queue at
  `~/.ihow-memory/telemetry-queue.ndjson` (100 rows by default).
- Default-off recording creates or modifies no telemetry file and makes no network request.
- There is no built-in upload endpoint. Transport requires an explicitly configured HTTP(S) endpoint with
  no URL credentials, query string, or fragment. Recording never sends automatically: a user must run
  `ihow-memory telemetry flush` to attempt one batch.
- An explicit flush sends one bounded batch, requires a versioned acknowledgement for the full batch, and removes
  rows only after that acknowledgement. Timeouts, malformed responses, partial acknowledgements, and
  server errors retain the queue and apply bounded retry backoff.
- Telemetry failures are fail-open for setup, hooks, and the host runtime. They cannot become a product
  availability dependency.
