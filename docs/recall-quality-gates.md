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

## Recall explanation / preview v0

Alpha.26 also adds a small user/agent experience layer for explaining prompt recall without making the default injected prompt block noisy.

Surfaces:

- `ihow-memory recall-preview <prompt> [--json]`: local CLI diagnostic for a prompt against a chosen `--memory-root` / `--state-root` or normal workspace.
- `ihow-memory hook-user-prompt-submit --explain` or `IHOW_RECALL_EXPLAIN=1`: opt-in `structuredContent` on the hook response. The default `additionalContext` body remains the same concise recall block.

The explanation metadata is machine-readable and deterministic:

- `mode`: `lexical/FTS only` or `semantic-ready`, derived from `recallReadiness`.
- `included[]`: safe citation path, snippet, tier, lightweight reason, and matched terms for items that would pass recall gates.
- `excluded.counts`: counts by reason such as `flagged`, `private`, `audit-only`, `not-curated`, `irrelevant`, `secret`, `unreadable`, or `over-budget`.
- `bounded`: search/include/character limits and considered/included counts.
- `noRelevantRecall` / `summary`: a short explanation when recall is empty, including lexical-only mode when semantic is not ready.

Privacy and governance boundaries:

- This is **not telemetry**. The preview is local-only and does not upload prompts, memory, counts, or snippets.
- Excluded entries are reported as counts/reasons only. Their snippets, body text, and private/flagged/audit-only content must not appear in explanation output.
- Explanation does not replace the governance/read boundary. It calls the same default prompt-recall boundary and must not widen eligibility.
- The CLI tests use temporary memory roots; they must not depend on or inspect real private memory.

## Semantic provider readiness / fallback honesty v0

Alpha.26 exposes a descriptive readiness object on `status` / `memory.status` and a non-required `doctor` check named `recall-readiness`.

Fields:

- `lexicalReady`: true when the mandatory local FTS floor is available. This is the default path.
- `semanticAvailable`: true only when a configured vector provider is the active ready engine, not an FTS fallback.
- `semanticReady`: true only when `semanticAvailable` is true **and** the configured model has a measured recall floor for semantic bypass decisions.
- `provider`: `fts/lexical` for default or fallback states; `vector-gguf` only for an active ready vector provider.
- `modeLabel`: stable short label for status cards and CLI display, e.g. `lexical/FTS only`, `semantic-ready + lexical fallback`, or `semantic provider available; recall gate fail-closed`.
- `summary`: stable one-sentence UX summary, e.g. `semantic recall not enabled` or `semantic recall ready with measured model "bge-m3"; lexical FTS remains the availability fallback`.
- `nextAction`: stable operator guidance. Default lexical-only points to optional `ihow-memory enable-semantic --model bge-m3`; unmeasured semantic providers point to a measured floor/calibration/override instead of pretending semantic recall is ready.
- `reason` / `warnings`: human-readable and machine-testable explanation for lexical-only fallback, provider failure, or unmeasured-model fail-closed behavior.

Fallback honesty rules:

- Default / no config reports `semanticAvailable=false`, `semanticReady=false`, `provider=fts/lexical`, `modeLabel=lexical/FTS only`, and `summary=semantic recall not enabled`. Doctor keeps this non-required and `info` severity so ordinary local FTS users do not read it as a broken system.
- Configured but unavailable providers report lexical FTS-only fallback. This is a warning, not a local-health failure, because semantic search is additive and not load-bearing.
- Configured providers using unmeasured models may be `semanticAvailable=true` but must keep `semanticReady=false`; prompt-recall semantic bypass stays fail-closed until the model has a measured floor or an explicit local calibration override. Their `nextAction` must mention measured floor/calibration/override.
- Human `ihow-memory status` prints a first-line readiness sentence: `Recall mode: <modeLabel>; <summary>`, followed by the detailed booleans/reason and `nextAction` for operators/agents.
- JSON `status` / MCP `memory.status` expose the same stable readiness fields for automation: `modeLabel`, `summary`, `nextAction`, plus the existing booleans and warnings.
- The readiness object is status-only. It must not change actual recall eligibility or connect a new provider.

## Future work

Later alpha.26 work may add richer calibration tooling and provider setup helpers, but those must remain honest about provider availability and must not widen prompt-injection eligibility.
