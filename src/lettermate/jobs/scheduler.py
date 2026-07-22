"""Dedicated APScheduler worker with durable daily-run claims."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from threading import Event, Thread
from zoneinfo import ZoneInfo

from apscheduler.schedulers.background import BackgroundScheduler
from sqlalchemy.orm import Session, sessionmaker

from lettermate.config import Settings
from lettermate.db.repository import Repository


@dataclass(frozen=True)
class DailyClaimGuard:
    lease_lost: Event

    def ensure_held(self) -> None:
        if self.lease_lost.is_set():
            raise RuntimeError("daily job lease was lost")


@dataclass(frozen=True)
class SchedulerCallbacks:
    collect: Callable[[], None]
    daily: Callable[[datetime, bool, DailyClaimGuard], None]


def create_scheduler(
    settings: Settings,
    callbacks: SchedulerCallbacks,
    *,
    session_factory: sessionmaker[Session] | None = None,
) -> BackgroundScheduler:
    timezone = ZoneInfo(settings.scheduler_timezone)
    scheduler = BackgroundScheduler(timezone=timezone)
    scheduler.add_job(
        lambda: _run_collect_claimed(session_factory, settings, callbacks)
        if session_factory is not None
        else callbacks.collect(),
        "interval",
        id="collect_sources",
        minutes=settings.scheduler_collect_interval_minutes,
        max_instances=1,
        coalesce=True,
        replace_existing=True,
    )

    def scheduled_daily() -> None:
        now = datetime.now(timezone)
        scheduled_for = now.replace(
            hour=settings.scheduler_daily_hour,
            minute=settings.scheduler_daily_minute,
            second=0,
            microsecond=0,
        )
        if session_factory is None:
            callbacks.daily(scheduled_for, False, DailyClaimGuard(Event()))
            return
        _run_daily_claimed(
            session_factory,
            callbacks,
            scheduled_for,
            settings,
            recovered=False,
            execution_started_at=now,
        )

    scheduler.add_job(
        scheduled_daily,
        "cron",
        id="daily_run",
        hour=settings.scheduler_daily_hour,
        minute=settings.scheduler_daily_minute,
        max_instances=1,
        coalesce=True,
        replace_existing=True,
    )
    return scheduler


def recover_missed_daily_run(
    session_factory: sessionmaker[Session],
    settings: Settings,
    callbacks: SchedulerCallbacks,
    *,
    now: datetime,
) -> bool:
    timezone = ZoneInfo(settings.scheduler_timezone)
    local_now = now.astimezone(timezone)
    scheduled_for = _most_recent_daily_scheduled_for(local_now, settings)
    if local_now - scheduled_for > timedelta(
        minutes=settings.scheduler_recovery_window_minutes
    ):
        return False
    return _run_daily_claimed(
        session_factory,
        callbacks,
        scheduled_for,
        settings,
        recovered=True,
        execution_started_at=local_now,
        stale_before=local_now - timedelta(minutes=settings.scheduler_claim_stale_minutes),
    )


def _run_daily_claimed(
    session_factory: sessionmaker[Session],
    callbacks: SchedulerCallbacks,
    scheduled_for: datetime,
    settings: Settings,
    *,
    recovered: bool,
    execution_started_at: datetime,
    stale_before: datetime | None = None,
) -> bool:
    key = f"daily:{scheduled_for.date().isoformat()}"
    with session_factory() as session:
        run = Repository(session).claim_scheduled_job(
            job_type="daily",
            idempotency_key=key,
            scheduled_for=scheduled_for,
            recovered=recovered,
            started_at=execution_started_at,
            stale_before=stale_before,
            lease_expires_at=execution_started_at
            + timedelta(minutes=settings.scheduler_claim_stale_minutes),
        )
    if run is None:
        return False
    if run.claim_token is None:
        raise RuntimeError(f"scheduled job {run.id} was claimed without a token")
    stop_heartbeat = Event()
    guard = DailyClaimGuard(Event())
    heartbeat = Thread(
        target=_renew_job_lease,
        args=(session_factory, run.id, run.claim_token, settings, stop_heartbeat, guard.lease_lost),
        daemon=True,
    )
    heartbeat.start()
    try:
        callbacks.daily(scheduled_for, recovered, guard)
        guard.ensure_held()
    except Exception as error:
        stop_heartbeat.set()
        heartbeat.join()
        with session_factory() as session:
            Repository(session).fail_scheduled_job_claim(
                run.id, run.claim_token, f"{type(error).__name__}: {error}"
            )
        raise
    stop_heartbeat.set()
    heartbeat.join()
    with session_factory() as session:
        return Repository(session).complete_scheduled_job_claim(run.id, run.claim_token)


def _renew_job_lease(
    session_factory: sessionmaker[Session],
    job_run_id: int,
    claim_token: str,
    settings: Settings,
    stop: Event,
    lease_lost: Event,
) -> None:
    interval_seconds = max(1, settings.scheduler_claim_stale_minutes * 20)
    timezone = ZoneInfo(settings.scheduler_timezone)
    while not stop.wait(interval_seconds):
        now = datetime.now(timezone)
        try:
            with session_factory() as session:
                renewed = Repository(session).renew_scheduled_job_lease(
                    job_run_id,
                    claim_token,
                    lease_expires_at=now
                    + timedelta(minutes=settings.scheduler_claim_stale_minutes),
                )
        except Exception:
            lease_lost.set()
            return
        if not renewed:
            lease_lost.set()
            return


def schedule_missed_daily_recovery(
    scheduler: BackgroundScheduler,
    session_factory: sessionmaker[Session],
    settings: Settings,
    callbacks: SchedulerCallbacks,
    *,
    now: datetime,
    clock: Callable[[], datetime] | None = None,
) -> None:
    timezone = ZoneInfo(settings.scheduler_timezone)
    local_now = now.astimezone(timezone)
    scheduled_for = _most_recent_daily_scheduled_for(local_now, settings)
    deadline = scheduled_for + timedelta(minutes=settings.scheduler_recovery_window_minutes)
    if local_now < scheduled_for or local_now >= deadline:
        return
    clock = clock or (lambda: datetime.now(timezone))

    def retry() -> None:
        retry_now = clock().astimezone(timezone)
        recovered = recover_missed_daily_run(
            session_factory, settings, callbacks, now=retry_now
        )
        if not recovered:
            schedule_missed_daily_recovery(
                scheduler,
                session_factory,
                settings,
                callbacks,
                now=retry_now,
                clock=clock,
            )

    scheduler.add_job(
        retry,
        "date",
        id="daily_recovery",
        run_date=min(local_now + timedelta(minutes=1), deadline),
        misfire_grace_time=max(1, int((deadline - local_now).total_seconds())),
        replace_existing=True,
    )


def _most_recent_daily_scheduled_for(local_now: datetime, settings: Settings) -> datetime:
    scheduled_for = local_now.replace(
        hour=settings.scheduler_daily_hour,
        minute=settings.scheduler_daily_minute,
        second=0,
        microsecond=0,
    )
    if local_now < scheduled_for:
        return scheduled_for - timedelta(days=1)
    return scheduled_for


def _run_collect_claimed(
    session_factory: sessionmaker[Session],
    settings: Settings,
    callbacks: SchedulerCallbacks,
    *,
    now: datetime | None = None,
) -> bool:
    timezone = ZoneInfo(settings.scheduler_timezone)
    now = (now or datetime.now(timezone)).astimezone(timezone)
    minute = now.minute - now.minute % settings.scheduler_collect_interval_minutes
    scheduled_for = now.replace(minute=minute, second=0, microsecond=0)
    key = f"collect:{scheduled_for.isoformat()}"
    with session_factory() as session:
        run = Repository(session).claim_scheduled_job(
            job_type="collect",
            idempotency_key=key,
            scheduled_for=scheduled_for,
            recovered=False,
            started_at=now,
        )
    if run is None:
        return False
    try:
        callbacks.collect()
    except Exception as error:
        with session_factory() as session:
            Repository(session).fail_job_run(run.id, f"{type(error).__name__}: {error}")
        raise
    with session_factory() as session:
        Repository(session).complete_job_run(run.id)
    return True
