from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, datetime

from sqlalchemy.orm import Session, sessionmaker

from lettermate.curation.service import CurationService
from lettermate.db.models import JobRun, Source
from lettermate.db.repository import ContentInput, NewsletterItemInput, Repository
from lettermate.db.statuses import NewsletterStatus
from lettermate.newsletters.builder import NewsletterEntry, attach_signed_feedback, build_newsletter
from lettermate.notifiers.email import EmailNotifier
from lettermate.preferences.signing import FeedbackSigner
from lettermate.sources.collector import FeedResponse, parse_feed
from lettermate.sources.config_loader import SourceConfig


@dataclass(frozen=True)
class StageResult:
    run: JobRun
    status: str
    details: dict[str, int]
    warnings: tuple["StageWarning", ...] = ()

    @property
    def job_id(self) -> int:
        return self.run.id


@dataclass(frozen=True)
class DailyRunResult:
    issue_date: date
    idempotency_key: str
    stages: tuple[StageResult, ...]


@dataclass(frozen=True)
class StageWarning:
    code: str
    message: str
    details: dict[str, object]


@dataclass(frozen=True)
class StageOutcome:
    details: dict[str, int]
    warnings: tuple[StageWarning, ...] = ()


class JobRunner:
    def __init__(self, session_factory: sessionmaker[Session]) -> None:
        self._session_factory = session_factory

    def run_stage(
        self,
        job_type: str,
        operation: Callable[[Repository], dict[str, int] | StageOutcome],
        *,
        on_failure: Callable[[Repository, Exception], None] | None = None,
        failure_details: Callable[[Exception], dict[str, object]] | None = None,
    ) -> StageResult:
        with self._session_factory() as session:
            run = Repository(session).start_job_run(job_type)
            job_id = run.id
            repository = Repository(session, auto_commit=False)
            try:
                outcome = operation(repository)
                if isinstance(outcome, StageOutcome):
                    details = outcome.details
                    warnings = outcome.warnings
                else:
                    details = outcome
                    warnings = ()
                for warning in warnings:
                    repository.add_job_event(
                        run.id,
                        "warning",
                        warning.message,
                        details={"code": warning.code, **warning.details},
                    )
                completed = repository.complete_job_run(run.id)
                session.commit()
                session.refresh(completed)
                return StageResult(
                    run=completed,
                    status=completed.status,
                    details=details,
                    warnings=warnings,
                )
            except Exception as error:
                session.rollback()
                stage_error = error
                error_message = f"{type(error).__name__}: {error}"
        with self._session_factory() as failure_session:
            failure_repository = Repository(failure_session, auto_commit=False)
            if on_failure is not None:
                on_failure(failure_repository, stage_error)
            failed = failure_repository.fail_job_run(
                job_id,
                error_message,
                details={
                    "job_type": job_type,
                    **(failure_details(stage_error) if failure_details is not None else {}),
                },
                rollback=False,
            )
            failure_session.commit()
            failure_session.refresh(failed)
            list(failed.events)
            return StageResult(run=failed, status=failed.status, details={})

    def add_job_event(
        self,
        job_id: int,
        level: str,
        message: str,
        *,
        details: dict[str, object],
    ) -> None:
        with self._session_factory() as session:
            Repository(session).add_job_event(
                job_id,
                level,
                message,
                details=details,
            )


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


def collect_fixture(runner: JobRunner, feed_bytes: bytes, *, now: datetime) -> StageResult:
    return collect_sources(runner, lambda _source: feed_bytes, now=now)


def collect_sources(
    runner: JobRunner,
    feed_loader: Callable[[Source], bytes],
    *,
    now: datetime,
) -> StageResult:
    def operation(repository: Repository) -> StageOutcome:
        sources = repository.list_enabled_sources()
        item_count = 0
        warnings: list[StageWarning] = []
        for source in sources:
            try:
                parsed = parse_feed(FeedResponse(200, feed_loader(source), None, None))
                for item in parsed.items:
                    repository.upsert_content_item(
                        ContentInput(
                            source_id=source.id,
                            external_id=item.external_id,
                            title=item.title,
                            url=item.url,
                            author=item.author,
                            published_at=item.published_at,
                            raw_content=item.raw_content,
                        )
                    )
                    item_count += 1
                repository.record_source_fetch(source.id, fetched_at=now)
            except Exception as error:
                message = f"{type(error).__name__}: {error}"
                repository.record_source_fetch(source.id, fetched_at=now, error=message)
                warnings.append(
                    StageWarning(
                        code="source_fetch_failed",
                        message=message,
                        details={"source_id": source.id, "source_url": source.url},
                    )
                )
        details = {"sources": len(sources), "items": item_count}
        if warnings:
            details["failed_sources"] = len(warnings)
        return StageOutcome(details=details, warnings=tuple(warnings))

    return runner.run_stage("collect", operation)


def analyze_pending(
    runner: JobRunner,
    service_factory: Callable[[Repository], CurationService],
    *,
    now: datetime,
) -> StageResult:
    def operation(repository: Repository) -> dict[str, int]:
        analyses = service_factory(repository).analyze_pending(now=now)
        return {"analyses": len(analyses)}

    return runner.run_stage("analyze", operation)


def send_newsletter(
    runner: JobRunner,
    issue_date: date,
    *,
    notifier: EmailNotifier,
    force: bool = False,
) -> StageResult:
    newsletter_id: int | None = None
    notifier_attempted = False
    smtp_accepted = False

    def operation(repository: Repository) -> dict[str, int] | StageOutcome:
        nonlocal newsletter_id, notifier_attempted, smtp_accepted
        newsletter = repository.get_newsletter(issue_date)
        if newsletter is None:
            raise LookupError(f"newsletter for {issue_date.isoformat()} not found")
        newsletter_id = newsletter.id
        if newsletter.status == NewsletterStatus.SENT.value and not force:
            raise ValueError(f"newsletter {newsletter.id} is already sent")
        notifier_attempted = True
        result = notifier.send(subject=newsletter.title, html_body=newsletter.html_body)
        smtp_accepted = result.accepted
        if result.dry_run:
            repository.mark_newsletter_preview(newsletter.id)
        elif result.accepted:
            repository.mark_newsletter_sent(newsletter.id, force=force)
        else:
            raise RuntimeError("SMTP did not accept newsletter")
        details = {"sent": int(result.accepted), "dry_run": int(result.dry_run)}
        if result.accepted:
            warnings = [
                StageWarning(
                    code="smtp_exactly_once_boundary",
                    message=(
                        "SMTP acceptance and local status commit are not atomic; "
                        "reconcile before retrying an ambiguous send"
                    ),
                    details={
                        "newsletter_id": newsletter.id,
                        "force": force,
                        "reconciliation_required_after_ambiguous_outcome": True,
                    },
                )
            ]
            if force:
                warnings.append(
                    StageWarning(
                        code="explicit_forced_resend",
                        message="newsletter was resent through an explicit force action",
                        details={"newsletter_id": newsletter.id, "force": True},
                    )
                )
            return StageOutcome(
                details=details,
                warnings=tuple(warnings),
            )
        return details

    def persist_send_failure(repository: Repository, _error: Exception) -> None:
        if newsletter_id is not None and notifier_attempted and not smtp_accepted:
            repository.mark_newsletter_failed(newsletter_id)

    def send_failure_details(_error: Exception) -> dict[str, object]:
        if smtp_accepted and newsletter_id is not None:
            return {
                "smtp_accepted": True,
                "newsletter_id": newsletter_id,
                "reconciliation_required_after_ambiguous_outcome": True,
            }
        return {}

    return runner.run_stage(
        "send",
        operation,
        on_failure=persist_send_failure,
        failure_details=send_failure_details,
    )


def build_newsletter_issue(
    runner: JobRunner,
    issue_date: date,
    *,
    signer: FeedbackSigner,
    feedback_base_url: str,
    feedback_expires_at: datetime,
) -> StageResult:
    def operation(repository: Repository) -> dict[str, int] | StageOutcome:
        existing = repository.get_newsletter(issue_date)
        if existing is not None and existing.status == NewsletterStatus.SENT.value:
            return StageOutcome(
                details={"items": len(existing.items)},
                warnings=(
                    StageWarning(
                        code="newsletter_already_sent",
                        message="newsletter is already sent and was not rebuilt",
                        details={"newsletter_id": existing.id},
                    ),
                ),
            )
        analyses = repository.list_included_analyses()
        placeholder = repository.save_newsletter(issue_date, "Building", "", "", "draft")
        entries = [
            NewsletterEntry(
                content_item_id=analysis.content_item_id,
                decision_id=analysis.id,
                position=index,
                section="Top picks",
                final_score=analysis.final_score,
                title=analysis.item.title,
                source=analysis.item.source.name,
                url=analysis.item.url,
                summary=analysis.summary,
                reason=analysis.reason,
                confidence=1.0,
                feedback_urls={},
            )
            for index, analysis in enumerate(analyses, start=1)
        ]
        built = build_newsletter(
            issue_date,
            attach_signed_feedback(
                entries,
                issue_id=placeholder.id,
                signer=signer,
                base_url=feedback_base_url,
                expires_at=feedback_expires_at,
            ),
        )
        repository.save_newsletter(
            issue_date,
            built.title,
            built.markdown_body,
            built.html_body,
            "draft",
            [NewsletterItemInput(**membership.__dict__) for membership in built.memberships],
        )
        return {"items": len(built.memberships)}

    return runner.run_stage("build", operation)


def run_daily(
    issue_date: date,
    stages: list[Callable[[], StageResult]],
    *,
    runner: JobRunner | None = None,
) -> DailyRunResult:
    results: list[StageResult] = []
    idempotency_key = f"daily:{issue_date.isoformat()}"
    for stage in stages:
        result = stage()
        results.append(result)
        if len(results) == 1 and runner is not None:
            runner.add_job_event(
                result.job_id,
                "info",
                "daily_run_context",
                details={
                    "issue_date": issue_date.isoformat(),
                    "idempotency_key": idempotency_key,
                },
            )
        if result.status == "failed":
            break
    return DailyRunResult(
        issue_date=issue_date,
        idempotency_key=idempotency_key,
        stages=tuple(results),
    )
