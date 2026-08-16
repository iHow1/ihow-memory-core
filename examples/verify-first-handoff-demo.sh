#!/usr/bin/env bash
# Replays the shipped verify-first proof with synthetic data only.
# The CLI owns and removes its temporary git repo and memory workspace.

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
CLI="$REPO_DIR/bin/ihow-memory.mjs"

command -v node >/dev/null 2>&1 || {
  echo "error: Node.js >= 22.12 is required" >&2
  exit 1
}

node -e '
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 12)) process.exit(1);
' || {
  echo "error: Node.js >= 22.12 is required; found $(node --version)" >&2
  exit 1
}

if [[ ! -f "$REPO_DIR/dist/cli.js" ]]; then
  echo "Building the local CLI..."
  npm --prefix "$REPO_DIR" run build
fi

OUTPUT="$(node "$CLI" proof)"
printf '%s\n' "$OUTPUT"

for evidence in \
  "prior narrative: UNVERIFIED" \
  "receiver verdict before drift: GREEN" \
  "receiver verdict after drift: RED" \
  "agent B search hit:" \
  "citation:" \
  "audit event:" \
  "PASS proof:"; do
  if [[ "$OUTPUT" != *"$evidence"* ]]; then
    echo "error: proof completed without required evidence: $evidence" >&2
    exit 1
  fi
done
