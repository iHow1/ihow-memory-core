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
| Blocked export | draft export fails closed when `safety.blocked_items > 0` or `export_safe:false` | alpha.25 v0 does not silently emit a sanitized subset; any future sanitized export must be an explicit named policy/flag with audit metadata. |
| Audit | organize/export must emit audit events | The draft/export itself is not source of truth; refused blocked exports are audited with `status:refused`, `reason:blocked_items_present`, and `blockedItemsPolicy:fail-closed`. |
| Durable duplicate/stale/supersede | write/promote/durable-promote surfaces attach review-first policy metadata | alpha.25 v0 marks `duplicate_candidate`, `stale_candidate`, and `supersede_candidate` in audit/frontmatter/plan metadata. It does not delete sources, rewrite old durable memory, or silently choose the new claim as authoritative. |

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
- drafts with `blocked_items` fail closed by default and do not write a Markdown export;
- blocked-export refusals leave audit metadata identifying the `fail-closed` policy;
- organize/export audit records are present.

## Source Adapter Layer contract v0

The first alpha.25 source-adapter code surface is intentionally local and fixture-only. It does **not** connect to Feishu, Obsidian, ima, or any external service. The contract now validates adapter-produced documents before they can be rendered as source-lane Markdown fixtures:

- adapter documents must declare `adapter.id`, `adapter.kind`, `adapter.version`, `source_id`, `scope`, `visibility`, `title`, and `text`;
- `visibility` is constrained to `source-local` or `source-shared`, so adapter output cannot masquerade as curated project/private/audit memory;
- `scope` must already be a slug and determines `memory/sources/<local|shared>/<scope>/...` placement;
- persisted provenance fields are one-line, detector-clean values;
- body/title content is redacted before Markdown rendering and must pass the same secret detector as gardener export;
- fixture-rendered source docs participate in the existing gardener gate matrix: source-shared can support named project review, source-local stays out until explicit source review.

This gives Feishu/Obsidian/ima a typed, testable target without shipping real adapters or reading external credentials in alpha.25 v0.

## Durable write dedupe / supersede baseline v0

alpha.25 adds a deterministic `alpha25.durable-write-policy.v0` guard on promote/durable-promote write surfaces. It is intentionally a metadata/audit baseline, not an automatic merge engine:

- durable write candidates receive a normalized body fingerprint (`durable_write_fingerprint`) in frontmatter;
- existing durable memory with the same normalized body is reported as `duplicate_candidate` and is referenced in audit metadata;
- self-labeled stale/deprecated/superseded/obsolete text is reported as `stale_candidate`;
- a duplicate write that would make a newer durable entry beside an older durable entry is also marked `supersede_candidate`;
- all flags are `destructive:false`, `mode:review-first`, and `reviewRequired:true` when present;
- `durable-promote --dry-run` exposes the same policy in the plan before any write;
- real writes remain append/create-only. Existing curated memory and source files are not rewritten or deleted by this baseline.

The baseline is deliberately conservative: it makes duplicate/stale/supersede candidates auditable and testable so a reviewer can decide what to keep, supersede, forget, or archive later.

## Audit completeness baseline v0

The alpha.25 v0 audit baseline asserts that each governance action leaves enough append-only event data to reconstruct what happened without trusting the draft/export artifact alone.

Covered in v0:

| Action | Required audit evidence |
|---|---|
| candidate write | `candidate.created` event with candidate path and redacted actor/metadata surfaces |
| promote | `memory.promoted` event with durable target path and `durableWritePolicy` metadata |
| durable promote | `memory.promoted.durable` event or dry-run plan with append target, archive path, and `durableWritePolicy` metadata |
| journal append | `memory.journal.appended` event with reversible entry metadata |
| rollback | `memory.rolledback` event with `rolledBackEventId` and removal status |
| organize | `memory.organized` event with draft id, scope, item counts, out-of-scope exclusions, `curatedRewrite:false` |
| export | `memory.exported` event with draft id, format, export path or refusal status, source-of-truth marker, and blocked-items policy |

All event surfaces must be detector-clean: raw PII/secret-like values must not appear in event JSON, draft JSON, or Markdown export.

## Out of scope for alpha.25 v0

- full RBAC/ABAC engine;
- production admin UI;
- destructive automatic merge/delete;
- broad external crawlers;
- customer data import;
- platform-specific permission models for Feishu/Obsidian/ima.

Those can be added only after the v0 gate matrix stays green in CI.
