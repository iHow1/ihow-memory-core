---
name: ihow-memory
description: Recall and record project memory with iHow Memory (local, governed). Use at the START of a task to search for prior decisions, preferences, TODOs, and handoffs; and AFTER meaningful decisions, verified results, blockers, or handoffs to propose memory candidates. Memory is proposed by you and promoted under governance — nothing is stored unless you write it.
---

# Using iHow Memory well

iHow Memory is a local-first memory layer exposed over MCP. It does **not** auto-capture
anything — memory exists only because you call its tools. This skill is the discipline for
when to do that, so a future session (or a different agent) can pick up where you left off.

The tools: `memory.search`, `memory.read`, `memory.write_candidate`, `memory.promote`,
`memory.durable_promote`, `memory.status`. Writes are governed: `write_candidate` only
*proposes*; `promote` makes it durable.

## To resume after a context boundary — `continue`, don't re-brief

If the user says "continue", "接着上面的做", "resume", "pick up where we left off", or you're
starting fresh in a project that was clearly mid-task, run **`ihow-memory continue`** in the
project cwd. It prints a handoff: machine-verified git anchors (the only facts) + the previous
session's own summary, quoted and marked **UNVERIFIED**.

Then follow the receiver protocol in its output — **do NOT trust the narrative as fact**:

1. **Preflight** — re-check the git anchors against live state (`git rev-parse --short HEAD`,
   `git status`). If HEAD / branch / dirty changed, the handoff is stale — reconcile before acting.
2. **Handshake** — say back what you understand the task to be and what you'll verify first.
3. **First action = a minimal verification** (read a file, run the tests, check git) — never a big change.

The narrative is the prior agent's claim, not ground truth: any "done / passing / shipped" is a
claim to verify, not a fact. That split — git-verified anchors as fact, everything else verify-first —
is what makes resuming safe instead of confidently wrong.

## At the start of a task — recall before you re-derive

If the task touches an existing project, prior decisions, user preferences, TODOs, or a
handoff, **search first**:

- `memory.search` with a few keywords from the task.
- `memory.read` the cited file for any hit you're about to rely on (don't trust a snippet alone).

Skip this for trivial, self-contained, one-off requests. Don't search every turn — search
when continuity matters.

## During the task — capture what's worth keeping

Call `memory.write_candidate` when something durable happens:

- A **decision** ("we're standardizing on X", "we chose approach Y over Z").
- A **verified result** (something you confirmed works, with how you confirmed it).
- A **blocker** or its resolution.
- A **stated user preference** or constraint.
- A **handoff summary** at a natural stopping point.

Keep each candidate concise and self-contained: one durable fact or decision, with enough
context to act on it cold. Prefer a few high-value candidates over many noisy ones.

**Link related memory.** Before writing a candidate that refines, extends, or relates to an
existing decision, `memory.search` for it; if one exists, reference its path in your candidate
text (e.g. "extends memory/scopes/team/…-api-timeout-policy.md"). This keeps related decisions
connected instead of drifting into duplicates a future reader can't reconcile.

## What NOT to write

- **Never** secrets, tokens, API keys, passwords, or credentials.
- No transient chatter, raw transcripts, or low-value status pings.
- Don't restate what memory already holds — update intent, don't duplicate.

## Promotion — the governance gate

- `memory.promote` a candidate once you've confirmed it's correct, non-sensitive, and worth
  keeping. Don't reflexively promote everything you propose.
- `memory.durable_promote`: default to `dryRun: true` to preview the plan. Only set
  `realWrite: true` on explicit user confirmation.

## End of task / handoff checklist

Before you finish a substantive task, propose a short handoff candidate covering:

- What changed (paths/mechanisms), what's **verified** (and how), what's **next**, any **blockers**.

That one candidate is what makes the next session continuous instead of starting cold.

## Don't over-do it

This skill raises the odds memory is used well; it is not a mandate to search or write on
every turn. Quality and trust beat volume — capture high-value state with discipline, not noise.
