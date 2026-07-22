"""Local, redacted tracing for bounded curation runs."""

from __future__ import annotations

import hashlib
import json
import time
from collections.abc import Callable
from typing import Any

from lettermate.db.statuses import AgentRunStatus


def disable_sdk_tracing() -> None:
    """Disable OpenAI SDK raw-content tracing; persistence is handled locally."""
    try:
        from agents import set_tracing_disabled

        set_tracing_disabled(True)
    except ImportError:
        return


class TraceRecorder:
    def __init__(self, repository: Any = None, agent_run_id: int | None = None) -> None:
        self.repository = repository
        self.agent_run_id = agent_run_id
        self.records: list[dict[str, Any]] = []
        self._sequence = 0

    def call(
        self,
        tool_name: str,
        arguments: dict[str, Any],
        function: Callable[[], Any],
        *,
        argument_summary: str,
    ) -> Any:
        self._sequence += 1
        argument_hash = hashlib.sha256(
            json.dumps(arguments, sort_keys=True, separators=(",", ":"), default=str).encode()
        ).hexdigest()
        started = time.perf_counter()
        try:
            result = function()
        except Exception as error:
            latency = int((time.perf_counter() - started) * 1000)
            category = getattr(error, "error_category", "tool_error")
            self._record(
                tool_name,
                argument_summary,
                argument_hash,
                status=AgentRunStatus.FAILED.value,
                latency_ms=latency,
                error_message=str(error)[:500],
                error_category=category,
            )
            raise
        latency = int((time.perf_counter() - started) * 1000)
        summary = _result_summary(result)
        self._record(
            tool_name,
            argument_summary,
            argument_hash,
            status=AgentRunStatus.SUCCEEDED.value,
            latency_ms=latency,
            result_summary=summary,
        )
        return result

    def _record(
        self,
        tool_name: str,
        argument_summary: str,
        argument_hash: str,
        *,
        status: str,
        latency_ms: int,
        result_summary: str | None = None,
        error_message: str | None = None,
        error_category: str | None = None,
    ) -> None:
        record = {
            "sequence": self._sequence,
            "tool_name": tool_name,
            "argument_summary": argument_summary,
            "argument_hash": argument_hash,
            "status": status,
            "latency_ms": latency_ms,
            "result_summary": result_summary,
            "error_message": error_message,
            "error_category": error_category,
        }
        self.records.append(record)
        if self.repository is not None and self.agent_run_id is not None:
            self.repository.add_tool_call_trace(
                agent_run_id=self.agent_run_id,
                sequence=self._sequence,
                tool_name=tool_name,
                argument_summary=argument_summary,
                argument_hash=argument_hash,
                status=status,
                latency_ms=latency_ms,
                result_summary=result_summary,
                error_message=error_message,
                error_category=error_category,
            )


def _result_summary(result: Any) -> str:
    if isinstance(result, str):
        return f"text:{len(result)} chars"
    if isinstance(result, list):
        return f"items:{len(result)}"
    if isinstance(result, dict):
        return f"fields:{','.join(sorted(str(key) for key in result))[:200]}"
    return type(result).__name__
