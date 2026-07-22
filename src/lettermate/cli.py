from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated

import typer

from lettermate.curation.provider import FakeCurationProvider
from lettermate.curation.service import CurationService
from lettermate.db.repository import Repository
from lettermate.db.session import create_session_factory
from lettermate.jobs.runner import JobRunner, analyze_pending, collect_fixture, sync_sources
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


if __name__ == "__main__":
    app()
