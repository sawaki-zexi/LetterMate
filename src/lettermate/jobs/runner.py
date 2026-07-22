from collections.abc import Callable
from dataclasses import dataclass

from sqlalchemy.orm import Session, sessionmaker

from lettermate.db.models import JobRun
from lettermate.db.repository import Repository


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
