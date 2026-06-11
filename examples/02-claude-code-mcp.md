# Example 02 — Connect iHow Memory to Claude Code (MCP)

Goal: register the iHow Memory stdio MCP server in Claude Code, verify the six `memory.*` tools work from a Claude session, and run the governance steps (promote / durable-promote) from the CLI. Takes about ten minutes.

The MCP server is local stdio only: Claude Code launches it as a child process. No ports, no network, no account.

## Prerequisites

- Node.js `>= 22.12`, macOS or Linux
- Claude Code installed (the `claude` command)
- From a repository clone: `npm run build` once, then use `node bin/ihow-memory.mjs` as shown.
  With the npm package installed, replace `node bin/ihow-memory.mjs` with `npx ihow-memory`.

Outputs below are from a real run; `<state-root>` stands for the demo directory, and your timestamps/UUIDs will differ.

## Step 1 — Create a space and get the config snippet

For a disposable walkthrough, point `--root` at a temp directory. For a real setup, omit `--root` and the space lives under the default `~/.ihow-memory`.

```bash
export STATE_ROOT="$(mktemp -d)"
node bin/ihow-memory.mjs init --space demo --root "$STATE_ROOT" --runtime claude-code
```

Expected output:

```text
cloud: disabled / local only
initialized: <state-root>/demo
mode: managed-space
memory root: <state-root>/demo/memory
runtime bundle: <state-root>/demo/.runtime
backup first: Before editing Claude Code MCP settings, make a copy of the current settings file.

Claude Code MCP config snippet:
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

`init` copies a zero-dependency runtime bundle into `<state-root>/demo/.runtime`, so the server does not depend on an `npx` cache. `init` never edits Claude Code configuration — that is either your manual paste (Step 3B) or the explicit `connect` command (Step 3A).

## Step 2 — Smoke-test the server before touching Claude Code

The snippet is just a command line; you can run it yourself and speak MCP over stdin:

```bash
cd "$STATE_ROOT/demo/.runtime"
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node mcp/server.js --memory-root "$STATE_ROOT/demo/memory" --state-root "$STATE_ROOT"
cd -
```

The `id:1` response identifies the server (`"name":"ihow-memory-core","version":"0.1.0-alpha.2"`), and the `id:2` response lists exactly six tools:

```json
["memory.search","memory.read","memory.write_candidate","memory.promote","memory.durable_promote","memory.status"]
```

If this works, anything Claude Code does will work too.

## Step 3A — Automatic registration with `connect`

`connect` registers the server for you. Preview it first with `--dry-run` (no file is written, no backup is created):

```bash
node bin/ihow-memory.mjs connect --runtime claude-code --dry-run --space demo --root "$STATE_ROOT"
```

Real dry-run output on a machine where the `claude` CLI is on `PATH`:

```text
cloud: disabled / local only
[dry-run] would register mcpServers.ihow-memory via official-cli:claude (already present: true)
```

(`already present` reflects whether an `ihow-memory` entry is already registered — `false` on first connect.)

On a machine without the `claude` CLI, `connect` falls back to a safe merge of `~/.claude.json`:

```text
cloud: disabled / local only
[dry-run] would register mcpServers.ihow-memory via <home>/.claude.json
```

Add `--json` for machine-readable detail:

```json
{
  "ok": true,
  "runtime": "claude-code",
  "method": "direct-json",
  "target": "<home>/.claude.json",
  "backup": "",
  "dryRun": true,
  "existed": false
}
```

When the preview looks right, run it for real:

```bash
node bin/ihow-memory.mjs connect --runtime claude-code --space demo --root "$STATE_ROOT"
```

What this does, in order of preference:

1. If the `claude` CLI is available, it runs the official command (user scope):

   ```bash
   claude mcp add-json --scope user ihow-memory \
     '{"type":"stdio","command":"node","args":["<state-root>/demo/.runtime/mcp/server.js","--memory-root","<state-root>/demo/memory","--state-root","<state-root>"]}'
   ```

   Note the server path is absolute here, so no `cwd` is needed.

2. Otherwise it merges the same `mcpServers.ihow-memory` entry into `~/.claude.json`, after writing a timestamped backup (`~/.claude.json.ihow-bak-<ts>`). It refuses to touch a file it cannot parse as JSON.

In both paths an existing `ihow-memory` entry is replaced. After a real (non-dry-run) `connect`, the CLI also asks once whether you want to opt in to anonymous usage telemetry — it is off by default and stays off if you decline.

Then restart Claude Code so it launches the server.

## Step 3B — Manual registration (alternative)

If you prefer to edit config yourself, back up the target file first, then either:

- run the `claude mcp add-json` one-liner shown above, or
- paste the Step 1 snippet into a project-scope `.mcp.json` (or your user MCP settings). If your client ignores the `cwd` field, replace the relative `mcp/server.js` with the absolute path `<state-root>/demo/.runtime/mcp/server.js` — that is exactly what `connect` registers.

## Step 4 — Verify inside Claude Code

From a terminal:

```bash
claude mcp get ihow-memory
```

Expected shape after `connect`:

```text
ihow-memory:
  Scope: User config (available in all your projects)
  Status: ✓ Connected
  Type: stdio
  Command: node
  Args: <state-root>/demo/.runtime/mcp/server.js --memory-root <state-root>/demo/memory --state-root <state-root>

To remove this server, run: claude mcp remove "ihow-memory" -s user
```

Inside a Claude Code session:

1. Run `/mcp` — `ihow-memory` should be listed as connected with six tools.
2. Tool names are namespaced by Claude Code and dots become underscores: `memory.search` shows up as `mcp__ihow-memory__memory_search`, `memory.status` as `mcp__ihow-memory__memory_status`, and so on.
3. Try these prompts:

   - "Use the ihow-memory status tool and tell me whether cloud or sync is enabled." — the tool result ends with `"provider": {"id": "fts", ..., "cloud": false}` and `"sync": {"enabled": false}`.
   - "Store a memory candidate: 'MCP smoke test from snippet config. Marker: violet-pier-9.'" — Claude calls `memory.write_candidate` and the result is:

     ```json
     {
       "candidateId": "75f855f4-5dcf-4def-a4ba-db76ed32dbea",
       "path": "memory/_mcp/candidates/claude-code/20260611T085536Z-mcp-smoke.md",
       "status": "candidate"
     }
     ```

   - "Search the ihow memory for violet-pier-9 and quote the citation path." — `memory.search` returns the hit with `citation.path` pointing at that same file.

Where did `memory/_mcp/candidates/...` come from? When launched with `--memory-root` (as the generated snippet does), the server treats the memory directory as an existing memory root and applies the documented write boundary: agent candidates go under `memory/_mcp/candidates/<agent>/`, `memory.promote` stages under `memory/_mcp/promoted/`, and only an explicit `memory.durable_promote` with `realWrite: true` can append into real memory paths such as `memory/scopes/...`. Durable Markdown stays read-only by default.

## Step 5 — Govern what the agent proposed (from the CLI)

Promote the candidate Claude wrote. Use the same `--memory-root/--state-root` pair as the server so the CLI sees the same workspace mode:

```bash
node bin/ihow-memory.mjs promote \
  "memory/_mcp/candidates/claude-code/20260611T085536Z-mcp-smoke.md" \
  --memory-root "$STATE_ROOT/demo/memory" --state-root "$STATE_ROOT" \
  --scope notes --title mcp-smoke
```

Expected output (staging only — note the `_mcp/promoted` path):

```json
{
  "candidateId": "75f855f4-5dcf-4def-a4ba-db76ed32dbea",
  "path": "memory/_mcp/promoted/20260611T085625Z-mcp-smoke.md",
  "status": "promoted",
  "eventId": "c6124a44-6ca3-4c99-b040-2138b4864949"
}
```

For a durable write into `memory/scopes/`, use the explicit durable lane. Have Claude write one more candidate first (for example: "Store a memory candidate: 'Team decision: use feature flags for risky rollouts. Marker: cedar-lock-31.'"), then promote it durably using the `path` from that tool result:

```bash
node bin/ihow-memory.mjs durable-promote \
  "memory/_mcp/candidates/claude-code/20260611T085743Z-feature-flag-decision.md" \
  --real-write --scope decisions --title feature-flags \
  --memory-root "$STATE_ROOT/demo/memory" --state-root "$STATE_ROOT"
```

(Replace the candidate path with the one from your session.)

Expected output (trimmed):

```json
{
  "candidateId": "520bb388-6eec-49d2-bdaa-a97243a243ff",
  "status": "promoted",
  "dryRun": false,
  "eventId": "e555e060-a3d1-4c04-ac29-1f26f06a5662",
  "path": "memory/scopes/decisions/20260611T085743Z-feature-flags.md",
  "archivedCandidatePath": "memory/_mcp/history/promoted-candidates/20260611T085743Z-feature-flag-decision.md",
  "proof": {
    "explicitDurableTrigger": true,
    "sourceCandidateInboxOnly": true,
    "protectedCoreBlocked": true,
    "targetWhitelistEnforced": true,
    "redactCheck": "passed",
    "dryRunNoWrites": false
  }
}
```

Back in Claude Code, "read memory/scopes/decisions/20260611T085743Z-feature-flags.md from ihow memory" returns the exact content plus a citation — the loop is closed: agent proposed, you governed, agents can now cite it.

## Step 6 — Doctor

```bash
node bin/ihow-memory.mjs doctor --runtime claude-code --space demo --root "$STATE_ROOT"
```

Expected output:

```text
doctor: ok
cloud: disabled / local only
- ok node: v24.14.1
- ok sqlite: node:sqlite DatabaseSync available
- ok memory-root: <state-root>/demo/memory
- ok runtime: Claude Code selected
  hint: Run ihow-memory init --runtime claude-code and paste the snippet into Claude Code after backing up existing config.
- ok engine: active=fts ready=true
- ok vector: not configured requested=fts
- ok index-manifest: <state-root>/demo/index-manifest.json
- ok cloud: disabled / local only
```

Exit code is 0 when all required checks pass. Add `--share-diagnostics` for a redacted JSON report (paths replaced with placeholders, secrets redacted, memory content omitted) suitable for a GitHub issue.

## Step 7 — Undo everything

```bash
claude mcp remove "ihow-memory" -s user          # or restore your ~/.claude.json.ihow-bak-<ts> backup
node bin/ihow-memory.mjs reset --space demo --root "$STATE_ROOT"
rm -rf "$STATE_ROOT"
```

Restart Claude Code afterwards so the tools disappear.
