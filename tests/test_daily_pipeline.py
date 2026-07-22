from datetime import UTC, date, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from lettermate.curation.provider import FakeCurationProvider
from lettermate.curation.service import CurationService
from lettermate.db.models import (
    AnalysisResult,
    ContentItem,
    JobRun,
    Newsletter,
    NewsletterItem,
    Source,
)
from lettermate.db.repository import Repository
from lettermate.jobs.runner import (
    JobRunner,
    analyze_pending,
    build_newsletter_issue,
    collect_sources,
    run_daily,
    send_newsletter,
    sync_sources,
)
from lettermate.notifiers.email import EmailNotifier, EmailSettings
from lettermate.preferences.signing import FeedbackSigner
from lettermate.ranking.policy import RankingPolicy
from lettermate.sources.config_loader import SourceConfig


def test_daily_pipeline_twice_is_stable_and_isolates_a_failed_source(
    temp_db_factory: sessionmaker[Session],
):
    issue_date = date(2026, 7, 23)
    now = datetime(2026, 7, 23, tzinfo=UTC)
    runner = JobRunner(temp_db_factory)
    sources = [
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
    ]
    feed = (
        b"<rss version='2.0'><channel><item><guid>one</guid>"
        b"<title>Agent engineering field note</title>"
        b"<link>https://healthy.example/one</link>"
        b"<description>Practical agent engineering techniques.</description>"
        b"</item></channel></rss>"
    )
    with temp_db_factory() as session:
        Repository(session).create_preference_snapshot(
            explicit_interests=["agent engineering"],
            exclusions=[],
            tag_weights={},
            source_weights={},
            feedback_cutoff=None,
        )

    def load_feed(source: Source) -> bytes:
        if source.name == "Failed":
            raise RuntimeError("source unavailable")
        return feed

    smtp_calls = 0

    def fail_if_smtp_is_created(_host: str, _port: int) -> object:
        nonlocal smtp_calls
        smtp_calls += 1
        raise AssertionError("dry-run must not construct an SMTP connection")

    notifier = EmailNotifier(
        EmailSettings(
            host="unused",
            port=25,
            username="",
            password="",
            sender="from@example.com",
            recipient="to@example.com",
            use_tls=False,
            dry_run=True,
        ),
        smtp_factory=fail_if_smtp_is_created,
    )

    def execute_daily():
        return run_daily(
            issue_date,
            [
                lambda: sync_sources(runner, sources),
                lambda: collect_sources(runner, load_feed, now=now),
                lambda: analyze_pending(
                    runner,
                    lambda repository: CurationService(
                        repository,
                        provider=FakeCurationProvider(),
                        ranking_policy=RankingPolicy(item_limit=5, minimum_score=4),
                    ),
                    now=now,
                ),
                lambda: build_newsletter_issue(
                    runner,
                    issue_date,
                    signer=FeedbackSigner("test-secret"),
                    feedback_base_url="https://letters.example/feedback",
                    feedback_expires_at=now + timedelta(days=7),
                ),
                lambda: send_newsletter(runner, issue_date, notifier=notifier),
            ],
            runner=runner,
        )

    first = execute_daily()
    second = execute_daily()

    assert [stage.status for stage in first.stages] == ["succeeded"] * 5
    assert [stage.status for stage in second.stages] == ["succeeded"] * 5
    assert first.stages[1].details["failed_sources"] == 1
    assert second.stages[1].warnings[0].details["source_url"] == "https://failed.example/feed"
    assert smtp_calls == 0
    with temp_db_factory() as session:
        counts = {
            model.__name__: session.scalar(select(func.count(model.id)))
            for model in (Source, ContentItem, AnalysisResult, Newsletter, NewsletterItem)
        }
        assert counts == {
            "Source": 2,
            "ContentItem": 1,
            "AnalysisResult": 1,
            "Newsletter": 1,
            "NewsletterItem": 1,
        }
        runs = list(session.scalars(select(JobRun).order_by(JobRun.id)))
        assert len(runs) == 10
        assert [run.job_type for run in runs] == [
            "sync",
            "collect",
            "analyze",
            "build",
            "send",
        ] * 2
        assert all(run.status == "succeeded" and run.finished_at is not None for run in runs)
        assert [event.details["idempotency_key"] for event in runs[0].events] == [
            "daily:2026-07-23"
        ]
        assert [event.details["idempotency_key"] for event in runs[5].events] == [
            "daily:2026-07-23"
        ]
