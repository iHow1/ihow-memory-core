# Recall Quality Gates

Alpha.26 starts with a deterministic recall-quality baseline before adding any new semantic provider surface.

## Scope

This is not a full semantic engine release. The v0 gate is model-free and protects prompt-recall surfaces that inject memory back into an agent context.

## Default prompt recall boundary

Default prompt recall must fail closed for memory that should not be injected into a prompt without an explicit future audited scope option:

- `flagged: true`
- `visibility: private` / `scope: private`
- private lanes such as `memory/private/**` or `memory/scopes/private/**`
- `visibility: audit-only` / `scope: audit-only`
- audit lanes such as `memory/audit/**` or `memory/_events/**`

The boundary is shared by Claude/Codex style `hook-user-prompt-submit` recall and no-hook `memory.context_probe(prompt)` recall.

## Existing quality invariants kept in alpha.26

- No semantic provider means lexical/FTS behavior only; do not claim semantic recall.
- Unmeasured semantic models fail closed for bypass decisions.
- Reviewed memory ranks/injects before unreviewed auto/journal lanes.
- Off-topic prompts inject nothing.
- Recall remains bounded and redacts secret-like content on the read path.

## Future work

A later alpha.26 step may add explicit semantic-provider readiness metrics and cross-runtime parity probes, but those must remain honest about provider availability and must not widen prompt-injection eligibility.
