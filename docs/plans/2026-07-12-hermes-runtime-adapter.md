# Hermes Runtime Adapter Kit Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add a reusable runtime capability contract and a truthful Hermes adapter lane without touching the uncommitted OpenClaw Stage 2 checkpoint core.

**Architecture:** Introduce a runtime-neutral capability manifest as a standalone module. Hermes is represented by a host-specific manifest that records lifecycle surfaces and the guarantees they can support. Existing Activation Truth consumes the manifest incrementally: the first slice only exposes data and keeps Hermes `TOOLS ONLY` until verified plugin wiring and observed live evidence exist. Later slices add legacy MCP migration and a standalone Hermes plugin adapter against the committed checkpoint API.

**Tech Stack:** TypeScript, Node.js `node:test`, Hermes plugin hooks, MCP stdio.

---

## Parallel-work boundary

This branch starts from committed A2 HEAD `3c171c7` and must not copy or depend on the uncommitted OpenClaw Stage 2 implementation.

**Do not modify in the first slice:**
- `src/core.ts`
- `src/checkpoints.ts`
- `src/checkpoint-schema.ts`
- `src/store/checkpoints.ts`
- `tests/checkpoint-core.test.mjs`
- `README.md`
- `README.zh-CN.md`
- `CHANGELOG.md`
- `tests/package-completeness.test.mjs`

**Allowed first-slice files:**
- Create `src/runtime-capabilities.ts`
- Create `tests/runtime-capabilities.test.mjs`
- Create/update this plan only

## Task 1: Runtime capability contract and Hermes manifest

**Objective:** Define a frozen, runtime-neutral capability schema and a truthful Hermes manifest reusable by future adapters.

**Files:**
- Create: `src/runtime-capabilities.ts`
- Test: `tests/runtime-capabilities.test.mjs`

**Step 1: Write failing tests**

Tests must prove:
- Hermes declares MCP tools and readable transcripts.
- Hermes declares start/reset/before-prompt/after-turn/finalize/end lifecycle surfaces.
- Hermes does not claim native precise pre-compact support.
- Capability-derived guarantee is `lifecycle-capable`, not `active`.
- Unknown/no-hook runtimes degrade to `tools-only` or `explicit-only` without false automation claims.
- Returned manifests cannot be mutated across callers.

**Step 2: Verify RED**

Run:

```bash
node --test tests/runtime-capabilities.test.mjs
```

Expected: FAIL because `src/runtime-capabilities.ts` does not exist.

**Step 3: Minimal implementation**

Implement:

```ts
export type RuntimeCapabilityManifest = Readonly<{
  runtime: string;
  mcpTools: boolean;
  readableTranscript: boolean;
  lifecycle: Readonly<{
    sessionStart: boolean;
    sessionReset: boolean;
    beforePrompt: boolean;
    afterTurn: boolean;
    sessionFinalize: boolean;
    sessionEnd: boolean;
    preCompact: 'native' | 'estimated' | 'none';
  }>;
}>;
```

Add `runtimeCapabilityManifest(runtime)` and `runtimeAutomationCeiling(manifest)`. Keep the output descriptive; it must never prove installation or live activation.

**Step 4: Verify GREEN**

Run:

```bash
node --test tests/runtime-capabilities.test.mjs
npm run typecheck
npm run build
```

Expected: all pass.

**Step 5: Review and commit**

Review the diff for scope leakage. Commit only the two implementation/test files plus this plan:

```bash
git add src/runtime-capabilities.ts tests/runtime-capabilities.test.mjs docs/plans/2026-07-12-hermes-runtime-adapter.md
git commit -m "feat: define runtime capability contract"
```

## Task 2: Legacy Hermes MCP binding diagnosis and migration plan

**Objective:** Detect `ihowmemory` thin-wrapper aliases separately from the canonical `ihow-memory` full server, without changing user configuration.

**Files:**
- Create: `src/hermes-adapter.ts`
- Test: `tests/hermes-adapter.test.mjs`

Required classifications:
- canonical full server
- legacy alias
- thin wrapper with incomplete tool inventory
- wrong root/binding
- duplicate/conflicting entries
- absent

This task remains read-only. Migration writes belong to a later reviewed task.

## Task 3: Hermes plugin contract prototype

**Objective:** Create a standalone edge adapter mapping Hermes plugin events to runtime-neutral events.

Target mapping:
- `on_session_start` → `runtime.session_start`
- `on_session_reset` → `runtime.reset`
- `pre_llm_call` → `runtime.before_prompt`
- `post_llm_call` → `runtime.after_turn`
- `on_session_finalize` → `runtime.finalize`
- `on_session_end` → `runtime.session_end`

Constraints:
- bounded payloads
- secret filtering
- fail-open
- no mutation of historical messages
- no prompt-cache-invalidating system prompt rebuild
- no `ACTIVE` until observed live evidence exists

## Integration gate with OpenClaw Stage 2

Do not wire Hermes finalize/checkpoint calls until OpenClaw commits Stage 2 and this branch rebases onto that commit. After rebase:

1. map runtime-neutral finalize events to the committed Checkpoint Draft/Artifact API;
2. run focused Hermes tests;
3. run complete test suite;
4. run typecheck/build/secret-scan/package checks;
5. perform clean temporary `HERMES_HOME` E2E;
6. request independent spec and quality reviews;
7. do not push, tag, publish, or modify real `~/.hermes` during tests.
