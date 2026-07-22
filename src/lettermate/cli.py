from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Annotated

import typer
from sqlalchemy.orm import Session, sessionmaker

from lettermate.config import get_settings
from lettermate.curation.provider import FakeCurationProvider
from lettermate.curation.service import CurationService
from lettermate.db.models import Base
from lettermate.db.repository import Repository
from lettermate.db.session import create_session_factory
from lettermate.evals.runner import main as run_eval
from lettermate.jobs.runner import (
    JobRunner,
    StageResult,
    analyze_pending,
    build_newsletter_issue,
    collect_fixture,
    run_daily,
    send_newsletter,
    sync_sources,
)
from lettermate.notifiers.email import EmailNotifier, EmailSettings
from lettermate.preferences.signing import FeedbackSigner
from lettermate.ranking.policy import RankingPolicy
from lettermate.sources.config_loader import Preferences, load_preferences, load_sources

app = typer.Typer(no_args_is_help=True)


def _initialized_session_factory() -> sessionmaker[Session]:
    factory = create_session_factory()
    bind = factory.kw.get("bind")
    if bind is None:
        raise RuntimeError("database session factory has no engine")
    Base.metadata.create_all(bind)
    return factory


def _ensure_preference_snapshot(
    factory: sessionmaker[Session], preferences_path: Path
) -> Preferences:
    config = load_preferences(preferences_path)
    with factory() as session:
        repository = Repository(session)
        if repository.get_latest_preference_snapshot() is None:
            repository.create_preference_snapshot(
                explicit_interests=config.profile.interests,
                exclusions=config.profile.exclude,
                tag_weights={},
                source_weights={},
                feedback_cutoff=None,
            )
    return config


def _echo_stage(name: str, result: StageResult) -> None:
    counts = " ".join(f"{key}={value}" for key, value in result.details.items())
    suffix = f" {counts}" if counts else ""
    typer.echo(f"stage={name} job={result.job_id} status={result.status}{suffix}")
    for warning in result.warnings:
        typer.echo(f"warning={warning.code} message={warning.message}")


def _exit_if_failed(result: StageResult) -> None:
    if result.status == "failed":
        raise typer.Exit(code=1)


@app.command("sync-sources")
def sync_sources_command(config: Path = Path("configs/sources.example.yaml")) -> None:
    result = sync_sources(JobRunner(_initialized_session_factory()), load_sources(config))
    typer.echo(
        f"job={result.job_id} status={result.status} "
        f"sources={result.details.get('sources', 0)}"
    )
    _exit_if_failed(result)


@app.command("collect")
def collect_command(
    feed_fixture: Annotated[Path, typer.Option(exists=True, dir_okay=False)],
) -> None:
    result = collect_fixture(
        JobRunner(_initialized_session_factory()),
        feed_fixture.read_bytes(),
        now=datetime.now(UTC),
    )
    typer.echo(
        f"job={result.job_id} status={result.status} "
        f"items={result.details.get('items', 0)}"
    )
    _exit_if_failed(result)


@app.command("analyze")
def analyze_command(preferences: Path = Path("configs/preferences.example.yaml")) -> None:
    session_factory = _initialized_session_factory()
    config = _ensure_preference_snapshot(session_factory, preferences)
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
    _exit_if_failed(result)


@app.command("newsletter")
def newsletter_command(issue_date: str = "") -> None:
    settings = get_settings()
    resolved_date = date.fromisoformat(issue_date) if issue_date else datetime.now().date()
    result = build_newsletter_issue(
        JobRunner(_initialized_session_factory()),
        resolved_date,
        signer=FeedbackSigner(settings.feedback_signing_secret),
        feedback_base_url=settings.feedback_base_url,
        feedback_expires_at=datetime.now(UTC)
        + timedelta(hours=settings.feedback_token_ttl_hours),
    )
    typer.echo(f"job={result.job_id} status={result.status} items={result.details.get('items', 0)}")
    _exit_if_failed(result)


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
        JobRunner(_initialized_session_factory()),
        resolved_date,
        notifier=notifier,
        force=force,
    )
    typer.echo(f"job={result.job_id} status={result.status}")
    _exit_if_failed(result)


@app.command("run-daily")
def run_daily_command(
    feed_fixture: Annotated[Path, typer.Option(exists=True, dir_okay=False)],
    dry_run: bool = True,
    sources: Path = Path("configs/sources.example.yaml"),
    preferences: Path = Path("configs/preferences.example.yaml"),
    issue_date: str = "",
) -> None:
    settings = get_settings()
    resolved_date = date.fromisoformat(issue_date) if issue_date else datetime.now().date()
    now = datetime.now(UTC)
    factory = _initialized_session_factory()
    runner = JobRunner(factory)
    preferences_config = load_preferences(preferences)
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

    def analyze_stage() -> StageResult:
        _ensure_preference_snapshot(factory, preferences)
        return analyze_pending(
            runner,
            lambda repository: CurationService(
                repository,
                provider=FakeCurationProvider(),
                ranking_policy=RankingPolicy(
                    item_limit=min(preferences_config.newsletter.max_items, 5),
                    minimum_score=preferences_config.newsletter.min_score_to_include,
                ),
            ),
            now=now,
        )

    daily = run_daily(
        resolved_date,
        [
            lambda: sync_sources(runner, load_sources(sources)),
            lambda: collect_fixture(runner, feed_fixture.read_bytes(), now=now),
            analyze_stage,
            lambda: build_newsletter_issue(
                runner,
                resolved_date,
                signer=FeedbackSigner(settings.feedback_signing_secret),
                feedback_base_url=settings.feedback_base_url,
                feedback_expires_at=now + timedelta(hours=settings.feedback_token_ttl_hours),
            ),
            lambda: send_newsletter(
                runner,
                resolved_date,
                notifier=notifier,
            ),
        ],
        runner=runner,
    )
    typer.echo(
        f"issue_date={daily.issue_date.isoformat()} idempotency_key={daily.idempotency_key}"
    )
    for name, result in zip(
        ("sync", "collect", "analyze", "build", "send"), daily.stages, strict=False
    ):
        _echo_stage(name, result)
    if any(stage.status == "failed" for stage in daily.stages):
        raise typer.Exit(code=1)


@app.command("eval")
def eval_command(
    dataset: Path = Path("evals/datasets/items.sample.jsonl"),
    labels: Path = Path("evals/datasets/labels.sample.jsonl"),
    baseline: str = "latest-first",
    output: Path | None = None,
) -> None:
    arguments = [
        "--dataset",
        str(dataset),
        "--labels",
        str(labels),
        "--baseline",
        baseline,
    ]
    if output is not None:
        arguments.extend(["--output", str(output)])
    exit_code = run_eval(arguments)
    if exit_code:
        raise typer.Exit(code=exit_code)


if __name__ == "__main__":
    app()
