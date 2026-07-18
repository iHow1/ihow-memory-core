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
from collections import OrderedDict
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)
_MAX_CONTEXT_CHARS = 8_000
_MAX_PROMPT_DIGEST_CHARS = 2_000
_MAX_RECEIPT_ID_BYTES = 512
_MAX_RECEIPT_TEXT_BYTES = 2_000
_MAX_PROJECT_ROOT_BYTES = 4_096
_MAX_PENDING_RECEIPTS = 256
_PENDING_RECEIPT_TTL_SECONDS = 3_600
_pending_receipts_lock = threading.RLock()
_pending_receipts: OrderedDict[str, dict[str, Any]] = OrderedDict()
_COMMIT_NOT_PROVEN_REASONS = frozenset({
    "identity_invalid",
    "durable_marker_missing",
    "pending_not_found",
    "final_evidence_invalid",
    "final_conflict",
    "end_not_successful",
    "final_evidence_missing",
    "transport_failure",
    "input_conflict",
})



def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _now_millis() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _sha256(domain: str, value: str) -> str:
    return hashlib.sha256((domain + value).encode("utf-8")).hexdigest()


def _receipt_correlation_key(session_hash: str, turn_id: str) -> str:
    return _sha256("hermes-turn-receipt-correlation-v1\0", session_hash + "\0" + turn_id)


def _prune_pending_receipts_locked(now: float) -> None:
    stale_before = now - _PENDING_RECEIPT_TTL_SECONDS
    stale = [key for key, value in _pending_receipts.items() if value["_touched"] < stale_before]
    for key in stale:
        _pending_receipts.pop(key, None)
    while len(_pending_receipts) > _MAX_PENDING_RECEIPTS:
        _pending_receipts.popitem(last=False)


def _retain_open_receipt(receipt: dict[str, Any]) -> None:
    now = time.monotonic()
    key = _receipt_correlation_key(receipt["sessionHash"], receipt["turnId"])
    with _pending_receipts_lock:
        _prune_pending_receipts_locked(now)
        existing = _pending_receipts.get(key)
        if existing is not None and _same_input_evidence(existing, receipt):
            existing["_touched"] = now
            _pending_receipts.move_to_end(key)
            return
        _pending_receipts[key] = {
            "schemaVersion": receipt["schemaVersion"],
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


def _same_input_evidence(left: dict[str, Any], right: dict[str, Any]) -> bool:
    return all(left.get(field) == right.get(field) for field in (
        "schemaVersion", "runtime", "projectId", "sessionHash", "turnId", "revision",
        "inputSourceHash", "inputContentSha256",
    ))


def _invalidate_conflicting_open_receipt(receipt: dict[str, Any]) -> bool:
    """Drop stale pending evidence before Core observes a conflicting OPEN."""
    now = time.monotonic()
    key = _receipt_correlation_key(receipt["sessionHash"], receipt["turnId"])
    with _pending_receipts_lock:
        _prune_pending_receipts_locked(now)
        existing = _pending_receipts.get(key)
        if existing is None or _same_input_evidence(existing, receipt):
            return False
        _pending_receipts.pop(key, None)
        return True


def _commit_not_proven(
    reason: str,
    session_hash: Optional[str] = None,
    turn_id: Optional[str] = None,
) -> dict[str, Any]:
    if reason not in _COMMIT_NOT_PROVEN_REASONS:
        raise ValueError("ihow_memory_commit_not_proven_reason_invalid")
    diagnostic: dict[str, Any] = {"code": "commit_not_proven", "reason": reason}
    if session_hash and turn_id:
        diagnostic["sessionHash"] = session_hash
        diagnostic["turnId"] = turn_id
    return diagnostic


def _bounded_correlation(kwargs: dict[str, Any]) -> tuple[Optional[str], Optional[str]]:
    session_id = _bounded_identity(kwargs.get("session_id"))
    turn_id = _bounded_identity(kwargs.get("turn_id"))
    if not session_id or not turn_id:
        return None, None
    return (
        _sha256("turn-receipt-session-v1\0", session_id),
        _sha256("turn-receipt-turn-v1\0", turn_id),
    )


def _attach_commit_diagnostic(event: dict[str, Any], diagnostic: dict[str, Any]) -> None:
    event.pop("sessionId", None)
    event.pop("prompt", None)
    event.pop("checkpointClaims", None)
    event["diagnostic"] = diagnostic


def _dispatch_commit_diagnostic(
    event_name: str,
    kwargs: dict[str, Any],
    reason: str,
    correlation: tuple[Optional[str], Optional[str]],
) -> None:
    """Best-effort one-shot diagnostic dispatch; never calls itself."""
    try:
        event = _metadata_event(event_name, kwargs)
        _attach_commit_diagnostic(event, _commit_not_proven(reason, *correlation))
        _dispatch(event)
    except Exception:
        pass


def _stage_final_receipt(kwargs: dict[str, Any]) -> Optional[dict[str, Any]]:
    session_id = _bounded_identity(kwargs.get("session_id"))
    turn_id = _bounded_identity(kwargs.get("turn_id"))
    history = kwargs.get("conversation_history")
    if not session_id or not turn_id:
        return _commit_not_proven("identity_invalid")
    session_hash = _sha256("turn-receipt-session-v1\0", session_id)
    hashed_turn_id = _sha256("turn-receipt-turn-v1\0", turn_id)
    correlation = (session_hash, hashed_turn_id)
    if not isinstance(history, list) or not history:
        return _commit_not_proven("durable_marker_missing", *correlation)
    tail = history[-1]
    if not isinstance(tail, dict) or tail.get("_db_persisted") is not True:
        return _commit_not_proven("durable_marker_missing", *correlation)
    if tail.get("role") != "assistant":
        return _commit_not_proven("final_evidence_invalid", *correlation)
    content = tail.get("content")
    if not isinstance(content, str):
        return _commit_not_proven("final_evidence_invalid", *correlation)
    try:
        if len(content.encode("utf-8")) > _MAX_RECEIPT_TEXT_BYTES:
            return _commit_not_proven("final_evidence_invalid", *correlation)
    except UnicodeEncodeError:
        return _commit_not_proven("final_evidence_invalid", *correlation)
    key = _receipt_correlation_key(session_hash, hashed_turn_id)
    final_source_hash = "sha256:" + _sha256("turn-receipt-source-v1\0", "hermes-final/" + turn_id)
    final_content_hash = _sha256("", content)
    diagnostic = None
    now = time.monotonic()
    with _pending_receipts_lock:
        _prune_pending_receipts_locked(now)
        pending = _pending_receipts.get(key)
        if pending is None:
            return _commit_not_proven("pending_not_found", *correlation)
        if "finalContentSha256" in pending:
            if (
                pending["finalSourceHash"] != final_source_hash
                or pending["finalContentSha256"] != final_content_hash
            ):
                pending.pop("finalSourceHash", None)
                pending.pop("finalContentSha256", None)
                pending["finalConflict"] = True
                diagnostic = _commit_not_proven("final_conflict", *correlation)
        elif pending.get("finalConflict") is True:
            pending["_touched"] = now
            _pending_receipts.move_to_end(key)
            return
        else:
            pending["finalSourceHash"] = final_source_hash
            pending["finalContentSha256"] = final_content_hash
        pending["_touched"] = now
        _pending_receipts.move_to_end(key)
        return diagnostic


def _pending_receipts_snapshot() -> list[dict[str, Any]]:
    """Return a test-only copy containing bounded hash metadata and no raw Hermes values."""
    now = time.monotonic()
    with _pending_receipts_lock:
        _prune_pending_receipts_locked(now)
        return [
            {key: value for key, value in pending.items() if key != "_touched"}
            for pending in _pending_receipts.values()
            if "finalContentSha256" in pending or pending.get("finalConflict") is True
        ]


def _has_staged_final_receipt(session_hash: Optional[str], turn_id: Optional[str]) -> bool:
    if not session_hash or not turn_id:
        return False
    key = _receipt_correlation_key(session_hash, turn_id)
    now = time.monotonic()
    with _pending_receipts_lock:
        _prune_pending_receipts_locked(now)
        pending = _pending_receipts.get(key)
        return pending is not None and "finalContentSha256" in pending


def _take_commit_receipt_action(kwargs: dict[str, Any]) -> tuple[Optional[dict[str, Any]], Optional[dict[str, Any]]]:
    session_id = _bounded_identity(kwargs.get("session_id"))
    turn_id = _bounded_identity(kwargs.get("turn_id"))
    if not session_id or not turn_id:
        return None, _commit_not_proven("identity_invalid")
    session_hash = _sha256("turn-receipt-session-v1\0", session_id)
    hashed_turn_id = _sha256("turn-receipt-turn-v1\0", turn_id)
    key = _receipt_correlation_key(session_hash, hashed_turn_id)
    now = time.monotonic()
    with _pending_receipts_lock:
        _prune_pending_receipts_locked(now)
        pending = _pending_receipts.pop(key, None)
    correlation = (session_hash, hashed_turn_id)
    if pending is None:
        return None, _commit_not_proven("pending_not_found", *correlation)
    if kwargs.get("completed") is not True or kwargs.get("interrupted") is not False:
        return None, _commit_not_proven("end_not_successful", *correlation)
    if pending.get("finalConflict") is True:
        return None, _commit_not_proven("final_conflict", *correlation)
    if "finalSourceHash" not in pending or "finalContentSha256" not in pending:
        return None, _commit_not_proven("final_evidence_missing", *correlation)
    committed_at = _now_millis()
    if committed_at < pending["openedAt"]:
        committed_at = pending["openedAt"]
    return {
        "action": "commit",
        "receipt": {
            "schemaVersion": pending["schemaVersion"],
            "runtime": pending["runtime"],
            "projectId": pending["projectId"],
            "sessionHash": pending["sessionHash"],
            "turnId": pending["turnId"],
            "revision": pending["revision"],
            "inputSourceHash": pending["inputSourceHash"],
            "inputContentSha256": pending["inputContentSha256"],
            "finalSourceHash": pending["finalSourceHash"],
            "finalContentSha256": pending["finalContentSha256"],
            "committedAt": committed_at,
            "deltaState": "not_emitted",
        },
    }, None


def _pending_receipts_stats() -> dict[str, int]:
    """Return test-only bounded-structure metadata without receipt values."""
    now = time.monotonic()
    with _pending_receipts_lock:
        _prune_pending_receipts_locked(now)
        return {
            "count": len(_pending_receipts),
            "maxCount": _MAX_PENDING_RECEIPTS,
            "ttlSeconds": _PENDING_RECEIPT_TTL_SECONDS,
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
    session_id = _bounded_identity(kwargs.get("session_id"))
    turn_id = _bounded_identity(kwargs.get("turn_id"))
    user_message = kwargs.get("user_message")
    history = kwargs.get("conversation_history")
    if not session_id or not turn_id or not isinstance(user_message, str):
        return None
    if not user_message or len(user_message.encode("utf-8")) > _MAX_RECEIPT_TEXT_BYTES:
        return None
    if not isinstance(history, list) or not history:
        return None
    tail = history[-1]
    if not isinstance(tail, dict) or tail.get("_db_persisted") is not True:
        return None
    if tail.get("role") != "user" or tail.get("content") != user_message:
        return None
    project_id = _sha256("turn-receipt-project-v1\0", _project_root())
    return {
        "action": "open",
        "receipt": {
            "schemaVersion": 1,
            "runtime": "hermes",
            "projectId": project_id,
            "sessionHash": _sha256("turn-receipt-session-v1\0", session_id),
            "turnId": _sha256("turn-receipt-turn-v1\0", turn_id),
            "revision": 1,
            "inputSourceHash": "sha256:" + _sha256("turn-receipt-source-v1\0", turn_id),
            "inputContentSha256": _sha256("", user_message),
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
    input_conflict = False
    correlation = (None, None)
    try:
        event = _metadata_event("runtime.before_prompt", kwargs)
        receipt_action = _open_receipt_action(kwargs)
        if receipt_action:
            input_conflict = _invalidate_conflicting_open_receipt(receipt_action["receipt"])
            if input_conflict:
                correlation = (
                    receipt_action["receipt"]["sessionHash"],
                    receipt_action["receipt"]["turnId"],
                )
            event["turnReceipt"] = receipt_action
        result = _dispatch(event)
        if not isinstance(result, dict):
            return None
        if receipt_action:
            _retain_open_receipt(receipt_action["receipt"])
        context = result.get("context")
        if not isinstance(context, str) or not context.strip():
            return None
        return {"context": context[:_MAX_CONTEXT_CHARS]}
    except Exception:
        if input_conflict:
            _dispatch_commit_diagnostic(
                "runtime.before_prompt", kwargs, "input_conflict", correlation,
            )
        logger.debug("ihow_memory_hermes_hook_failed_open")
        return None


def _on_post_llm_call(**kwargs: Any) -> None:
    correlation = _bounded_correlation(kwargs)
    final_staged = False
    try:
        event = _metadata_event("runtime.after_turn", kwargs)
        diagnostic = _stage_final_receipt(kwargs)
        final_staged = diagnostic is None and _has_staged_final_receipt(*correlation)
        if diagnostic:
            _attach_commit_diagnostic(event, diagnostic)
        _dispatch(event)
    except Exception:
        if final_staged:
            _dispatch_commit_diagnostic(
                "runtime.after_turn", kwargs, "transport_failure", correlation,
            )
        logger.debug("ihow_memory_hermes_hook_failed_open")


def _on_session_finalize(**kwargs: Any) -> None:
    _safe_dispatch("runtime.session_finalize", kwargs)


def _on_session_end(**kwargs: Any) -> None:
    receipt_action = None
    try:
        event = _metadata_event("runtime.session_end", kwargs)
        receipt_action, diagnostic = _take_commit_receipt_action(kwargs)
        if receipt_action:
            event["turnReceipt"] = receipt_action
        if diagnostic:
            _attach_commit_diagnostic(event, diagnostic)
        _dispatch(event)
    except Exception:
        if receipt_action:
            _dispatch_commit_diagnostic(
                "runtime.session_end", kwargs, "transport_failure", _bounded_correlation(kwargs),
            )
        logger.debug("ihow_memory_hermes_hook_failed_open")


def register(ctx: Any) -> None:
    ctx.register_hook("on_session_start", _on_session_start)
    ctx.register_hook("on_session_reset", _on_session_reset)
    ctx.register_hook("pre_llm_call", _on_pre_llm_call)
    ctx.register_hook("post_llm_call", _on_post_llm_call)
    ctx.register_hook("on_session_finalize", _on_session_finalize)
    ctx.register_hook("on_session_end", _on_session_end)
