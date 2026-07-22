from collections.abc import Callable, Mapping
from datetime import UTC, date, datetime, timedelta
from urllib.parse import parse_qs, urlparse

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from lettermate.config import Settings
from lettermate.db.models import Base
from lettermate.db.repository import ContentInput, NewsletterItemInput, Repository
from lettermate.preferences.service import build_feedback_urls
from lettermate.preferences.signing import FeedbackSigner


def _client(
    session_factory: sessionmaker[Session] | None = None,
    *,
    stage_triggers: Mapping[str, Callable[[], None]] | None = None,
    next_scheduled_run: Callable[[], datetime | None] | None = None,
) -> TestClient:
    from lettermate.api.app import create_app

    if session_factory is None:
        engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)
    return TestClient(
        create_app(
            Settings(
                database_url="sqlite://",
                app_env="test",
                owner_api_token="owner-test-token",
                scheduler_token="scheduler-test-token",
            ),
            session_factory=session_factory,
            stage_triggers=stage_triggers,
            next_scheduled_run=next_scheduled_run,
        )
    )


def test_health_is_public_but_operational_routes_require_owner_authentication():
    client = _client()

    assert client.get("/health").json() == {"status": "ok"}
    assert client.get("/api/sources").status_code == 401
    assert client.get("/api/sources", headers={"Authorization": "Bearer wrong"}).status_code == 403
    assert client.get(
        "/api/sources", headers={"Authorization": "Bearer owner-test-token"}
    ).status_code == 200


def test_scheduler_token_is_separate_from_owner_authentication_and_invokes_stage_trigger():
    triggered: list[str] = []
    client = _client(stage_triggers={"collect": lambda: triggered.append("collect")})

    owner = {"Authorization": "Bearer owner-test-token"}
    assert client.post("/api/stages/collect", headers=owner).status_code == 403
    assert client.post(
        "/api/stages/collect", headers={"X-Scheduler-Token": "wrong"}
    ).status_code == 403
    response = client.post(
        "/api/stages/collect", headers={"X-Scheduler-Token": "scheduler-test-token"}
    )
    assert response.status_code == 202
    assert response.json() == {"stage": "collect", "status": "accepted"}
    assert triggered == ["collect"]
    assert client.post(
        "/api/stages/sync", headers={"X-Scheduler-Token": "scheduler-test-token"}
    ).status_code == 503


def test_feedback_endpoint_does_not_expose_private_records_on_invalid_signature():
    client = _client()

    response = client.post("/feedback", json={"token": "not-a-valid-token"})

    assert response.status_code == 400
    assert response.json() == {"detail": "invalid feedback token"}


def test_source_api_uses_repository_and_redacts_fetch_metadata(temp_db_session):
    source = Repository(temp_db_session).create_source(
        "Example Source",
        "blog",
        "rss",
        "https://example.com/feed.xml",
        ["agents"],
    )
    source.etag = "private-etag"
    source.last_error = "private diagnostic"
    temp_db_session.commit()
    factory = sessionmaker(bind=temp_db_session.bind, expire_on_commit=False, future=True)

    response = _client(factory).get(
        "/api/sources", headers={"Authorization": "Bearer owner-test-token"}
    )

    assert response.status_code == 200
    assert response.json() == [
        {
            "id": source.id,
            "name": "Example Source",
            "platform": "blog",
            "source_type": "rss",
            "url": "https://example.com/feed.xml",
            "tags": ["agents"],
            "enabled": True,
            "status": "active",
            "last_fetched_at": None,
        }
    ]


def test_operational_resource_collections_and_missing_item_are_explicit():
    client = _client()
    owner = {"Authorization": "Bearer owner-test-token"}

    for path in ("/api/items", "/api/newsletters", "/api/jobs", "/api/preferences"):
        response = client.get(path, headers=owner)
        assert response.status_code == 200
        assert response.json() == []
    assert client.get("/api/items/999", headers=owner).status_code == 404


def test_signed_email_feedback_link_creates_a_preference_snapshot_and_confirms_safely(
    temp_db_session,
):
    repository = Repository(temp_db_session)
    source = repository.create_source(
        "Example", "blog", "rss", "https://example.com/feed", ["agents"]
    )
    item = repository.upsert_content_item(
        ContentInput(
            source_id=source.id,
            external_id="item-1",
            title="Agent safety",
            url="https://example.com/article",
            author="",
            published_at=None,
            raw_content="safe summary",
        )
    )
    snapshot = repository.create_preference_snapshot(
        explicit_interests=["agents"],
        exclusions=[],
        tag_weights={},
        source_weights={},
        feedback_cutoff=None,
    )
    run = repository.start_agent_run(
        content_item_id=item.id,
        preference_snapshot_id=snapshot.id,
        prompt_version="test",
        model="test",
        input_hash="a" * 64,
    )
    repository.complete_agent_run(
        run.id,
        semantic_output={"confidence": 0.9, "evidence_references": ["feed:1"]},
        latency_ms=0,
        input_tokens=0,
        output_tokens=0,
        cost_usd="0",
    )
    analysis = repository.save_analysis(
        item,
        summary="safe",
        tags=["agents"],
        score=4,
        reason="relevant",
        actionable_insight="read",
        should_include=True,
        model="test",
        agent_run_id=run.id,
        semantic_score=4,
        final_score=4,
        decision="include",
    )
    newsletter = repository.save_newsletter(
        date(2026, 7, 23),
        "Daily",
        "# Daily",
        "<h1>Daily</h1>",
        "draft",
        [NewsletterItemInput(item.id, analysis.id, 1, "Daily", 4)],
    )
    factory = sessionmaker(bind=temp_db_session.bind, expire_on_commit=False, future=True)
    urls = build_feedback_urls(
        signer=FeedbackSigner("dev-only-change-me"),
        base_url="http://testserver/feedback",
        issue_id=newsletter.id,
        item_id=item.id,
        expires_at=datetime.now(UTC) + timedelta(hours=1),
    )
    signed_url = urls["saved"]

    response = _client(factory).get(signed_url)

    assert response.status_code == 200
    assert "Feedback recorded" in response.text
    assert "Agent safety" not in response.text
    assert "snapshot_id" not in response.text
    assert parse_qs(urlparse(signed_url).query)["token"]
    with factory() as session:
        assert Repository(session).get_latest_preference_snapshot().version == 2


def test_owner_can_reset_derived_preference_weights(temp_db_session):
    repository = Repository(temp_db_session)
    repository.create_preference_snapshot(
        explicit_interests=["agents"],
        exclusions=["marketing"],
        tag_weights={"agents": 4},
        source_weights={"Example": 2},
        feedback_cutoff=None,
    )
    factory = sessionmaker(bind=temp_db_session.bind, expire_on_commit=False, future=True)

    response = _client(factory).post(
        "/api/preferences/reset", headers={"Authorization": "Bearer owner-test-token"}
    )

    assert response.status_code == 200
    assert response.json() == {
        "id": 2,
        "version": 2,
        "interests": ["agents"],
        "exclusions": ["marketing"],
        "tag_weights": {},
        "source_weights": {},
        "derivation_type": "reset",
    }


def test_owner_session_cookie_supports_dashboard_navigation_and_preference_reset(
    temp_db_session,
):
    repository = Repository(temp_db_session)
    repository.create_preference_snapshot(
        explicit_interests=["agents"],
        exclusions=["marketing"],
        tag_weights={"agents": 4},
        source_weights={"Example": 2},
        feedback_cutoff=None,
    )
    factory = sessionmaker(bind=temp_db_session.bind, expire_on_commit=False, future=True)
    client = _client(factory)

    rejected = client.post("/login", data={"token": "wrong"}, follow_redirects=False)
    assert rejected.status_code == 403
    assert "lettermate_owner_session" not in rejected.headers.get("set-cookie", "")

    login = client.post(
        "/login",
        data={"token": "owner-test-token"},
        follow_redirects=False,
    )
    assert login.status_code == 303
    assert "HttpOnly" in login.headers["set-cookie"]
    assert "SameSite=lax" in login.headers["set-cookie"]

    assert client.get("/dashboard/sources").status_code == 200
    reset = client.post("/dashboard/preferences/reset", follow_redirects=False)
    assert reset.status_code == 303
    assert reset.headers["location"] == "/dashboard/preferences"
    assert "Version 2" in client.get(reset.headers["location"]).text


def test_explanation_views_render_operational_evidence_without_private_trace_data(temp_db_session):
    repository = Repository(temp_db_session)
    source = repository.create_source(
        "Example Source", "blog", "rss", "https://example.com/feed", ["agents"]
    )
    source.status = "error"
    source.last_error = "private source diagnostic"
    item = repository.upsert_content_item(
        ContentInput(
            source_id=source.id,
            external_id="item-1",
            title="Bounded agent safety",
            url="https://example.com/article",
            author="Example",
            published_at=datetime(2026, 7, 23, tzinfo=UTC),
            raw_content="PRIVATE ARTICLE BODY",
        )
    )
    snapshot = repository.create_preference_snapshot(
        explicit_interests=["agents"],
        exclusions=[],
        tag_weights={"agents": 3},
        source_weights={"Example Source": 1},
        feedback_cutoff=None,
    )
    run = repository.start_agent_run(
        content_item_id=item.id,
        preference_snapshot_id=snapshot.id,
        prompt_version="test",
        model="test",
        input_hash="b" * 64,
    )
    repository.complete_agent_run(
        run.id,
        semantic_output={"confidence": 0.9, "evidence_references": ["feed:entry-1"]},
        latency_ms=12,
        input_tokens=3,
        output_tokens=4,
        cost_usd="0.001",
    )
    repository.add_tool_call_trace(
        agent_run_id=run.id,
        sequence=1,
        tool_name="lookup_recent_topics",
        argument_summary="PRIVATE TOOL ARGUMENT",
        argument_hash="c" * 64,
        status="succeeded",
        latency_ms=5,
        result_summary="one prior topic found",
        error_message="PRIVATE TRACE ERROR",
        error_category="network",
    )
    analysis = repository.save_analysis(
        item,
        summary="A bounded curation pattern.",
        tags=["agents"],
        score=4,
        reason="Matches the owner interest.",
        actionable_insight="Review the tool boundary.",
        should_include=True,
        model="test",
        agent_run_id=run.id,
        semantic_score=3.5,
        preference_boost=1.0,
        freshness_bonus=0.4,
        repetition_penalty=-0.1,
        source_diversity_adjustment=0.2,
        final_score=5.0,
        decision="include",
    )
    repository.save_newsletter(
        date(2026, 7, 23),
        "Daily Briefing",
        "# Daily Briefing",
        "<h1>Daily Briefing</h1>",
        "preview",
        [NewsletterItemInput(item.id, analysis.id, 1, "Daily", 5.0)],
    )
    job = repository.start_job_run("daily_delivery")
    repository.complete_job_run(job.id)
    repository.upsert_content_item(
        ContentInput(
            source_id=source.id,
            external_id="pending-item",
            title="Unreviewed later item",
            url="https://example.com/pending",
            author="Example",
            published_at=None,
            raw_content="Pending private content",
        )
    )
    factory = sessionmaker(bind=temp_db_session.bind, expire_on_commit=False, future=True)
    next_run = datetime(2026, 7, 24, 8, 30, tzinfo=UTC)
    client = _client(factory, next_scheduled_run=lambda: next_run)
    owner = {"Authorization": "Bearer owner-test-token"}

    detail = client.get(f"/api/items/{item.id}", headers=owner)
    assert detail.status_code == 200
    payload = detail.json()
    assert payload["score_components"] == {
        "semantic_score": 3.5,
        "preference_boost": 1.0,
        "freshness_bonus": 0.4,
        "repetition_penalty": -0.1,
        "source_diversity_adjustment": 0.2,
        "final_score": 5.0,
    }
    assert payload["preference_snapshot_version"] == 1
    assert payload["tool_traces"] == [
        {
            "tool_name": "lookup_recent_topics",
            "status": "succeeded",
            "latency_ms": 5,
            "result_summary": "one prior topic found",
            "error_category": "network",
        }
    ]

    item_page = client.get(f"/dashboard/items/{item.id}", headers=owner)
    overview = client.get("/", headers=owner)
    sources_page = client.get("/dashboard/sources", headers=owner)
    preferences_page = client.get("/dashboard/preferences", headers=owner)
    combined = "\n".join(
        [detail.text, item_page.text, overview.text, sources_page.text, preferences_page.text]
    )
    for expected in (
        "A bounded curation pattern.",
        "Matches the owner interest.",
        "semantic_score",
        "Preference version 1",
        "one prior topic found",
        "Example Source",
        "Daily Briefing",
        "daily_delivery",
        "Next scheduled run",
        "2026-07-24",
        "Version 1",
        "Exclusions:",
        "Reset derived weights",
    ):
        assert expected in combined
    for private_value in (
        "PRIVATE ARTICLE BODY",
        "PRIVATE TOOL ARGUMENT",
        "PRIVATE TRACE ERROR",
        "private source diagnostic",
        "Unreviewed later item",
        "c" * 64,
    ):
        assert private_value not in combined


def test_dashboard_renders_protected_operational_views():
    client = _client()
    owner = {"Authorization": "Bearer owner-test-token"}

    assert client.get("/").status_code == 401
    for path, marker in (
        ("/", "Daily Operations"),
        ("/dashboard/sources", "Sources"),
        ("/dashboard/jobs", "Job Runs"),
        ("/dashboard/newsletters", "Issues"),
        ("/dashboard/preferences", "Preference History"),
    ):
        response = client.get(path, headers=owner)
        assert response.status_code == 200
        assert marker in response.text
