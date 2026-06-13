# Connect iHow Memory to Tencent WorkBuddy (via MCP)

WorkBuddy (Tencent CodeBuddy's desktop AI agent) speaks the Model Context Protocol, so it can use iHow Memory as a governed, local, cross-tool memory layer — the same memory your Claude Code / Codex / Cursor sessions write to.

> Status: WorkBuddy is not yet a one-command `connect` target. This is the manual path using iHow Memory's generic MCP snippet. It works today.
>
> One open item being confirmed: whether WorkBuddy accepts **stdio** MCP servers (a local `node` command, which is what iHow Memory ships) or only **remote URL** MCP servers. If your WorkBuddy only accepts a URL, see "If WorkBuddy needs a URL" at the bottom.

## Prerequisites

- Node.js `>= 22.12` (Windows users: run inside **WSL**, which is Linux and fully supported)
- WorkBuddy installed
- A writable local directory

## 1. Provision a memory workspace and get the MCP snippet

```bash
npx ihow-memory init --space workbuddy
```

`init` prints a **generic MCP client** config snippet. It looks like this (your paths will be under `~/.ihow-memory/workbuddy/`):

```json
{
  "mcpServers": {
    "ihow-memory": {
      "command": "node",
      "args": [
        "mcp/server.js",
        "--memory-root", "<home>/.ihow-memory/workbuddy/memory",
        "--state-root", "<home>/.ihow-memory"
      ],
      "cwd": "<home>/.ihow-memory/workbuddy/.runtime"
    }
  }
}
```

Copy the exact values that **your** `init` printed — don't hand-type the paths.

## 2. Add it as a custom MCP server in WorkBuddy

In WorkBuddy, open the agent's **technical/MCP settings** (where you add 技能 / 专家 / MCP), choose **add a custom MCP server**, and fill in the fields from the snippet:

- **Name:** `ihow-memory`
- **Command:** `node`
- **Args:** `mcp/server.js`, `--memory-root`, `<your memory path>`, `--state-root`, `<your state path>`
- **Working directory (cwd):** `<your .runtime path>`

Then **save / publish** (WorkBuddy merges connectors into the agent's manifest on publish).

> Exact menu labels follow your installed WorkBuddy version. If WorkBuddy expects a single JSON blob instead of separate fields, paste the whole `mcpServers` object above.

## 3. Verify

In WorkBuddy, ask the agent something that exercises memory, e.g.:

> "Save a candidate note that we use pnpm, then search memory for pnpm."

The agent should call `memory.write_candidate` then `memory.search`. You can also confirm from your shell:

```bash
npx ihow-memory console --space workbuddy   # read-only local UI: status, search, audit
```

## MCP tools WorkBuddy will see

`memory.search` · `memory.read` · `memory.write_candidate` · `memory.promote` · `memory.durable_promote` · `memory.status`

Writes are governed: the agent only **proposes** (`write_candidate`); promotion to durable memory is an explicit, audited step. Nothing is remembered without your say-so.

## If WorkBuddy needs a URL (remote MCP only)

If your WorkBuddy only accepts a remote MCP endpoint (a URL) and not a local `node` command, iHow Memory's stdio server can't be added directly. Track this guide for an HTTP/SSE bridge, or use a WorkBuddy build that supports local (stdio) MCP servers. (We're confirming WorkBuddy's stdio support; this section will be updated.)

## Notes

- Local-first: no account, no API key, no required network calls; cloud and sync are disabled.
- Same `--space` across tools = shared memory. Point Claude Code / Codex / Cursor / WorkBuddy at `--space workbuddy` (or any shared name) and they read each other's promoted memory.
- Windows: use WSL until native Windows `connect` lands.
