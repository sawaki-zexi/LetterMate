import json
from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import Decimal
from hashlib import sha256

from sqlalchemy import delete, func, or_, select
from sqlalchemy.orm import Session

from lettermate.db.models import (
    AgentRun,
    AnalysisResult,
    ContentItem,
    Feedback,
    JobEvent,
    JobRun,
    Newsletter,
    NewsletterItem,
    PreferenceSnapshot,
    Source,
    ToolCallTrace,
    utc_now,
)
from lettermate.db.statuses import (
    AgentRunStatus,
    ContentItemStatus,
    JobRunStatus,
    NewsletterStatus,
    SourceStatus,
    require_status,
)
from lettermate.sources.urls import normalize_url


@dataclass(frozen=True)
class ContentInput:
    source_id: int
    external_id: str | None
    title: str
    url: str
    author: str
    published_at: datetime | None
    raw_content: str
    normalized_url: str | None = None


@dataclass(frozen=True)
class NewsletterItemInput:
    content_item_id: int
    decision_id: int
    position: int
    section: str
    final_score: float


def make_content_hash(title: str, url: str, raw_content: str) -> str:
    del url
    payload = json.dumps(
        [title.strip(), raw_content.strip()], separators=(",", ":")
    ).encode()
    return sha256(payload).hexdigest()


def make_preference_hash(
    *,
    explicit_interests: list[str],
    exclusions: list[str],
    tag_weights: dict[str, int],
    source_weights: dict[str, int],
    feedback_cutoff: datetime | None,
    feedback_cutoff_id: int | None = None,
) -> str:
    normalized_cutoff = None
    if feedback_cutoff is not None:
        cutoff_with_zone = (
            feedback_cutoff.replace(tzinfo=UTC)
            if feedback_cutoff.tzinfo is None
            else feedback_cutoff
        )
        normalized_cutoff = cutoff_with_zone.astimezone(UTC).isoformat()
    payload = {
        "explicit_interests": sorted(set(explicit_interests)),
        "exclusions": sorted(set(exclusions)),
        "tag_weights": dict(sorted(tag_weights.items())),
        "source_weights": dict(sorted(source_weights.items())),
        "feedback_cutoff": normalized_cutoff,
        "feedback_cutoff_id": feedback_cutoff_id,
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return sha256(canonical.encode()).hexdigest()


class Repository:
    def __init__(self, session: Session) -> None:
        self.session = session

    def create_source(
        self,
        name: str,
        platform: str,
        source_type: str,
        url: str,
        tags: list[str],
        enabled: bool = True,
        status: str = SourceStatus.ACTIVE,
    ) -> Source:
        return self.upsert_source(
            name=name,
            platform=platform,
            source_type=source_type,
            url=url,
            tags=tags,
            enabled=enabled,
            status=status,
        )

    def upsert_source(
        self,
        *,
        name: str,
        platform: str,
        source_type: str,
        url: str,
        tags: list[str],
        enabled: bool = True,
        status: str = SourceStatus.ACTIVE,
    ) -> Source:
        valid_status = require_status(status, SourceStatus)
        normalized_url = normalize_url(url)
        source = self.session.scalar(
            select(Source).where(or_(Source.url == url, Source.normalized_url == normalized_url))
        )
        if source is None:
            source = Source()
            self.session.add(source)
        source.name = name
        source.platform = platform
        source.source_type = source_type
        source.url = url
        source.normalized_url = normalized_url
        source.tags = list(tags)
        source.enabled = enabled
        source.status = valid_status
        self.session.commit()
        return source

    def get_source_by_url(self, url: str) -> Source | None:
        normalized_url = normalize_url(url)
        return self.session.scalar(
            select(Source).where(or_(Source.url == url, Source.normalized_url == normalized_url))
        )

    def list_enabled_sources(self) -> list[Source]:
        statement = select(Source).where(Source.enabled.is_(True)).order_by(Source.id)
        return list(self.session.scalars(statement))

    def record_source_fetch(
        self,
        source_id: int,
        *,
        fetched_at: datetime,
        etag: str | None = None,
        last_modified: str | None = None,
        error: str | None = None,
    ) -> Source:
        source = self.session.get(Source, source_id)
        if source is None:
            raise LookupError(f"source {source_id} not found")
        if error is not None:
            source.status = SourceStatus.ERROR.value
            source.last_error = error
        else:
            source.status = SourceStatus.ACTIVE.value
            source.last_error = None
            source.last_fetched_at = fetched_at
            if etag is not None:
                source.etag = etag
            if last_modified is not None:
                source.last_modified = last_modified
        self.session.commit()
        return source

    def upsert_content_item(self, item: ContentInput) -> ContentItem:
        content_hash = make_content_hash(item.title, item.url, item.raw_content)
        normalized_url = normalize_url(item.url)
        if item.normalized_url is not None and normalize_url(item.normalized_url) != normalized_url:
            raise ValueError("normalized URL does not match content URL")
        existing = self.session.scalar(
            select(ContentItem).where(ContentItem.normalized_url == normalized_url)
        )
        matched_by_identity = existing is not None
        matched_by_url = existing is not None
        matched_by_external_id = False
        if existing is None and item.external_id is not None:
            existing = self.session.scalar(
                select(ContentItem).where(
                    ContentItem.source_id == item.source_id,
                    ContentItem.external_id == item.external_id,
                )
            )
            matched_by_identity = existing is not None
            matched_by_external_id = existing is not None
        if existing is None:
            existing = self.session.scalar(
                select(ContentItem).where(ContentItem.content_hash == content_hash)
            )
        if existing is None:
            existing = ContentItem(
                source_id=item.source_id,
                url=item.url,
                normalized_url=normalized_url,
                content_hash=content_hash,
            )
            self.session.add(existing)
            matched_by_identity = True

        if matched_by_identity:
            existing.title = item.title
            existing.author = item.author
            existing.published_at = item.published_at
            existing.raw_content = item.raw_content
            existing.content_hash = content_hash
            if matched_by_url or matched_by_external_id:
                existing.url = item.url
                existing.normalized_url = normalized_url
            if existing.external_id is None:
                existing.external_id = item.external_id
        if existing.status is None:
            existing.status = ContentItemStatus.PENDING_ANALYSIS.value
        self.session.commit()
        return existing

    def get_content_item(
        self,
        *,
        url: str | None = None,
        source_id: int | None = None,
        external_id: str | None = None,
        content_hash: str | None = None,
    ) -> ContentItem | None:
        if url is not None:
            normalized_url = normalize_url(url)
            found = self.session.scalar(
                select(ContentItem).where(ContentItem.normalized_url == normalized_url)
            )
            if found is not None:
                return found
        if source_id is not None and external_id is not None:
            found = self.session.scalar(
                select(ContentItem).where(
                    ContentItem.source_id == source_id,
                    ContentItem.external_id == external_id,
                )
            )
            if found is not None:
                return found
        if content_hash is not None:
            return self.session.scalar(
                select(ContentItem).where(ContentItem.content_hash == content_hash)
            )
        return None

    def count_content_items(self) -> int:
        return int(self.session.scalar(select(func.count(ContentItem.id))) or 0)

    def list_pending_analysis_items(self, limit: int) -> list[ContentItem]:
        statement = (
            select(ContentItem)
            .where(ContentItem.status == ContentItemStatus.PENDING_ANALYSIS.value)
            .order_by(ContentItem.created_at, ContentItem.id)
            .limit(limit)
        )
        return list(self.session.scalars(statement))

    def set_content_item_status(self, item_id: int, status: str) -> ContentItem:
        valid_status = require_status(status, ContentItemStatus)
        item = self.session.get(ContentItem, item_id)
        if item is None:
            raise LookupError(f"content item {item_id} not found")
        item.status = valid_status
        self.session.commit()
        return item

    def save_analysis(
        self,
        item: ContentItem,
        summary: str,
        tags: list[str],
        score: int,
        reason: str,
        actionable_insight: str,
        should_include: bool,
        model: str,
        *,
        agent_run_id: int,
        semantic_score: float,
        preference_boost: float = 0.0,
        freshness_bonus: float = 0.0,
        repetition_penalty: float = 0.0,
        source_diversity_adjustment: float = 0.0,
        final_score: float,
        decision: str,
    ) -> AnalysisResult:
        agent_run = self._get_agent_run(agent_run_id)
        if agent_run.content_item_id != item.id:
            raise ValueError(
                f"agent run {agent_run_id} does not belong to content item {item.id}"
            )
        analysis = self.session.scalar(
            select(AnalysisResult).where(AnalysisResult.content_item_id == item.id)
        )
        if analysis is None:
            analysis = AnalysisResult(content_item_id=item.id)
            self.session.add(analysis)
        analysis.agent_run_id = agent_run_id
        analysis.summary = summary
        analysis.tags = list(tags)
        analysis.score = score
        analysis.reason = reason
        analysis.actionable_insight = actionable_insight
        analysis.should_include = should_include
        analysis.model = model
        analysis.semantic_score = semantic_score
        analysis.preference_boost = preference_boost
        analysis.freshness_bonus = freshness_bonus
        analysis.repetition_penalty = repetition_penalty
        analysis.source_diversity_adjustment = source_diversity_adjustment
        analysis.final_score = final_score
        analysis.decision = decision
        analysis.analyzed_at = utc_now()
        item.status = ContentItemStatus.ANALYZED.value
        self.session.commit()
        return analysis

    def create_preference_snapshot(
        self,
        *,
        explicit_interests: list[str],
        exclusions: list[str],
        tag_weights: dict[str, int],
        source_weights: dict[str, int],
        feedback_cutoff: datetime | None,
        feedback_cutoff_id: int | None = None,
        derivation_type: str = "manual",
    ) -> PreferenceSnapshot:
        normalized_interests = sorted(set(explicit_interests))
        normalized_exclusions = sorted(set(exclusions))
        normalized_tag_weights = dict(sorted(tag_weights.items()))
        normalized_source_weights = dict(sorted(source_weights.items()))
        current_version = self.session.scalar(select(func.max(PreferenceSnapshot.version))) or 0
        snapshot = PreferenceSnapshot(
            version=current_version + 1,
            explicit_interests=normalized_interests,
            exclusions=normalized_exclusions,
            tag_weights=normalized_tag_weights,
            source_weights=normalized_source_weights,
            feedback_cutoff=feedback_cutoff,
            feedback_cutoff_id=feedback_cutoff_id,
            derivation_type=derivation_type,
            content_hash=make_preference_hash(
                explicit_interests=normalized_interests,
                exclusions=normalized_exclusions,
                tag_weights=normalized_tag_weights,
                source_weights=normalized_source_weights,
                feedback_cutoff=feedback_cutoff,
                feedback_cutoff_id=feedback_cutoff_id,
            ),
        )
        self.session.add(snapshot)
        self.session.commit()
        return snapshot

    def get_preference_snapshot(self, version: int) -> PreferenceSnapshot | None:
        return self.session.scalar(
            select(PreferenceSnapshot).where(PreferenceSnapshot.version == version)
        )

    def get_latest_preference_snapshot(self) -> PreferenceSnapshot | None:
        return self.session.scalar(
            select(PreferenceSnapshot).order_by(PreferenceSnapshot.version.desc()).limit(1)
        )

    def reset_preference_weights(self) -> PreferenceSnapshot:
        latest = self.get_latest_preference_snapshot()
        if latest is None:
            return self.create_preference_snapshot(
                explicit_interests=[],
                exclusions=[],
                tag_weights={},
                source_weights={},
                feedback_cutoff=None,
                derivation_type="reset",
            )
        latest_feedback = self.session.scalar(
            select(Feedback).order_by(Feedback.created_at.desc(), Feedback.id.desc()).limit(1)
        )
        return self.create_preference_snapshot(
            explicit_interests=latest.explicit_interests,
            exclusions=latest.exclusions,
            tag_weights={},
            source_weights={},
            feedback_cutoff=(
                latest_feedback.created_at if latest_feedback else latest.feedback_cutoff
            ),
            feedback_cutoff_id=(
                latest_feedback.id if latest_feedback else latest.feedback_cutoff_id
            ),
            derivation_type="reset",
        )

    def save_newsletter(
        self,
        issue_date: date,
        title: str,
        markdown_body: str,
        html_body: str,
        status: str,
        items: list[NewsletterItemInput] | None = None,
    ) -> Newsletter:
        valid_status = require_status(status, NewsletterStatus)
        if items is not None:
            self._validate_newsletter_items(items)
            self._validate_newsletter_decisions(items)
        newsletter = self.session.scalar(
            select(Newsletter).where(Newsletter.issue_date == issue_date)
        )
        if newsletter is None:
            newsletter = Newsletter(issue_date=issue_date)
            self.session.add(newsletter)
        newsletter.title = title
        newsletter.markdown_body = markdown_body
        newsletter.html_body = html_body
        newsletter.status = valid_status
        self.session.flush()
        if items is not None:
            self._replace_newsletter_items(newsletter, items)
        self.session.commit()
        self.session.refresh(newsletter)
        return newsletter

    def get_newsletter(self, issue_date: date) -> Newsletter | None:
        return self.session.scalar(select(Newsletter).where(Newsletter.issue_date == issue_date))

    def list_included_analyses(self, limit: int = 5) -> list[AnalysisResult]:
        return list(
            self.session.scalars(
                select(AnalysisResult)
                .where(AnalysisResult.decision == "include")
                .order_by(AnalysisResult.final_score.desc(), AnalysisResult.id)
                .limit(limit)
            )
        )

    def mark_newsletter_sent(self, newsletter_id: int, *, force: bool = False) -> Newsletter:
        newsletter = self.session.get(Newsletter, newsletter_id)
        if newsletter is None:
            raise LookupError(f"newsletter {newsletter_id} not found")
        if newsletter.status == NewsletterStatus.SENT.value and not force:
            raise ValueError(f"newsletter {newsletter_id} is already sent")
        newsletter.status = NewsletterStatus.SENT.value
        newsletter.sent_at = utc_now()
        self.session.commit()
        return newsletter

    def mark_newsletter_failed(self, newsletter_id: int) -> Newsletter:
        newsletter = self.session.get(Newsletter, newsletter_id)
        if newsletter is None:
            raise LookupError(f"newsletter {newsletter_id} not found")
        newsletter.status = NewsletterStatus.SEND_FAILED.value
        self.session.commit()
        return newsletter

    def mark_newsletter_preview(self, newsletter_id: int) -> Newsletter:
        newsletter = self.session.get(Newsletter, newsletter_id)
        if newsletter is None:
            raise LookupError(f"newsletter {newsletter_id} not found")
        newsletter.status = NewsletterStatus.PREVIEW.value
        self.session.commit()
        return newsletter

    def _replace_newsletter_items(
        self, newsletter: Newsletter, items: list[NewsletterItemInput]
    ) -> None:
        self._validate_newsletter_items(items)
        content_ids = [item.content_item_id for item in items]
        positions = [item.position for item in items]

        existing = {
            member.content_item_id: member
            for member in self.session.scalars(
                select(NewsletterItem).where(NewsletterItem.newsletter_id == newsletter.id)
            )
        }
        removed_ids = set(existing) - set(content_ids)
        if removed_ids:
            self.session.execute(
                delete(NewsletterItem).where(
                    NewsletterItem.newsletter_id == newsletter.id,
                    NewsletterItem.content_item_id.in_(removed_ids),
                )
            )
        temporary_offset = max(
            [*positions, *(member.position for member in existing.values())], default=0
        )
        for temporary_position, member in enumerate(existing.values(), start=1):
            if member.content_item_id not in removed_ids:
                member.position = temporary_offset + temporary_position
        self.session.flush()

        for entry in sorted(items, key=lambda candidate: candidate.position):
            decision = self.session.get(AnalysisResult, entry.decision_id)
            content_item = self.session.get(ContentItem, entry.content_item_id)
            if decision is None or content_item is None:
                raise RuntimeError("validated newsletter provenance disappeared")
            agent_run = self.session.get(AgentRun, decision.agent_run_id)
            if agent_run is None:
                raise RuntimeError("validated newsletter agent run disappeared")
            recommendation_snapshot_id = agent_run.preference_snapshot_id
            candidate = existing.get(entry.content_item_id)
            if candidate is None:
                candidate = NewsletterItem(
                    newsletter_id=newsletter.id, content_item_id=entry.content_item_id
                )
                self.session.add(candidate)
            candidate.decision_id = entry.decision_id
            candidate.source_id = content_item.source_id
            candidate.preference_snapshot_id = recommendation_snapshot_id
            candidate.decision_tags = sorted(set(decision.tags))
            candidate.position = entry.position
            candidate.section = entry.section
            candidate.final_score = entry.final_score

    @staticmethod
    def _validate_newsletter_items(items: list[NewsletterItemInput]) -> None:
        content_ids = [item.content_item_id for item in items]
        positions = [item.position for item in items]
        if len(content_ids) != len(set(content_ids)):
            raise ValueError("newsletter content item IDs must be unique")
        if len(positions) != len(set(positions)) or sorted(positions) != list(
            range(1, len(items) + 1)
        ):
            raise ValueError("newsletter positions must be unique and contiguous from 1")

    def _validate_newsletter_decisions(self, items: list[NewsletterItemInput]) -> None:
        for item in items:
            decision = self.session.get(AnalysisResult, item.decision_id)
            if decision is None:
                raise ValueError(f"analysis decision {item.decision_id} not found")
            if decision.content_item_id != item.content_item_id:
                raise ValueError(
                    f"analysis decision {item.decision_id} does not belong to "
                    f"content item {item.content_item_id}"
                )

    def start_agent_run(
        self,
        *,
        content_item_id: int,
        preference_snapshot_id: int,
        prompt_version: str,
        model: str,
        input_hash: str,
        status: str = AgentRunStatus.RUNNING,
        error_category: str | None = None,
    ) -> AgentRun:
        valid_status = require_status(status, AgentRunStatus)
        existing = self.session.scalar(
            select(AgentRun).where(
                AgentRun.content_item_id == content_item_id,
                AgentRun.preference_snapshot_id == preference_snapshot_id,
                AgentRun.prompt_version == prompt_version,
                AgentRun.model == model,
                AgentRun.input_hash == input_hash,
            )
        )
        if existing is not None:
            return existing
        run = AgentRun(
            content_item_id=content_item_id,
            preference_snapshot_id=preference_snapshot_id,
            prompt_version=prompt_version,
            model=model,
            input_hash=input_hash,
            status=valid_status,
            error_category=error_category,
        )
        self.session.add(run)
        self.session.commit()
        return run

    def complete_agent_run(
        self,
        agent_run_id: int,
        *,
        semantic_output: dict[str, object],
        latency_ms: int,
        input_tokens: int,
        output_tokens: int,
        cost_usd: str | Decimal,
        error_category: str | None = None,
    ) -> AgentRun:
        run = self._get_agent_run(agent_run_id)
        if run.status == AgentRunStatus.SUCCEEDED.value:
            return run
        if run.status == AgentRunStatus.FAILED.value:
            raise ValueError(f"agent run {agent_run_id} is terminal failed")
        run.status = AgentRunStatus.SUCCEEDED.value
        run.semantic_output = semantic_output
        run.latency_ms = latency_ms
        run.input_tokens = input_tokens
        run.output_tokens = output_tokens
        run.cost_usd = Decimal(cost_usd)
        run.finished_at = utc_now()
        run.error_message = None
        run.error_category = error_category
        self.session.commit()
        return run

    def fail_agent_run(
        self, agent_run_id: int, error_message: str, *, error_category: str | None = None
    ) -> AgentRun:
        self.session.rollback()
        run = self._get_agent_run(agent_run_id)
        if run.status == AgentRunStatus.FAILED.value:
            return run
        if run.status == AgentRunStatus.SUCCEEDED.value:
            raise ValueError(f"agent run {agent_run_id} is terminal succeeded")
        run.status = AgentRunStatus.FAILED.value
        run.error_message = error_message
        run.error_category = error_category
        run.finished_at = utc_now()
        self.session.commit()
        return run

    def _get_agent_run(self, agent_run_id: int) -> AgentRun:
        run = self.session.get(AgentRun, agent_run_id)
        if run is None:
            raise LookupError(f"agent run {agent_run_id} not found")
        return run

    def add_tool_call_trace(
        self,
        *,
        agent_run_id: int,
        sequence: int,
        tool_name: str,
        argument_summary: str,
        argument_hash: str,
        status: str,
        latency_ms: int | None = None,
        result_summary: str | None = None,
        error_message: str | None = None,
        error_category: str | None = None,
    ) -> ToolCallTrace:
        valid_status = require_status(status, AgentRunStatus)
        trace = self.session.scalar(
            select(ToolCallTrace).where(
                ToolCallTrace.agent_run_id == agent_run_id,
                ToolCallTrace.sequence == sequence,
            )
        )
        if trace is None:
            trace = ToolCallTrace(agent_run_id=agent_run_id, sequence=sequence)
            self.session.add(trace)
        trace.tool_name = tool_name
        trace.argument_summary = argument_summary
        trace.argument_hash = argument_hash
        trace.status = valid_status
        trace.latency_ms = latency_ms
        trace.result_summary = result_summary
        trace.error_message = error_message
        trace.error_category = error_category
        self.session.commit()
        return trace

    def list_tool_call_traces(self, agent_run_id: int) -> list[ToolCallTrace]:
        return list(
            self.session.scalars(
                select(ToolCallTrace)
                .where(ToolCallTrace.agent_run_id == agent_run_id)
                .order_by(ToolCallTrace.sequence)
            )
        )

    def start_job_run(self, job_type: str, status: str = JobRunStatus.RUNNING) -> JobRun:
        valid_status = require_status(status, JobRunStatus)
        run = JobRun(job_type=job_type, status=valid_status)
        self.session.add(run)
        self.session.commit()
        return run

    def add_job_event(
        self,
        job_run_id: int,
        level: str,
        message: str,
        *,
        details: dict[str, object] | None = None,
    ) -> JobEvent:
        event = JobEvent(
            job_run_id=job_run_id,
            level=level,
            message=message,
            details=details or {},
        )
        self.session.add(event)
        self.session.commit()
        return event

    def complete_job_run(self, job_run_id: int) -> JobRun:
        run = self._get_job_run(job_run_id)
        if run.status == JobRunStatus.SUCCEEDED.value:
            return run
        if run.status == JobRunStatus.FAILED.value:
            raise ValueError(f"job run {job_run_id} is terminal failed")
        run.status = JobRunStatus.SUCCEEDED.value
        run.finished_at = utc_now()
        run.error_message = None
        self.session.commit()
        return run

    def fail_job_run(
        self,
        job_run_id: int,
        error_message: str,
        *,
        details: dict[str, object] | None = None,
    ) -> JobRun:
        self.session.rollback()
        run = self._get_job_run(job_run_id)
        if run.status == JobRunStatus.FAILED.value:
            return run
        if run.status == JobRunStatus.SUCCEEDED.value:
            raise ValueError(f"job run {job_run_id} is terminal succeeded")
        run.status = JobRunStatus.FAILED.value
        run.finished_at = utc_now()
        run.error_message = error_message
        run.events.append(JobEvent(level="error", message=error_message, details=details or {}))
        self.session.commit()
        return run

    def _get_job_run(self, job_run_id: int) -> JobRun:
        run = self.session.get(JobRun, job_run_id)
        if run is None:
            raise LookupError(f"job run {job_run_id} not found")
        return run

    def list_job_events(self, job_run_id: int) -> list[JobEvent]:
        return list(
            self.session.scalars(
                select(JobEvent).where(JobEvent.job_run_id == job_run_id).order_by(JobEvent.id)
            )
        )
