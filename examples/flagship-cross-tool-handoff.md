# Flagship demo — "What Claude Code learns, Codex already knows"

The 3-minute demo that shows the one thing other memory layers don't: a decision
made in one AI tool is instantly, verifiably available in **another** tool — on
your machine, with no API key, no model download, and a human-reviewed, auditable
trail behind every remembered fact.

> **Git-style memory governance for AI agents.** Agents *propose* (`write_candidate`),
> you *commit* (`promote`), every change is *logged* (audit) with a *citation*
> (source trace), and the memory itself is plain Markdown you own — not a vector
> blob inside someone's cloud.

- **Time:** ~3 minutes. **Needs:** Node >= 22.12, Claude Code and Codex installed.
- **Costs nothing, sends nothing:** zero-dependency FTS, no embedding model, no key, fully local.
- Want the mechanism without two GUIs? Run [`03-two-agents-shared-memory.sh`](./03-two-agents-shared-memory.sh) — same flow, deterministic, one command.

---

## Setup (30s) — point both tools at one memory

Run both from the same directory and pass the **same `--space`** so they share one memory:

```bash
npx ihow-memory connect --runtime claude-code --space handoff-demo
npx ihow-memory connect --runtime codex       --space handoff-demo
```

Both tools now talk to the same local memory under `~/.ihow-memory/handoff-demo/`. Restart/reload both runtimes so they pick up the MCP server.

> Narrate: "Two different AI tools. **One** local memory. One command each — no account, no key, no model download."

---

## Act 1 (60s) — teach Claude Code something worth keeping

In **Claude Code**, have a normal exchange that ends in a decision, then ask it to remember and promote it:

> "We're standardizing on `pnpm` for all repos — npm and yarn are out. Remember that as a team decision and promote it."

Claude Code calls `memory.write_candidate` (a *proposal*), then `memory.promote` (the *commit*) — it has both tools and the candidate id from its own write. Confirm from your shell that it's now durable and searchable:

```bash
npx ihow-memory search "pnpm" --space handoff-demo
```

> Narrate: "It didn't silently rewrite shared memory — it *proposed*, then *promoted*. Now it's a durable, plain-Markdown fact, and search returns it with a citation path."

(Manual alternative: if you'd rather promote by hand, take the candidate path from the agent's `write_candidate` result and run `npx ihow-memory promote "<that-path>" --scope team --title "Package manager policy" --space handoff-demo` — candidate path first, then the flags.)

---

## Act 2 (60s) — Codex, cold, already knows

Switch to **Codex**. It never saw the Claude Code conversation. Ask:

> "What package manager should I use in this project, and who decided it?"

Codex calls `memory.search` → `memory.read` and answers **with a citation** pointing at the exact Markdown file from Act 1.

> Narrate: "Different tool. Different session. It didn't ask me to re-explain — it *recalled*, and it *cited its source*. That's the handoff."

Prove there's no trick from the shell — the same fact, same citation, from either side:

```bash
npx ihow-memory search "package manager" --space handoff-demo
```

---

## Act 3 (30s) — the trust reveal

```bash
npx ihow-memory status --space handoff-demo                          # cloud=false, sync=false — never left the machine
find ~/.ihow-memory/handoff-demo -name '*.ndjson' -exec cat {} \;    # the append-only audit log: every candidate + promote
```

Each line in the audit log is one event (who proposed, who promoted, when). For a visual browse, `npx ihow-memory console --space handoff-demo` opens a read-only local UI for status, search and cited reads.

> Narrate: "No cloud. No telemetry. Nothing auto-written without review. Every remembered fact traces to who proposed it and who approved it. **Not the smartest memory — the one you can trust and audit.**"

Clean up:

```bash
npx ihow-memory reset --space handoff-demo
```

---

## The one-liner

> **"What Claude Code learns, Codex already knows — locally, with a citation, and nothing remembered without your say-so."**

## Recording tips (for the website hero / Show HN)

- Record the terminal with [asciinema](https://asciinema.org/) (`asciinema rec`) → convert to GIF with `agg`.
- Two panes side by side (Claude Code | Codex) so the handoff is visible in one frame.
- The screenshot that sells it: Codex's answer with its citation path, beside the Markdown file Claude Code created.

## Honest notes

- Alpha software. Retrieval is lexical FTS5 by default (no semantic vectors) — exact-and-substring recall, not fuzzy paraphrase matching.
- `connect` runs the MCP server against the space's memory directory, so an agent's promoted memory lands under `memory/_mcp/promoted/`; `search`, `read` and `console` find it regardless — don't hardcode internal paths in a demo.
- The promote step is deliberate (the governance gate). For a hands-off run you can tell each agent to promote its own candidate; the human-in-the-loop is the point, not a limitation.
