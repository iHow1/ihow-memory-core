# Recall Quality Gates

Alpha.26 starts with a deterministic recall-quality baseline before adding any new semantic provider surface.

## Scope

This is not a full semantic engine release. The v0 gate is model-free and protects prompt-recall surfaces that inject memory back into an agent context.

## Default prompt recall boundary

Default prompt recall must fail closed for memory that should not be injected into a prompt without an explicit future audited scope option:

- `flagged: true`
- quarantine/flagged lanes such as `memory/flagged/**`, `memory/quarantine/**`, or `memory/scopes/flagged/**`
- `visibility: private` / `scope: private`
- private lanes such as `memory/private/**` or `memory/scopes/private/**`
- `visibility: audit-only` / `scope: audit-only`
- audit lanes such as `memory/audit/**` or `memory/_events/**`

The boundary is shared by Claude/Codex style `hook-user-prompt-submit` recall and no-hook `memory.context_probe(prompt)` recall.

## Cross-runtime parity smoke v0

Alpha.26 adds a deterministic local smoke for cross-runtime recall parity. It uses temporary `--memory-root` / `--state-root` fixtures and does **not** launch real Claude Code, Codex, OpenClaw, or other external clients.

The smoke compares the boundary behavior of:

- Claude-style `hook-user-prompt-submit` prompt recall.
- Codex/no-hook `memory.context_probe(prompt)` prompt recall.
- OpenClaw/CLI `status` / `doctor` recall-readiness reporting for the same memory root.

Because each surface returns a different shape, the parity check asserts eligible content and boundary outcomes rather than byte-identical output:

- A reviewed, relevant curated memory is visible on both prompt-recall surfaces.
- `flagged`, `private`, and `audit-only` memory are absent from both prompt-recall surfaces.
- Off-topic prompts inject nothing on both prompt-recall surfaces.
- CLI readiness remains descriptive/status-only and must not widen recall eligibility.

## Existing quality invariants kept in alpha.26

- No semantic provider means lexical/FTS behavior only; do not claim semantic recall.
- Unmeasured semantic models fail closed for bypass decisions.
- Reviewed memory ranks/injects before unreviewed auto/journal lanes.
- Off-topic prompts inject nothing.
- Recall remains bounded and redacts secret-like content on the read path.

## Semantic provider readiness / fallback honesty v0

Alpha.26 exposes a descriptive readiness object on `status` / `memory.status` and a non-required `doctor` check named `recall-readiness`.

Fields:

- `lexicalReady`: true when the mandatory local FTS floor is available. This is the default path.
- `semanticAvailable`: true only when a configured vector provider is the active ready engine, not an FTS fallback.
- `semanticReady`: true only when `semanticAvailable` is true **and** the configured model has a measured recall floor for semantic bypass decisions.
- `provider`: `fts/lexical` for default or fallback states; `vector-gguf` only for an active ready vector provider.
- `reason` / `warnings`: human-readable and machine-testable explanation for lexical-only fallback, provider failure, or unmeasured-model fail-closed behavior.

Fallback honesty rules:

- Default / no config reports `semanticAvailable=false`, `semanticReady=false`, `provider=fts/lexical`, with a no-semantic-provider/config reason.
- Configured but unavailable providers report lexical FTS-only fallback. This is a warning, not a local-health failure, because semantic search is additive and not load-bearing.
- Configured providers using unmeasured models may be `semanticAvailable=true` but must keep `semanticReady=false`; prompt-recall semantic bypass stays fail-closed until the model has a measured floor or an explicit local calibration override.
- The readiness object is status-only. It must not change actual recall eligibility or connect a new provider.

## Future work

A later alpha.26 step may add cross-runtime parity probes, but those must remain honest about provider availability and must not widen prompt-injection eligibility.
