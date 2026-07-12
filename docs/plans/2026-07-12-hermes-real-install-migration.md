# Hermes iHow Memory — Real Install Migration Plan

Status: STOP GATE — requires explicit approval before applying

## Current verified state

- Development branch: `alpha27-hermes-runtime-adapter`
- Verified commit: `4971a74`
- Runtime adapter: packaged, fresh-install tested, host-native lifecycle tested in temporary `HERMES_HOME`
- Real Hermes home remains unchanged: `$HERMES_HOME`
- Current real product state: `TOOLS ONLY`

## Current real Hermes bindings

### Legacy MCP

- Registered name: `ihowmemory`
- Transport: stdio Python wrapper
- Wrapper: `$HERMES_HOME/mcp-servers/ihowmemory_mcp.py`
- Legacy CLI target: `$LEGACY_IHOW_MEMORY_CLI`
- Tools: 6

### Native lifecycle plugin

- Plugin `ihow-memory`: absent
- `plugins.enabled`: empty
- Native lifecycle evidence: absent

## Proposed changes

1. Create a timestamped backup directory under `$HERMES_HOME/backups/ihow-memory-real-install-<timestamp>/`.
2. Back up at minimum:
   - `$HERMES_HOME/config.yaml`
   - `$HERMES_HOME/mcp-servers/ihowmemory_mcp.py`
   - any existing `$HERMES_HOME/plugins/ihow-memory/`
3. Build and pack commit `4971a74` locally; do not publish.
4. Install the tarball into a versioned runtime directory under `$HERMES_HOME/runtime/ihow-memory/` so `ihow-memory-hermes-bridge` has its complete `dist/` dependency graph.
5. Copy only the Python plugin integration to `$HERMES_HOME/plugins/ihow-memory/`.
6. Add `ihow-memory` to `plugins.enabled` without changing unrelated config.
7. Register canonical MCP name `ihow-memory` against the package-owned MCP server.
8. Keep legacy `ihowmemory` available during the first verification phase, but disable it only after canonical MCP and native lifecycle verification pass. Do not delete the legacy wrapper in the first phase.
9. Record `configured` evidence bound to the exact installed plugin and bridge generation.
10. Restart or reload the Hermes host only as required by Hermes plugin discovery.
11. Run a real Hermes lifecycle verification:
    - session start
    - before prompt recall
    - finalize/session end checkpoint
    - native-hook completed evidence
    - doctor state `ACTIVE`
12. After all checks pass, disable legacy `ihowmemory`; retain its backup for rollback.

## Verification gates

- `hermes plugins list` shows `ihow-memory` enabled with six hooks.
- `hermes mcp test ihow-memory` connects and discovers the canonical tool surface.
- No conflicting `ihow-memory` / `ihowmemory` active binding remains after cutover.
- Recall is injected through `pre_llm_call` without model-initiated MCP use.
- `on_session_finalize` creates a valid immutable Checkpoint.
- Activation evidence is from `native-hook`, same installation generation, `observed-live-completed`.
- Doctor reports `ACTIVE` only after the above evidence.
- Raw prompt, response, history, tool results, and checkpoint claims do not appear in Python plugin logs.
- Bridge failure remains fail-open.

## Rollback

1. Stop/reload Hermes host if needed.
2. Restore backed-up `config.yaml` atomically.
3. Restore/remove `$HERMES_HOME/plugins/ihow-memory/` to its pre-install state.
4. Remove the versioned runtime directory created by this install.
5. Restore legacy wrapper if changed.
6. Verify `hermes mcp test ihowmemory` again reports six tools.
7. Confirm lifecycle status returns to `TOOLS ONLY`, not a false `ACTIVE`.

## Explicit non-actions

- No push, merge, tag, npm publish, or release.
- No deletion of legacy files before successful verification.
- No credential changes.
- No changes to OpenClaw worktree.
- No migration proceeds without explicit user approval at this stop gate.