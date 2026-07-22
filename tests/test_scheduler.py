from datetime import UTC, datetime
from threading import Event

import pytest
from apscheduler.schedulers.background import BackgroundScheduler
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from lettermate.config import Settings
from lettermate.db.models import Base
from lettermate.db.repository import Repository
from lettermate.jobs import scheduler as scheduler_module
from lettermate.jobs.scheduler import (
    SchedulerCallbacks,
    _run_collect_claimed,
    create_scheduler,
    recover_missed_daily_run,
)


def _factory() -> sessionmaker[Session]:
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, expire_on_commit=False, future=True)


def test_scheduler_registers_isolated_collect_and_daily_jobs_with_stable_controls():
    calls: list[tuple[str, bool]] = []
    settings = Settings(
        app_env="test",
        scheduler_timezone="UTC",
        scheduler_collect_interval_minutes=30,
        scheduler_daily_hour=8,
        scheduler_daily_minute=15,
    )
    callbacks = SchedulerCallbacks(
        collect=lambda: calls.append(("collect", False)),
        daily=lambda _scheduled_for, recovered, _guard: calls.append(("daily", recovered)),
    )

    scheduler = create_scheduler(settings, callbacks)

    assert isinstance(scheduler, BackgroundScheduler)
    jobs = {job.id: job for job in scheduler.get_jobs()}
    assert set(jobs) == {"collect_sources", "daily_run"}
    assert jobs["collect_sources"].max_instances == 1
    assert jobs["daily_run"].max_instances == 1
    assert jobs["collect_sources"].coalesce is True
    assert jobs["daily_run"].coalesce is True
    assert str(jobs["collect_sources"].trigger.timezone) == "UTC"
    assert str(jobs["daily_run"].trigger.timezone) == "UTC"
    jobs["collect_sources"].func()
    assert calls == [("collect", False)]


def test_missed_daily_run_recovers_once_inside_window_and_records_timing():
    factory = _factory()
    settings = Settings(
        app_env="test",
        scheduler_timezone="UTC",
        scheduler_daily_hour=8,
        scheduler_daily_minute=0,
        scheduler_recovery_window_minutes=90,
    )
    invoked: list[tuple[datetime, bool]] = []
    callbacks = SchedulerCallbacks(
        collect=lambda: None,
        daily=lambda scheduled_for, recovered, _guard: invoked.append((scheduled_for, recovered)),
    )
    now = datetime(2026, 7, 23, 8, 30, tzinfo=UTC)

    first = recover_missed_daily_run(factory, settings, callbacks, now=now)
    repeated = recover_missed_daily_run(factory, settings, callbacks, now=now)

    assert first is True
    assert repeated is False
    assert invoked == [(datetime(2026, 7, 23, 8, tzinfo=UTC), True)]
    with factory() as session:
        runs = Repository(session).list_job_runs()
        assert len(runs) == 1
        assert runs[0].idempotency_key == "daily:2026-07-23"
        assert runs[0].scheduled_for.replace(tzinfo=UTC) == datetime(
            2026, 7, 23, 8, tzinfo=UTC
        )
        assert runs[0].recovered is True
        assert runs[0].finished_at is not None


def test_collect_tick_claims_each_time_bucket_once_across_workers():
    factory = _factory()
    settings = Settings(
        app_env="test",
        scheduler_timezone="UTC",
        scheduler_collect_interval_minutes=30,
    )
    invoked: list[str] = []
    callbacks = SchedulerCallbacks(
        collect=lambda: invoked.append("collect"),
        daily=lambda _scheduled_for, _recovered, _guard: None,
    )
    now = datetime(2026, 7, 23, 8, 47, tzinfo=UTC)

    first = _run_collect_claimed(factory, settings, callbacks, now=now)
    duplicate_worker = _run_collect_claimed(factory, settings, callbacks, now=now)

    assert first is True
    assert duplicate_worker is False
    assert invoked == ["collect"]
    with factory() as session:
        runs = Repository(session).list_job_runs()
        assert len(runs) == 1
        assert runs[0].idempotency_key == "collect:2026-07-23T08:30:00+00:00"
        assert runs[0].scheduled_for.replace(tzinfo=UTC) == datetime(
            2026, 7, 23, 8, 30, tzinfo=UTC
        )


def test_missed_daily_run_reclaims_one_stale_running_claim_once():
    factory = _factory()
    settings = Settings(
        app_env="test",
        scheduler_timezone="UTC",
        scheduler_daily_hour=8,
        scheduler_daily_minute=0,
        scheduler_recovery_window_minutes=90,
        scheduler_claim_stale_minutes=5,
    )
    scheduled_for = datetime(2026, 7, 23, 8, tzinfo=UTC)
    with factory() as session:
        run = Repository(session).start_job_run(
            "daily",
            idempotency_key="daily:2026-07-23",
            scheduled_for=scheduled_for,
        )
        run.started_at = datetime(2026, 7, 23, 8, 5, tzinfo=UTC)
        session.commit()
    invoked: list[tuple[datetime, bool]] = []
    callbacks = SchedulerCallbacks(
        collect=lambda: None,
        daily=lambda value, recovered, _guard: invoked.append((value, recovered)),
    )
    now = datetime(2026, 7, 23, 8, 30, tzinfo=UTC)

    reclaimed = recover_missed_daily_run(factory, settings, callbacks, now=now)
    duplicate_recovery = recover_missed_daily_run(factory, settings, callbacks, now=now)

    assert reclaimed is True
    assert duplicate_recovery is False
    assert invoked == [(scheduled_for, True)]
    with factory() as session:
        refreshed = session.get(type(run), run.id)
        assert refreshed is not None
        assert refreshed.recovered is True
        assert refreshed.started_at.replace(tzinfo=UTC) == now
        assert refreshed.finished_at is not None


def test_scheduled_recovery_retries_after_a_fresh_claim_becomes_stale():
    factory = _factory()
    settings = Settings(
        app_env="test",
        scheduler_timezone="UTC",
        scheduler_daily_hour=8,
        scheduler_daily_minute=0,
        scheduler_recovery_window_minutes=90,
        scheduler_claim_stale_minutes=15,
    )
    scheduled_for = datetime(2026, 7, 23, 8, tzinfo=UTC)
    with factory() as session:
        Repository(session).claim_scheduled_job(
            job_type="daily",
            idempotency_key="daily:2026-07-23",
            scheduled_for=scheduled_for,
            recovered=False,
            started_at=datetime(2026, 7, 23, 8, 5, tzinfo=UTC),
            lease_expires_at=datetime(2026, 7, 23, 8, 20, tzinfo=UTC),
        )
    invoked: list[tuple[datetime, bool]] = []
    callbacks = SchedulerCallbacks(
        collect=lambda: None,
        daily=lambda value, recovered, _guard: invoked.append((value, recovered)),
    )
    scheduler = create_scheduler(settings, callbacks, session_factory=factory)

    scheduler_module.schedule_missed_daily_recovery(
        scheduler,
        factory,
        settings,
        callbacks,
        now=datetime(2026, 7, 23, 8, 10, tzinfo=UTC),
        clock=lambda: datetime(2026, 7, 23, 8, 30, tzinfo=UTC),
    )

    scheduler.start(paused=True)
    retry = scheduler.get_job("daily_recovery")
    assert retry is not None
    assert retry.misfire_grace_time == 80 * 60
    retry.func()
    assert invoked == [(scheduled_for, True)]


def test_scheduled_recovery_keeps_the_previous_day_target_across_midnight():
    factory = _factory()
    settings = Settings(
        app_env="test",
        scheduler_timezone="UTC",
        scheduler_daily_hour=23,
        scheduler_daily_minute=30,
        scheduler_recovery_window_minutes=90,
        scheduler_claim_stale_minutes=15,
    )
    invoked: list[tuple[datetime, bool]] = []
    callbacks = SchedulerCallbacks(
        collect=lambda: None,
        daily=lambda value, recovered, _guard: invoked.append((value, recovered)),
    )
    scheduler = create_scheduler(settings, callbacks, session_factory=factory)

    scheduler_module.schedule_missed_daily_recovery(
        scheduler,
        factory,
        settings,
        callbacks,
        now=datetime(2026, 7, 23, 23, 40, tzinfo=UTC),
        clock=lambda: datetime(2026, 7, 24, 0, 15, tzinfo=UTC),
    )

    retry = scheduler.get_job("daily_recovery")
    assert retry is not None
    retry.func()
    assert invoked == [(datetime(2026, 7, 23, 23, 30, tzinfo=UTC), True)]


def test_lease_renewal_prevents_recovery_from_stealing_an_active_daily_run():
    factory = _factory()
    settings = Settings(
        app_env="test",
        scheduler_timezone="UTC",
        scheduler_daily_hour=8,
        scheduler_daily_minute=0,
        scheduler_recovery_window_minutes=90,
        scheduler_claim_stale_minutes=15,
    )
    scheduled_for = datetime(2026, 7, 23, 8, tzinfo=UTC)
    with factory() as session:
        repository = Repository(session)
        active = repository.claim_scheduled_job(
            job_type="daily",
            idempotency_key="daily:2026-07-23",
            scheduled_for=scheduled_for,
            recovered=False,
            started_at=datetime(2026, 7, 23, 8, tzinfo=UTC),
            lease_expires_at=datetime(2026, 7, 23, 8, 15, tzinfo=UTC),
        )
        assert active is not None
        assert active.claim_token is not None
        assert repository.renew_scheduled_job_lease(
            active.id,
            active.claim_token,
            lease_expires_at=datetime(2026, 7, 23, 8, 45, tzinfo=UTC),
        )
    callbacks = SchedulerCallbacks(collect=lambda: None, daily=lambda *_args: None)

    recovered = recover_missed_daily_run(
        factory,
        settings,
        callbacks,
        now=datetime(2026, 7, 23, 8, 30, tzinfo=UTC),
    )

    assert recovered is False


def test_daily_claim_guard_rejects_work_after_lease_loss():
    lost = Event()
    guard = scheduler_module.DailyClaimGuard(lost)

    guard.ensure_held()
    lost.set()

    with pytest.raises(RuntimeError, match="lease"):
        guard.ensure_held()


def test_missed_daily_run_does_not_recover_outside_the_configured_window():
    factory = _factory()
    settings = Settings(
        app_env="test",
        scheduler_timezone="UTC",
        scheduler_daily_hour=8,
        scheduler_daily_minute=0,
        scheduler_recovery_window_minutes=30,
    )
    callbacks = SchedulerCallbacks(
        collect=lambda: None,
        daily=lambda _scheduled_for, _recovered, _guard: None,
    )

    recovered = recover_missed_daily_run(
        factory,
        settings,
        callbacks,
        now=datetime(2026, 7, 23, 9, 0, tzinfo=UTC),
    )

    assert recovered is False
    with factory() as session:
        assert Repository(session).list_job_runs() == []


def test_missed_daily_run_recovers_previous_day_inside_a_cross_midnight_window():
    factory = _factory()
    settings = Settings(
        app_env="test",
        scheduler_timezone="UTC",
        scheduler_daily_hour=23,
        scheduler_daily_minute=30,
        scheduler_recovery_window_minutes=90,
    )
    invoked: list[tuple[datetime, bool]] = []
    callbacks = SchedulerCallbacks(
        collect=lambda: None,
        daily=lambda scheduled_for, recovered, _guard: invoked.append((scheduled_for, recovered)),
    )

    recovered = recover_missed_daily_run(
        factory,
        settings,
        callbacks,
        now=datetime(2026, 7, 24, 0, 15, tzinfo=UTC),
    )

    assert recovered is True
    assert invoked == [(datetime(2026, 7, 23, 23, 30, tzinfo=UTC), True)]
