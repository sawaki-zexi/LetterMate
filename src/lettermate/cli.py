from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated

import typer

from lettermate.db.session import create_session_factory
from lettermate.jobs.runner import JobRunner, collect_fixture, sync_sources
from lettermate.sources.config_loader import load_sources

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


if __name__ == "__main__":
    app()
