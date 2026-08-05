# Contributing to iHow Memory Core

This repository hosts the source for the [`ihow-memory`](https://www.npmjs.com/package/ihow-memory) npm package: the local-first CLI and stdio MCP server. The protocol specification and conformance material live in a separate repository, [iHow1/ihow-memory-standard](https://github.com/iHow1/ihow-memory-standard) — spec-level proposals belong there.

The project is in alpha. The most useful contributions right now:

- Reproducible bug reports (with the redacted `doctor --share-diagnostics` output).
- Test coverage for the security and governance boundaries (write guards, redaction, reset safety, path handling).
- Documentation fixes that remove ambiguity.
- Small, focused code fixes.

For anything larger than a small fix, please open an issue first so we can agree on the direction before you invest time.

## Development setup

Requirements: Node.js >= 22.12, macOS or Linux.

```bash
git clone https://github.com/iHow1/ihow-memory-core.git
cd ihow-memory-core
npm run build
node bin/ihow-memory.mjs --help
```

There is intentionally no `npm install` step: the package has zero runtime dependencies, and the build uses Node's built-in TypeScript type-stripping (`node:module`).

Useful loops while developing:

```bash
npm run build                      # src/*.ts -> dist/*.js
node --test tests/                 # run the test suite (when present)
node bin/ihow-memory.mjs proof     # end-to-end governed-loop proof in a throwaway space
npm pack --dry-run                 # verify the published file list
```

When testing by hand, keep your experiments out of your real memory root: pass `--root "$(mktemp -d)"` (or set `IHOW_MEMORY_HOME`) so demo spaces land in a temporary directory.

## Ground rules

### Synthetic data only

Examples, tests, fixtures and docs must use synthetic or clearly fictional data. Never commit real conversations, real customer or user data, private memory content, or anything copied from a production memory root. CI scans for credential-like patterns; a hit fails the build.

### Privacy red lines

The privacy contract is part of the product (see the contract comment in `src/telemetry.ts`). Pull requests must not:

- enable telemetry by default, or widen the telemetry field allow-list;
- add required network calls to the local core;
- weaken redaction in `doctor --share-diagnostics` or `feedback`;
- bypass or soften governance: candidate → explicit promote, write guards, the `--dry-run | --real-write` requirement on durable writes, audit events, or `reset` safety boundaries.

PRs that cross these lines will be declined regardless of other merits.

### Keep zero-dependency

The published package has no third-party runtime dependencies. PRs that add one need a very strong reason, discussed in an issue first.

## DCO sign-off

Contributions are accepted under the Developer Certificate of Origin. Sign off every commit:

```bash
git commit -s -m "your message"
```

See [DCO.md](./DCO.md) for the full text. Unsigned commits will be asked to amend before merge.

## Pull request checklist

- `npm run build` passes.
- `node --test tests/` passes (when the test suite is present).
- `npm pack --dry-run` shows the expected file list.
- Synthetic data only; no secrets, no customer data.
- README / CHANGELOG updated if behavior changed.
- Commits signed off (DCO).

## Security issues

Do not open public issues for vulnerabilities. See [SECURITY.md](./SECURITY.md) for the private reporting channel.

## License

By contributing you agree that your contributions are licensed under the [Apache License 2.0](./LICENSE). The iHow / iHow Memory names and logos are trademarks — see [TRADEMARK.md](./TRADEMARK.md).
