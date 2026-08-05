# Safe Memory Gardener (alpha.24)

Safe Memory Gardener is a review-first organize/export path for local iHow Memory workspaces. It helps a human reviewer turn scattered Markdown memory into an evidence-linked digest without rewriting the source memory.

## What it does

```bash
ihow-memory organize --scope project --draft --json
ihow-memory export-vault --from-draft <draft_id> --format markdown
```

The alpha.24 path:

1. scans in-scope Markdown memory;
2. builds a deterministic JSON organize draft;
3. preserves evidence pointers back to source files and line numbers;
4. flags duplicate or stale-looking claims as review-only candidates;
5. writes an append-only `memory.organized` audit event;
6. exports an Obsidian-compatible Markdown digest; and
7. writes an append-only `memory.exported` audit event.

The Markdown export is a **view/editor artifact only**. It is not the source of truth, and editing it does not update governed memory. The source of truth remains the governed memory store plus the organize/export audit trail.

## Safety boundaries

- The gardener does **not** delete, merge, auto-promote, supersede, or rewrite source memory.
- It redacts secret-like/PII-like strings before draft/export persistence and refuses an export if detector-clean Markdown cannot be produced.
- `--scope project` excludes private and audit-only memory surfaces from the digest.
- Duplicate/stale flags are non-destructive review hints, not policy decisions.
- This is **not** full enterprise memory policy automation: no RBAC/ABAC engine, namespace leak matrix, adapter framework, admin UI, or durable retention automation is claimed in alpha.24.

## Synthetic enterprise-style fixture

The repository test fixture `tests/fixtures/enterprise-gardener.mjs` models a sanitized enterprise workflow using generic Project Orchard events. It proves the end-to-end chain without customer data:

```text
synthetic workflow events
  -> memory/candidate/project state
  -> organize draft
  -> evidence-linked digest
  -> redaction-checked Markdown export
  -> organize/export audit trail
```

Run it directly with:

```bash
node --test tests/gardener.test.mjs
```

The fixture intentionally avoids production identifiers, customer ontology, real endpoints, secrets, or private names.

## CLI notes

- `organize --draft --json` prints the JSON draft and writes it under the managed workspace's `gardener/drafts/` directory.
- `export-vault --from-draft <draft_id> --format markdown` writes `memory-gardener-digest.md` under `gardener/exports/<draft_id>/`.
- Audit events can be inspected with `ihow-memory audit`.

Recommended review loop:

1. Run `organize --scope project --draft --json`.
2. Inspect the draft's `safety`, `sources`, evidence arrays, and duplicate/stale flags.
3. Export Markdown only after the draft is acceptable.
4. Use the Markdown in an editor or vault for human review notes.
5. If durable memory should change, make that change through the normal governed memory path, not by treating the export as authoritative.
