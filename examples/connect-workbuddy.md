# Connect iHow Memory to Tencent WorkBuddy (via MCP)

WorkBuddy (Tencent CodeBuddy's desktop AI agent) speaks the Model Context Protocol, so it can use iHow Memory as a governed, local, cross-tool memory layer — the same memory your Claude Code / Codex / Cursor sessions write to.

> One-command `connect` supports WorkBuddy. Current WorkBuddy/CodeBuddy CLI builds store
> user-scope MCP servers in `~/.workbuddy/.mcp.json`, so `connect` writes there directly
> with a backup, preserving every existing server. Project-local MCP configuration remains
> owned by WorkBuddy and is not modified by this user-scope command.

## Prerequisites

- Node.js `>= 22.12` (Windows users: run inside **WSL**, which is Linux and fully supported)
- WorkBuddy installed
- A writable local directory

## 1. One command

```bash
npx ihow-memory connect --runtime workbuddy
```

This:

- provisions a managed memory workspace under `~/.ihow-memory/`,
- upserts an `ihow-memory` entry into `~/.workbuddy/.mcp.json` (stdio, absolute `node` path),
- **backs up** the existing file first and **preserves** every other MCP server you already have,
- never touches WorkBuddy's connector marketplace files or `mcp-approvals.json`.

Preview without writing:

```bash
npx ihow-memory connect --runtime workbuddy --dry-run
```

Then **restart WorkBuddy** so it loads the new server. If WorkBuddy asks you to approve the MCP server on first use, approve it in its UI (that's WorkBuddy's own security step).

## 2. Verify

In WorkBuddy, ask the agent something that exercises memory, e.g.:

> "Save a candidate note that we use pnpm, then search memory for pnpm."

The agent should call `memory.write_candidate` then `memory.search`. You can also confirm from your shell:

```bash
npx ihow-memory console --space <your-space>   # read-only local UI: status, search, audit
```

(`connect` derives the space from the current directory unless you pass `--space`.)

## MCP tools WorkBuddy will see

`memory.search` · `memory.read` · `memory.write_candidate` · `memory.promote` · `memory.durable_promote` · `memory.status`

Writes are governed: the agent only **proposes** (`write_candidate`); promotion to durable memory is an explicit, audited step. Nothing is remembered without your say-so.

## Manual alternative

If you prefer to edit config by hand, `npx ihow-memory init` prints a generic MCP snippet. Add it to `~/.workbuddy/.mcp.json` under `mcpServers` for the current user. If you intentionally use a project-local WorkBuddy configuration, follow that WorkBuddy version's own project-scope documentation instead of copying the user path:

```json
{
  "mcpServers": {
    "ihow-memory": {
      "type": "stdio",
      "command": "<absolute-path-to-node>",
      "args": [
        "<home>/.ihow-memory/<space>/.runtime/mcp/server.js",
        "--memory-root", "<home>/.ihow-memory/<space>/memory",
        "--state-root", "<home>/.ihow-memory"
      ]
    }
  }
}
```

Use an **absolute** `node` path — WorkBuddy's GUI launch context may not have a complete `PATH`.

## Notes

- Local-first: no account, no API key, no required network calls; cloud and sync are disabled.
- Same `--space` across tools = shared memory. Point Claude Code / Codex / Cursor / WorkBuddy at the same space and they read each other's promoted memory.
- Windows: use WSL until native Windows lands.
