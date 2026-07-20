"""Fail-open Hermes lifecycle adapter for iHow Memory.

The first slice is intentionally transport-thin: hooks emit metadata-only runtime events and
`pre_llm_call` may inject bounded recall returned by a configured adapter transport. Raw prompts,
responses, and conversation histories are never written to the adapter event log.
"""

from __future__ import annotations

import json
import hashlib
import logging
import os
import shutil
import subprocess
import threading
import time
import re
import unicodedata
from collections import OrderedDict
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)
_MAX_CONTEXT_CHARS = 8_000
_MAX_PROMPT_DIGEST_CHARS = 2_000
_MAX_RECEIPT_ID_BYTES = 512
_MAX_PROJECT_ROOT_BYTES = 4_096
_MAX_SIDECAR_ARGUMENT_BYTES = 16_384
_MAX_COMPILED_DELTA_BYTES = 8 * 1_024
_MAX_PENDING_RECEIPTS = 256
_PENDING_RECEIPT_TTL_SECONDS = 3_600
_pending_receipts_lock = threading.RLock()
_pending_receipts: OrderedDict[str, dict[str, Any]] = OrderedDict()
_MAX_RECEIPT_ALIASES = 256
_RECEIPT_ALIAS_TTL_SECONDS = 3_600
_receipt_aliases: OrderedDict[str, dict[str, Any]] = OrderedDict()
_LOWER_HEX_64_RE = re.compile(r"^[a-f0-9]{64}$")
_DURABLE_INPUT_KEYS = frozenset({
    "schemaVersion",
    "identityDomain",
    "sessionHash",
    "turnId",
    "inputSourceHash",
    "inputContentSha256",
})
_MEMORY_DELTA_KINDS = frozenset({"preference", "fact", "event", "procedure"})
_ECMASCRIPT_WHITESPACE = (
    "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680"
    "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000\ufeff"
)
_ECMASCRIPT_WHITESPACE_RE = re.compile(f"[{re.escape(_ECMASCRIPT_WHITESPACE)}]+")
_SECRET_LIKE_PATTERNS = tuple(re.compile(pattern, re.IGNORECASE) for pattern in (
    r"\b(api[_-]?key|secret|token|password|passwd|pwd|cookie|authorization|bearer|refresh[_-]?token|access[_-]?token|private[_-]?key|client[_-]?secret|aws[_-]?secret[_-]?access[_-]?key|aws[_-]?access[_-]?key[_-]?id)\b\s*[:=]",
    r"\bBearer\s+[A-Za-z0-9._~+/=-]{12,}",
    r"\bsk-[A-Za-z0-9_-]{16,}\b",
    r"\b(?:sk|rk)_live_[0-9A-Za-z]{16,}\b",
    r"\b(?:github_pat_[0-9A-Za-z_]{20,}|gh[oprsu]_[0-9A-Za-z]{16,})\b",
    r"\bAKIA[0-9A-Z]{16}\b",
    r"\bAIza[0-9A-Za-z_-]{35}\b",
    r"\bya29\.[0-9A-Za-z._-]{20,}",
    r"\bxox[baprs]-[0-9A-Za-z-]{10,}",
    r"\bSK[0-9a-f]{32}\b",
    r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b",
    r"-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----",
    r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}",
    r"(?:账号|账户|邮箱|密码|密钥|令牌)\s*[:：=]\s*\S+",
    r"\b[a-z][a-z0-9+.-]*://[^\s/:@]+:[^\s/:@]+@\S+",
    r"\bAuthorization\s*:\s*Bearer\s+\S+",
    r"\bBearer\s+\S*@\S+",
    r"\bBearer\s+(?=[A-Za-z0-9._~+/=-]{8,}(?![A-Za-z0-9._~+/=-]))(?=\S*[0-9._~+/=-])[A-Za-z0-9._~+/=-]{8,}(?![A-Za-z0-9._~+/=-])",
))
_DELTA_TOOL_DESCRIPTION = (
    "Control-only terminal sidecar for the same final response. This is not a user command and "
    "must not trigger a second LLM, API, or tool round. Emit exactly one typed memory delta or "
    "explicit_none only when the response is terminal."
)
_DELTA_TOOL_PARAMETERS = {
    "oneOf": [
        {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "schemaVersion": {"type": "integer", "const": 1},
                "status": {"type": "string", "const": "emitted"},
                "proposal": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "kind": {"type": "string", "enum": ["preference", "fact", "event", "procedure"]},
                        "subject": {"type": "string", "minLength": 1, "maxLength": 120},
                        "key": {"type": "string", "minLength": 1, "maxLength": 120},
                        "value": {"type": "string", "minLength": 1, "maxLength": 1_200},
                    },
                    "required": ["kind", "subject", "key", "value"],
                },
            },
            "required": ["schemaVersion", "status", "proposal"],
        },
        {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "schemaVersion": {"type": "integer", "const": 1},
                "status": {"type": "string", "const": "explicit_none"},
            },
            "required": ["schemaVersion", "status"],
        },
    ],
}



def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _now_millis() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _sha256(domain: str, value: str) -> str:
    return hashlib.sha256((domain + value).encode("utf-8")).hexdigest()


def _canonical_sha256(value: Any) -> str:
    canonical = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False,
    ) + "\n"
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _utf16_length(value: str) -> int:
    return len(value.encode("utf-16-le")) // 2


def _normalize_proposal_text(value: str) -> str:
    # This mirrors Core normalizeProposalTextV1: NFKC, ECMAScript trim, then Unicode whitespace collapse.
    normalized = unicodedata.normalize("NFKC", value)
    normalized = normalized.strip(_ECMASCRIPT_WHITESPACE)
    return _ECMASCRIPT_WHITESPACE_RE.sub(" ", normalized)


def _exact_model_text(value: Any, maximum: int) -> Optional[str]:
    if not isinstance(value, str) or not value:
        return None
    if _utf16_length(value) > maximum or _normalize_proposal_text(value) != value:
        return None
    return value


def _contains_secret_like_content(value: str) -> bool:
    return any(pattern.search(value) is not None for pattern in _SECRET_LIKE_PATTERNS)


def _exact_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("ihow_memory_delta_duplicate_json_key")
        result[key] = value
    return result


def _reject_json_constant(_value: str) -> None:
    raise ValueError("ihow_memory_delta_non_json_number")


def _receipt_correlation_key(session_hash: str, turn_id: str) -> str:
    return _sha256("hermes-turn-receipt-correlation-v1\0", session_hash + "\0" + turn_id)


def _is_lower_hex_64(value: Any) -> bool:
    return isinstance(value, str) and _LOWER_HEX_64_RE.fullmatch(value) is not None


def _durable_input_evidence(value: Any) -> Optional[dict[str, Any]]:
    if not isinstance(value, dict) or set(value) != _DURABLE_INPUT_KEYS:
        return None
    if type(value.get("schemaVersion")) is not int or value["schemaVersion"] != 1:
        return None
    if value.get("identityDomain") != "hermes-transcript-v1":
        return None
    if not _is_lower_hex_64(value.get("sessionHash")):
        return None
    if not _is_lower_hex_64(value.get("turnId")):
        return None
    source_hash = value.get("inputSourceHash")
    if not isinstance(source_hash, str) or not source_hash.startswith("sha256:"):
        return None
    if not _is_lower_hex_64(source_hash[7:]):
        return None
    if not _is_lower_hex_64(value.get("inputContentSha256")):
        return None
    return value


def _pending_key(receipt: dict[str, Any]) -> str:
    return _receipt_correlation_key(receipt["sessionHash"], receipt["turnId"])


def _raw_alias_key(kwargs: dict[str, Any]) -> Optional[str]:
    session_hash, turn_hash = _bounded_correlation(kwargs)
    if not session_hash or not turn_hash:
        return None
    return _receipt_correlation_key(session_hash, turn_hash)


def _prune_receipt_aliases_locked(now: float) -> None:
    stale_before = now - _RECEIPT_ALIAS_TTL_SECONDS
    stale = [key for key, value in _receipt_aliases.items() if value["_touched"] < stale_before]
    for key in stale:
        _receipt_aliases.pop(key, None)
    while len(_receipt_aliases) > _MAX_RECEIPT_ALIASES:
        _receipt_aliases.popitem(last=False)


def _bind_receipt_alias(kwargs: dict[str, Any], pending_key: str) -> None:
    alias_key = _raw_alias_key(kwargs)
    if alias_key is None:
        return
    now = time.monotonic()
    with _pending_receipts_lock:
        _prune_receipt_aliases_locked(now)
        existing = _receipt_aliases.get(alias_key)
        if existing is not None and existing.get("pendingKey") != pending_key:
            existing.clear()
            existing.update({"poisoned": True, "_touched": now})
        elif existing is None:
            _receipt_aliases[alias_key] = {"pendingKey": pending_key, "_touched": now}
        else:
            existing["_touched"] = now
        _receipt_aliases.move_to_end(alias_key)
        _prune_receipt_aliases_locked(now)


def _resolve_receipt_alias(kwargs: dict[str, Any]) -> Optional[str]:
    alias_key = _raw_alias_key(kwargs)
    if alias_key is None:
        return None
    now = time.monotonic()
    with _pending_receipts_lock:
        _prune_receipt_aliases_locked(now)
        alias = _receipt_aliases.get(alias_key)
        if alias is None or alias.get("poisoned") is True:
            return None
        pending_key = alias.get("pendingKey")
        if not isinstance(pending_key, str) or pending_key not in _pending_receipts:
            _receipt_aliases.pop(alias_key, None)
            return None
        alias["_touched"] = now
        _receipt_aliases.move_to_end(alias_key)
        return pending_key


def _clear_receipt_alias(kwargs: dict[str, Any]) -> None:
    alias_key = _raw_alias_key(kwargs)
    if alias_key is None:
        return
    with _pending_receipts_lock:
        _receipt_aliases.pop(alias_key, None)


def _prune_pending_receipts_locked(now: float) -> None:
    stale_before = now - _PENDING_RECEIPT_TTL_SECONDS
    stale = [key for key, value in _pending_receipts.items() if value["_touched"] < stale_before]
    for key in stale:
        _pending_receipts.pop(key, None)
    while len(_pending_receipts) > _MAX_PENDING_RECEIPTS:
        _pending_receipts.popitem(last=False)


def _retain_open_receipt(receipt: dict[str, Any]) -> str:
    now = time.monotonic()
    key = _pending_key(receipt)
    with _pending_receipts_lock:
        _prune_pending_receipts_locked(now)
        existing = _pending_receipts.get(key)
        if existing is not None and _same_input_evidence(existing, receipt):
            existing["_touched"] = now
            _pending_receipts.move_to_end(key)
            return key
        _pending_receipts[key] = {
            "schemaVersion": receipt["schemaVersion"],
            "identityDomain": receipt["identityDomain"],
            "origin": receipt["origin"],
            "runtime": receipt["runtime"],
            "projectId": receipt["projectId"],
            "sessionHash": receipt["sessionHash"],
            "turnId": receipt["turnId"],
            "revision": receipt["revision"],
            "inputSourceHash": receipt["inputSourceHash"],
            "inputContentSha256": receipt["inputContentSha256"],
            "openedAt": receipt["openedAt"],
            "_touched": now,
        }
        _pending_receipts.move_to_end(key)
        _prune_pending_receipts_locked(now)
        return key


def _same_input_evidence(left: dict[str, Any], right: dict[str, Any]) -> bool:
    return all(left.get(field) == right.get(field) for field in (
        "schemaVersion", "identityDomain", "origin", "runtime", "projectId", "sessionHash",
        "turnId", "revision", "inputSourceHash", "inputContentSha256",
    ))


def _bounded_correlation(kwargs: dict[str, Any]) -> tuple[Optional[str], Optional[str]]:
    session_id = _bounded_identity(kwargs.get("session_id"))
    turn_id = _bounded_identity(kwargs.get("turn_id"))
    if not session_id or not turn_id:
        return None, None
    return (
        _sha256("turn-receipt-session-v1\0", session_id),
        _sha256("turn-receipt-turn-v1\0", turn_id),
    )


def _attach_commit_diagnostic(
    event: dict[str, Any],
    diagnostic: dict[str, Any],
    *,
    preserve_prompt: bool = False,
) -> None:
    event.pop("sessionId", None)
    if not preserve_prompt:
        event.pop("prompt", None)
    event.pop("checkpointClaims", None)
    event["diagnostic"] = diagnostic


def _tool_call_name(call: Any) -> Optional[str]:
    try:
        function = call.get("function") if isinstance(call, dict) else getattr(call, "function", None)
        name = function.get("name") if isinstance(function, dict) else getattr(function, "name", None)
        return name if isinstance(name, str) else None
    except Exception:
        return None


def _tool_call_arguments(call: Any) -> Any:
    function = call.get("function") if isinstance(call, dict) else getattr(call, "function", None)
    return function.get("arguments") if isinstance(function, dict) else getattr(function, "arguments", None)


def _strip_delta_tool_calls(assistant_message: Any) -> tuple[list[Any], list[Any]]:
    """Strip the control call from the host-owned mutable list before inspecting its arguments."""
    if isinstance(assistant_message, dict):
        calls = assistant_message.get("tool_calls")
    else:
        calls = getattr(assistant_message, "tool_calls", None)
    if calls is None:
        calls = []
    if not isinstance(calls, (list, tuple)):
        raise ValueError("ihow_memory_tool_calls_invalid")
    sidecars: list[Any] = []
    remaining: list[Any] = []
    for call in calls:
        name = _tool_call_name(call)
        if name == "ihow_memory_delta":
            sidecars.append(call)
        else:
            remaining.append(call)
        # Only an explicitly named iHow sidecar belongs to this plugin. Preserve every other call,
        # including an opaque/malformed generic call, so this observer never changes host execution.
    if isinstance(calls, list):
        calls[:] = remaining
    elif isinstance(assistant_message, dict):
        assistant_message["tool_calls"] = remaining
    else:
        setattr(assistant_message, "tool_calls", remaining)
    return sidecars, remaining


def _classify_delta_sidecars(sidecars: list[Any]) -> tuple[str, Optional[dict[str, str]]]:
    if not sidecars:
        return "not_emitted", None
    if len(sidecars) != 1:
        return "extraction_failed", None
    try:
        arguments = _tool_call_arguments(sidecars[0])
        if not isinstance(arguments, str):
            return "extraction_failed", None
        if len(arguments.encode("utf-8")) > _MAX_SIDECAR_ARGUMENT_BYTES:
            return "extraction_failed", None
        payload = json.loads(
            arguments,
            object_pairs_hook=_exact_json_object,
            parse_constant=_reject_json_constant,
        )
        if not isinstance(payload, dict) or type(payload.get("schemaVersion")) is not int:
            return "extraction_failed", None
        status = payload.get("status")
        if status == "explicit_none":
            if set(payload) != {"schemaVersion", "status"} or payload["schemaVersion"] != 1:
                return "extraction_failed", None
            return "explicit_none", None
        if status != "emitted" or set(payload) != {"schemaVersion", "status", "proposal"}:
            return "extraction_failed", None
        if payload["schemaVersion"] != 1 or not isinstance(payload.get("proposal"), dict):
            return "extraction_failed", None
        proposal = payload["proposal"]
        if set(proposal) != {"kind", "subject", "key", "value"}:
            return "extraction_failed", None
        kind = proposal.get("kind")
        subject = _exact_model_text(proposal.get("subject"), 120)
        key = _exact_model_text(proposal.get("key"), 120)
        value = _exact_model_text(proposal.get("value"), 1_200)
        if kind not in _MEMORY_DELTA_KINDS or subject is None or key is None or value is None:
            return "extraction_failed", None
        semantic = {"kind": kind, "subject": subject, "key": key, "value": value}
        if _contains_secret_like_content(json.dumps(semantic, ensure_ascii=False, sort_keys=True)):
            return "extraction_failed", None
        return "emitted", semantic
    except Exception:
        return "extraction_failed", None


def _stage_delta_sidecar(kwargs: dict[str, Any]) -> None:
    assistant_message = kwargs.get("assistant_message")
    try:
        sidecars, remaining = _strip_delta_tool_calls(assistant_message)
    except Exception:
        # Unsupported host container shapes remain entirely host-owned. Without a mutable list/tuple
        # boundary this observer cannot prove which calls it may remove, so it must not mutate any of
        # them or stage typed memory state.
        return
    if remaining:
        return
    content = assistant_message.get("content") if isinstance(assistant_message, dict) else getattr(assistant_message, "content", None)
    if not isinstance(content, str) or not content.strip(_ECMASCRIPT_WHITESPACE):
        return
    key = _resolve_receipt_alias(kwargs)
    if key is None:
        return
    now = time.monotonic()
    with _pending_receipts_lock:
        _prune_pending_receipts_locked(now)
        pending = _pending_receipts.get(key)
        if pending is None or "deltaState" in pending:
            return
    state, semantic = _classify_delta_sidecars(sidecars)
    now = time.monotonic()
    with _pending_receipts_lock:
        _prune_pending_receipts_locked(now)
        pending = _pending_receipts.get(key)
        if pending is None or "deltaState" in pending:
            return
        for field in ("deltaState", "deltaProposal", "deltaObservedAt"):
            pending.pop(field, None)
        if state == "emitted" and semantic is not None:
            observed_at = _now_millis()
            sizing = dict(pending)
            sizing["deltaProposal"] = semantic
            sizing["deltaObservedAt"] = observed_at
            sizing["finalContentSha256"] = "0" * 64
            sizing["finalSourceHash"] = "sha256:" + "0" * 64
            proposal = _proposal_input(sizing)
            hash_input = {
                "schemaVersion": 1,
                "receiptIdentity": {
                    "runtime": sizing["runtime"],
                    "projectId": sizing["projectId"],
                    "sessionHash": sizing["sessionHash"],
                    "turnId": sizing["turnId"],
                    "revision": sizing["revision"],
                },
                "finalEvidence": {
                    "finalSourceHash": sizing["finalSourceHash"],
                    "finalContentSha256": sizing["finalContentSha256"],
                    "committedAt": observed_at,
                },
                "proposal": proposal,
            }
            envelope = {**hash_input, "deltaHash": _canonical_sha256(hash_input)}
            canonical = json.dumps(
                envelope, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False,
            ) + "\n"
            if len(canonical.encode("utf-8")) > _MAX_COMPILED_DELTA_BYTES:
                state = "extraction_failed"
            else:
                pending["deltaProposal"] = semantic
                pending["deltaObservedAt"] = observed_at
        pending["deltaState"] = state
        pending["_touched"] = now
        _pending_receipts.move_to_end(key)


def _proposal_input(pending: dict[str, Any]) -> dict[str, Any]:
    semantic = pending["deltaProposal"]
    return {
        "schemaVersion": 1,
        "kind": semantic["kind"],
        "text": (
            f"[memory:{semantic['kind']}] subject={semantic['subject']} | "
            f"key={semantic['key']} | value={semantic['value']}"
        ),
        "subject": semantic["subject"],
        "key": semantic["key"],
        "value": semantic["value"],
        "scope": {
            "declaredVisibility": "project",
            "effectiveVisibility": "project",
            "projectScope": pending["projectId"],
            "sourcePath": None,
            "frontmatter": None,
        },
        "provenance": {
            "sourceKind": "runtime-event",
            "sourceId": "hermes-final:" + pending["finalContentSha256"],
            "runtime": "hermes",
            "observedAt": pending["deltaObservedAt"],
            "sourceSha256": pending["finalContentSha256"],
            "evidenceLocator": "memory-delta:proposal:0",
        },
        "relation": {
            "verdict": "review_required",
            "targetProposalIds": [],
            "targetPaths": [],
            "reviewRequired": True,
            "destructive": False,
            "reason": "ordinary_language_typed_sidecar",
        },
        "review": {"mode": "review-first", "state": "pending"},
        "safety": {
            "outcome": "candidate-only",
            "directDurableWrite": False,
            "indexWrite": False,
            "destructive": False,
            "autoPromote": False,
        },
    }


def _bounded_identity(value: Any) -> Optional[str]:
    if not isinstance(value, str) or not value.strip() or any(ord(ch) < 32 or ord(ch) == 127 for ch in value):
        return None
    if len(value.encode("utf-8")) > _MAX_RECEIPT_ID_BYTES:
        return None
    return value


def _valid_project_root_candidate(value: str) -> bool:
    if not value or any(ord(ch) < 32 or ord(ch) == 127 for ch in value):
        return False
    try:
        return len(value.encode("utf-8")) <= _MAX_PROJECT_ROOT_BYTES
    except UnicodeEncodeError:
        return False


@lru_cache(maxsize=1)
def _project_root() -> str:
    """Resolve one normalized project root for this one-project-per-process adapter."""
    fallback = os.path.realpath(os.getcwd())
    try:
        completed = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=fallback,
            capture_output=True,
            text=True,
            timeout=1,
            check=False,
        )
        candidate = completed.stdout.strip()
        if completed.returncode == 0 and _valid_project_root_candidate(candidate):
            return os.path.realpath(candidate)
    except Exception:
        pass
    return fallback


def _open_receipt_action(kwargs: dict[str, Any]) -> Optional[dict[str, Any]]:
    evidence = _durable_input_evidence(kwargs.get("durable_transcript_input"))
    if evidence is None:
        return None
    project_id = _sha256("turn-receipt-project-v1\0", _project_root())
    return {
        "action": "open",
        "receipt": {
            "schemaVersion": 2,
            "identityDomain": evidence["identityDomain"],
            "origin": "native-hook",
            "runtime": "hermes",
            "projectId": project_id,
            "sessionHash": evidence["sessionHash"],
            "turnId": evidence["turnId"],
            "revision": 1,
            "inputSourceHash": evidence["inputSourceHash"],
            "inputContentSha256": evidence["inputContentSha256"],
            "openedAt": _now_millis(),
        },
    }


def _cwd(kwargs: dict[str, Any]) -> str:
    value = kwargs.get("cwd")
    return str(value).strip() if isinstance(value, str) and value.strip() else os.getcwd()


def _metadata_event(name: str, kwargs: dict[str, Any]) -> dict[str, Any]:
    event = {
        "schemaVersion": 1,
        "event": name,
        "runtime": "hermes",
        "cwd": _cwd(kwargs),
        "sessionId": str(kwargs.get("session_id") or "")[:256],
        "platform": str(kwargs.get("platform") or "")[:64],
        "observedAt": _now(),

    }
    if name == "runtime.before_prompt":
        prompt = kwargs.get("user_message")
        if isinstance(prompt, str) and prompt.strip():
            # Canonical governance redaction happens in the Node bridge before logging or recall.
            event["prompt"] = prompt.strip()[:_MAX_PROMPT_DIGEST_CHARS]
    if name in ("runtime.session_finalize", "runtime.session_end"):
        claims = kwargs.get("checkpoint_claims")
        if isinstance(claims, dict):
            event["checkpointClaims"] = claims
    return event


def _append_metadata_event(event: dict[str, Any]) -> None:
    target = os.environ.get("IHOW_MEMORY_HERMES_EVENT_LOG", "").strip()
    if not target:
        return
    # Raw prompts are never persisted by the Python adapter. Redacted prompt evidence is audited by
    # context_probe in the Node core as a hash, using the canonical governance policy.
    safe_event = {
        key: event[key] for key in ("schemaVersion", "event", "runtime", "platform", "observedAt")
        if key in event
    }
    path = Path(target).expanduser()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(safe_event, ensure_ascii=False, sort_keys=True) + "\n")


def _safe_argv(value: str) -> str:
    if not value or any(ch in value for ch in ("\x00", "\r", "\n")):
        raise RuntimeError("ihow_memory_hermes_bridge_path_invalid")
    return value


def _bridge_command() -> list[str]:
    configured = os.environ.get("IHOW_MEMORY_HERMES_BRIDGE", "").strip()
    if configured:
        bridge = Path(configured).expanduser()
        node = os.environ.get("IHOW_MEMORY_HERMES_NODE", "").strip() or "node"
        argv = [_safe_argv(node)]
        if bridge.suffix == ".ts":
            argv.append("--experimental-strip-types")
        argv.append(_safe_argv(str(bridge)))
        return argv
    packaged = shutil.which("ihow-memory-hermes-bridge")
    if not packaged:
        raise RuntimeError("ihow_memory_hermes_bridge_not_found")
    return [_safe_argv(packaged)]


def _dispatch(event: dict[str, Any]) -> Optional[dict[str, Any]]:
    """Dispatch one event without making Hermes availability depend on iHow Memory."""
    _append_metadata_event(event)
    mode = os.environ.get("IHOW_MEMORY_HERMES_TEST_MODE", "").strip().lower()
    if mode == "failure":
        raise RuntimeError("simulated iHow Memory transport failure")
    if mode == "success" and event["event"] == "runtime.before_prompt":
        return {"context": "Verified iHow Memory recall"}

    completed = subprocess.run(
        _bridge_command(),
        input=json.dumps(event, ensure_ascii=False) + "\n",
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError("ihow_memory_hermes_bridge_failed")
    payload = json.loads(completed.stdout.strip() or "{}")
    if payload.get("ok") is not True:
        raise RuntimeError("ihow_memory_hermes_bridge_failed")
    return payload


def _safe_dispatch(event_name: str, kwargs: dict[str, Any]) -> Optional[dict[str, Any]]:
    try:
        # Event construction belongs inside the same fail-open boundary as transport dispatch.
        result = _dispatch(_metadata_event(event_name, kwargs))
        if not isinstance(result, dict):
            return None
        context = result.get("context")
        if not isinstance(context, str) or not context.strip():
            return None
        return {"context": context[:_MAX_CONTEXT_CHARS]}
    except Exception:
        logger.debug("ihow_memory_hermes_hook_failed_open")
        return None


def _on_session_start(**kwargs: Any) -> None:
    _safe_dispatch("runtime.session_start", kwargs)


def _on_session_reset(**kwargs: Any) -> None:
    _safe_dispatch("runtime.session_reset", kwargs)


def _on_pre_llm_call(**kwargs: Any) -> Optional[dict[str, str]]:
    try:
        event = _metadata_event("runtime.before_prompt", kwargs)
        receipt_action = _open_receipt_action(kwargs)
        if receipt_action is None:
            hook_turn_diagnostic = _bounded_correlation(kwargs)[1]
            _attach_commit_diagnostic(event, {
                "code": "durable_transcript_input_invalid",
                **({"hookTurnDiagnostic": hook_turn_diagnostic} if hook_turn_diagnostic else {}),
            }, preserve_prompt=True)
        else:
            event["turnReceipt"] = receipt_action
        result = _dispatch(event)
        if not isinstance(result, dict):
            return None
        if receipt_action:
            pending_key = _retain_open_receipt(receipt_action["receipt"])
            _bind_receipt_alias(kwargs, pending_key)
        context = result.get("context")
        if not isinstance(context, str) or not context.strip():
            return None
        return {"context": context[:_MAX_CONTEXT_CHARS]}
    except Exception:
        logger.debug("ihow_memory_hermes_hook_failed_open")
        return None


def _on_post_llm_call(**kwargs: Any) -> None:
    _safe_dispatch("runtime.after_turn", kwargs)


def _on_post_api_request(**kwargs: Any) -> None:
    try:
        _stage_delta_sidecar(kwargs)
    except Exception:
        logger.debug("ihow_memory_hermes_sidecar_failed_closed")


def _on_session_finalize(**kwargs: Any) -> None:
    _safe_dispatch("runtime.session_finalize", kwargs)


def _on_session_end(**kwargs: Any) -> None:
    try:
        event = _metadata_event("runtime.session_end", kwargs)
        hook_turn_diagnostic = _bounded_correlation(kwargs)[1]
        _attach_commit_diagnostic(event, {
            "code": "durable_transcript_revision_pending",
            **({"hookTurnDiagnostic": hook_turn_diagnostic} if hook_turn_diagnostic else {}),
        })
        _dispatch(event)
    except Exception:
        logger.debug("ihow_memory_hermes_hook_failed_open")
    finally:
        _clear_receipt_alias(kwargs)


_DURABLE_REVISION_KEYS = frozenset({
    "schemaVersion",
    "sessionHash",
    "revision",
    "manifestPath",
    "transcriptPath",
    "contentSha256",
    "committedAt",
})
_DURABLE_REVISION_OBSERVER_KEYS = _DURABLE_REVISION_KEYS | {"telemetry_schema_version"}


def _durable_revision_publication(value: Any) -> Optional[dict[str, Any]]:
    if not isinstance(value, dict) or set(value) - _DURABLE_REVISION_OBSERVER_KEYS:
        return None
    if not _DURABLE_REVISION_KEYS.issubset(value):
        return None
    publication = {field: value[field] for field in _DURABLE_REVISION_KEYS}
    if type(publication.get("schemaVersion")) is not int or publication["schemaVersion"] != 1:
        return None
    if not _is_lower_hex_64(publication.get("sessionHash")):
        return None
    if type(publication.get("revision")) is not int or publication["revision"] < 1:
        return None
    if not _is_lower_hex_64(publication.get("contentSha256")):
        return None
    session_hash = publication["sessionHash"]
    revision = publication["revision"]
    if publication.get("manifestPath") != f"manifests/{session_hash}.json":
        return None
    if publication.get("transcriptPath") != f"revisions/{session_hash}/{revision}.json":
        return None
    committed_at = publication.get("committedAt")
    if not isinstance(committed_at, str) or not committed_at or len(committed_at) > 64:
        return None
    return publication


def _on_durable_transcript_revision(**kwargs: Any) -> None:
    try:
        publication = _durable_revision_publication(kwargs)
        if publication is None:
            return
        _dispatch({
            "schemaVersion": 1,
            "event": "runtime.durable_transcript_revision",
            "runtime": "hermes",
            "projectId": _sha256("turn-receipt-project-v1\0", _project_root()),
            "observedAt": _now(),
            "publication": dict(publication),
        })
    except Exception:
        logger.debug("ihow_memory_hermes_durable_revision_failed_open")


def _delta_tool_handler(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
    return {"ok": False, "error": "ihow_memory_delta_control_sidecar_must_not_execute"}


def register(ctx: Any) -> None:
    ctx.register_hook("on_session_start", _on_session_start)
    ctx.register_hook("on_session_reset", _on_session_reset)
    ctx.register_hook("pre_llm_call", _on_pre_llm_call)
    ctx.register_hook("post_llm_call", _on_post_llm_call)
    ctx.register_hook("on_session_finalize", _on_session_finalize)
    ctx.register_hook("on_session_end", _on_session_end)
    ctx.register_hook("on_durable_transcript_revision", _on_durable_transcript_revision)
    # Old hook-only test hosts do not expose register_tool. Real Hermes does, and the control hook/tool
    # must be installed together so a sidecar can never be declared without its strip-first interceptor.
    if callable(getattr(ctx, "register_tool", None)):
        ctx.register_hook("post_api_request", _on_post_api_request)
        ctx.register_tool(
            name="ihow_memory_delta",
            toolset="ihow_memory",
            schema={
                "name": "ihow_memory_delta",
                "description": _DELTA_TOOL_DESCRIPTION,
                "parameters": _DELTA_TOOL_PARAMETERS,
            },
            handler=_delta_tool_handler,
            description=_DELTA_TOOL_DESCRIPTION,
        )
