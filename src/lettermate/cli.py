from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Annotated

import typer

from lettermate.config import get_settings
from lettermate.curation.provider import FakeCurationProvider
from lettermate.curation.service import CurationService
from lettermate.db.repository import Repository
from lettermate.db.session import create_session_factory
from lettermate.jobs.runner import (
    JobRunner,
    analyze_pending,
    build_newsletter_issue,
    collect_fixture,
    send_newsletter,
    sync_sources,
)
from lettermate.notifiers.email import EmailNotifier, EmailSettings
from lettermate.preferences.signing import FeedbackSigner
from lettermate.ranking.policy import RankingPolicy
from lettermate.sources.config_loader import load_preferences, load_sources

app = typer.Typer(no_args_is_help=True)


@app.command("sync-sources")
def sync_sources_command(config: Path = Path("configs/sources.yaml")) -> None:
    result = sync_sources(JobRunner(create_session_factory()), load_sources(config))
    typer.echo(
        f"job={result.job_id} status={result.status} "
        f"sources={result.details.get('sources', 0)}"
    )


@app.command("collect")
def collect_command(
    feed_fixture: Annotated[Path, typer.Option(exists=True, dir_okay=False)],
) -> None:
    result = collect_fixture(
        JobRunner(create_session_factory()),
        feed_fixture.read_bytes(),
        now=datetime.now(UTC),
    )
    typer.echo(
        f"job={result.job_id} status={result.status} "
        f"items={result.details.get('items', 0)}"
    )


@app.command("analyze")
def analyze_command(preferences: Path = Path("configs/preferences.yaml")) -> None:
    config = load_preferences(preferences)
    session_factory = create_session_factory()
    with session_factory() as session:
        repository = Repository(session)
        if repository.get_latest_preference_snapshot() is None:
            repository.create_preference_snapshot(
                explicit_interests=config.profile.interests,
                exclusions=config.profile.exclude,
                tag_weights={},
                source_weights={},
                feedback_cutoff=None,
            )
    result = analyze_pending(
        JobRunner(session_factory),
        lambda repository: CurationService(
            repository,
            provider=FakeCurationProvider(),
            ranking_policy=RankingPolicy(
                item_limit=min(config.newsletter.max_items, 5),
                minimum_score=config.newsletter.min_score_to_include,
            ),
        ),
        now=datetime.now(UTC),
    )
    typer.echo(
        f"job={result.job_id} status={result.status} "
        f"analyses={result.details.get('analyses', 0)}"
    )


@app.command("newsletter")
def newsletter_command(issue_date: str = "") -> None:
    settings = get_settings()
    resolved_date = date.fromisoformat(issue_date) if issue_date else datetime.now().date()
    result = build_newsletter_issue(
        JobRunner(create_session_factory(settings)),
        resolved_date,
        signer=FeedbackSigner(settings.feedback_signing_secret),
        feedback_base_url=settings.feedback_base_url,
        feedback_expires_at=datetime.now(UTC)
        + timedelta(hours=settings.feedback_token_ttl_hours),
    )
    typer.echo(f"job={result.job_id} status={result.status} items={result.details.get('items', 0)}")


@app.command("send")
def send_command(issue_date: str = "", dry_run: bool = True, force: bool = False) -> None:
    settings = get_settings()
    resolved_date = date.fromisoformat(issue_date) if issue_date else datetime.now().date()
    notifier = EmailNotifier(
        EmailSettings(
            host=settings.smtp_host,
            port=settings.smtp_port,
            username=settings.smtp_username,
            password=settings.smtp_password,
            sender=settings.smtp_from,
            recipient=settings.smtp_to,
            use_tls=settings.smtp_use_tls,
            dry_run=dry_run,
        )
    )
    result = send_newsletter(
        JobRunner(create_session_factory(settings)),
        resolved_date,
        notifier=notifier,
        force=force,
    )
    typer.echo(f"job={result.job_id} status={result.status}")


if __name__ == "__main__":
    app()
