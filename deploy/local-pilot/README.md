# Local Pilot Deploy Shell

This directory is a secure local deploy shell for a local pilot deployment. It runs a localhost-only static Console and mounts a local `memory/` directory as the file truth source.

It does not expose the iHow Memory protocol API. It is not the sidecar service.

## Responsibilities

- Provide a 5-minute local startup path.
- Keep pilot data on the customer machine.
- Make ports, volumes, network, and sandboxing easy to audit.
- Serve the static Console from `console/`.
- Mount local pilot state from `memory/`.

## Non-Goals

- No `/memory/events` API.
- No `/memory/context` API.
- No `/memory/writeback` API.
- No `/memory/pending` API.
- No `/memory/audit` API.
- No commercial module or hosted service dependency.

## Protocol API Candidate

The protocol sidecar candidate is maintained separately in private deployment material outside this public repo. This directory only hosts the localhost-only static Console deploy shell.

## Local Run

```bash
cd deploy/local-pilot
docker compose up -d
open http://127.0.0.1:8787
```

Defaults:

- host bind: `127.0.0.1`
- host port: `8787`
- container image: `nginx:1.27-alpine`
- memory mount: `./memory -> /data/ihow-memory`

To expose the pilot on a LAN, set `IHOW_CONSOLE_BIND=0.0.0.0` only after the customer network owner explicitly approves it.
