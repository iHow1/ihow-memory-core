#!/usr/bin/env bash
# 03-two-agents-shared-memory.sh
#
# End-to-end demo of two AI agents sharing one governed iHow Memory space:
#
#   agent A (MCP stdio)  --> memory.write_candidate   (sandbox inbox, not searchable)
#   governance (CLI)     --> ihow-memory promote      (audit event, durable scope file)
#   agent B (MCP stdio)  --> memory.search + memory.read (citation-backed read-back)
#
# Both "agents" talk to the same stdio MCP server binary that Claude Code /
# Codex / Cursor would launch (dist/mcp/server.js). No network, no accounts.
#
# Usage:
#   bash examples/03-two-agents-shared-memory.sh
#
# Environment:
#   KEEP_STATE_ROOT=1   keep the temporary state root for inspection
#
# Requirements: Node >= 22.12 (node:sqlite), macOS/Linux, dist/ built.
# The script is idempotent: every run uses a fresh mktemp state root and
# cleans it up on exit. It never touches ~/.ihow-memory or any runtime config.

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
SERVER_JS="$REPO_DIR/dist/mcp/server.js"
CLI="$REPO_DIR/bin/ihow-memory.mjs"
SPACE="shared-demo"

command -v node >/dev/null 2>&1 || { echo "error: node not found on PATH (need Node >= 22.12)" >&2; exit 1; }
[[ -f "$SERVER_JS" ]] || { echo "error: $SERVER_JS not found. Run 'npm run build' in $REPO_DIR first." >&2; exit 1; }

STATE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ihow-two-agents.XXXXXX")"
cleanup() {
  if [[ "${KEEP_STATE_ROOT:-0}" == "1" ]]; then
    echo "state root kept at: $STATE_ROOT"
  else
    rm -rf "$STATE_ROOT"
  fi
}
trap cleanup EXIT
trap 'echo "FAIL two-agents-shared-memory: aborted at line $LINENO" >&2' ERR

# Unique per run, so re-runs never collide on search results.
MARKER="copper-finch-$(date +%s)-$$"

# mcp_call <agent-name> <tool> <json-arguments>
# Spawns one stdio MCP server process (the same entry point an AI runtime
# launches), performs initialize + a single tools/call, prints raw JSON-RPC
# response lines. One call per process: the server handles stdin lines
# concurrently, so a real client always awaits a response before the next
# request — we model that by giving each call its own process.
mcp_call() {
  local agent="$1" tool="$2" args="$3"
  printf '%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"'"$agent"'","version":"0.0.0"}}}' \
    '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"'"$tool"'","arguments":'"$args"'}}' \
    | node "$SERVER_JS" --root "$STATE_ROOT" --space "$SPACE"
}

# rpc_field <dot-path>  — stdin: raw JSON-RPC lines from mcp_call.
# Picks the id:2 response and extracts a field from result.structuredContent.
rpc_field() {
  node -e '
const fs = require("fs");
const expr = process.argv[1];
const lines = fs.readFileSync(0, "utf8").trim().split("\n").filter(Boolean);
const msg = lines.map((l) => JSON.parse(l)).find((m) => m.id === 2);
if (!msg) { console.error("no JSON-RPC response with id 2"); process.exit(1); }
if (msg.error) { console.error("rpc error: " + JSON.stringify(msg.error)); process.exit(1); }
let v = msg.result.structuredContent;
for (const key of expr.split(".").filter(Boolean)) v = v == null ? undefined : v[key];
if (v === undefined) { console.error("missing field: " + expr); process.exit(1); }
process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));
' "$1"
}

# json_field <dot-path>  — stdin: a single JSON document (CLI --json output).
json_field() {
  node -e '
const fs = require("fs");
const expr = process.argv[1];
let v = JSON.parse(fs.readFileSync(0, "utf8"));
for (const key of expr.split(".").filter(Boolean)) v = v == null ? undefined : v[key];
if (v === undefined) { console.error("missing field: " + expr); process.exit(1); }
process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));
' "$1"
}

FAILURES=0
check_eq() { # <description> <expected> <actual>
  if [[ "$2" == "$3" ]]; then
    printf 'ok   %s\n' "$1"
  else
    printf 'FAIL %s\n     expected: %s\n     actual:   %s\n' "$1" "$2" "$3"
    FAILURES=$((FAILURES + 1))
  fi
}
check_prefix() { # <description> <prefix> <actual>
  if [[ "$3" == "$2"* ]]; then
    printf 'ok   %s\n' "$1"
  else
    printf 'FAIL %s\n     expected prefix: %s\n     actual:          %s\n' "$1" "$2" "$3"
    FAILURES=$((FAILURES + 1))
  fi
}
check_contains() { # <description> <needle> <haystack>
  if [[ "$3" == *"$2"* ]]; then
    printf 'ok   %s\n' "$1"
  else
    printf 'FAIL %s (needle not found: %s)\n' "$1" "$2"
    FAILURES=$((FAILURES + 1))
  fi
}

echo "iHow Memory — two agents, one governed memory space"
echo "state root: $STATE_ROOT (temporary)"
echo "space:      $SPACE"
echo "marker:     $MARKER"
echo

echo "==> step 1: agent A proposes a memory (MCP memory.write_candidate)"
A_OUT="$(mcp_call agent-a memory.write_candidate \
  '{"text":"Agent A field note: prefer additive DB migrations; clean up in a follow-up release. Marker: '"$MARKER"'.","title":"agent-a-handoff","sourceAgent":"agent-a"}')"
CAND_PATH="$(printf '%s' "$A_OUT" | rpc_field path)"
CAND_STATUS="$(printf '%s' "$A_OUT" | rpc_field status)"
echo "candidate: $CAND_PATH"
check_eq    "candidate status is 'candidate'" "candidate" "$CAND_STATUS"
check_prefix "candidate lands in the sandbox inbox" "memory/candidate/inbox/" "$CAND_PATH"
echo

echo "==> step 2: agent B searches before governance (expects no hits)"
B_PRE="$(mcp_call agent-b memory.search '{"query":"'"$MARKER"'","limit":5}')"
PRE_HITS="$(printf '%s' "$B_PRE" | rpc_field length)"
check_eq "candidates are not searchable until promoted" "0" "$PRE_HITS"
echo

echo "==> step 3: governance promotes the candidate (CLI, writes audit event)"
PROMOTE_OUT="$(node "$CLI" promote "$CAND_PATH" --root "$STATE_ROOT" --space "$SPACE" --scope shared --title agent-a-handoff)"
PROMOTED_PATH="$(printf '%s' "$PROMOTE_OUT" | json_field path)"
PROMOTE_STATUS="$(printf '%s' "$PROMOTE_OUT" | json_field status)"
PROMOTE_EVENT="$(printf '%s' "$PROMOTE_OUT" | json_field eventId)"
echo "promoted:  $PROMOTED_PATH"
echo "event id:  $PROMOTE_EVENT"
check_eq    "promote status is 'promoted'" "promoted" "$PROMOTE_STATUS"
check_prefix "promoted into a governed scope" "memory/scopes/shared/" "$PROMOTED_PATH"
echo

echo "==> step 4: agent B searches again (MCP memory.search)"
B_SEARCH="$(mcp_call agent-b memory.search '{"query":"'"$MARKER"'","limit":5}')"
HIT_PATH="$(printf '%s' "$B_SEARCH" | rpc_field 0.path)"
HIT_CITATION="$(printf '%s' "$B_SEARCH" | rpc_field 0.citation.path)"
HIT_SOURCE="$(printf '%s' "$B_SEARCH" | rpc_field 0.source)"
echo "hit:       $HIT_PATH (source=$HIT_SOURCE)"
check_eq "search hit is the promoted file" "$PROMOTED_PATH" "$HIT_PATH"
check_eq "search hit carries a citation path" "$PROMOTED_PATH" "$HIT_CITATION"
echo

echo "==> step 5: agent B reads the cited file (MCP memory.read)"
B_READ="$(mcp_call agent-b memory.read '{"ref":"'"$HIT_PATH"'"}')"
READ_CONTENT="$(printf '%s' "$B_READ" | rpc_field content)"
READ_CITATION="$(printf '%s' "$B_READ" | rpc_field citation.path)"
check_contains "read-back contains agent A's marker" "$MARKER" "$READ_CONTENT"
check_eq       "read result cites the same file" "$PROMOTED_PATH" "$READ_CITATION"
echo

echo "==> step 6: audit trail (append-only NDJSON events)"
EVENTS_DIR="$STATE_ROOT/$SPACE/memory/_events"
if grep -hq '"type":"candidate.created"' "$EVENTS_DIR"/*.ndjson 2>/dev/null; then
  printf 'ok   audit has candidate.created (actor: agent-a)\n'
else
  printf 'FAIL audit missing candidate.created event\n'; FAILURES=$((FAILURES + 1))
fi
if grep -hq '"type":"memory.promoted"' "$EVENTS_DIR"/*.ndjson 2>/dev/null; then
  printf 'ok   audit has memory.promoted\n'
else
  printf 'FAIL audit missing memory.promoted event\n'; FAILURES=$((FAILURES + 1))
fi
echo

echo "==> step 7: status stays local-only"
STATUS_OUT="$(node "$CLI" status --root "$STATE_ROOT" --space "$SPACE" --json)"
check_eq "provider.cloud is false" "false" "$(printf '%s' "$STATUS_OUT" | json_field provider.cloud)"
check_eq "sync.enabled is false"   "false" "$(printf '%s' "$STATUS_OUT" | json_field sync.enabled)"
echo

if [[ "$FAILURES" -eq 0 ]]; then
  echo "PASS two-agents-shared-memory: A wrote -> governance promoted -> B read back with citation, local-only"
else
  echo "FAIL two-agents-shared-memory: $FAILURES check(s) failed"
  exit 1
fi
