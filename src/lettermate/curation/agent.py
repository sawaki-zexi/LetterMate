"""Bounded content curation agent built on the OpenAI Agents SDK."""

from __future__ import annotations

import json
import time
from collections.abc import Callable, Mapping
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeoutError
from hashlib import sha256
from typing import Any

from agents import Agent, OpenAIResponsesModel, Runner, function_tool
from pydantic import ValidationError

from lettermate.curation.prompts import PROMPT_VERSION, SYSTEM_PROMPT
from lettermate.curation.schemas import CurationOutput
from lettermate.curation.tools import CurationTools
from lettermate.curation.tracing import TraceRecorder, disable_sdk_tracing

_TOOL_NAMES = ("fetch_full_text", "lookup_recent_topics", "get_preference_evidence")


def build_curation_agent(
    *, model: Any = None, tool_functions: Mapping[str, Callable[..., Any]] | None = None
) -> Agent[Any]:
    """Build an SDK agent with the deliberately small curation tool surface."""
    functions = dict(tool_functions or {})
    tools: list[Any] = []
    for name in _TOOL_NAMES:
        fn = functions.get(name)
        if fn is None:
            fn = _unavailable_tool(name)
        tools.append(function_tool(fn, name_override=name, failure_error_function=None))
    return Agent(
        name="bounded-content-curator",
        instructions=SYSTEM_PROMPT,
        model=model,
        tools=tools,
        output_type=CurationOutput,
    )


def _unavailable_tool(name: str) -> Callable[..., str]:
    if name == "fetch_full_text":
        def fetch_full_text(url: str) -> str:
            raise RuntimeError(f"tool {name} is unavailable")

        return fetch_full_text
    if name == "lookup_recent_topics":
        def lookup_recent_topics(query: str = "") -> str:
            raise RuntimeError(f"tool {name} is unavailable")

        return lookup_recent_topics

    def get_preference_evidence(topic: str = "") -> str:
        raise RuntimeError(f"tool {name} is unavailable")

    return get_preference_evidence


class AgentRunTimeout(RuntimeError):
    pass


class _SDKRunner:
    def run_sync(
        self, agent: Agent[Any], input: dict[str, object], *, max_turns: int
    ) -> Any:
        return Runner.run_sync(
            agent,
            json.dumps(input, sort_keys=True, separators=(",", ":"), default=str),
            max_turns=max_turns,
        )


class AgentCurationProvider:
    prompt_version = PROMPT_VERSION

    def __init__(
        self,
        repository: Any,
        *,
        runner: Any = None,
        model: Any = "gpt-5-mini",
        client: Any = None,
        http_client: Any = None,
        resolver: Callable[[str], list[str]] | None = None,
        max_turns: int = 4,
        timeout_seconds: float = 30.0,
        minimum_confidence: float = 0.6,
    ) -> None:
        if max_turns < 1 or timeout_seconds <= 0 or not 0 <= minimum_confidence <= 1:
            raise ValueError("invalid bounded agent configuration")
        self._repository = repository
        self._runner = runner or _SDKRunner()
        self._http_client = http_client
        self._resolver = resolver
        self.max_turns = max_turns
        self.timeout_seconds = timeout_seconds
        self.minimum_confidence = minimum_confidence
        self.model = _model_identifier(model)
        self._agent_model = (
            OpenAIResponsesModel(model=self.model, openai_client=client)
            if client is not None and isinstance(model, str)
            else model
        )
        disable_sdk_tracing()

    def curate(self, request: Any) -> CurationOutput:
        if request.preference_snapshot_id is None:
            raise ValueError("agent curation requires a preference snapshot ID")
        payload = self._input_payload(request)
        input_hash = sha256(
            json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode()
        ).hexdigest()
        run = self._repository.start_agent_run(
            content_item_id=request.item_id,
            preference_snapshot_id=request.preference_snapshot_id,
            prompt_version=self.prompt_version,
            model=self.model,
            input_hash=input_hash,
        )
        tracer = TraceRecorder(self._repository, run.id)
        context = type(
            "CurationToolContext",
            (),
            {
                "item_id": request.item_id,
                "candidate_url": str(request.url),
                "source_url": str(request.source_url) if request.source_url is not None else None,
                "repository": self._repository,
            },
        )()
        tools = CurationTools(
            context,
            client=self._http_client,
            resolver=self._resolver,
            tracer=tracer,
        )
        agent = build_curation_agent(
            model=self._agent_model,
            tool_functions={
                "fetch_full_text": tools.fetch_full_text,
                "lookup_recent_topics": tools.lookup_recent_topics,
                "get_preference_evidence": tools.get_preference_evidence,
            },
        )
        started = time.perf_counter()
        try:
            result = self._run_with_timeout(agent, payload)
            output = self._validated_output(
                result,
                request,
                available_evidence_ids=set(request.available_evidence_ids) | tools.evidence_ids,
            )
            if output.confidence < self.minimum_confidence and output.recommendation == "include":
                output = output.model_copy(update={"recommendation": "review"})
            output = output.model_copy(
                update={"agent_run_id": run.id, "model_identifier": self.model}
            )
            usage = getattr(getattr(result, "context_wrapper", None), "usage", None)
            self._repository.complete_agent_run(
                run.id,
                semantic_output=output.model_dump(
                    exclude={"available_evidence_ids", "agent_run_id"}
                ),
                latency_ms=int((time.perf_counter() - started) * 1000),
                input_tokens=int(getattr(usage, "input_tokens", 0) or 0),
                output_tokens=int(getattr(usage, "output_tokens", 0) or 0),
                cost_usd="0",
            )
            return output
        except Exception as error:
            category = _error_category(error)
            self._repository.fail_agent_run(
                run.id,
                _safe_error_message(error, category),
                error_category=category,
            )
            raise

    def _run_with_timeout(self, agent: Agent[Any], payload: dict[str, object]) -> Any:
        executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="curation-agent")
        future = executor.submit(
            self._runner.run_sync, agent, payload, max_turns=self.max_turns
        )
        try:
            return future.result(timeout=self.timeout_seconds)
        except FutureTimeoutError as error:
            future.cancel()
            raise AgentRunTimeout("curation agent exceeded its timeout") from error
        finally:
            executor.shutdown(wait=False, cancel_futures=True)

    @staticmethod
    def _validated_output(
        result: Any,
        request: Any,
        *,
        available_evidence_ids: set[str] | None = None,
    ) -> CurationOutput:
        value = getattr(result, "final_output", result)
        if isinstance(value, CurationOutput):
            values = value.model_dump(exclude={"available_evidence_ids", "agent_run_id"})
        else:
            values = value
        return CurationOutput.model_validate(
            {
                **values,
                "available_evidence_ids": sorted(
                    available_evidence_ids or set(request.available_evidence_ids)
                ),
            }
        )

    def _input_payload(self, request: Any) -> dict[str, object]:
        return {
            "candidate": {
                "item_id": request.item_id,
                "title": request.title,
                "excerpt": request.excerpt,
                "url": str(request.url),
                "source_url": str(request.source_url) if request.source_url is not None else None,
                "available_evidence_ids": list(request.available_evidence_ids),
            },
            "preference_snapshot": dict(request.preference_snapshot),
            "current_issue_context": dict(request.current_issue_context),
            "prompt_version": self.prompt_version,
        }


def _model_identifier(model: Any) -> str:
    if isinstance(model, str):
        return model
    return str(
        getattr(model, "model", None)
        or getattr(model, "name", None)
        or type(model).__name__
    )


def _error_category(error: Exception) -> str:
    explicit = getattr(error, "error_category", None)
    if explicit:
        return str(explicit)
    if isinstance(error, AgentRunTimeout):
        return "agent_timeout"
    if isinstance(error, (ValidationError, TypeError, ValueError)):
        return "output_validation"
    return "model_error"


def _safe_error_message(error: Exception, category: str) -> str:
    if category.startswith("tool_") or category == "agent_timeout":
        return str(error)[:300]
    return f"{category}: {type(error).__name__}"
