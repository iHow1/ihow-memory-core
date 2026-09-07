# FTS source projection: local PR candidate

Core 0.1.0 indexed complete Markdown, including generated `created_at`,
`promoted_at`, and `candidate_id` fields. A question containing a calendar day
could consequently match the seconds of an ingestion timestamp. This candidate
changes the lexical index representation, not the original memory files or
the published version.

## Content contract

`src/engine/source-projection.ts` recognizes the envelope emitted by
`markdownCandidate` and preserved by promotion: a canonical UUID `candidate_id`,
nonempty `source_agent` and `created_at`, plus either
`type: memory_candidate` / `status: candidate` or
`type: memory` / `status: promoted`. This is a format classification, not a trust
or authorization decision. Ordinary user Markdown is returned unchanged,
including business `created_at`, `promoted_at`, `type`, and `status` fields.

For recognized envelopes only, the indexed representation removes these exact
top-level operational fields and their continuation blocks:

- `created_at`, `promoted_at`, `candidate_id`;
- `flagged`, `reviewed`, `tier`, `auto_tier`;
- the Core policy namespace `durable_write_*`.

Other fields remain searchable, including title, tags, entity aliases, validity
dates, custom `appointment_at` fields, and nested user metadata. There is no
blanket `*_at` exclusion. Field names tolerate case and simple quotes; complete
leading frontmatter supports BOM/CRLF and an exact standalone closing fence.
Unknown fields retain their raw blocks, without interpreting arbitrary YAML.
Malformed or unrecognized envelopes remain literal source text.

Only a leading `# Candidate <UUID>` heading whose UUID matches the recognized
envelope is omitted. Original body dates, roles, text, order, later headings,
and literal body identifiers remain. Projection precedes existing CJK bigram
segmentation. SQLite `orig` and the source Markdown retain their original bytes.

Flag exclusion and unreviewed demotion still derive independently from the
original Markdown through the existing predicates. Projection does not broaden
recall eligibility or change provenance authority. Snippet rendering retains
its previous contract: it shows body text, so a metadata-only lexical match can
still display the body opening. This change does not claim improved snippet
presentation or answer quality.

## Migration and old writers

The `memory_fts` schema contains a dedicated `source_text_v1 UNINDEXED` column.
That column marks the projection generation, including for an empty index.
An old writer's DROP/CREATE removes the column, so the next search detects and
rebuilds the legacy index. A separate version table would not detect that case.
No `PRAGMA user_version` or unrelated database tables are modified.

DROP, CREATE and inserts occur in one transaction; an insertion failure rolls
back both schema and data. Lazy migration uses the existing workspace lock and
does not overwrite the provider manifest. In particular, repairing FTS cannot
turn a previous vector-index failure into provider readiness. Explicit reindex
keeps its existing manifest behavior.

The final search statement references the generation column as a column. If an
old writer replaces the schema after the readiness check, search fails visibly
instead of silently searching the old representation. The following call can
detect and migrate that schema; there is no broad SQL-error retry or swallowing
of busy/corruption failures. Concurrent use of old and new writers can therefore
cause temporary failures/rebuilds until runtimes are consistently upgraded.

Equal lexical scores now have a final `path ASC` tie-breaker after the existing
governance and journal ordering. This independently fixes rowid-dependent ties;
it is not presented as the cause of the observed ingestion-timestamp drift.

## Verification scope

The local TDD loop reproduced the metadata match/score defect, old-index reuse,
and rowid tie ordering before the first fix (six failing regressions). Additional
RED/GREEN checks cover preservation of ordinary user dates, the old-writer race,
and inclusion of the new module in semantic activation candidate identity.

Focused verification passes 12 new tests plus existing CJK, decay/rank, and
semantic-fusion tests: 33 tests total. These cover original-byte retention,
semantic metadata, whole operational blocks, flags/demotion, legacy migration,
old-writer downgrade, unrelated table/user_version retention, rollback on
injected failure, and preservation of a failed vector-provider manifest.
Typecheck, build, secret scan and diff validation pass.

Read-only inspection of the two existing public dev snapshots found 326 of 326
source documents recognized and all 326 pairs projected identically despite
their different generated metadata. Root-owned real-fixture verification is a
separate artifact; no holdout, full product suite, publication, website update,
or live runtime upgrade is implied by these local checks.

The semantic activation gate's source identity list includes this new module,
so prior evidence cannot silently authorize changed projection bytes. Rollback
to an older Core can rebuild its legacy FTS schema from retained source files;
it also restores that version's metadata-indexing behavior.
