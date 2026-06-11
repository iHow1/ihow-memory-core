# iHow Memory

Local-first shared memory for AI agents. The alpha core stores Markdown locally, indexes it with Node's built-in SQLite FTS5, returns citations, and exposes the same governed memory flow through CLI and stdio MCP.

- No account
- No telemetry
- No required network calls
- No embedding model or API key required
- Cloud and sync are disabled by default

> Alpha software. Back up runtime configuration before editing it, and use a demo space until you have reviewed the local file layout.

## 2-Minute Quickstart

Requirements:

- Node.js `>=22.12`
- macOS or Linux for the current alpha validation lane
- A writable local directory

### 1. Inspect and initialize

During repository development:

```bash
git clone https://github.com/iHow1/ihow-memory-core.git
cd ihow-memory-core
npm run cli -- doctor
npm run cli -- init --space demo --runtime codex
```

After the npm package is published:

```bash
npx ihow-memory init --space demo --runtime codex
```

Use one of:

```bash
ihow-memory init --space demo --runtime claude-code
ihow-memory init --space demo --runtime codex
ihow-memory init --space demo --runtime cursor
```

`init` creates a local managed workspace and prints the matching MCP configuration snippet. It does not edit runtime configuration automatically.
It also copies the small zero-dependency JavaScript runtime into `<state-root>/<space>/.runtime/`, so the MCP configuration does not depend on an `npx` cache directory.

Before pasting the snippet:

1. Back up the existing runtime configuration file.
2. Paste the generated snippet.
3. Restart or reload the runtime.
4. Run `ihow-memory doctor --runtime <runtime>` again.

### 2. Run the local proof

```bash
ihow-memory proof --space demo-proof
```

Expected flow:

```text
agent A write candidate
-> governed promote
-> agent B search/read
-> citation
-> audit event
-> cloud disabled / local only
```

### 3. Connect an AI runtime

The generated snippet starts:

```text
node mcp/server.js
```

with `cwd` set to:

```text
<state-root>/<space>/.runtime
```

Available MCP tools:

- `memory.search`
- `memory.read`
- `memory.write_candidate`
- `memory.promote`
- `memory.durable_promote`
- `memory.status`

### 4. Verify the result

Ask runtime A to write a non-sensitive candidate. Ask runtime B to search for the marker and read the cited file. Confirm:

- the search result contains a citation path and snippet;
- the read result contains the original marker;
- an audit event exists;
- status reports `cloud=false` and `sync.enabled=false`.

## Doctor and Diagnostics

Run:

```bash
ihow-memory doctor --runtime codex
```

`doctor` checks:

- Node version;
- `node:sqlite` availability;
- memory root writability;
- selected runtime setup guidance;
- retrieval engine readiness;
- index manifest;
- local-only cloud/sync state.

For a redacted report:

```bash
ihow-memory doctor --runtime codex --share-diagnostics
```

The report omits memory content, replaces local paths with placeholders, and redacts secret-like values. It is printed locally and is not uploaded.

## Feedback

```bash
ihow-memory feedback --runtime codex
```

This prints:

- a prefilled GitHub issue URL;
- a Markdown issue template;
- a redacted doctor summary.

No issue is submitted automatically.

## Reset and Uninstall

Remove a managed demo space:

```bash
ihow-memory reset --space demo
```

Use the same `--root <dir>` value if the demo was initialized under a custom root:

```bash
ihow-memory reset --root <state-root> --space demo
```

Safety boundary:

- `reset` requires an explicit `--space`;
- `reset` only removes managed spaces;
- `reset` refuses `--memory-root`, so it cannot delete an existing shared memory root.

Uninstall steps:

1. Remove the `ihow-memory` entry from the AI runtime's MCP configuration.
2. Restore the configuration backup if needed.
3. Delete demo spaces with `ihow-memory reset`.
4. Remove a global npm install with `npm uninstall -g ihow-memory`.
5. Delete any remaining custom state root only after reviewing its contents.

## Workspace Modes

### Managed Space

Default layout:

```text
<state-root>/<space>/
  memory/
    candidate/inbox/
    scopes/
    _events/
  history/
  index.sqlite
  index-manifest.json
```

### Existing Memory Root

Use an existing Markdown memory directory without moving it:

```bash
ihow-memory doctor \
  --memory-root <memory-root> \
  --state-root <state-root>
```

Write boundary:

- existing durable Markdown is read-only by default;
- candidates are written under `memory/_mcp/candidates/`;
- normal promote writes staging files under `memory/_mcp/promoted/`;
- audit events stay under `memory/_mcp/_events/`;
- SQLite state stays under `<state-root>`, outside the memory root.

## Retrieval Engine

The default `fts` provider uses only Node built-in modules and `node:sqlite` FTS5:

- zero third-party runtime dependencies;
- zero embedding downloads;
- zero model/API requirements;
- citation-bearing lexical search.

The optional `vector-gguf` provider runs as a separate local process. If it is unconfigured, missing, slow, or unhealthy, retrieval falls back visibly to FTS. Governance, write guards, and audit behavior do not change with the retrieval provider.

## Development Proofs

From a clone of the source repository (these scripts are not part of the npm package):

```bash
npm run proof
npm run dogfood
```

`dogfood` requires explicit local paths:

```bash
MEMORY_ROOT=<memory-root> \
IHOW_MEMORY_STATE_ROOT=<state-root> \
npm run dogfood
```

## Hosted Runtime

A single-tenant HTTP runtime exists for development and controlled deployment. It is **not** part of the published npm package and is not the self-serve alpha path: no accounts, billing, hosted sync, or web console.

## Package Status

Alpha prerelease (`0.1.0-alpha.0`). The npm tarball ships only the local CLI, the stdio MCP server, and the read-only local console (`ihow-memory console`). The single-tenant hosted runtime, TypeScript sources, and internal proof scripts are intentionally not part of the published package.

## Privacy

The open-source core runs locally with no telemetry and no required network calls. Memory content is not included in diagnostics. `feedback` only prints a template; the user decides whether to submit it.

## License

Apache License 2.0. See [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).
