# Enterprise Quality Gates alpha.25

alpha.25 starts by turning the alpha.24 Safe Memory Gardener smoke checks into a deterministic enterprise boundary matrix.

This is still not a complete RBAC/ABAC product. The goal is to prove the memory lifecycle fails closed across scope, source, privacy, redaction, and audit boundaries before the source-adapter layer expands ingestion.

## Gate matrix v0

| Boundary | v0 behavior | Notes |
|---|---|---|
| Named project scope | `organize --scope <project>` includes only that project namespace plus shared source docs for that namespace | Prevents project-to-project digest/export leakage. |
| Public scope | excludes private, audit-only, source-local, and source-shared lanes | Public digest remains curated/project-only. |
| Private scope | includes private lane only | Used for explicit private review, not public export. |
| Source scope | includes source-local and source-shared lanes only | Lets adapter/source material be inspected without mixing curated private/audit content. |
| Audit-only lane | never exportable through gardener organize/export | Audit log details are evidence for system accountability, not product digest content. |
| Source-local lane | excluded from normal project/public digest | Adapter scratch/source-local notes must be reviewed before becoming curated memory. |
| Source-shared lane | allowed in named project and source review, excluded from public digest | Shared source material can support a project review without becoming default public output. |
| Redaction | raw secret/PII-like content must not appear in draft/export | Export artifacts are higher-blast-radius views and must be detector-clean. |
| Audit | organize/export must emit audit events | The draft/export itself is not source of truth. |

## Namespace conventions

The v0 matrix recognizes these memory paths and frontmatter labels:

```text
memory/scopes/<project>/...          project-curated memory
memory/scopes/private/...            private memory
memory/audit/...                     audit-only memory
memory/sources/shared/<project>/...  source-shared adapter/import material
memory/sources/local/<project>/...   source-local adapter/import scratchpad
```

Equivalent frontmatter labels are also supported:

```yaml
visibility: project
visibility: private
visibility: audit-only
visibility: source-shared
visibility: source-local
```

## What v0 proves

The deterministic test fixture asserts:

- project Orchard output does not include project Harbor facts;
- project/public output does not include private notes;
- project/public output does not include audit-only routing details;
- project/public output does not include source-local scratchpad notes;
- public output does not include source-shared imports;
- named project output may include its source-shared evidence;
- source review output includes source lanes without leaking private/audit content;
- Markdown export preserves the same boundary invariants as the JSON draft;
- raw email/secret-like values are redacted from export;
- organize/export audit records are present.

## Out of scope for alpha.25 v0

- full RBAC/ABAC engine;
- production admin UI;
- destructive automatic merge/delete;
- broad external crawlers;
- customer data import;
- platform-specific permission models for Feishu/Obsidian/ima.

Those can be added only after the v0 gate matrix stays green in CI.
