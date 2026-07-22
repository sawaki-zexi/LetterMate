from datetime import UTC, date, datetime

import pytest
from sqlalchemy import inspect
from sqlalchemy.exc import IntegrityError

from lettermate.config import Settings
from lettermate.db.models import (
    AgentRun,
    AnalysisResult,
    ContentItem,
    Newsletter,
    NewsletterItem,
    PreferenceSnapshot,
    Source,
    ToolCallTrace,
)
from lettermate.db.session import create_session_factory
from lettermate.db.statuses import (
    AgentRunStatus,
    ContentItemStatus,
    JobRunStatus,
    NewsletterStatus,
    SourceStatus,
)


def add_source(temp_db_session, *, url: str = "https://example.com/feed.xml") -> Source:
    source = Source(
        name="Example Blog",
        platform="blog",
        source_type="rss",
        url=url,
        tags=["AI", "Career"],
        enabled=True,
    )
    temp_db_session.add(source)
    temp_db_session.flush()
    return source


def add_item(
    temp_db_session,
    source: Source,
    *,
    external_id: str | None = "entry-1",
    url: str = "https://example.com/agent",
    content_hash: str = "hash-1",
) -> ContentItem:
    item = ContentItem(
        source_id=source.id,
        external_id=external_id,
        title="Agent engineering notes",
        url=url,
        author="Example Author",
        published_at=datetime(2026, 6, 26, tzinfo=UTC),
        raw_content="Useful article about agent engineering.",
        content_hash=content_hash,
        status=ContentItemStatus.PENDING_ANALYSIS,
    )
    temp_db_session.add(item)
    temp_db_session.flush()
    return item


def add_snapshot(temp_db_session, *, version: int = 1) -> PreferenceSnapshot:
    snapshot = PreferenceSnapshot(
        version=version,
        explicit_interests=["agent engineering"],
        exclusions=["cryptocurrency"],
        tag_weights={"agents": 2},
        source_weights={"Example Blog": 1},
        feedback_cutoff=datetime(2026, 6, 26, tzinfo=UTC),
        content_hash=f"snapshot-{version}",
    )
    temp_db_session.add(snapshot)
    temp_db_session.flush()
    return snapshot


def add_agent_run(temp_db_session, item: ContentItem, snapshot: PreferenceSnapshot) -> AgentRun:
    run = AgentRun(
        content_item_id=item.id,
        preference_snapshot_id=snapshot.id,
        prompt_version="curator-v1",
        model="fake-local",
        input_hash="input-hash",
        status=AgentRunStatus.RUNNING,
    )
    temp_db_session.add(run)
    temp_db_session.flush()
    return run


def test_status_values_are_centralized_and_stable():
    assert SourceStatus.ACTIVE == "active"
    assert ContentItemStatus.PENDING_ANALYSIS == "pending_analysis"
    assert AgentRunStatus.SUCCEEDED == "succeeded"
    assert NewsletterStatus.DRAFT == "draft"
    assert JobRunStatus.FAILED == "failed"


def test_source_url_is_unique(temp_db_session):
    add_source(temp_db_session)
    temp_db_session.add(
        Source(
            name="Duplicate",
            platform="blog",
            source_type="rss",
            url="https://example.com/feed.xml",
            tags=[],
        )
    )

    with pytest.raises(IntegrityError):
        temp_db_session.commit()


def test_nullable_external_ids_do_not_collide_but_non_null_ids_are_source_scoped(
    temp_db_session,
):
    source = add_source(temp_db_session)
    add_item(
        temp_db_session, source, external_id=None, url="https://example.com/a", content_hash="a"
    )
    add_item(
        temp_db_session, source, external_id=None, url="https://example.com/b", content_hash="b"
    )
    temp_db_session.commit()

    add_item(
        temp_db_session, source, external_id="same", url="https://example.com/c", content_hash="c"
    )
    temp_db_session.commit()
    temp_db_session.add(
        ContentItem(
            source_id=source.id,
            external_id="same",
            title="Other",
            url="https://example.com/d",
            content_hash="d",
        )
    )
    with pytest.raises(IntegrityError):
        temp_db_session.commit()


def test_one_analysis_per_item_and_analysis_references_agent_run(temp_db_session):
    source = add_source(temp_db_session)
    item = add_item(temp_db_session, source)
    snapshot = add_snapshot(temp_db_session)
    run = add_agent_run(temp_db_session, item, snapshot)
    analysis = AnalysisResult(
        content_item_id=item.id,
        agent_run_id=run.id,
        summary="A short summary.",
        tags=["AI"],
        score=4,
        reason="Relevant.",
        actionable_insight="Add evaluation metrics.",
        should_include=True,
        model="fake-local",
        semantic_score=4.0,
        preference_boost=1.0,
        freshness_bonus=0.5,
        repetition_penalty=0.0,
        source_diversity_adjustment=0.25,
        final_score=5.75,
        decision="include",
    )
    temp_db_session.add(analysis)
    temp_db_session.commit()

    temp_db_session.add(
        AnalysisResult(
            content_item_id=item.id,
            agent_run_id=run.id,
            summary="Replacement",
            tags=[],
            score=1,
            model="fake-local",
        )
    )
    with pytest.raises(IntegrityError):
        temp_db_session.commit()


def test_recommendation_provenance_and_ranking_components_are_required():
    analysis_columns = AnalysisResult.__table__.c

    assert not analysis_columns.agent_run_id.nullable
    assert not analysis_columns.semantic_score.nullable
    assert not analysis_columns.final_score.nullable
    assert not analysis_columns.decision.nullable
    assert not NewsletterItem.__table__.c.decision_id.nullable


def test_one_newsletter_per_local_date_and_unique_membership(temp_db_session):
    source = add_source(temp_db_session)
    item = add_item(temp_db_session, source)
    run = add_agent_run(temp_db_session, item, add_snapshot(temp_db_session))
    analysis = AnalysisResult(
        content_item_id=item.id,
        agent_run_id=run.id,
        summary="Summary",
        tags=["AI"],
        score=4,
        model="fake-local",
        semantic_score=4.0,
        final_score=5.0,
        decision="include",
    )
    temp_db_session.add(analysis)
    temp_db_session.flush()
    newsletter = Newsletter(
        issue_date=date(2026, 6, 26),
        title="Daily",
        markdown_body="# Daily",
        html_body="<h1>Daily</h1>",
        status=NewsletterStatus.DRAFT,
    )
    temp_db_session.add(newsletter)
    temp_db_session.flush()
    temp_db_session.add(
        NewsletterItem(
            newsletter_id=newsletter.id,
            content_item_id=item.id,
            decision_id=analysis.id,
            position=1,
            section="Top picks",
            final_score=5.75,
        )
    )
    temp_db_session.commit()

    temp_db_session.add(
        NewsletterItem(
            newsletter_id=newsletter.id,
            content_item_id=item.id,
            decision_id=analysis.id,
            position=2,
            section="More",
            final_score=4.0,
        )
    )
    with pytest.raises(IntegrityError):
        temp_db_session.commit()


def test_preference_snapshot_is_immutable(temp_db_session):
    snapshot = add_snapshot(temp_db_session)
    temp_db_session.commit()

    snapshot.tag_weights = {"changed": 99}
    with pytest.raises(ValueError, match="immutable"):
        temp_db_session.commit()


def test_preference_snapshot_relationships_can_receive_new_agent_runs(temp_db_session):
    source = add_source(temp_db_session)
    item = add_item(temp_db_session, source)
    snapshot = add_snapshot(temp_db_session)
    temp_db_session.commit()
    run = AgentRun(
        content_item_id=item.id,
        preference_snapshot=snapshot,
        prompt_version="curator-v1",
        model="fake-local",
        input_hash="input-hash",
        status=AgentRunStatus.RUNNING,
    )
    temp_db_session.add(run)

    temp_db_session.commit()

    assert run.preference_snapshot_id == snapshot.id


def test_tool_trace_sequences_are_unique_and_ordered_by_relationship(temp_db_session):
    source = add_source(temp_db_session)
    item = add_item(temp_db_session, source)
    run = add_agent_run(temp_db_session, item, add_snapshot(temp_db_session))
    temp_db_session.add_all(
        [
            ToolCallTrace(
                agent_run_id=run.id,
                sequence=2,
                tool_name="lookup_recent_topics",
                argument_summary="query metadata",
                argument_hash="args-2",
                status=AgentRunStatus.SUCCEEDED,
            ),
            ToolCallTrace(
                agent_run_id=run.id,
                sequence=1,
                tool_name="fetch_full_text",
                argument_summary="url redacted",
                argument_hash="args-1",
                status=AgentRunStatus.SUCCEEDED,
            ),
        ]
    )
    temp_db_session.commit()
    temp_db_session.refresh(run)

    assert [trace.sequence for trace in run.tool_traces] == [1, 2]


def test_sqlite_enforces_audit_foreign_keys(temp_db_session):
    temp_db_session.add(
        ToolCallTrace(
            agent_run_id=999,
            sequence=1,
            tool_name="fetch_full_text",
            argument_summary="host=example.com",
            argument_hash="args",
            status=AgentRunStatus.SUCCEEDED,
        )
    )

    with pytest.raises(IntegrityError):
        temp_db_session.commit()


def test_normal_session_factory_does_not_create_schema(tmp_path):
    database_path = tmp_path / "application.db"
    factory = create_session_factory(Settings(database_url=f"sqlite:///{database_path}"))
    engine = factory.kw["bind"]

    assert inspect(engine).get_table_names() == []
    engine.dispose()
