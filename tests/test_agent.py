import asyncio
import json
import time
import tomllib
from importlib.util import find_spec
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest


def test_agent_module_is_available():
    assert find_spec("lettermate.curation.agent") is not None


def test_openai_agents_is_a_bounded_runtime_dependency():
    project = tomllib.loads(Path("pyproject.toml").read_text(encoding="utf-8"))["project"]

    assert "openai-agents>=0.18.3,<0.19" in project["dependencies"]


def test_sdk_agent_exposes_only_bounded_tools_and_structured_output():
    from agents import Agent, FunctionTool

    from lettermate.curation.agent import build_curation_agent
    from lettermate.curation.schemas import CurationOutput

    agent = build_curation_agent(model="fake-model", tool_functions={})

    assert isinstance(agent, Agent)
    assert agent.output_type is CurationOutput
    assert {tool.name for tool in agent.tools} == {
        "fetch_full_text",
        "lookup_recent_topics",
        "get_preference_evidence",
    }
    assert all(isinstance(tool, FunctionTool) for tool in agent.tools)


def _tool_context(**kwargs):
    defaults = {
        "item_id": 1,
        "candidate_url": "https://example.com/article",
        "source_url": "https://example.com/feed.xml",
        "repository": None,
    }
    defaults.update(kwargs)
    return SimpleNamespace(**defaults)


def test_fetch_full_text_rejects_unrelated_private_and_non_http_urls():
    from lettermate.curation.tools import CurationTools, ToolSecurityError

    class NeverCalled:
        def get(self, *_args, **_kwargs):
            raise AssertionError("network should not be called")

    for url in ("ftp://example.com/a", "https://attacker.example/a", "http://127.0.0.1/a"):
        tools = CurationTools(_tool_context(), client=NeverCalled(), resolver=lambda host: [])
        with pytest.raises(ToolSecurityError):
            tools.fetch_full_text(url)


def test_fetch_full_text_revalidates_each_redirect_and_returns_bounded_plain_text():
    from lettermate.curation.tools import CurationTools, ToolSecurityError

    requests: list[str] = []

    def resolver(host: str):
        return ["93.184.216.34"] if host == "example.com" else ["127.0.0.1"]

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(str(request.url))
        if len(requests) == 1:
            return httpx.Response(302, headers={"location": "https://example.com/final"})
        return httpx.Response(
            200,
            headers={"content-type": "text/html"},
            content=b"<script>bad()</script><article>Hello <b>world</b></article>",
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))
    tools = CurationTools(_tool_context(), client=client, resolver=resolver)

    assert tools.fetch_full_text("https://example.com/article") == "Hello world"
    assert requests == ["https://example.com/article", "https://example.com/final"]

    private_redirect = httpx.Client(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                302, headers={"location": "http://127.0.0.1/private"}
            )
        )
    )
    with pytest.raises(ToolSecurityError):
        CurationTools(_tool_context(), client=private_redirect, resolver=resolver).fetch_full_text(
            "https://example.com/article"
        )


def test_fetch_full_text_rejects_oversized_content_length_before_reading():
    from lettermate.curation.tools import CurationTools, ToolError

    client = httpx.Client(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                200,
                headers={"content-type": "text/plain", "content-length": "1000001"},
                content=b"small body",
            )
        )
    )

    with pytest.raises(ToolError, match="byte limit"):
        CurationTools(
            _tool_context(),
            client=client,
            resolver=lambda _host: ["93.184.216.34"],
        ).fetch_full_text("https://example.com/article")


def test_tools_enforce_three_call_budget_and_record_duplicate_failures():
    from lettermate.curation.tools import CurationTools, ToolBudgetError
    from lettermate.curation.tracing import TraceRecorder

    class Repo:
        def list_recent_topics(self, **_kwargs):
            return []

        def list_preference_evidence(self, **_kwargs):
            return []

    tools = CurationTools(
        _tool_context(repository=Repo()), resolver=lambda _host: ["93.184.216.34"]
    )
    traces = TraceRecorder()
    tools.tracer = traces
    tools.lookup_recent_topics("agents")
    with pytest.raises(ToolBudgetError, match="duplicate"):
        tools.lookup_recent_topics("agents")
    tools.get_preference_evidence("agents")
    with pytest.raises(ToolBudgetError, match="budget"):
        tools.fetch_full_text("https://example.com/article")

    assert len(traces.records) == 4
    assert traces.records[1]["status"] == "failed"
    assert traces.records[1]["error_category"] == "tool_duplicate"
    assert traces.records[-1]["error_category"] == "tool_budget"


def test_read_only_history_tools_return_bounded_redacted_records(temp_db_session):
    from lettermate.curation.tools import CurationTools
    from lettermate.db.models import Feedback
    from lettermate.db.repository import ContentInput, Repository

    repository = Repository(temp_db_session)
    source = repository.create_source(
        "Example", "blog", "rss", "https://example.com/feed.xml", ["agents"]
    )
    item = repository.upsert_content_item(
        ContentInput(
            source_id=source.id,
            external_id="one",
            title="Agent topic",
            url="https://example.com/one",
            author="",
            published_at=None,
            raw_content="PRIVATE RAW ARTICLE SHOULD NOT ESCAPE",
        )
    )
    snapshot = repository.create_preference_snapshot(
        explicit_interests=["agents"],
        exclusions=[],
        tag_weights={},
        source_weights={},
        feedback_cutoff=None,
    )
    temp_db_session.add(
        Feedback(
            content_item_id=item.id,
            feedback_type="useful",
            tags=["agents"],
            note="PRIVATE NOTE SHOULD NOT ESCAPE",
            preference_snapshot_id=snapshot.id,
        )
    )
    temp_db_session.commit()
    tools = CurationTools(_tool_context(repository=repository))

    topics = tools.lookup_recent_topics("agents")
    evidence = tools.get_preference_evidence("agents")

    assert topics and evidence
    combined = repr(topics + evidence)
    assert "PRIVATE" not in combined
    assert set(topics[0]) <= {"item_id", "tags", "summary"}
    assert set(evidence[0]) <= {
        "feedback_id",
        "content_item_id",
        "feedback_type",
        "tags",
        "summary",
    }


class ScriptedRunner:
    def __init__(self, output, calls=()):
        self.output = output
        self.calls = list(calls)
        self.inputs = []

    def run_sync(self, agent, input, *, max_turns):
        from agents import RunConfig
        from agents.tool_context import ToolContext

        self.inputs.append((input, max_turns))
        for name, arguments in self.calls:
            tool = next(tool for tool in agent.tools if tool.name == name)
            encoded = json.dumps(arguments)
            context = ToolContext(
                None,
                tool_name=name,
                tool_call_id=f"call-{name}",
                tool_arguments=encoded,
                run_config=RunConfig(
                    tracing_disabled=True, trace_include_sensitive_data=False
                ),
            )
            asyncio.run(tool.on_invoke_tool(context, encoded))
        return SimpleNamespace(
            final_output=self.output,
            context_wrapper=SimpleNamespace(
                usage=SimpleNamespace(input_tokens=11, output_tokens=7)
            ),
        )


def _output(**updates):
    values = {
        "summary": "Bounded summary",
        "tags": ["agents"],
        "semantic_score": 4,
        "recommendation": "include",
        "reason": "Relevant to configured interests.",
        "evidence_references": ["feed:1"],
        "confidence": 0.9,
    }
    values.update(updates)
    return values


def _agent_setup(session):
    from lettermate.curation.schemas import CurationRequest
    from lettermate.db.repository import ContentInput, Repository

    repository = Repository(session)
    source = repository.create_source(
        "Example", "blog", "rss", "https://example.com/feed.xml", ["agents"]
    )
    item = repository.upsert_content_item(
        ContentInput(
            source_id=source.id,
            external_id="one",
            title="Bounded agents",
            url="https://example.com/article",
            author="",
            published_at=None,
            raw_content="Feed excerpt",
        )
    )
    snapshot = repository.create_preference_snapshot(
        explicit_interests=["agents"],
        exclusions=["spam"],
        tag_weights={"agents": 2},
        source_weights={},
        feedback_cutoff=None,
    )
    request = CurationRequest(
        item_id=item.id,
        title=item.title,
        excerpt=item.raw_content,
        url=item.url,
        source_url=source.url,
        preference_snapshot_id=snapshot.id,
        preference_snapshot={
            "version": snapshot.version,
            "explicit_interests": snapshot.explicit_interests,
            "exclusions": snapshot.exclusions,
            "tag_weights": snapshot.tag_weights,
        },
        current_issue_context={"recent_item_ids": []},
        preferences=snapshot.explicit_interests,
        available_evidence_ids=[f"feed:{item.id}"],
    )
    return repository, request


@pytest.mark.parametrize(
    "calls",
    [
        [],
        [("fetch_full_text", {"url": "https://example.com/article"})],
        [("lookup_recent_topics", {"query": "agents"})],
        [("get_preference_evidence", {"topic": "agents"})],
        [
            ("fetch_full_text", {"url": "https://example.com/article"}),
            ("lookup_recent_topics", {"query": "agents"}),
            ("get_preference_evidence", {"topic": "agents"}),
        ],
    ],
)
def test_agent_runs_zero_single_and_all_bounded_tools(temp_db_session, calls):
    from lettermate.curation.agent import AgentCurationProvider
    from lettermate.db.models import AgentRun, ToolCallTrace

    repository, request = _agent_setup(temp_db_session)
    runner = ScriptedRunner(_output(), calls)
    http_client = httpx.Client(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                200, headers={"content-type": "text/plain"}, content=b"Full text"
            )
        )
    )
    provider = AgentCurationProvider(
        repository,
        runner=runner,
        model="fake-model",
        http_client=http_client,
        resolver=lambda _host: ["93.184.216.34"],
    )

    result = provider.curate(request)

    run = temp_db_session.query(AgentRun).one()
    assert result.agent_run_id == run.id
    assert run.status == "succeeded"
    assert run.input_tokens == 11 and run.output_tokens == 7
    assert temp_db_session.query(ToolCallTrace).count() == len(calls)
    payload, max_turns = runner.inputs[0]
    assert payload["candidate"]["item_id"] == request.item_id
    assert payload["preference_snapshot"]["version"] == 1
    assert "current_issue_context" in payload and "prompt_version" in payload
    assert max_turns == provider.max_turns


@pytest.mark.parametrize(
    ("calls", "category"),
    [
        (
            [
                ("lookup_recent_topics", {"query": "a"}),
                ("lookup_recent_topics", {"query": "b"}),
            ],
            "tool_duplicate",
        ),
        (
            [
                ("fetch_full_text", {"url": "https://example.com/article"}),
                ("lookup_recent_topics", {"query": "a"}),
                ("get_preference_evidence", {"topic": "a"}),
                ("lookup_recent_topics", {"query": "b"}),
            ],
            "tool_budget",
        ),
    ],
)
def test_duplicate_and_over_budget_fail_agent_run_visibly(temp_db_session, calls, category):
    from lettermate.curation.agent import AgentCurationProvider
    from lettermate.curation.tools import ToolBudgetError
    from lettermate.db.models import AgentRun, ToolCallTrace

    repository, request = _agent_setup(temp_db_session)
    client = httpx.Client(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                200, headers={"content-type": "text/plain"}, content=b"Full text"
            )
        )
    )
    provider = AgentCurationProvider(
        repository,
        runner=ScriptedRunner(_output(), calls),
        model="fake-model",
        http_client=client,
        resolver=lambda _host: ["93.184.216.34"],
    )

    with pytest.raises(ToolBudgetError):
        provider.curate(request)

    run = temp_db_session.query(AgentRun).one()
    assert run.status == "failed" and run.error_category == category
    trace = (
        temp_db_session.query(ToolCallTrace)
        .order_by(ToolCallTrace.sequence.desc())
        .first()
    )
    assert trace.error_category == category


def test_timeout_invalid_output_and_low_confidence_policy(temp_db_session):
    from lettermate.curation.agent import AgentCurationProvider, AgentRunTimeout
    from lettermate.db.models import AgentRun

    class SlowRunner:
        def run_sync(self, agent, input, *, max_turns):
            time.sleep(0.1)
            return SimpleNamespace(final_output=_output())

    repository, request = _agent_setup(temp_db_session)
    timeout_provider = AgentCurationProvider(
        repository, runner=SlowRunner(), model="fake-model", timeout_seconds=0.01
    )
    with pytest.raises(AgentRunTimeout):
        timeout_provider.curate(request)
    assert temp_db_session.query(AgentRun).one().error_category == "agent_timeout"

    temp_db_session.query(AgentRun).delete()
    temp_db_session.commit()
    invalid = AgentCurationProvider(
        repository, runner=ScriptedRunner({"not": "valid"}), model="fake-model"
    )
    from pydantic import ValidationError

    with pytest.raises((ValidationError, TypeError, ValueError)):
        invalid.curate(request)
    assert temp_db_session.query(AgentRun).one().error_category == "output_validation"

    temp_db_session.query(AgentRun).delete()
    temp_db_session.commit()
    low = AgentCurationProvider(
        repository,
        runner=ScriptedRunner(_output(confidence=0.2)),
        model="fake-model",
        minimum_confidence=0.6,
    ).curate(request)
    assert low.recommendation == "review"


def test_service_reuses_agent_run_while_ranking_owns_final_decision(temp_db_session):
    from lettermate.curation.agent import AgentCurationProvider
    from lettermate.curation.service import CurationService
    from lettermate.db.models import AgentRun
    from lettermate.ranking.policy import RankingPolicy

    repository, _request = _agent_setup(temp_db_session)
    provider = AgentCurationProvider(
        repository,
        runner=ScriptedRunner(
            _output(semantic_score=5, recommendation="exclude", confidence=0.95)
        ),
        model="fake-model",
    )
    service = CurationService(
        repository,
        provider=provider,
        ranking_policy=RankingPolicy(item_limit=5, minimum_score=4),
    )

    analysis = service.analyze_pending(now=None)[0]

    run = temp_db_session.query(AgentRun).one()
    assert analysis.agent_run_id == run.id
    assert run.semantic_output["recommendation"] == "exclude"
    assert analysis.should_include is True
    assert analysis.decision == "include"


def test_agent_accepts_ids_returned_by_bounded_evidence_tools(temp_db_session):
    from lettermate.curation.agent import AgentCurationProvider

    repository, request = _agent_setup(temp_db_session)
    provider = AgentCurationProvider(
        repository,
        runner=ScriptedRunner(
            _output(
                evidence_references=["item:1"],
            ),
            calls=[("lookup_recent_topics", {"query": "agents"})],
        ),
        model="fake-model",
    )

    assert provider.curate(request).evidence_references == ["item:1"]


def test_agent_revalidates_sdk_parsed_output_with_runtime_evidence(temp_db_session):
    from lettermate.curation.agent import AgentCurationProvider
    from lettermate.curation.schemas import CurationOutput

    repository, request = _agent_setup(temp_db_session)
    sdk_output = CurationOutput(**_output(evidence_references=["item:1"]))
    provider = AgentCurationProvider(
        repository,
        runner=ScriptedRunner(
            sdk_output,
            calls=[("lookup_recent_topics", {"query": "agents"})],
        ),
        model="fake-model",
    )

    assert provider.curate(request).evidence_references == ["item:1"]


def test_agent_settings_are_bounded_and_do_not_require_an_api_key():
    from lettermate.config import Settings

    settings = Settings(_env_file=None)

    assert settings.openai_api_key == ""
    assert 1 <= settings.curation_max_turns <= 8
    assert 0 < settings.curation_timeout_seconds <= 120
    assert 0 <= settings.curation_minimum_confidence <= 1
