from pathlib import Path

import typer

from lettermate.db.session import create_session_factory
from lettermate.jobs.runner import JobRunner, sync_sources
from lettermate.sources.config_loader import load_sources

app = typer.Typer(no_args_is_help=True)


@app.command("sync-sources")
def sync_sources_command(config: Path = Path("configs/sources.yaml")) -> None:
    result = sync_sources(JobRunner(create_session_factory()), load_sources(config))
    typer.echo(
        f"job={result.job_id} status={result.status} "
        f"sources={result.details.get('sources', 0)}"
    )


if __name__ == "__main__":
    app()
