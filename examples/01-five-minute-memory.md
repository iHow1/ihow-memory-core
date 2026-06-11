# Example 01 — Five-Minute Memory (CLI end to end)

Goal: in about five minutes, run the full governed memory loop locally with the CLI alone — no MCP client, no network, no account:

```text
init a demo space
-> write a candidate (sandbox inbox)
-> promote it (governance + audit event)
-> search hits it (with citation)
-> read it back (exact content + citation)
-> status confirms local-only
```

Everything happens inside a throwaway directory created with `mktemp -d`. Nothing touches `~/.ihow-memory` or any AI runtime configuration.

## Prerequisites

- Node.js `>= 22.12` (needs the built-in `node:sqlite`)
- macOS or Linux
- From a repository clone: run `npm run build` once so `dist/` exists, then use `node bin/ihow-memory.mjs` as shown below.
  If you installed the npm package instead, replace `node bin/ihow-memory.mjs` with `npx ihow-memory` everywhere.

All commands below are run from the repository root. Outputs were captured from a real run; your timestamps, UUIDs, and absolute paths will differ. The throwaway directory is shown as `<state-root>`.

## Step 1 — Create a demo space

```bash
export STATE_ROOT="$(mktemp -d)"
node bin/ihow-memory.mjs init --space demo --root "$STATE_ROOT"
```

Expected output:

```text
cloud: disabled / local only
initialized: <state-root>/demo
mode: managed-space
memory root: <state-root>/demo/memory
runtime bundle: <state-root>/demo/.runtime
backup first: Before writing this snippet into any runtime config, back up the existing config file.

generic MCP client MCP config snippet:
{
  "mcpServers": {
    "ihow-memory": {
      "command": "node",
      "args": [
        "mcp/server.js",
        "--memory-root",
        "<state-root>/demo/memory",
        "--state-root",
        "<state-root>"
      ],
      "cwd": "<state-root>/demo/.runtime"
    }
  }
}
```

The MCP snippet is for wiring an AI runtime — that is [Example 02](./02-claude-code-mcp.md). This example stays on the CLI.

## Step 2 — Write a candidate

Agents (and the CLI) never write durable memory directly. They propose a *candidate* into a sandbox inbox. The extra two lines capture the returned path into `$CAND_PATH` so every later step is copy-pasteable:

```bash
CAND_JSON="$(node bin/ihow-memory.mjs write-candidate \
  "Prefer rg over grep in this repo. Marker: teal-harbor-042." \
  --space demo --root "$STATE_ROOT")"
echo "$CAND_JSON"
CAND_PATH="$(echo "$CAND_JSON" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).path")"
```

Expected output:

```json
{
  "candidateId": "93501df3-db60-40ad-9fcf-64b71af3a9f5",
  "path": "memory/candidate/inbox/20260611T085142Z-93501df3-db60-40ad-9fcf-64b71af3a9f5.md",
  "status": "candidate"
}
```

Two things worth knowing:

- Candidates are **not searchable** until promoted (the inbox is excluded from the index).
- Candidates that look like they contain secrets are rejected. For example:

  ```bash
  node bin/ihow-memory.mjs write-candidate "my api_key=abc123 don't tell anyone" \
    --space demo --root "$STATE_ROOT"
  ```

  ```text
  candidate_contains_secret_like_content
  ```

  (exit code 1, nothing written)

## Step 3 — Promote the candidate

Promotion is the governance step: it moves the candidate into a named scope, archives the original inbox file, and appends an audit event.

```bash
PROMOTE_JSON="$(node bin/ihow-memory.mjs promote "$CAND_PATH" \
  --space demo --root "$STATE_ROOT" \
  --scope conventions --title prefer-rg)"
echo "$PROMOTE_JSON"
MEM_PATH="$(echo "$PROMOTE_JSON" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).path")"
```

Expected output:

```json
{
  "candidateId": "93501df3-db60-40ad-9fcf-64b71af3a9f5",
  "path": "memory/scopes/conventions/20260611T085151Z-prefer-rg.md",
  "status": "promoted",
  "eventId": "7213d889-5404-4768-80d0-fcc158cb3682"
}
```

## Step 4 — Search (and get a citation)

```bash
node bin/ihow-memory.mjs search "teal-harbor-042" --space demo --root "$STATE_ROOT"
```

Expected output:

```json
[
  {
    "path": "memory/scopes/conventions/20260611T085151Z-prefer-rg.md",
    "snippet": "...at: \"2026-06-11T08:51:42.561Z\"\n---\n\n# Candidate 93501df3-db60-40ad-9fcf-64b71af3a9f5\n\nPrefer rg over grep in this repo. Marker: [teal-harbor-042].\n",
    "score": -0.000001,
    "source": "fts",
    "citation": {
      "path": "memory/scopes/conventions/20260611T085151Z-prefer-rg.md",
      "snippet": "...at: \"2026-06-11T08:51:42.561Z\"\n---\n\n# Candidate 93501df3-db60-40ad-9fcf-64b71af3a9f5\n\nPrefer rg over grep in this repo. Marker: [teal-harbor-042].\n"
    }
  }
]
```

Every hit carries a `citation` with the exact file path and a snippet — answers are traceable to a Markdown file on your disk. `source: "fts"` means the zero-dependency SQLite FTS5 engine served the query.

## Step 5 — Read the cited file

```bash
node bin/ihow-memory.mjs read "$MEM_PATH" --space demo --root "$STATE_ROOT"
```

Expected output (trimmed):

```json
{
  "path": "memory/scopes/conventions/20260611T085151Z-prefer-rg.md",
  "content": "---\npromoted_at: \"2026-06-11T08:51:51.225Z\"\ntype: \"memory\"\ncandidate_id: \"93501df3-db60-40ad-9fcf-64b71af3a9f5\"\nstatus: \"promoted\"\nsource_agent: \"cli\"\ncreated_at: \"2026-06-11T08:51:42.561Z\"\n---\n\n# Candidate 93501df3-db60-40ad-9fcf-64b71af3a9f5\n\nPrefer rg over grep in this repo. Marker: teal-harbor-042.\n",
  "source": "markdown",
  "citation": {
    "path": "memory/scopes/conventions/20260611T085151Z-prefer-rg.md",
    "snippet": "--- promoted_at: \"2026-06-11T08:51:51.225Z\" type: \"memory\" ... Marker: teal-harbor-..."
  }
}
```

The original marker text is back, with front matter showing the full provenance chain: `candidate_id`, `source_agent`, `created_at`, `promoted_at`.

## Step 6 — Status: local-only proof

```bash
node bin/ihow-memory.mjs status --space demo --root "$STATE_ROOT"
```

Expected output:

```text
workspace: <state-root>/demo
space: demo
mode: managed-space
memory root: <state-root>/demo/memory
provider: fts (ready=true, cloud=false, model=null)
index: ready, documents=1
index path: <state-root>/demo/index.sqlite
sync: enabled=false
```

`cloud=false` and `sync: enabled=false` — nothing leaves the machine.

## Step 7 — Inspect the audit trail

Every write and promote appends to an NDJSON event log:

```bash
cat "$STATE_ROOT"/demo/memory/_events/*.ndjson
```

Expected output (one JSON object per line; reformatted here for readability):

```json
{"id":"67c7d83a-...","at":"2026-06-11T08:51:42.562Z","type":"candidate.created","path":"memory/candidate/inbox/20260611T085142Z-....md","actor":"cli","metadata":{"candidateId":"93501df3-...","status":"candidate"}}
{"id":"7213d889-...","at":"2026-06-11T08:51:51.225Z","type":"memory.promoted","candidatePath":"memory/candidate/inbox/20260611T085142Z-....md","targetPath":"memory/scopes/conventions/20260611T085151Z-prefer-rg.md","actor":"core.promote","metadata":{"candidateId":"93501df3-...","target":{"scope":"conventions","title":"prefer-rg"},"stagingOnly":false,"targetMemoryPath":"scopes/conventions/20260611T085151Z-prefer-rg.md"}}
```

## Going further: durable promote with an explicit dry run

`promote` writes into the managed space. For the stricter lane — appending into durable memory paths with a write whitelist and redact check — use `durable-promote`, which refuses to run unless you pass exactly one of `--dry-run` or `--real-write`:

```bash
CAND2_PATH="$(node bin/ihow-memory.mjs write-candidate \
  "Durable note: deploy checklist lives in scopes. Marker: amber-quay-7." \
  --space demo --root "$STATE_ROOT" \
  | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).path")"
node bin/ihow-memory.mjs durable-promote "$CAND2_PATH" \
  --dry-run --scope ops --title deploy-checklist \
  --space demo --root "$STATE_ROOT"
```

Expected output (trimmed — the full plan includes the exact append content and audit event):

```json
{
  "candidateId": "c540ac67-d727-41ef-b22f-7bdcadc50443",
  "status": "dry-run",
  "dryRun": true,
  "plan": {
    "targetPath": "memory/scopes/ops/20260611T085347Z-deploy-checklist.md",
    "operation": "append",
    "writeGuards": [
      "explicit-durable-promote-call",
      "candidate-inbox-source-only",
      "protected-core-blocked",
      "target-whitelist-enforced",
      "redact-check-before-write",
      "withWorkspaceLock",
      "atomicWriteFile-for-real-write",
      "dry-run-no-write"
    ]
  },
  "proof": {
    "redactCheck": "passed",
    "dryRunNoWrites": true
  }
}
```

Re-run with `--real-write` instead of `--dry-run` to apply exactly that plan.

## Step 8 — Clean up

```bash
node bin/ihow-memory.mjs reset --space demo --root "$STATE_ROOT"
rm -rf "$STATE_ROOT"
```

Expected output:

```text
reset complete: demo
removed demo workspace: <state-root>/demo
```

`reset` only removes managed demo spaces; it requires an explicit `--space` and refuses `--memory-root`, so it can never delete an existing shared memory root.

## Next steps

- [Example 02](./02-claude-code-mcp.md) — connect this memory to Claude Code over MCP.
- [Example 03](./03-two-agents-shared-memory.sh) — scripted proof of two agents sharing one governed space.
