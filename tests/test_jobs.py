from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, date, datetime
from pathlib import Path
from threading import Event, Lock

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import lettermate.jobs.runner as jobs
from lettermate.curation.provider import FakeCurationProvider
from lettermate.curation.service import CurationService
from lettermate.db.models import Base, ContentItem, Source
from lettermate.db.repository import ContentInput, Repository
from lettermate.db.statuses import NewsletterStatus
from lettermate.jobs.runner import (
    JobRunner,
    analyze_pending,
    build_newsletter_issue,
    collect_fixture,
    run_daily,
    send_newsletter,
    sync_sources,
)
from lettermate.notifiers.email import SendResult
from lettermate.preferences.signing import FeedbackSigner
from lettermate.ranking.policy import RankingPolicy
from lettermate.sources.config_loader import SourceConfig


def test_newsletter_status_keeps_legacy_failed_and_explicit_send_failed_values():
    assert NewsletterStatus.FAILED.value == "failed"
    assert NewsletterStatus.SEND_FAILED.value == "send_failed"


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


def test_stage_runner_rolls_back_business_writes_before_persisting_failure_event(tmp_path: Path):
    engine = create_engine(f"sqlite:///{tmp_path / 'atomic-stage.db'}", future=True)
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)

    def fail_after_write(repository: Repository) -> dict[str, int]:
        repository.create_source(
            name="Transient",
            platform="blog",
            source_type="rss",
            url="https://example.com/transient",
            tags=[],
        )
        raise RuntimeError("abort stage")

    result = JobRunner(factory).run_stage("sync", fail_after_write)

    assert result.status == "failed"
    with factory() as session:
        assert session.query(Source).count() == 0
        failed_run = session.get(type(result.run), result.job_id)
        assert failed_run.status == "failed"
        assert failed_run.events[0].message == "RuntimeError: abort stage"
    engine.dispose()


def test_stage_runner_records_structured_warnings_on_a_successful_run(tmp_path: Path):
    engine = create_engine(f"sqlite:///{tmp_path / 'warning.db'}", future=True)
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)

    result = JobRunner(factory).run_stage(
        "collect",
        lambda _repository: jobs.StageOutcome(
            details={"sources": 2, "items": 1},
            warnings=(
                jobs.StageWarning(
                    code="source_fetch_failed",
                    message="fixture fetch failed",
                    details={"source_id": 2},
                ),
            ),
        ),
    )

    assert result.status == "succeeded"
    assert result.details == {"sources": 2, "items": 1}
    assert result.warnings[0].code == "source_fetch_failed"
    with factory() as session:
        events = Repository(session).list_job_events(result.job_id)
        assert [(event.level, event.message, event.details) for event in events] == [
            (
                "warning",
                "fixture fetch failed",
                {"code": "source_fetch_failed", "source_id": 2},
            )
        ]
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


def test_collect_sources_isolates_a_failed_source_and_reports_a_warning(tmp_path: Path):
    engine = create_engine(f"sqlite:///{tmp_path / 'source-isolation.db'}", future=True)
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)
    runner = JobRunner(factory)
    sync_sources(
        runner,
        [
            SourceConfig(
                name="Healthy",
                platform="blog",
                type="rss",
                url="https://healthy.example/feed",
            ),
            SourceConfig(
                name="Failed",
                platform="blog",
                type="rss",
                url="https://failed.example/feed",
            ),
        ],
    )
    feed = b"""<rss version='2.0'><channel><item><guid>x</guid><title>Agent update</title><link>https://healthy.example/post</link><description>Useful</description></item></channel></rss>"""

    def load_feed(source: Source) -> bytes:
        if source.name == "Failed":
            raise RuntimeError("fixture fetch failed")
        return feed

    result = jobs.collect_sources(
        runner,
        load_feed,
        now=datetime(2026, 7, 22, tzinfo=UTC),
    )

    assert result.status == "succeeded"
    assert result.details == {"sources": 2, "items": 1, "failed_sources": 1}
    assert [warning.code for warning in result.warnings] == ["source_fetch_failed"]
    with factory() as session:
        sources = session.query(Source).order_by(Source.name).all()
        assert [(source.name, source.status) for source in sources] == [
            ("Failed", "error"),
            ("Healthy", "active"),
        ]
        assert session.query(ContentItem).count() == 1
        assert session.query(ContentItem).one().source.name == "Healthy"
    engine.dispose()


def test_collect_source_rolls_back_earlier_items_when_a_later_item_write_fails(
    tmp_path: Path, monkeypatch
):
    engine = create_engine(f"sqlite:///{tmp_path / 'atomic-source.db'}", future=True)
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)
    runner = JobRunner(factory)
    sync_sources(
        runner,
        [SourceConfig(name="Example", platform="blog", type="rss", url="https://example.com")],
    )
    feed = (
        b"<rss version='2.0'><channel>"
        b"<item><guid>one</guid><title>One</title>"
        b"<link>https://example.com/one</link><description>First</description></item>"
        b"<item><guid>two</guid><title>Two</title>"
        b"<link>https://example.com/two</link><description>Second</description></item>"
        b"</channel></rss>"
    )
    original_upsert = Repository.upsert_content_item
    attempts = 0

    def fail_second_item(repository: Repository, item: ContentInput):
        nonlocal attempts
        attempts += 1
        if attempts == 2:
            raise RuntimeError("second item write failed")
        return original_upsert(repository, item)

    monkeypatch.setattr(Repository, "upsert_content_item", fail_second_item)

    result = collect_fixture(runner, feed, now=datetime(2026, 7, 23, tzinfo=UTC))

    assert result.status == "succeeded"
    assert result.details == {"sources": 1, "items": 0, "failed_sources": 1}
    assert [warning.code for warning in result.warnings] == ["source_fetch_failed"]
    with factory() as session:
        assert session.query(ContentItem).count() == 0
        source = session.query(Source).one()
        assert source.status == "error"
        assert source.last_error == "RuntimeError: second item write failed"
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


def test_analyze_stage_normalizes_sqlite_feed_timestamps_to_utc(tmp_path: Path):
    engine = create_engine(f"sqlite:///{tmp_path / 'timestamp.db'}", future=True)
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)
    runner = JobRunner(factory)
    sync_sources(
        runner,
        [SourceConfig(name="Example", platform="blog", type="rss", url="https://example.com")],
    )
    collect_fixture(
        runner,
        (
            b"<rss version='2.0'><channel><item><guid>x</guid>"
            b"<title>Agent engineering update</title>"
            b"<link>https://example.com/post</link>"
            b"<description>Agent engineering details</description>"
            b"<pubDate>Thu, 23 Jul 2026 00:00:00 GMT</pubDate>"
            b"</item></channel></rss>"
        ),
        now=datetime(2026, 7, 23, tzinfo=UTC),
    )
    with factory() as session:
        Repository(session).create_preference_snapshot(
            explicit_interests=["agent engineering"],
            exclusions=[],
            tag_weights={},
            source_weights={},
            feedback_cutoff=None,
        )

    result = analyze_pending(
        runner,
        lambda repository: CurationService(
            repository,
            provider=FakeCurationProvider(),
            ranking_policy=RankingPolicy(item_limit=5, minimum_score=4),
        ),
        now=datetime(2026, 7, 23, tzinfo=UTC),
    )

    assert result.status == "succeeded"
    assert result.details == {"analyses": 1}
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


def test_send_exception_marks_issue_send_failed_and_records_failed_job(tmp_path: Path):
    engine = create_engine(f"sqlite:///{tmp_path / 'send-failure.db'}", future=True)
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)
    issue_date = date(2026, 7, 23)
    with factory() as session:
        Repository(session).save_newsletter(
            issue_date, "Daily", "# Daily", "<h1>Daily</h1>", "draft"
        )

    class FailingNotifier:
        def send(self, *, subject: str, html_body: str) -> SendResult:
            raise OSError("SMTP unavailable")

    result = send_newsletter(JobRunner(factory), issue_date, notifier=FailingNotifier())

    assert result.status == "failed"
    with factory() as session:
        newsletter = Repository(session).get_newsletter(issue_date)
        assert newsletter.status == NewsletterStatus.SEND_FAILED
        assert result.run.events[0].message.startswith("OSError: SMTP unavailable")
    engine.dispose()


def test_send_blocks_an_already_sent_issue_before_calling_notifier(tmp_path: Path):
    engine = create_engine(f"sqlite:///{tmp_path / 'already-sent.db'}", future=True)
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)
    issue_date = date(2026, 7, 23)
    with factory() as session:
        repository = Repository(session)
        newsletter = repository.save_newsletter(
            issue_date, "Daily", "# Daily", "<h1>Daily</h1>", "draft"
        )
        repository.mark_newsletter_sent(newsletter.id)

    class CountingNotifier:
        calls = 0

        def send(self, *, subject: str, html_body: str) -> SendResult:
            self.calls += 1
            return SendResult(accepted=True, dry_run=False)

    notifier = CountingNotifier()
    result = send_newsletter(JobRunner(factory), issue_date, notifier=notifier)

    assert result.status == "failed"
    assert notifier.calls == 0
    with factory() as session:
        assert Repository(session).get_newsletter(issue_date).status == "sent"
    engine.dispose()


def test_send_rejection_marks_issue_send_failed(tmp_path: Path):
    engine = create_engine(f"sqlite:///{tmp_path / 'rejected.db'}", future=True)
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)
    issue_date = date(2026, 7, 23)
    with factory() as session:
        Repository(session).save_newsletter(
            issue_date, "Daily", "# Daily", "<h1>Daily</h1>", "draft"
        )

    class RejectingNotifier:
        def send(self, *, subject: str, html_body: str) -> SendResult:
            return SendResult(accepted=False, dry_run=False)

    result = send_newsletter(JobRunner(factory), issue_date, notifier=RejectingNotifier())

    assert result.status == "failed"
    with factory() as session:
        assert Repository(session).get_newsletter(issue_date).status == "send_failed"
    engine.dispose()


def test_ambiguous_send_keeps_durable_claim_and_records_reconciliation_details(
    tmp_path: Path,
):
    engine = create_engine(f"sqlite:///{tmp_path / 'ambiguous-send.db'}", future=True)
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)
    issue_date = date(2026, 7, 23)
    with factory() as session:
        newsletter = Repository(session).save_newsletter(
            issue_date, "Daily", "# Daily", "<h1>Daily</h1>", "draft"
        )

    class AmbiguousNotifier:
        def send(self, *, subject: str, html_body: str) -> SendResult:
            return SendResult(accepted=False, dry_run=False, ambiguous=True)

    result = send_newsletter(JobRunner(factory), issue_date, notifier=AmbiguousNotifier())

    assert result.status == "failed"
    with factory() as session:
        assert Repository(session).get_newsletter(issue_date).status == "sending"
        events = Repository(session).list_job_events(result.job_id)
        assert events[0].details == {
            "job_type": "send",
            "newsletter_id": newsletter.id,
            "force": False,
            "previously_sent": False,
            "smtp_outcome": "ambiguous",
            "smtp_accepted": False,
            "smtp_ambiguous": True,
            "reconciliation_required": True,
        }
    engine.dispose()


@pytest.mark.parametrize(
    ("failure_mode", "smtp_outcome", "smtp_ambiguous", "reconciliation_required"),
    [
        ("rejected", "rejected", False, False),
        ("raises", "error", False, False),
        ("ambiguous", "ambiguous", True, True),
    ],
)
def test_failed_forced_resend_restores_sent_status_and_original_timestamp(
    tmp_path: Path,
    failure_mode: str,
    smtp_outcome: str,
    smtp_ambiguous: bool,
    reconciliation_required: bool,
):
    engine = create_engine(
        f"sqlite:///{tmp_path / f'failed-forced-{failure_mode}.db'}", future=True
    )
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)
    issue_date = date(2026, 7, 23)
    with factory() as session:
        newsletter = Repository(session).save_newsletter(
            issue_date, "Daily", "# Daily", "<h1>Daily</h1>", "draft"
        )

    class AcceptingNotifier:
        def send(self, *, subject: str, html_body: str) -> SendResult:
            return SendResult(accepted=True, dry_run=False)

    first = send_newsletter(JobRunner(factory), issue_date, notifier=AcceptingNotifier())
    assert first.status == "succeeded"
    with factory() as session:
        original_sent_at = Repository(session).get_newsletter(issue_date).sent_at

    class FailingForcedNotifier:
        def send(self, *, subject: str, html_body: str) -> SendResult:
            if failure_mode == "raises":
                raise OSError("SMTP unavailable")
            return SendResult(
                accepted=False,
                dry_run=False,
                ambiguous=failure_mode == "ambiguous",
            )

    forced = send_newsletter(
        JobRunner(factory), issue_date, notifier=FailingForcedNotifier(), force=True
    )

    class CountingNotifier:
        calls = 0

        def send(self, *, subject: str, html_body: str) -> SendResult:
            self.calls += 1
            return SendResult(accepted=True, dry_run=False)

    ordinary_notifier = CountingNotifier()
    ordinary = send_newsletter(JobRunner(factory), issue_date, notifier=ordinary_notifier)

    assert forced.status == "failed"
    assert ordinary.status == "failed"
    assert ordinary_notifier.calls == 0
    with factory() as session:
        persisted = Repository(session).get_newsletter(issue_date)
        assert persisted.status == "sent"
        assert persisted.sent_at == original_sent_at
        events = Repository(session).list_job_events(forced.job_id)
        assert events[0].details == {
            "job_type": "send",
            "newsletter_id": newsletter.id,
            "force": True,
            "previously_sent": True,
            "smtp_outcome": smtp_outcome,
            "smtp_accepted": False,
            "smtp_ambiguous": smtp_ambiguous,
            "reconciliation_required": reconciliation_required,
        }
    engine.dispose()


def test_force_send_records_reconciliation_warning_for_smtp_boundary(tmp_path: Path):
    engine = create_engine(f"sqlite:///{tmp_path / 'forced.db'}", future=True)
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)
    issue_date = date(2026, 7, 23)
    with factory() as session:
        repository = Repository(session)
        newsletter = repository.save_newsletter(
            issue_date, "Daily", "# Daily", "<h1>Daily</h1>", "draft"
        )
        repository.mark_newsletter_sent(newsletter.id)

    class AcceptingNotifier:
        calls = 0

        def send(self, *, subject: str, html_body: str) -> SendResult:
            self.calls += 1
            return SendResult(accepted=True, dry_run=False)

    notifier = AcceptingNotifier()
    result = send_newsletter(JobRunner(factory), issue_date, notifier=notifier, force=True)

    assert result.status == "succeeded"
    assert notifier.calls == 1
    assert [warning.code for warning in result.warnings] == [
        "smtp_exactly_once_boundary",
        "explicit_forced_resend",
    ]
    with factory() as session:
        events = Repository(session).list_job_events(result.job_id)
        assert events[0].details["reconciliation_required_after_ambiguous_outcome"] is True
    engine.dispose()


def test_smtp_accepted_persistence_failure_records_reconciliation_details(
    tmp_path: Path, monkeypatch
):
    engine = create_engine(f"sqlite:///{tmp_path / 'accepted-local-failure.db'}", future=True)
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)
    issue_date = date(2026, 7, 23)
    with factory() as session:
        newsletter = Repository(session).save_newsletter(
            issue_date, "Daily", "# Daily", "<h1>Daily</h1>", "draft"
        )

    class AcceptingNotifier:
        def send(self, *, subject: str, html_body: str) -> SendResult:
            return SendResult(accepted=True, dry_run=False)

    def fail_local_mark(
        _repository: Repository, _newsletter_id: int, *, force: bool = False
    ) -> object:
        raise OSError("local status persistence failed")

    monkeypatch.setattr(Repository, "mark_newsletter_sent", fail_local_mark)

    result = send_newsletter(JobRunner(factory), issue_date, notifier=AcceptingNotifier())

    assert result.status == "failed"
    with factory() as session:
        events = Repository(session).list_job_events(result.job_id)
        assert events[0].details == {
            "job_type": "send",
            "smtp_accepted": True,
            "newsletter_id": newsletter.id,
            "reconciliation_required_after_ambiguous_outcome": True,
        }
        assert Repository(session).get_newsletter(issue_date).status == "sending"
    engine.dispose()


def test_send_persists_an_explicit_force_resend_event(tmp_path: Path):
    engine = create_engine(f"sqlite:///{tmp_path / 'force-event.db'}", future=True)
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)
    issue_date = date(2026, 7, 23)
    with factory() as session:
        newsletter = Repository(session).save_newsletter(
            issue_date, "Daily", "# Daily", "<h1>Daily</h1>", "draft"
        )

    class AcceptingNotifier:
        def send(self, *, subject: str, html_body: str) -> SendResult:
            return SendResult(accepted=True, dry_run=False)

    first = send_newsletter(JobRunner(factory), issue_date, notifier=AcceptingNotifier())
    forced = send_newsletter(
        JobRunner(factory), issue_date, notifier=AcceptingNotifier(), force=True
    )

    assert first.status == "succeeded"
    assert forced.status == "succeeded"
    with factory() as session:
        first_events = Repository(session).list_job_events(first.job_id)
        forced_events = Repository(session).list_job_events(forced.job_id)
        assert first_events[0].details["newsletter_id"] == newsletter.id
        assert first_events[0].details["force"] is False
        assert all(event.details.get("code") != "explicit_forced_resend" for event in first_events)
        assert any(
            event.details
            == {
                "code": "explicit_forced_resend",
                "newsletter_id": newsletter.id,
                "force": True,
            }
            for event in forced_events
        )
    engine.dispose()


def test_concurrent_real_sends_use_one_durable_claim_and_one_smtp_call(tmp_path: Path):
    engine = create_engine(f"sqlite:///{tmp_path / 'concurrent-send.db'}", future=True)
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)
    issue_date = date(2026, 7, 23)
    with factory() as session:
        newsletter = Repository(session).save_newsletter(
            issue_date, "Daily", "# Daily", "<h1>Daily</h1>", "draft"
        )

    class BlockingFirstNotifier:
        def __init__(self) -> None:
            self.calls = 0
            self.first_entered = Event()
            self.release_first = Event()
            self.lock = Lock()

        def send(self, *, subject: str, html_body: str) -> SendResult:
            with self.lock:
                self.calls += 1
                call_number = self.calls
            if call_number == 1:
                self.first_entered.set()
                assert self.release_first.wait(timeout=5)
            return SendResult(accepted=True, dry_run=False)

    notifier = BlockingFirstNotifier()
    with ThreadPoolExecutor(max_workers=2) as executor:
        first_future = executor.submit(
            send_newsletter,
            JobRunner(factory),
            issue_date,
            notifier=notifier,
        )
        assert notifier.first_entered.wait(timeout=5)
        second_future = executor.submit(
            send_newsletter,
            JobRunner(factory),
            issue_date,
            notifier=notifier,
        )
        second = second_future.result(timeout=5)
        notifier.release_first.set()
        first = first_future.result(timeout=5)

    assert notifier.calls == 1
    assert sorted([first.status, second.status]) == ["failed", "succeeded"]
    loser = first if first.status == "failed" else second
    with factory() as session:
        events = Repository(session).list_job_events(loser.job_id)
        assert events[0].details == {
            "job_type": "send",
            "send_claim_lost": True,
            "newsletter_id": newsletter.id,
            "current_status": "sending",
        }
        assert Repository(session).get_newsletter(issue_date).status == "sent"
    engine.dispose()


def test_force_dry_run_keeps_a_sent_issue_protected_from_later_real_send(tmp_path: Path):
    engine = create_engine(f"sqlite:///{tmp_path / 'force-dry-run.db'}", future=True)
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)
    issue_date = date(2026, 7, 23)
    with factory() as session:
        repository = Repository(session)
        newsletter = repository.save_newsletter(
            issue_date, "Daily", "# Daily", "<h1>Daily</h1>", "draft"
        )
        repository.mark_newsletter_sent(newsletter.id)

    class DryRunNotifier:
        dry_run = True
        calls = 0

        def send(self, *, subject: str, html_body: str) -> SendResult:
            self.calls += 1
            return SendResult(accepted=False, dry_run=True)

    class RealNotifier:
        calls = 0

        def send(self, *, subject: str, html_body: str) -> SendResult:
            self.calls += 1
            return SendResult(accepted=True, dry_run=False)

    preview = send_newsletter(
        JobRunner(factory), issue_date, notifier=DryRunNotifier(), force=True
    )
    real_notifier = RealNotifier()
    blocked = send_newsletter(JobRunner(factory), issue_date, notifier=real_notifier)

    assert preview.status == "succeeded"
    assert [warning.code for warning in preview.warnings] == ["forced_dry_run_sent_noop"]
    assert blocked.status == "failed"
    assert real_notifier.calls == 0
    with factory() as session:
        assert Repository(session).get_newsletter(issue_date).status == "sent"
        events = Repository(session).list_job_events(preview.job_id)
        assert events[0].details == {
            "code": "forced_dry_run_sent_noop",
            "newsletter_id": newsletter.id,
            "force": True,
            "preserved_sent_status": True,
        }
    engine.dispose()


def test_build_stage_persists_ranked_membership_and_signed_feedback(tmp_path: Path):
    engine = create_engine(f"sqlite:///{tmp_path / 'build.db'}", future=True)
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)
    runner = JobRunner(factory)
    sync_sources(
        runner,
        [SourceConfig(name="Example", platform="blog", type="rss", url="https://example.com/feed")],
    )
    feed = (
        b"<rss version='2.0'><channel><item><guid>x</guid>"
        b"<title>Agent engineering update</title>"
        b"<link>https://example.com/post</link>"
        b"<description>agent engineering details</description>"
        b"</item></channel></rss>"
    )
    collect_fixture(runner, feed, now=datetime(2026, 7, 23, tzinfo=UTC))
    with factory() as session:
        Repository(session).create_preference_snapshot(
            explicit_interests=["agent engineering"],
            exclusions=[],
            tag_weights={},
            source_weights={},
            feedback_cutoff=None,
        )
    analyze_pending(
        runner,
        lambda repository: CurationService(
            repository,
            provider=FakeCurationProvider(),
            ranking_policy=RankingPolicy(item_limit=5, minimum_score=4),
        ),
        now=datetime(2026, 7, 23, tzinfo=UTC),
    )

    result = build_newsletter_issue(
        runner,
        date(2026, 7, 23),
        signer=FeedbackSigner("test-secret"),
        feedback_base_url="https://letters.example/feedback",
        feedback_expires_at=datetime(2026, 7, 30, tzinfo=UTC),
    )

    assert result.details == {"items": 1}
    with factory() as session:
        newsletter = Repository(session).get_newsletter(date(2026, 7, 23))
        assert len(newsletter.items) == 1
        assert "token=" in newsletter.html_body
    engine.dispose()


def test_build_stage_does_not_reset_an_already_sent_issue(tmp_path: Path):
    engine = create_engine(f"sqlite:///{tmp_path / 'sent-build.db'}", future=True)
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)
    issue_date = date(2026, 7, 23)
    with factory() as session:
        repository = Repository(session)
        newsletter = repository.save_newsletter(
            issue_date, "Daily", "# Daily", "<h1>Daily</h1>", "draft"
        )
        repository.mark_newsletter_sent(newsletter.id)

    result = build_newsletter_issue(
        JobRunner(factory),
        issue_date,
        signer=FeedbackSigner("test-secret"),
        feedback_base_url="https://letters.example/feedback",
        feedback_expires_at=datetime(2026, 7, 30, tzinfo=UTC),
    )

    assert result.status == "succeeded"
    assert [warning.code for warning in result.warnings] == ["newsletter_already_sent"]
    with factory() as session:
        assert Repository(session).get_newsletter(issue_date).status == "sent"
    engine.dispose()


def test_daily_orchestrator_stops_after_failed_dependency():
    calls: list[str] = []

    def stage(name: str, status: str):
        def call():
            calls.append(name)
            return type("Result", (), {"status": status})()

        return call

    result = run_daily(
        date(2026, 7, 23),
        [stage("sync", "succeeded"), stage("collect", "failed"), stage("analyze", "succeeded")],
    )

    assert calls == ["sync", "collect"]
    assert result.issue_date == date(2026, 7, 23)
    assert result.idempotency_key == "daily:2026-07-23"
    assert len(result.stages) == 2


def test_daily_orchestrator_persists_issue_context_on_the_first_stage(tmp_path: Path):
    engine = create_engine(f"sqlite:///{tmp_path / 'daily-context.db'}", future=True)
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)
    runner = JobRunner(factory)

    result = run_daily(
        date(2026, 7, 23),
        [lambda: runner.run_stage("sync", lambda _repository: {"sources": 1})],
        runner=runner,
    )

    with factory() as session:
        events = Repository(session).list_job_events(result.stages[0].job_id)
        assert [(event.message, event.details) for event in events] == [
            (
                "daily_run_context",
                {"issue_date": "2026-07-23", "idempotency_key": "daily:2026-07-23"},
            )
        ]
    engine.dispose()
