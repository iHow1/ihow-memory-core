#!/usr/bin/env bash
set -euo pipefail

ROOT="${IHOW_MEMORY_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
RUNTIME=""
OP=""
ANCHOR=""
HASH_BEFORE=""
HASH_AFTER=""
SOURCE_SESSION=""
EXTRA_JSON="{}"
EVENT_DATE="$(date +%F)"
PROJECT_ID=""
TENANT_ID="local"
CUSTOMER_ID="local"
USER_ID="operator"
ACTOR_TYPE="agent"
ACTOR_NAME=""
SUMMARY=""
SENSITIVITY="normal"

usage() {
  cat >&2 <<'EOF'
Usage: event-log.sh --runtime <runtime> --op <op> --anchor <path-or-anchor> [options]

Options:
  --root <dir>              iHow Memory workspace root (default: tool parent)
  --date <YYYY-MM-DD>       event file date (default: today)
  --hash-before <sha|null>  previous content hash
  --hash-after <sha|null>   new content hash; defaults to sha256(anchor) when anchor is a file
  --source-session <id>     runtime/session identifier
  --project-id <id>         protocol namespace.project_id (default: workspace basename)
  --tenant-id <id>          protocol namespace.tenant_id (default: local)
  --customer-id <id>        protocol namespace.customer_id (default: local)
  --user-id <id>            protocol namespace.user_id (default: operator)
  --actor-type <type>       protocol actor.type (default: agent)
  --actor-name <name>       protocol actor.name (default: runtime)
  --summary <text>          protocol summary (default: generated)
  --sensitivity <level>     protocol sensitivity (default: normal)
  --extra-json <json>       op-specific JSON object
  -h, --help                show this help

Writes one append-only NDJSON event to memory/_events/<date>.ndjson.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root)
      ROOT="${2:-}"; shift 2 ;;
    --runtime)
      RUNTIME="${2:-}"; shift 2 ;;
    --op)
      OP="${2:-}"; shift 2 ;;
    --anchor)
      ANCHOR="${2:-}"; shift 2 ;;
    --date)
      EVENT_DATE="${2:-}"; shift 2 ;;
    --hash-before)
      HASH_BEFORE="${2:-}"; shift 2 ;;
    --hash-after)
      HASH_AFTER="${2:-}"; shift 2 ;;
    --source-session)
      SOURCE_SESSION="${2:-}"; shift 2 ;;
    --project-id)
      PROJECT_ID="${2:-}"; shift 2 ;;
    --tenant-id)
      TENANT_ID="${2:-}"; shift 2 ;;
    --customer-id)
      CUSTOMER_ID="${2:-}"; shift 2 ;;
    --user-id)
      USER_ID="${2:-}"; shift 2 ;;
    --actor-type)
      ACTOR_TYPE="${2:-}"; shift 2 ;;
    --actor-name)
      ACTOR_NAME="${2:-}"; shift 2 ;;
    --summary)
      SUMMARY="${2:-}"; shift 2 ;;
    --sensitivity)
      SENSITIVITY="${2:-}"; shift 2 ;;
    --extra-json)
      EXTRA_JSON="${2:-}"; shift 2 ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 2 ;;
  esac
done

if [[ -z "$RUNTIME" || -z "$OP" || -z "$ANCHOR" ]]; then
  usage
  exit 2
fi

PYTHON="${PYTHON:-}"
if [[ -z "$PYTHON" ]]; then
  if command -v python3 >/dev/null 2>&1; then
    PYTHON="python3"
  elif command -v python >/dev/null 2>&1; then
    PYTHON="python"
  else
    echo "python3 or python is required" >&2
    exit 127
  fi
fi

export EVENT_ROOT="$ROOT"
export EVENT_RUNTIME="$RUNTIME"
export EVENT_OP="$OP"
export EVENT_ANCHOR="$ANCHOR"
export EVENT_HASH_BEFORE="$HASH_BEFORE"
export EVENT_HASH_AFTER="$HASH_AFTER"
export EVENT_SOURCE_SESSION="$SOURCE_SESSION"
export EVENT_EXTRA_JSON="$EXTRA_JSON"
export EVENT_DATE="$EVENT_DATE"
export EVENT_PROJECT_ID="$PROJECT_ID"
export EVENT_TENANT_ID="$TENANT_ID"
export EVENT_CUSTOMER_ID="$CUSTOMER_ID"
export EVENT_USER_ID="$USER_ID"
export EVENT_ACTOR_TYPE="$ACTOR_TYPE"
export EVENT_ACTOR_NAME="$ACTOR_NAME"
export EVENT_SUMMARY="$SUMMARY"
export EVENT_SENSITIVITY="$SENSITIVITY"

"$PYTHON" <<'PY'
from __future__ import annotations

import datetime as _dt
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import uuid

ROOT = Path(os.environ["EVENT_ROOT"]).expanduser().resolve()
RUNTIME = os.environ["EVENT_RUNTIME"].strip()
OP = os.environ["EVENT_OP"].strip()
ANCHOR_RAW = os.environ["EVENT_ANCHOR"].strip()
DATE = os.environ["EVENT_DATE"].strip()
EXTRA_RAW = os.environ["EVENT_EXTRA_JSON"]
PROJECT_ID_RAW = os.environ["EVENT_PROJECT_ID"].strip()
TENANT_ID = os.environ["EVENT_TENANT_ID"].strip() or "local"
CUSTOMER_ID = os.environ["EVENT_CUSTOMER_ID"].strip() or "local"
USER_ID = os.environ["EVENT_USER_ID"].strip() or "operator"
ACTOR_TYPE = os.environ["EVENT_ACTOR_TYPE"].strip() or "agent"
ACTOR_NAME_RAW = os.environ["EVENT_ACTOR_NAME"].strip()
SUMMARY_RAW = os.environ["EVENT_SUMMARY"].strip()
SENSITIVITY = os.environ["EVENT_SENSITIVITY"].strip() or "normal"

IDENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
SENSITIVITY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,39}$")
DENY_KEY_RE = re.compile(r"(password|passwd|secret|token|api[_-]?key|credential|authorization|cookie)", re.I)
DENY_VALUE_RES = [
    re.compile(r"sk-[A-Za-z0-9_-]{16,}"),
    re.compile(r"xox[baprs]-[A-Za-z0-9-]{20,}", re.I),
    re.compile(r"gh[pousr]_[A-Za-z0-9_]{20,}", re.I),
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"bearer\s+[A-Za-z0-9._~+/=-]{20,}", re.I),
    re.compile(r"(secret|token|password|api[_-]?key)\s*[:=]\s*\S+", re.I),
]


def fail(message: str) -> None:
    print(f"event-log: {message}", file=sys.stderr)
    raise SystemExit(2)


def normalize_nullable_hash(value: str) -> str | None:
    value = value.strip()
    if value == "" or value.lower() == "null":
        return None
    if not re.fullmatch(r"[A-Fa-f0-9]{64}", value):
        fail("hash values must be sha256 hex or null")
    return value.lower()


def normalize_anchor(raw: str) -> tuple[str, Path | None]:
    if raw == "":
        fail("anchor is required")
    candidate = Path(raw).expanduser()
    if candidate.is_absolute():
        resolved = candidate.resolve()
        try:
            rel = resolved.relative_to(ROOT)
        except ValueError:
            fail("absolute anchors must stay inside the workspace root")
        rel_text = rel.as_posix()
        return rel_text, ROOT / rel
    normalized = Path(os.path.normpath(raw))
    if normalized.is_absolute() or str(normalized).startswith(".."):
        fail("relative anchors may not escape the workspace root")
    rel_text = normalized.as_posix()
    if rel_text == ".":
        fail("anchor is required")
    return rel_text, ROOT / normalized


def sha256_file(path: Path) -> str | None:
    try:
        if not path.is_file() or path.is_symlink():
            return None
        h = hashlib.sha256()
        with path.open("rb") as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                h.update(chunk)
        return h.hexdigest()
    except FileNotFoundError:
        return None


def scan_redact(value, path: str = "$") -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            if DENY_KEY_RE.search(str(key)):
                fail(f"redact-check failed at {path}.{key}: sensitive key name")
            scan_redact(child, f"{path}.{key}")
    elif isinstance(value, list):
        for idx, child in enumerate(value):
            scan_redact(child, f"{path}[{idx}]")
    elif isinstance(value, str):
        for pattern in DENY_VALUE_RES:
            if pattern.search(value):
                fail(f"redact-check failed at {path}: sensitive-looking value")


def event_type_for_op(op: str) -> str:
    return {
        "init": "handoff",
        "read": "context_retrieval",
        "write": "validation",
        "commit": "decision",
        "handoff": "handoff",
        "rollback": "rollback",
        "restore": "restore",
    }.get(op, op)


def source_kind_for_anchor(anchor: str) -> str:
    if "/" in anchor or "." in Path(anchor).name:
        return "file"
    return "anchor"


if not IDENT_RE.fullmatch(RUNTIME):
    fail("runtime must match [A-Za-z0-9][A-Za-z0-9._:-]{0,79}")
if not IDENT_RE.fullmatch(OP):
    fail("op must match [A-Za-z0-9][A-Za-z0-9._:-]{0,79}; custom ops are allowed")
if not DATE_RE.fullmatch(DATE):
    fail("date must be YYYY-MM-DD")
if not SENSITIVITY_RE.fullmatch(SENSITIVITY):
    fail("sensitivity must be a short identifier")

try:
    extra = json.loads(EXTRA_RAW)
except json.JSONDecodeError as exc:
    fail(f"extra-json must be valid JSON: {exc}")
if not isinstance(extra, dict):
    fail("extra-json must be a JSON object")

anchor, anchor_path = normalize_anchor(ANCHOR_RAW)
hash_before = normalize_nullable_hash(os.environ["EVENT_HASH_BEFORE"])
hash_after = normalize_nullable_hash(os.environ["EVENT_HASH_AFTER"])
if hash_after is None and anchor_path is not None:
    hash_after = sha256_file(anchor_path)

source_session = os.environ["EVENT_SOURCE_SESSION"].strip() or None
project_id = PROJECT_ID_RAW or ROOT.name
actor_name = ACTOR_NAME_RAW or RUNTIME
summary = SUMMARY_RAW or f"{RUNTIME} {OP} {anchor}"
protocol_event = {
    "event_id": f"evt_{uuid.uuid4().hex}",
    "namespace": {
        "tenant_id": TENANT_ID,
        "customer_id": CUSTOMER_ID,
        "project_id": project_id,
        "user_id": USER_ID,
    },
    "event_type": event_type_for_op(OP),
    "actor": {
        "type": ACTOR_TYPE,
        "name": actor_name,
    },
    "occurred_at": _dt.datetime.now().astimezone().isoformat(timespec="seconds"),
    "summary": summary,
    "source": {
        "kind": source_kind_for_anchor(anchor),
        "uri": anchor,
        "reference": anchor,
    },
    "sensitivity": SENSITIVITY,
    "metadata": {
        "anchor": anchor,
        "local_schema_version": "ihow.events.v0",
        "local_op": OP,
        "runtime": RUNTIME,
        "hash_before": hash_before,
        "hash_after": hash_after,
        "source_session": source_session,
        "extra": extra,
    },
}
event = {
    "schema_version": "ihow.events.v0",
    "event_id": str(uuid.uuid4()),
    "ts": _dt.datetime.now().astimezone().isoformat(timespec="seconds"),
    "runtime": RUNTIME,
    "op": OP,
    "anchor": anchor,
    "hash_before": hash_before,
    "hash_after": hash_after,
    "source_session": source_session,
    "extra": extra,
    "protocol_event": protocol_event,
}
scan_redact(event)

events_dir = ROOT / "memory" / "_events"
events_dir.mkdir(parents=True, exist_ok=True)
event_file = events_dir / f"{DATE}.ndjson"
line = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
with event_file.open("a", encoding="utf-8") as f:
    f.write(line + "\n")

print(event_file.relative_to(ROOT).as_posix())
print(event["event_id"])
PY
