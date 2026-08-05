# Examples

Runnable, end-to-end walkthroughs for iHow Memory. Every command and output in these documents was executed against this repository; outputs use `<state-root>` as a placeholder for the throwaway directory, and your timestamps/UUIDs will differ.

## Prerequisites

- Node.js `>= 22.12` (the engine uses the built-in `node:sqlite`; check with `node --version`). Example 02 runs the full `doctor` check inside its sandbox. Note that running `doctor`/`status` without `--root` creates a workspace for the current directory under `~/.ihow-memory` — the examples always pass `--root` to avoid that.
- macOS or Linux
- One of:
  - a repository clone with `dist/` built (`npm run build` once), using `node bin/ihow-memory.mjs`, or
  - the published npm package, using `npx ihow-memory` instead.

## Safety

All examples are sandboxed by design:

- state lives in a fresh `mktemp -d` directory, never in `~/.ihow-memory`;
- no AI runtime configuration is modified unless you explicitly run the non-dry-run `connect` step in Example 02 (and that path makes a backup first);
- no network calls, no accounts, no telemetry.

## Index

| Example | What it shows | Time |
| --- | --- | --- |
| [01-five-minute-memory.md](./01-five-minute-memory.md) | The full governed loop with the CLI alone: init a demo space, write a candidate, promote it, search with citations, read back, confirm local-only status, inspect the audit trail. | ~5 min |
| [02-claude-code-mcp.md](./02-claude-code-mcp.md) | Wiring the stdio MCP server into Claude Code: `init` snippet, `connect --dry-run` preview, manual config alternative, in-session verification of the six `memory.*` tools, governance from the CLI, `doctor`, clean uninstall. | ~10 min |
| [03-two-agents-shared-memory.sh](./03-two-agents-shared-memory.sh) | Executable proof that two agents share one governed memory: agent A writes a candidate over MCP stdio, governance promotes it via the CLI, agent B finds and reads it back with a citation. Prints `PASS`/`FAIL`. | ~15 s |

## Running the script example

```bash
bash examples/03-two-agents-shared-memory.sh
```

The script is idempotent (fresh temp state per run, cleaned up on exit) and exits non-zero on failure. Set `KEEP_STATE_ROOT=1` to keep the temp directory for inspection.
