"""Hermes MemoryProvider adapter for iHow pre-compression checkpoints.

The adapter observes message structure only. Message content, tool names, tool arguments, paths, and
session identifiers never cross the bridge; the Node side receives bounded hashes and creates the
checkpoint through iHow's existing checkpoint service.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any, Dict, List

from agent.memory_provider import MemoryProvider

logger = logging.getLogger(__name__)

_CHECKPOINT_ID_RE = re.compile(r"^cp_[a-f0-9]{64}$")
_HASH_RE = re.compile(r"^[a-f0-9]{64}$")
_MAX_MESSAGES = 100_000
_MAX_PARTS = 10_000
_MAX_HANDOFF_CHARS = 320


def _hash(domain: str, value: str) -> str:
    return hashlib.sha256((domain + value).encode("utf-8")).hexdigest()


def _safe_argv(value: str) -> str:
    if not value or any(character in value for character in ("\x00", "\r", "\n")):
        raise RuntimeError("ihow_memory_provider_bridge_path_invalid")
    return value


def _bounded_count(value: Any, maximum: int) -> int:
    try:
        return min(len(value), maximum)
    except Exception:
        return 0


def _installed_bridge_settings() -> dict[str, str] | None:
    target = Path(__file__).with_name("bridge.json")
    try:
        payload = json.loads(target.read_text(encoding="utf-8"))
    except Exception:
        return None
    expected = {"schemaVersion", "node", "bridge", "memoryRoot", "stateRoot"}
    if not isinstance(payload, dict) or set(payload) != expected or payload.get("schemaVersion") != 1:
        return None
    for key in ("node", "bridge", "memoryRoot", "stateRoot"):
        value = payload.get(key)
        if not isinstance(value, str) or not value or any(character in value for character in ("\x00", "\r", "\n")):
            return None
        if not Path(value).is_absolute():
            return None
    if not Path(payload["node"]).is_file() or not Path(payload["bridge"]).is_file():
        return None
    return payload


def _message_shape(messages: List[Dict[str, Any]]) -> list[dict[str, Any]]:
    """Return content-free structure sufficient for retry deduplication."""
    shapes: list[dict[str, Any]] = []
    for message in list(messages or [])[:_MAX_MESSAGES]:
        if not isinstance(message, dict):
            shapes.append({"role": "unknown", "content": "other", "parts": 0, "tools": 0})
            continue
        role = message.get("role")
        safe_role = role if role in {"system", "user", "assistant", "tool"} else "unknown"
        content = message.get("content")
        if isinstance(content, str):
            content_kind = "text"
            parts = 1
        elif isinstance(content, list):
            content_kind = "parts"
            parts = _bounded_count(content, _MAX_PARTS)
        elif content is None:
            content_kind = "none"
            parts = 0
        else:
            content_kind = "other"
            parts = 0
        shapes.append({
            "role": safe_role,
            "content": content_kind,
            "parts": parts,
            "tools": _bounded_count(message.get("tool_calls"), _MAX_PARTS),
        })
    return shapes


class IHowMemoryCompactionProvider(MemoryProvider):
    """Thin, fail-open Hermes adapter backed by iHow checkpoint artifacts."""

    def __init__(self) -> None:
        self._session_hash = ""
        self._hermes_home = ""
        self._project_dir = ""
        self._boundary_generation = 0
        self._handoffs: dict[str, str] = {}
        self._protection: dict[str, str] = {
            "status": "UNVERIFIED",
            "coverage": "unknown",
            "reason": "not_observed",
        }

    @property
    def name(self) -> str:
        return "ihow-memory-compaction"

    @property
    def protection_state(self) -> dict[str, str]:
        return dict(self._protection)

    def is_available(self) -> bool:
        configured = os.environ.get("IHOW_MEMORY_HERMES_BRIDGE", "").strip()
        return bool(configured or _installed_bridge_settings() or shutil.which("ihow-memory-hermes-bridge"))

    def initialize(self, session_id: str, **kwargs: Any) -> None:
        self._session_hash = _hash("hermes-memory-provider-session-v1\0", str(session_id or ""))
        self._hermes_home = str(kwargs.get("hermes_home") or os.environ.get("HERMES_HOME") or "")
        self._project_dir = os.path.realpath(os.getcwd())
        self._boundary_generation = 0
        self._handoffs.clear()
        self._protection = {
            "status": "UNVERIFIED",
            "coverage": "unknown",
            "reason": "not_observed",
        }

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        return []

    def _bridge_command(self) -> list[str]:
        configured = os.environ.get("IHOW_MEMORY_HERMES_BRIDGE", "").strip()
        if configured:
            bridge = Path(configured).expanduser()
            node = os.environ.get("IHOW_MEMORY_HERMES_NODE", "").strip() or "node"
            command = [_safe_argv(node)]
            if bridge.suffix == ".ts":
                command.append("--experimental-strip-types")
            command.append(_safe_argv(str(bridge)))
            return command
        installed = _installed_bridge_settings()
        if installed:
            return [_safe_argv(installed["node"]), _safe_argv(installed["bridge"])]
        packaged = shutil.which("ihow-memory-hermes-bridge")
        if not packaged:
            raise RuntimeError("ihow_memory_provider_bridge_not_found")
        return [_safe_argv(packaged)]

    @staticmethod
    def _timeout_seconds() -> float:
        try:
            configured = float(os.environ.get("IHOW_MEMORY_HERMES_TIMEOUT_SECONDS", "8"))
        except (TypeError, ValueError):
            configured = 8.0
        return min(8.0, max(0.01, configured))

    def _compaction_id(self, messages: List[Dict[str, Any]]) -> str:
        shape = {
            "schemaVersion": 1,
            "sessionHash": self._session_hash,
            "boundaryGeneration": self._boundary_generation,
            "messageCount": min(_bounded_count(messages, _MAX_MESSAGES + 1), _MAX_MESSAGES),
            "messages": _message_shape(messages),
        }
        canonical = json.dumps(shape, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
        return _hash("hermes-memory-provider-compaction-v1\0", canonical)

    def on_pre_compress(self, messages: List[Dict[str, Any]]) -> str:
        compaction_id = self._compaction_id(messages)
        cached = self._handoffs.get(compaction_id)
        if cached is not None:
            return cached
        request = {
            "schemaVersion": 1,
            "operation": "checkpoint.pre_compress",
            "runtime": "hermes",
            "sessionHash": self._session_hash,
            "compactionId": compaction_id,
        }
        try:
            environment = dict(os.environ)
            if self._hermes_home:
                environment["HERMES_HOME"] = self._hermes_home
            installed = _installed_bridge_settings()
            if installed:
                environment["MEMORY_ROOT"] = installed["memoryRoot"]
                environment["IHOW_MEMORY_STATE_ROOT"] = installed["stateRoot"]
            completed = subprocess.run(
                self._bridge_command(),
                input=json.dumps(request, ensure_ascii=True, sort_keys=True) + "\n",
                capture_output=True,
                text=True,
                timeout=self._timeout_seconds(),
                check=False,
                cwd=self._project_dir or None,
                env=environment,
            )
            if completed.returncode != 0:
                raise RuntimeError("ihow_memory_provider_bridge_failed")
            response = json.loads(completed.stdout.strip() or "{}")
            checkpoint_id = response.get("checkpointId") if isinstance(response, dict) else None
            coverage = response.get("coverageStatus") if isinstance(response, dict) else None
            if (
                not isinstance(response, dict)
                or response.get("ok") is not True
                or not isinstance(checkpoint_id, str)
                or _CHECKPOINT_ID_RE.fullmatch(checkpoint_id) is None
                or coverage not in {"partial", "known_closed"}
            ):
                raise RuntimeError("ihow_memory_provider_response_invalid")
            handoff = (
                f"iHow checkpoint handoff: {checkpoint_id}; coverage={coverage}; "
                "recovery=memory.continue checkpoint-first; status=UNVERIFIED until live anchors are checked."
            )[:_MAX_HANDOFF_CHARS]
            self._handoffs[compaction_id] = handoff
            self._protection = {
                "status": "UNVERIFIED",
                "coverage": coverage,
                "checkpointId": checkpoint_id,
            }
            return handoff
        except Exception:
            self._protection = {
                "status": "UNVERIFIED",
                "coverage": "unknown",
                "reason": "transport_failed",
            }
            logger.debug("ihow_memory_provider_pre_compress_failed_open")
            return ""

    def on_session_switch(
        self,
        new_session_id: str,
        *,
        parent_session_id: str = "",
        reset: bool = False,
        rewound: bool = False,
        **kwargs: Any,
    ) -> None:
        del parent_session_id, rewound
        new_hash = _hash("hermes-memory-provider-session-v1\0", str(new_session_id or ""))
        if new_hash != self._session_hash:
            self._session_hash = new_hash
            self._boundary_generation = 0
            self._handoffs.clear()
        elif kwargs.get("reason") == "compression":
            self._boundary_generation += 1
        elif reset:
            self._boundary_generation = 0
            self._handoffs.clear()
        self._protection = {
            "status": "UNVERIFIED",
            "coverage": "unknown",
            "reason": "session_rebound",
        }


Provider = IHowMemoryCompactionProvider


def create_provider() -> IHowMemoryCompactionProvider:
    return IHowMemoryCompactionProvider()
