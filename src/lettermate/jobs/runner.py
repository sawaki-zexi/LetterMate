from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, datetime

from sqlalchemy.orm import Session, sessionmaker

from lettermate.curation.service import CurationService
from lettermate.db.models import JobRun
from lettermate.db.repository import ContentInput, Repository
from lettermate.notifiers.email import EmailNotifier
from lettermate.sources.collector import FeedResponse, parse_feed
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


def collect_fixture(runner: JobRunner, feed_bytes: bytes, *, now: datetime) -> StageResult:
    def operation(repository: Repository) -> dict[str, int]:
        parsed = parse_feed(FeedResponse(200, feed_bytes, None, None))
        sources = repository.list_enabled_sources()
        item_count = 0
        for source in sources:
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
        return {"sources": len(sources), "items": item_count}

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
    def operation(repository: Repository) -> dict[str, int]:
        newsletter = repository.get_newsletter(issue_date)
        if newsletter is None:
            raise LookupError(f"newsletter for {issue_date.isoformat()} not found")
        result = notifier.send(subject=newsletter.title, html_body=newsletter.html_body)
        if result.dry_run:
            repository.mark_newsletter_preview(newsletter.id)
        elif result.accepted:
            repository.mark_newsletter_sent(newsletter.id, force=force)
        else:
            repository.mark_newsletter_failed(newsletter.id)
            raise RuntimeError("SMTP did not accept newsletter")
        return {"sent": int(result.accepted), "dry_run": int(result.dry_run)}

    return runner.run_stage("send", operation)
