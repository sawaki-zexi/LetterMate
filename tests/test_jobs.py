from datetime import UTC, date, datetime
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from lettermate.db.models import Base, ContentItem, Source
from lettermate.db.repository import Repository
from lettermate.jobs.runner import (
    JobRunner,
    analyze_pending,
    collect_fixture,
    send_newsletter,
    sync_sources,
)
from lettermate.notifiers.email import SendResult
from lettermate.sources.config_loader import SourceConfig


def test_stage_runner_uses_independent_session_and_records_failure_after_rollback(tmp_path: Path):
    engine = create_engine(f"sqlite:///{tmp_path / 'jobs.db'}", future=True)
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)
    runner = JobRunner(factory)

    succeeded = runner.run_stage("sync", lambda _repo: {"sources": 2})

    def fail(_repo):
        raise RuntimeError("fixture fetch failed")

    failed = runner.run_stage("collect", fail)

    assert succeeded.status == "succeeded"
    assert succeeded.details == {"sources": 2}
    assert failed.status == "failed"
    with factory() as session:
        assert session.get(type(succeeded.run), succeeded.job_id).status == "succeeded"
        failed_run = session.get(type(failed.run), failed.job_id)
        assert failed_run.status == "failed"
        assert failed_run.events[0].details == {"job_type": "collect"}
    engine.dispose()


def test_collect_fixture_persists_feed_items_without_network(tmp_path: Path):
    engine = create_engine(f"sqlite:///{tmp_path / 'collect.db'}", future=True)
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)
    runner = JobRunner(factory)
    sync_sources(
        runner,
        [SourceConfig(name="Example", platform="blog", type="rss", url="https://example.com/feed")],
    )
    feed = b"""<?xml version='1.0'?><rss version='2.0'><channel><item><guid>x</guid><title>Agent update</title><link>https://example.com/post</link><description>Useful</description></item></channel></rss>"""

    first = collect_fixture(runner, feed, now=datetime(2026, 7, 22, tzinfo=UTC))
    second = collect_fixture(runner, feed, now=datetime(2026, 7, 22, tzinfo=UTC))

    assert first.details == {"items": 1, "sources": 1}
    assert second.details == first.details
    with factory() as session:
        assert session.query(Source).count() == 1
        assert session.query(ContentItem).count() == 1
    engine.dispose()


def test_analyze_stage_creates_an_independent_job_run(tmp_path: Path):
    engine = create_engine(f"sqlite:///{tmp_path / 'analyze.db'}", future=True)
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)

    class FakeService:
        def analyze_pending(self, *, now: datetime) -> list[object]:
            assert now == datetime(2026, 7, 22, tzinfo=UTC)
            return [object(), object()]

    result = analyze_pending(
        JobRunner(factory),
        lambda _repository: FakeService(),
        now=datetime(2026, 7, 22, tzinfo=UTC),
    )

    assert result.status == "succeeded"
    assert result.details == {"analyses": 2}
    engine.dispose()


def test_sync_sources_is_idempotent(tmp_path: Path):
    engine = create_engine(f"sqlite:///{tmp_path / 'sync.db'}", future=True)
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)
    sources = [
        SourceConfig(
            name="Example", platform="blog", type="rss", url="https://example.com/feed", tags=["AI"]
        )
    ]

    first = sync_sources(JobRunner(factory), sources)
    second = sync_sources(JobRunner(factory), sources)

    assert first.details == {"sources": 1}
    assert second.details == {"sources": 1}
    with factory() as session:
        assert session.query(Source).count() == 1
    engine.dispose()


def test_send_dry_run_marks_preview_without_marking_issue_sent(tmp_path: Path):
    engine = create_engine(f"sqlite:///{tmp_path / 'send.db'}", future=True)
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)
    issue_date = date(2026, 7, 23)
    with factory() as session:
        Repository(session).save_newsletter(
            issue_date, "Daily", "# Daily", "<h1>Daily</h1>", "draft"
        )

    class DryRunNotifier:
        def send(self, *, subject: str, html_body: str) -> SendResult:
            assert subject == "Daily"
            assert html_body == "<h1>Daily</h1>"
            return SendResult(accepted=False, dry_run=True)

    result = send_newsletter(JobRunner(factory), issue_date, notifier=DryRunNotifier())

    assert result.status == "succeeded"
    assert result.details == {"sent": 0, "dry_run": 1}
    with factory() as session:
        assert Repository(session).get_newsletter(issue_date).status == "preview"
    engine.dispose()
