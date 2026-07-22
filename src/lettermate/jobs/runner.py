from collections.abc import Callable
from dataclasses import dataclass

from sqlalchemy.orm import Session, sessionmaker

from lettermate.db.models import JobRun
from lettermate.db.repository import Repository
from lettermate.sources.config_loader import SourceConfig


@dataclass(frozen=True)
class StageResult:
    run: JobRun
    status: str
    details: dict[str, int]

    @property
    def job_id(self) -> int:
        return self.run.id


class JobRunner:
    def __init__(self, session_factory: sessionmaker[Session]) -> None:
        self._session_factory = session_factory

    def run_stage(
        self,
        job_type: str,
        operation: Callable[[Repository], dict[str, int]],
    ) -> StageResult:
        with self._session_factory() as session:
            repository = Repository(session)
            run = repository.start_job_run(job_type)
            try:
                details = operation(repository)
                completed = repository.complete_job_run(run.id)
                return StageResult(run=completed, status=completed.status, details=details)
            except Exception as error:
                failed = repository.fail_job_run(
                    run.id,
                    f"{type(error).__name__}: {error}",
                    details={"job_type": job_type},
                )
                return StageResult(run=failed, status=failed.status, details={})


def sync_sources(runner: JobRunner, sources: list[SourceConfig]) -> StageResult:
    def operation(repository: Repository) -> dict[str, int]:
        for source in sources:
            repository.upsert_source(
                name=source.name,
                platform=source.platform,
                source_type=source.source_type,
                url=str(source.url),
                tags=source.tags,
                enabled=source.enabled,
            )
        return {"sources": len(sources)}

    return runner.run_stage("sync", operation)
