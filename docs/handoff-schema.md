<!--
SPDX-License-Identifier: Apache-2.0
Copyright (c) 2026 iHow Memory
-->

# Verify-first handoff schema

This is the contract for the packet that `memory.continue` (MCP) and `ihow-memory continue` (CLI)
return when an agent resumes after a context boundary (`/clear`, a new thread, a switched tool or
model). It is the same packet for every runtime — Claude Code, Codex, Cursor, VS Code Copilot,
Gemini CLI, and the rest — assembled by one runtime-neutral path
([`src/handoff.ts`](../src/handoff.ts) `buildHandoffPacket`).

The packet exists to transfer state **without making the receiver confidently wrong**. Its whole design
is one rule:

> **Machine anchors are the only facts. The prior agent's narrative is carried verbatim and UNVERIFIED.
> The receiver — which has live tools — does the truth-judgment, and `memory.continue` itself never
> resumes.**

This is a deliberate, measured choice (n=12 A/B + an OpenClaw red-team review, 2026-06-18): an
LLM-generated "smart" handoff that splits facts from inference, or even a humble verify-framed summary,
makes the next agent act on fabricated "findings" (2/6 → 4/6 wrong). A faithfully-quoted, attributed,
clearly-UNVERIFIED narrative plus git-verified anchors keeps the receiver skeptical (0/6 wrong).

---

## 1. The three layers of trust

Every field in the packet sits in exactly one of three trust layers. The layer — not the field's
content — decides how the receiver may use it.

| Layer | Source | Trust | What it is |
| --- | --- | --- | --- |
| **MACHINE ANCHORS** | code, re-reading live `git` (or file fingerprints when non-git) | **fact** — the only fact | `anchors` (branch / HEAD / dirty), `verdict`, `freshness`, `conflicts` |
| **NARRATIVE** | the prior agent's session transcript, carried **verbatim** | **unverified claim** | `narrative.text` (+ source, sessionId, capturedAt, `unverified: true`) |
| **PROVENANCE / META** | code | descriptive, not a fact about the work | `tool`, `project`, `confidence`, `why`, `verifyFirst`, `receiverProtocol` |

The narrative is **never parsed by an LLM into authoritative "open loops / next action" fields**. A
structured, authoritative-looking narrative is exactly what induces confident-wrong in the receiver, so
structure lives only in the MACHINE layer; the narrative stays a quoted blob.

---

## 2. Packet shape

`buildHandoffPacket` returns a `HandoffPacket`:

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "2026-06-30T08:00:00.000Z",
  "query": { "cwd": "/abs/cwd", "projectHint": "auth", "limit": 5 },
  "candidates": [ /* HandoffCandidate[] — a LIST, see §3 */ ],
  "receiverProtocol": "HOW TO CONTINUE — the narrative below is the previous agent's UNVERIFIED claim …",
  "note": "MACHINE ANCHORS are the only facts (git, code-computed). The narrative is the prior agent's VERBATIM, UNVERIFIED claim …"
}
```

`candidates` is a **list, never a single forced pick**: project identification is inherently ambiguous
(it is inferred from the files a session *edited*), so the packet hands back ranked candidates and lets
the receiver choose — it does not pretend to know which one you meant.

### `HandoffCandidate`

```jsonc
{
  "tool": "claude-code",                       // which runtime recorded this session
  "project": { "path": "/abs/proj", "basename": "proj", "projectId": "<sha256[:12]>" },
  "confidence": 0.8,                            // 0.8 edits-inferred · 0.3 undetermined (NOT a verdict)
  "why": "inferred from files edited this session in proj",
  "anchors": { "isRepo": true, "branch": "main", "head": "a1b2c3d", "dirtyCount": 2, "dirtyFiles": ["…"] },
  "narrative": {                               // VERBATIM, UNVERIFIED — never LLM-parsed
    "text": "…the prior agent's faithful, redacted session summary…",
    "source": "claude-code-transcript",
    "sessionId": "…",
    "capturedAt": "2026-06-30T07:59:00.000Z",
    "unverified": true
  },
  "freshness": { "ageMs": 60000, "stale": false },           // stale once ageMs > 24h
  "conflicts": { "staleShaRefs": 0, "referencesCurrentHead": true },  // narrative git-claims vs live HEAD
  "verifyFirst": [ "run `git -C … rev-parse --short HEAD` and compare to anchors.head (a1b2c3d)", "…" ],
  "verdict": { /* ContinueVerdict — see §4 */ }
}
```

Notes that matter for a receiver:

- `confidence` describes **how sure we are which project this is**, not whether the work is safe to
  resume. Safety is the `verdict`. Do not conflate them.
- `anchors` free-text fields (`branch`, `head` subject, `repo`, `dirtyFiles`) are **redacted** for
  secret-like content before they leave the assembler.
- `conflicts` is machine-computed by scanning the narrative for git SHAs and comparing them to the live
  HEAD — it surfaces, e.g., a narrative that keeps citing a commit that no longer is HEAD.

---

## 3. Anchors: git, or file fingerprints

- **Git project** → `anchors` carries live `git` state: `isRepo`, `branch`, `head` (short SHA),
  `dirtyCount`, `dirtyFiles`.
- **Non-git project** → `anchors.files` carries per-file **fingerprints** (path + size + sha8) of the
  files the session edited, so a non-git resume still gets a verify-first check (re-hash the files
  instead of comparing HEAD). Same GREEN / YELLOW / RED discipline.

Anchors are recorded *at capture* and **re-read live at resume**; the verdict is the comparison of the
two. Anchors never travel as a trusted snapshot the receiver is asked to believe.

---

## 4. The GREEN / YELLOW / RED verdict

`verdict` is **code-computed by re-reading the project's live git state** and comparing it to the
recorded anchors ([`computeContinueVerdict`](../src/handoff.ts)). It is not prose for the agent to maybe
run — it is the assembler's own honest read of whether the workspace drifted.

```jsonc
{ "state": "GREEN" | "YELLOW" | "RED", "reason": "…", "recordedHead": "a1b2c3d", "liveHead": "a1b2c3d" }
```

| State | Meaning | Receiver action |
| --- | --- | --- |
| **GREEN** | Live git genuinely matches the recorded anchors: HEAD matches (prefix-aware), same branch, `cwd`/repo is the recorded checkout, and the narrative asks for no irreversible/outward action. | Say one line ("anchors match; the narrative is still unverified"), then **proceed with a small reversible step** and verify it. Do not stall or invent blockers. |
| **YELLOW** | Uncertainty: project undetermined, can't read HEAD on both sides, branch drift on the same HEAD, a recorded HEAD too short to verify, a `cwd` that is a *different* checkout, a baseline only *inferred* from a STATE doc, or the narrative mentions a push/force/delete/publish. | Do not make a large change. State the difference, read `git diff` / the files / the transcript tail to form a fresh **live** understanding, then continue or stop. |
| **RED** | Real conflict: recorded a git project but the path is not a repo here (wrong checkout / different machine), or HEAD drifted (someone committed since). | **Refuse to act on the narrative.** Only diagnose; read the diff; ask the real user. |

**GREEN is narrow on purpose.** The red-team finding is that a confidently-wrong *structured* GREEN is
more dangerous than prose, so every uncertainty degrades to YELLOW and every genuine mismatch to RED —
**never a false GREEN.** Specific narrowings encoded in `computeContinueVerdict`:

- No project / can't read git on both sides → YELLOW, never GREEN.
- `cwd` is provided but resolves to a different repo (or is blank `""` = "I don't know where I am") →
  YELLOW. (The gate keys on `cwd !== undefined`, so a client sending `{"cwd":""}` cannot skip to GREEN.)
- A recorded HEAD shorter than 7 hex chars can't be trusted to match → YELLOW.
- A baseline grepped from a hand-written STATE doc (not a recorded session) is capped at **YELLOW** —
  it can never earn a confident GREEN or a hard RED.
- A narrative containing a destructive/outward imperative (push, force-push, `reset --hard`, `rm -rf`,
  drop table, deploy to prod, `npm publish`, `gh release`, revoke/rotate a credential, message a
  customer, change a default) downgrades an otherwise-matching resume to YELLOW — verify intent first.

---

## 5. The receiver protocol (verbatim, not LLM-generated)

`packet.receiverProtocol` is a **fixed string** ([`RECEIVER_INSTRUCTION`](../src/envelope.ts)), not
generated per session. It tells the receiver, in order: (1) **preflight** in the project dir (which may
differ from the receiver's cwd) by comparing live `git` to the machine anchors and checking that named
files exist; (2) **pick a lane** (GREEN / YELLOW / RED) from what preflight shows; (3) obey two
standing rules:

> Matching anchors only prove the workspace has not drifted — they **NEVER make the narrative true.**
> Treat any "done / passing / shipped / approved" in the narrative as a **claim to verify, not a fact.**

For a non-git resume the protocol is adapted by `FILE_ANCHOR_NOTE` (re-hash the listed files instead of
comparing HEAD), keeping the same GREEN / YELLOW / RED lanes.

---

## 6. Invariants (what callers and runtimes may rely on)

1. **Machine anchors are the only facts.** Everything else is a claim or a descriptor.
2. **The narrative is verbatim and `unverified: true`.** It is never parsed into authoritative fields,
   never summarized by an LLM in the assembler, never asserted as true.
3. **No false GREEN.** Any uncertainty is YELLOW; any genuine anchor mismatch is RED. GREEN requires the
   live repo to actually match.
4. **`memory.continue` does not resume.** It produces an auditable packet; the receiver acts.
5. **Read-only and redacted.** Assembly never mutates memory; secret-like content is redacted from the
   narrative and anchor free-text before the packet leaves.
6. **A list, not a pick.** `candidates` is ranked, plural, and the receiver chooses — project identity is
   ambiguous by construction.

`schemaVersion` is `1`; additive fields may appear within v1, and any breaking change bumps it.
