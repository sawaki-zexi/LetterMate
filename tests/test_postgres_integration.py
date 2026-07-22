import os
from datetime import UTC, datetime
from uuid import uuid4

import pytest
from sqlalchemy import text

from lettermate.api.app import create_app
from lettermate.config import Settings
from lettermate.db.models import Source
from lettermate.db.repository import Repository
from lettermate.db.session import create_session_factory

POSTGRES_URL = os.environ.get("LETTERMATE_POSTGRES_TEST_URL", "")


@pytest.mark.skipif(not POSTGRES_URL, reason="requires LETTERMATE_POSTGRES_TEST_URL")
def test_migrated_postgres_shares_durable_scheduler_claims_between_workers():
    factory = create_session_factory(Settings(database_url=POSTGRES_URL, app_env="test"))
    key = f"postgres-claim:{uuid4()}"
    scheduled_for = datetime(2026, 7, 23, 8, tzinfo=UTC)
    with factory() as first_session:
        first = Repository(first_session).claim_scheduled_job(
            job_type="daily",
            idempotency_key=key,
            scheduled_for=scheduled_for,
            recovered=False,
            started_at=scheduled_for,
            lease_expires_at=datetime(2026, 7, 23, 8, 15, tzinfo=UTC),
        )
        assert first is not None
    with factory() as second_session:
        duplicate = Repository(second_session).claim_scheduled_job(
            job_type="daily",
            idempotency_key=key,
            scheduled_for=scheduled_for,
            recovered=False,
            started_at=scheduled_for,
        )
        assert duplicate is None
        matching_runs = second_session.scalar(
            text("select count(*) from job_runs where idempotency_key = :key"), {"key": key}
        )
        assert matching_runs == 1
    factory.kw["bind"].dispose()


@pytest.mark.skipif(not POSTGRES_URL, reason="requires LETTERMATE_POSTGRES_TEST_URL")
def test_postgres_state_written_by_worker_is_visible_through_the_web_api():
    settings = Settings(
        database_url=POSTGRES_URL,
        app_env="test",
        owner_api_token="owner-test-token",
        scheduler_token="scheduler-test-token",
    )
    factory = create_session_factory(settings)
    source_url = f"https://example.com/{uuid4()}.xml"
    with factory() as worker_session:
        worker_session.add(
            Source(
                name="Worker source",
                platform="blog",
                source_type="rss",
                url=source_url,
                normalized_url=source_url,
                tags=["agents"],
            )
        )
        worker_session.commit()
    from fastapi.testclient import TestClient

    client = TestClient(create_app(settings, session_factory=factory))
    response = client.get("/api/sources", headers={"Authorization": "Bearer owner-test-token"})

    assert response.status_code == 200
    assert any(source["url"] == source_url for source in response.json())
    factory.kw["bind"].dispose()
