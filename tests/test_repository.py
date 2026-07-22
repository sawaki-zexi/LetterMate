from datetime import UTC, date

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from lettermate.db.models import AnalysisResult, JobEvent, NewsletterItem, Source, ToolCallTrace
from lettermate.db.repository import (
    ContentInput,
    NewsletterItemInput,
    Repository,
    make_content_hash,
    normalize_url,
)
from lettermate.db.statuses import AgentRunStatus, JobRunStatus, NewsletterStatus, SourceStatus


def content_input(
    source_id: int,
    *,
    external_id: str | None = "entry-1",
    title: str = "Title",
    url: str = "https://example.com/post",
    raw_content: str = "Body",
) -> ContentInput:
    return ContentInput(
        source_id=source_id,
        external_id=external_id,
        title=title,
        url=url,
        author="Author",
        published_at=None,
        raw_content=raw_content,
    )


def create_source(repo: Repository, *, url: str = "https://example.com/feed.xml") -> Source:
    return repo.create_source(
        name="Example",
        platform="blog",
        source_type="rss",
        url=url,
        tags=["AI"],
    )


def test_content_hash_does_not_depend_on_url():
    first = make_content_hash("Title", "https://example.com/first", "Body")
    second = make_content_hash("Title", "https://elsewhere.example/second", "Body")

    assert first == second


def test_content_hash_has_unambiguous_field_boundaries():
    assert make_content_hash("a|b", "https://example.com/one", "c") != make_content_hash(
        "a", "https://example.com/two", "b|c"
    )


def test_url_normalization_removes_transport_noise_and_known_tracking_parameters():
    assert normalize_url(
        "HTTPS://Example.COM:443/post?utm_source=mail&b=2&a=1&fbclid=tracking#section"
    ) == "https://example.com/post?a=1&b=2"


def test_content_upsert_deduplicates_normalized_url_before_other_keys(temp_db_session):
    repo = Repository(temp_db_session)
    source = create_source(repo)
    first = repo.upsert_content_item(
        content_input(
            source.id,
            external_id="original",
            url="HTTPS://Example.COM:443/post?utm_source=mail#section",
            raw_content="Original body",
        )
    )
    second = repo.upsert_content_item(
        content_input(
            source.id,
            external_id="changed",
            url="https://example.com/post",
            raw_content="Updated body",
        )
    )

    assert second.id == first.id
    assert second.external_id == "original"
    assert second.normalized_url == "https://example.com/post"
    assert repo.count_content_items() == 1


def test_content_input_rejects_mismatched_pre_normalized_url(temp_db_session):
    repo = Repository(temp_db_session)
    source = create_source(repo)
    item = content_input(source.id)

    with pytest.raises(ValueError, match="normalized URL does not match"):
        repo.upsert_content_item(
            ContentInput(
                source_id=item.source_id,
                external_id=item.external_id,
                title=item.title,
                url=item.url,
                author=item.author,
                published_at=item.published_at,
                raw_content=item.raw_content,
                normalized_url="https://attacker.example/post",
            )
        )


def test_source_sync_updates_by_exact_or_normalized_url_with_stable_primary_key(temp_db_session):
    repo = Repository(temp_db_session)
    first = create_source(repo, url="HTTPS://Example.COM:443/feed.xml#fragment")
    second = repo.upsert_source(
        name="Renamed",
        platform="blog",
        source_type="rss",
        url="https://example.com/feed.xml",
        tags=["Agents"],
        status=SourceStatus.ACTIVE,
    )

    assert first.id == second.id
    assert second.name == "Renamed"
    assert second.url == "https://example.com/feed.xml"
    assert temp_db_session.query(Source).count() == 1


def test_content_upsert_deduplicates_in_required_order_and_keeps_primary_key(temp_db_session):
    repo = Repository(temp_db_session)
    source = create_source(repo)
    other_source = create_source(repo, url="https://other.example/feed")

    original = repo.upsert_content_item(content_input(source.id))
    by_url = repo.upsert_content_item(
        content_input(source.id, external_id="new-id", title="Changed", raw_content="Changed")
    )
    by_external_id = repo.upsert_content_item(
        content_input(
            source.id,
            external_id="entry-1",
            url="https://example.com/moved",
            title="Moved",
            raw_content="Moved body",
        )
    )
    by_hash = repo.upsert_content_item(
        content_input(
            other_source.id,
            external_id=None,
            url="https://mirror.example/post",
            title="Moved",
            raw_content="Moved body",
        )
    )

    assert {original.id, by_url.id, by_external_id.id, by_hash.id} == {original.id}
    assert by_external_id.url == "https://example.com/moved"
    assert repo.count_content_items() == 1


def test_nullable_external_ids_can_create_distinct_items(temp_db_session):
    repo = Repository(temp_db_session)
    source = create_source(repo)

    first = repo.upsert_content_item(
        content_input(source.id, external_id=None, url="https://example.com/a", raw_content="A")
    )
    second = repo.upsert_content_item(
        content_input(source.id, external_id=None, url="https://example.com/b", raw_content="B")
    )

    assert first.id != second.id


def test_analysis_upsert_replaces_values_without_replacing_row(temp_db_session):
    repo = Repository(temp_db_session)
    item = repo.upsert_content_item(content_input(create_source(repo).id))
    snapshot = repo.create_preference_snapshot(
        explicit_interests=[],
        exclusions=[],
        tag_weights={},
        source_weights={},
        feedback_cutoff=None,
    )
    first_run = repo.start_agent_run(
        content_item_id=item.id,
        preference_snapshot_id=snapshot.id,
        prompt_version="curator-v1",
        model="fake-local",
        input_hash="input-1",
    )

    first = repo.save_analysis(
        item,
        summary="First",
        tags=["AI"],
        score=3,
        reason="Relevant",
        actionable_insight="Try it",
        should_include=True,
        model="fake-local",
        agent_run_id=first_run.id,
        semantic_score=3.0,
        final_score=4.25,
        decision="include",
    )
    second_run = repo.start_agent_run(
        content_item_id=item.id,
        preference_snapshot_id=snapshot.id,
        prompt_version="curator-v2",
        model="fake-local-v2",
        input_hash="input-2",
    )
    second = repo.save_analysis(
        item,
        summary="Replacement",
        tags=["Agents"],
        score=4,
        reason="More relevant",
        actionable_insight="Ship it",
        should_include=True,
        model="fake-local-v2",
        agent_run_id=second_run.id,
        semantic_score=4.0,
        final_score=5.0,
        decision="include",
    )

    assert first.id == second.id
    assert second.summary == "Replacement"
    assert item.status == "analyzed"


def test_analysis_rejects_agent_run_for_a_different_content_item(temp_db_session):
    repo = Repository(temp_db_session)
    source = create_source(repo)
    first_item = repo.upsert_content_item(
        content_input(
            source.id, external_id="one", url="https://example.com/one", raw_content="One"
        )
    )
    second_item = repo.upsert_content_item(
        content_input(
            source.id, external_id="two", url="https://example.com/two", raw_content="Two"
        )
    )
    snapshot = repo.create_preference_snapshot(
        explicit_interests=[],
        exclusions=[],
        tag_weights={},
        source_weights={},
        feedback_cutoff=None,
    )
    wrong_run = repo.start_agent_run(
        content_item_id=second_item.id,
        preference_snapshot_id=snapshot.id,
        prompt_version="curator-v1",
        model="fake-local",
        input_hash="wrong-item",
    )

    with pytest.raises(ValueError, match="does not belong"):
        repo.save_analysis(
            first_item,
            summary="Summary",
            tags=[],
            score=1,
            reason="Reason",
            actionable_insight="None",
            should_include=False,
            model="fake-local",
            agent_run_id=wrong_run.id,
            semantic_score=1.0,
            final_score=1.0,
            decision="exclude",
        )

    assert temp_db_session.query(AnalysisResult).count() == 0


def test_snapshots_increment_are_deterministic_and_reset_without_deleting_feedback(
    temp_db_session,
):
    repo = Repository(temp_db_session)
    first = repo.create_preference_snapshot(
        explicit_interests=["agents"],
        exclusions=["crypto"],
        tag_weights={"agents": 2},
        source_weights={"Example": 1},
        feedback_cutoff=None,
    )
    second = repo.create_preference_snapshot(
        explicit_interests=["agents"],
        exclusions=["crypto"],
        tag_weights={"agents": 2},
        source_weights={"Example": 1},
        feedback_cutoff=None,
    )
    reset = repo.reset_preference_weights()

    assert [first.version, second.version, reset.version] == [1, 2, 3]
    assert first.content_hash == second.content_hash
    assert reset.explicit_interests == ["agents"]
    assert reset.exclusions == ["crypto"]
    assert reset.tag_weights == {}
    assert reset.source_weights == {}
    assert repo.get_latest_preference_snapshot().id == reset.id


def test_newsletter_upsert_replaces_membership_deterministically_and_preserves_rows(
    temp_db_session,
):
    repo = Repository(temp_db_session)
    source = create_source(repo)
    first_item = repo.upsert_content_item(
        content_input(
            source.id, external_id="one", url="https://example.com/one", raw_content="One"
        )
    )
    second_item = repo.upsert_content_item(
        content_input(
            source.id, external_id="two", url="https://example.com/two", raw_content="Two"
        )
    )
    snapshot = repo.create_preference_snapshot(
        explicit_interests=[],
        exclusions=[],
        tag_weights={},
        source_weights={},
        feedback_cutoff=None,
    )
    decisions = []
    for position, item in enumerate((first_item, second_item), start=1):
        run = repo.start_agent_run(
            content_item_id=item.id,
            preference_snapshot_id=snapshot.id,
            prompt_version="curator-v1",
            model="fake-local",
            input_hash=f"input-{position}",
        )
        decisions.append(
            repo.save_analysis(
                item,
                summary=f"Summary {position}",
                tags=["AI"],
                score=5 - position,
                reason="Relevant",
                actionable_insight="Read it",
                should_include=True,
                model="fake-local",
                agent_run_id=run.id,
                semantic_score=float(5 - position),
                final_score=float(6 - position),
                decision="include",
            )
        )
    with pytest.raises(ValueError, match="does not belong"):
        repo.save_newsletter(
            issue_date=date(2026, 7, 21),
            title="Invalid",
            markdown_body="# Invalid",
            html_body="<h1>Invalid</h1>",
            status=NewsletterStatus.DRAFT,
            items=[NewsletterItemInput(first_item.id, decisions[1].id, 1, "Top", 5.0)],
        )
    first = repo.save_newsletter(
        issue_date=date(2026, 7, 22),
        title="Daily",
        markdown_body="# Daily",
        html_body="<h1>Daily</h1>",
        status=NewsletterStatus.DRAFT,
        items=[
            NewsletterItemInput(first_item.id, decisions[0].id, 1, "Top", 5.0),
            NewsletterItemInput(second_item.id, decisions[1].id, 2, "More", 4.0),
        ],
    )
    original_ids = {member.content_item_id: member.id for member in first.items}
    second = repo.save_newsletter(
        issue_date=date(2026, 7, 22),
        title="Updated Daily",
        markdown_body="# Updated",
        html_body="<h1>Updated</h1>",
        status=NewsletterStatus.PREVIEW,
        items=[
            NewsletterItemInput(second_item.id, decisions[1].id, 1, "Top", 6.0),
            NewsletterItemInput(first_item.id, decisions[0].id, 2, "More", 3.0),
        ],
    )

    assert first.id == second.id
    assert [member.content_item_id for member in second.items] == [second_item.id, first_item.id]
    assert {member.content_item_id: member.id for member in second.items} == original_ids
    assert temp_db_session.query(NewsletterItem).count() == 2


def test_invalid_newsletter_membership_does_not_stage_partial_header_updates(temp_db_session):
    repo = Repository(temp_db_session)
    original = repo.save_newsletter(
        issue_date=date(2026, 7, 22),
        title="Original",
        markdown_body="# Original",
        html_body="<h1>Original</h1>",
        status=NewsletterStatus.DRAFT,
    )

    with pytest.raises(ValueError, match="content item IDs must be unique"):
        repo.save_newsletter(
            issue_date=original.issue_date,
            title="Partial update",
            markdown_body="# Partial",
            html_body="<h1>Partial</h1>",
            status=NewsletterStatus.PREVIEW,
            items=[
                NewsletterItemInput(1, 1, 1, "Top", 5.0),
                NewsletterItemInput(1, 1, 2, "More", 4.0),
            ],
        )
    temp_db_session.commit()
    temp_db_session.refresh(original)

    assert original.title == "Original"
    assert original.status == NewsletterStatus.DRAFT


def test_agent_run_lifecycle_records_ordered_redacted_tool_traces(temp_db_session):
    repo = Repository(temp_db_session)
    item = repo.upsert_content_item(content_input(create_source(repo).id))
    snapshot = repo.create_preference_snapshot(
        explicit_interests=[],
        exclusions=[],
        tag_weights={},
        source_weights={},
        feedback_cutoff=None,
    )
    run = repo.start_agent_run(
        content_item_id=item.id,
        preference_snapshot_id=snapshot.id,
        prompt_version="curator-v1",
        model="fake-local",
        input_hash="input-hash",
    )
    repeated_run = repo.start_agent_run(
        content_item_id=item.id,
        preference_snapshot_id=snapshot.id,
        prompt_version="curator-v1",
        model="fake-local",
        input_hash="input-hash",
    )
    second_trace = repo.add_tool_call_trace(
        agent_run_id=run.id,
        sequence=2,
        tool_name="lookup_recent_topics",
        argument_summary="query length=12",
        argument_hash="args-2",
        status=AgentRunStatus.FAILED,
        latency_ms=8,
        error_message="tool timed out after 8 ms",
        error_category="tool_timeout",
    )
    first_trace = repo.add_tool_call_trace(
        agent_run_id=run.id,
        sequence=1,
        tool_name="fetch_full_text",
        argument_summary="host=example.com",
        argument_hash="args-1",
        status=AgentRunStatus.SUCCEEDED,
        latency_ms=12,
        result_summary="1200 chars",
    )
    repeated_first_trace = repo.add_tool_call_trace(
        agent_run_id=run.id,
        sequence=1,
        tool_name="fetch_full_text",
        argument_summary="host=example.com",
        argument_hash="args-1",
        status=AgentRunStatus.SUCCEEDED,
        latency_ms=10,
        result_summary="1300 chars",
    )
    completed = repo.complete_agent_run(
        run.id,
        semantic_output={"recommendation": "include"},
        latency_ms=20,
        input_tokens=100,
        output_tokens=20,
        cost_usd="0.001000",
    )
    finished_at = completed.finished_at
    repeated_completion = repo.complete_agent_run(
        run.id,
        semantic_output={"recommendation": "include"},
        latency_ms=20,
        input_tokens=100,
        output_tokens=20,
        cost_usd="0.001000",
    )

    assert [trace.id for trace in repo.list_tool_call_traces(run.id)] == [
        first_trace.id,
        second_trace.id,
    ]
    assert completed.status == AgentRunStatus.SUCCEEDED
    assert repeated_run.id == run.id
    assert repeated_completion.finished_at == finished_at
    with pytest.raises(ValueError, match="terminal succeeded"):
        repo.fail_agent_run(run.id, "late failure")
    assert repeated_first_trace.id == first_trace.id
    assert repeated_first_trace.result_summary == "1300 chars"
    assert second_trace.error_category == "tool_timeout"
    assert temp_db_session.query(ToolCallTrace).count() == 2


def test_failed_agent_run_persists_error_category(temp_db_session):
    repo = Repository(temp_db_session)
    item = repo.upsert_content_item(content_input(create_source(repo).id))
    snapshot = repo.create_preference_snapshot(
        explicit_interests=[],
        exclusions=[],
        tag_weights={},
        source_weights={},
        feedback_cutoff=None,
    )
    run = repo.start_agent_run(
        content_item_id=item.id,
        preference_snapshot_id=snapshot.id,
        prompt_version="curator-v1",
        model="fake-local",
        input_hash="failed-input",
        error_category="input_validation",
    )
    failed = repo.fail_agent_run(
        run.id,
        "schema validation failed",
        error_category="output_validation",
    )

    assert failed.error_message == "schema validation failed"
    assert failed.error_category == "output_validation"


@pytest.mark.parametrize(
    "call",
    [
        lambda repo: repo.create_source("x", "blog", "rss", "https://x.test", [], status="bogus"),
        lambda repo: repo.save_newsletter(date(2026, 7, 22), "x", "x", "x", "bogus"),
        lambda repo: repo.start_job_run("collect", status="bogus"),
    ],
)
def test_repository_rejects_unknown_states_before_persistence(temp_db_session, call):
    repo = Repository(temp_db_session)

    with pytest.raises(ValueError, match="unknown"):
        call(repo)

    assert not temp_db_session.new


def test_job_failure_rolls_back_then_records_structured_error_event(temp_db_session):
    repo = Repository(temp_db_session)
    run = repo.start_job_run("collect")
    run_id = run.id
    create_source(repo)
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

    failed = repo.fail_job_run(run_id, "duplicate source", details={"stage": "collect"})
    finished_at = failed.finished_at

    assert failed.status == JobRunStatus.FAILED
    event = temp_db_session.scalar(select(JobEvent).where(JobEvent.job_run_id == run_id))
    assert event is not None
    assert event.level == "error"
    assert event.details == {"stage": "collect"}

    repeated = repo.fail_job_run(run_id, "duplicate source", details={"stage": "collect"})

    assert repeated.id == failed.id
    assert repeated.finished_at.replace(tzinfo=UTC) == finished_at
    assert len(repo.list_job_events(run_id)) == 1
    with pytest.raises(ValueError, match="terminal failed"):
        repo.complete_job_run(run_id)


def test_successful_job_lifecycle_is_idempotent_and_irreversible(temp_db_session):
    repo = Repository(temp_db_session)
    run = repo.start_job_run("build")

    first = repo.complete_job_run(run.id)
    finished_at = first.finished_at
    second = repo.complete_job_run(run.id)

    assert second.finished_at == finished_at
    with pytest.raises(ValueError, match="terminal succeeded"):
        repo.fail_job_run(run.id, "late failure")
    assert repo.list_job_events(run.id) == []
