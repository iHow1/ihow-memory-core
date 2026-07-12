"""Fail-open Hermes lifecycle adapter for iHow Memory.

The first slice is intentionally transport-thin: hooks emit metadata-only runtime events and
`pre_llm_call` may inject bounded recall returned by a configured adapter transport. Raw prompts,
responses, and conversation histories are never written to the adapter event log.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)
_MAX_CONTEXT_CHARS = 8_000
_MAX_PROMPT_DIGEST_CHARS = 2_000


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


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
    return event


def _append_metadata_event(event: dict[str, Any]) -> None:
    target = os.environ.get("IHOW_MEMORY_HERMES_EVENT_LOG", "").strip()
    if not target:
        return
    # Raw prompts are never persisted by the Python adapter. Redacted prompt evidence is audited by
    # context_probe in the Node core as a hash, using the canonical governance policy.
    safe_event = {key: value for key, value in event.items() if key != "prompt"}
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
        logger.debug("iHow Memory Hermes hook failed open", exc_info=True)
        return None


def _on_session_start(**kwargs: Any) -> None:
    _safe_dispatch("runtime.session_start", kwargs)


def _on_session_reset(**kwargs: Any) -> None:
    _safe_dispatch("runtime.session_reset", kwargs)


def _on_pre_llm_call(**kwargs: Any) -> Optional[dict[str, str]]:
    # user_message and conversation_history are deliberately ignored here. The transport slice will
    # pass only a bounded prompt digest after applying iHow Memory's redaction policy.
    return _safe_dispatch("runtime.before_prompt", kwargs)


def _on_post_llm_call(**kwargs: Any) -> None:
    # assistant_response and conversation_history are deliberately ignored in this metadata-only slice.
    _safe_dispatch("runtime.after_turn", kwargs)


def _on_session_finalize(**kwargs: Any) -> None:
    _safe_dispatch("runtime.session_finalize", kwargs)


def _on_session_end(**kwargs: Any) -> None:
    _safe_dispatch("runtime.session_end", kwargs)


def register(ctx: Any) -> None:
    ctx.register_hook("on_session_start", _on_session_start)
    ctx.register_hook("on_session_reset", _on_session_reset)
    ctx.register_hook("pre_llm_call", _on_pre_llm_call)
    ctx.register_hook("post_llm_call", _on_post_llm_call)
    ctx.register_hook("on_session_finalize", _on_session_finalize)
    ctx.register_hook("on_session_end", _on_session_end)
