# Harness Contract: Planner / Generator / Evaluator

This document describes the alpha.22 workflow contract for coordinating multiple agent runtimes through iHow Memory. It is a workflow convention, not a new daemon or remote service.

## Core rule

Do not assume every agent can call every other agent. Treat iHow Memory as the shared state bus and use explicit contracts, evidence, and review packets.

## Runtime roles

| Role | Runtime examples | Responsibility |
|---|---|---|
| Planner + canonical state owner | OpenClaw or a human operator | Owns the spec, acceptance gates, task slicing, final decision, and state writeback. |
| Generator | Codex / coding runtimes | Receives a narrow engineering brief, edits the repo, runs the requested gates, and reports diff + evidence. |
| Harness Controller / Protocol Evaluator | Hermes / reviewer runtime | Verifies branch/root/status, reviews diffs and tests, runs smoke checks when possible, and returns PASS / REQUEST_CHANGES / BLOCKED. |
| No-hook Secondary Evaluator | WorkBuddy / OpenCode / Gemini when no callable hook exists | Participates cooperatively through a current packet, `memory.context_probe`, a human-forwarded task, or a review packet. It is not assumed to be synchronously callable. |
| Shared state bus | iHow Memory | Stores contracts, task briefs, handoffs, evaluator reports, run ledgers, and runtime current packets. |

## No-hook boundary

A no-hook runtime is not a blocking worker unless it exposes an API/MCP/shell hook you can actually call and verify.

For no-hook runtimes:

1. Receive work through a file/packet, human-forwarded prompt, or `memory.context_probe`.
2. Return a structured review packet.
3. Do not auto-write a floor journal from inferred state.
4. If `context_probe(session_end)` returns `action: "journal"`, the runtime or planner must explicitly call `memory.journal` with a short handoff.

## Review packet template

Use this shape for evaluator output:

```md
# Review Packet

- verdict: PASS | REQUEST_CHANGES | BLOCKED
- scope reviewed: <files / commands / runtime path>
- evidence:
  - <command + result>
  - <file path / diff / smoke result>
- issues:
  - <issue with evidence, or "none">
- suggested fix:
  - <specific next action, or "none">
- memory write required: yes | no
- notes:
  - <optional>
```

## Run ledger

For non-trivial work, keep a run ledger under a project or inbox path. A ledger should contain:

1. Planner spec / acceptance gates.
2. Generator brief.
3. Generator diff summary and test logs.
4. Evaluator report.
5. WorkBuddy/no-hook review packet, if any.
6. Final decision and memory writeback.

A ledger is useful only if it records evidence, not just opinions.

## Acceptance gates before implementation

Before a Generator starts a non-trivial engineering task, the Planner should provide:

- objective and explicit non-goals;
- allowed write scope;
- safety boundaries, especially no push/publish/delete unless explicitly authorized;
- exact verification commands;
- expected report path;
- rollback / stop conditions.

## Evaluator stop conditions

An Evaluator should return REQUEST_CHANGES or BLOCKED when:

- branch/root/HEAD does not match the task brief;
- the diff contains out-of-scope changes;
- required gates were not run or failed;
- the implementation violates a memory safety boundary;
- a no-hook runtime is treated as if it had a reliable transcript or callable lifecycle hook;
- release/publish/push is attempted without explicit human approval.

## Relationship to `memory.context_probe`

`memory.context_probe` is the alpha.22 automation trigger for no-hook and partial-hook runtimes. It can diagnose, recall reviewed context, and request a cooperative journal, but it is not a universal auto-write mechanism.

In particular:

- WorkBuddy/OpenCode/Gemini-style no-hook runtimes must never receive `floor_journaled`.
- `prompt` probes return bounded reviewed recall only.
- `session_end` for no-hook runtimes means task completion/delivery, not process exit.
- Stale markers diagnose missed capture; they do not fabricate a summary.
