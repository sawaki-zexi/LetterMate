from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from lettermate.db.models import Base
from lettermate.jobs.runner import JobRunner


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
