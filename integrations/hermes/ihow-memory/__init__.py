"""Fail-open Hermes lifecycle adapter for iHow Memory.

The first slice is intentionally transport-thin: hooks emit metadata-only runtime events and
`pre_llm_call` may inject bounded recall returned by a configured adapter transport. Raw prompts,
responses, and conversation histories are never written to the adapter event log.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)
_MAX_CONTEXT_CHARS = 8_000


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _cwd(kwargs: dict[str, Any]) -> str:
    value = kwargs.get("cwd")
    return str(value).strip() if isinstance(value, str) and value.strip() else os.getcwd()


def _metadata_event(name: str, kwargs: dict[str, Any]) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "event": name,
        "runtime": "hermes",
        "cwd": _cwd(kwargs),
        "sessionId": str(kwargs.get("session_id") or "")[:256],
        "platform": str(kwargs.get("platform") or "")[:64],
        "observedAt": _now(),
    }


def _append_metadata_event(event: dict[str, Any]) -> None:
    target = os.environ.get("IHOW_MEMORY_HERMES_EVENT_LOG", "").strip()
    if not target:
        return
    path = Path(target).expanduser()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(event, ensure_ascii=False, sort_keys=True) + "\n")


def _dispatch(event: dict[str, Any]) -> Optional[dict[str, Any]]:
    """Dispatch one event without making Hermes availability depend on iHow Memory.

    Test mode is the first executable contract. A later slice replaces it with the packaged Node
    bridge/MCP transport while preserving this fail-open boundary and the same event envelope.
    """
    _append_metadata_event(event)
    mode = os.environ.get("IHOW_MEMORY_HERMES_TEST_MODE", "").strip().lower()
    if mode == "failure":
        raise RuntimeError("simulated iHow Memory transport failure")
    if mode == "success" and event["event"] == "runtime.before_prompt":
        return {"context": "Verified iHow Memory recall"}
    return None


def _safe_dispatch(event: dict[str, Any]) -> Optional[dict[str, Any]]:
    try:
        result = _dispatch(event)
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
    _safe_dispatch(_metadata_event("runtime.session_start", kwargs))


def _on_session_reset(**kwargs: Any) -> None:
    _safe_dispatch(_metadata_event("runtime.session_reset", kwargs))


def _on_pre_llm_call(**kwargs: Any) -> Optional[dict[str, str]]:
    # user_message and conversation_history are deliberately ignored here. The transport slice will
    # pass only a bounded prompt digest after applying iHow Memory's redaction policy.
    return _safe_dispatch(_metadata_event("runtime.before_prompt", kwargs))


def _on_post_llm_call(**kwargs: Any) -> None:
    # assistant_response and conversation_history are deliberately ignored in this metadata-only slice.
    _safe_dispatch(_metadata_event("runtime.after_turn", kwargs))


def _on_session_finalize(**kwargs: Any) -> None:
    _safe_dispatch(_metadata_event("runtime.session_finalize", kwargs))


def _on_session_end(**kwargs: Any) -> None:
    _safe_dispatch(_metadata_event("runtime.session_end", kwargs))


def register(ctx: Any) -> None:
    ctx.register_hook("on_session_start", _on_session_start)
    ctx.register_hook("on_session_reset", _on_session_reset)
    ctx.register_hook("pre_llm_call", _on_pre_llm_call)
    ctx.register_hook("post_llm_call", _on_post_llm_call)
    ctx.register_hook("on_session_finalize", _on_session_finalize)
    ctx.register_hook("on_session_end", _on_session_end)
