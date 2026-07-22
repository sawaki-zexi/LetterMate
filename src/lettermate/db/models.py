import sqlite3
from datetime import UTC, date, datetime
from decimal import Decimal

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    event,
    inspect,
)
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

from lettermate.db.statuses import (
    AgentRunStatus,
    ContentItemStatus,
    JobRunStatus,
    NewsletterStatus,
    SourceStatus,
)


def utc_now() -> datetime:
    return datetime.now(UTC)


class Base(DeclarativeBase):
    pass


@event.listens_for(Engine, "connect")
def _enable_sqlite_foreign_keys(dbapi_connection: object, _connection_record: object) -> None:
    if isinstance(dbapi_connection, sqlite3.Connection):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()


class Source(Base):
    __tablename__ = "sources"
    __table_args__ = (
        UniqueConstraint("url", name="uq_sources_url"),
        UniqueConstraint("normalized_url", name="uq_sources_normalized_url"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    platform: Mapped[str] = mapped_column(String(50), nullable=False)
    source_type: Mapped[str] = mapped_column(String(50), nullable=False)
    url: Mapped[str] = mapped_column(Text, nullable=False)
    normalized_url: Mapped[str | None] = mapped_column(Text)
    tags: Mapped[list[str]] = mapped_column(JSON, default=list)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    status: Mapped[str] = mapped_column(String(50), default=SourceStatus.ACTIVE.value)
    fetch_interval_minutes: Mapped[int] = mapped_column(Integer, default=1440)
    last_fetched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now
    )

    items: Mapped[list["ContentItem"]] = relationship(back_populates="source")


class ContentItem(Base):
    __tablename__ = "content_items"
    __table_args__ = (
        UniqueConstraint("url", name="uq_content_items_url"),
        UniqueConstraint("normalized_url", name="uq_content_items_normalized_url"),
        UniqueConstraint("source_id", "external_id", name="uq_content_items_source_external_id"),
        UniqueConstraint("content_hash", name="uq_content_items_hash"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    source_id: Mapped[int] = mapped_column(ForeignKey("sources.id"), nullable=False)
    external_id: Mapped[str | None] = mapped_column(String(300))
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    url: Mapped[str] = mapped_column(Text, nullable=False)
    normalized_url: Mapped[str] = mapped_column(Text, nullable=False)
    author: Mapped[str] = mapped_column(String(200), default="")
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    raw_content: Mapped[str] = mapped_column(Text, default="")
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(
        String(50), default=ContentItemStatus.PENDING_ANALYSIS.value
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now
    )

    source: Mapped[Source] = relationship(back_populates="items")
    analysis: Mapped["AnalysisResult | None"] = relationship(back_populates="item")
    agent_runs: Mapped[list["AgentRun"]] = relationship(back_populates="content_item")
    newsletter_memberships: Mapped[list["NewsletterItem"]] = relationship(
        back_populates="content_item"
    )


class PreferenceSnapshot(Base):
    __tablename__ = "preference_snapshots"
    __table_args__ = (CheckConstraint("version > 0", name="ck_preference_snapshots_version"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False, unique=True)
    explicit_interests: Mapped[list[str]] = mapped_column(JSON, default=list)
    exclusions: Mapped[list[str]] = mapped_column(JSON, default=list)
    tag_weights: Mapped[dict[str, int]] = mapped_column(JSON, default=dict)
    source_weights: Mapped[dict[str, int]] = mapped_column(JSON, default=dict)
    feedback_cutoff: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)

    agent_runs: Mapped[list["AgentRun"]] = relationship(back_populates="preference_snapshot")


@event.listens_for(PreferenceSnapshot, "before_update")
def _prevent_preference_snapshot_update(
    _mapper: object, _connection: object, target: PreferenceSnapshot
) -> None:
    state = inspect(target)
    assert state is not None
    column_changed = any(
        state.attrs[column.key].history.has_changes() for column in state.mapper.column_attrs
    )
    if column_changed:
        raise ValueError("PreferenceSnapshot records are immutable")


class AgentRun(Base):
    __tablename__ = "agent_runs"
    __table_args__ = (
        UniqueConstraint(
            "content_item_id",
            "preference_snapshot_id",
            "prompt_version",
            "model",
            "input_hash",
            name="uq_agent_runs_input_identity",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    content_item_id: Mapped[int] = mapped_column(ForeignKey("content_items.id"), nullable=False)
    preference_snapshot_id: Mapped[int] = mapped_column(
        ForeignKey("preference_snapshots.id"), nullable=False
    )
    prompt_version: Mapped[str] = mapped_column(String(100), nullable=False)
    model: Mapped[str] = mapped_column(String(200), nullable=False)
    input_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(50), default=AgentRunStatus.RUNNING.value)
    error_message: Mapped[str | None] = mapped_column(Text)
    error_category: Mapped[str | None] = mapped_column(String(100))
    semantic_output: Mapped[dict[str, object] | None] = mapped_column(JSON)
    latency_ms: Mapped[int | None] = mapped_column(Integer)
    input_tokens: Mapped[int | None] = mapped_column(Integer)
    output_tokens: Mapped[int | None] = mapped_column(Integer)
    cost_usd: Mapped[Decimal | None] = mapped_column(Numeric(12, 6))
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)

    content_item: Mapped[ContentItem] = relationship(back_populates="agent_runs")
    preference_snapshot: Mapped[PreferenceSnapshot] = relationship(back_populates="agent_runs")
    analysis: Mapped["AnalysisResult | None"] = relationship(back_populates="agent_run")
    tool_traces: Mapped[list["ToolCallTrace"]] = relationship(
        back_populates="agent_run", order_by="ToolCallTrace.sequence", cascade="all, delete-orphan"
    )


class ToolCallTrace(Base):
    __tablename__ = "tool_call_traces"
    __table_args__ = (
        UniqueConstraint("agent_run_id", "sequence", name="uq_tool_call_traces_run_sequence"),
        CheckConstraint("sequence > 0", name="ck_tool_call_traces_sequence"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    agent_run_id: Mapped[int] = mapped_column(ForeignKey("agent_runs.id"), nullable=False)
    sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    tool_name: Mapped[str] = mapped_column(String(100), nullable=False)
    argument_summary: Mapped[str] = mapped_column(Text, nullable=False)
    argument_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(50), nullable=False)
    latency_ms: Mapped[int | None] = mapped_column(Integer)
    result_summary: Mapped[str | None] = mapped_column(Text)
    error_message: Mapped[str | None] = mapped_column(Text)
    error_category: Mapped[str | None] = mapped_column(String(100))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)

    agent_run: Mapped[AgentRun] = relationship(back_populates="tool_traces")


class AnalysisResult(Base):
    __tablename__ = "analysis_results"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    content_item_id: Mapped[int] = mapped_column(
        ForeignKey("content_items.id"), nullable=False, unique=True
    )
    agent_run_id: Mapped[int] = mapped_column(
        ForeignKey("agent_runs.id"), nullable=False, unique=True
    )
    summary: Mapped[str] = mapped_column(Text, nullable=False)
    tags: Mapped[list[str]] = mapped_column(JSON, default=list)
    score: Mapped[int] = mapped_column(Integer, nullable=False)
    reason: Mapped[str] = mapped_column(Text, default="")
    actionable_insight: Mapped[str] = mapped_column(Text, default="")
    should_include: Mapped[bool] = mapped_column(Boolean, default=False)
    model: Mapped[str] = mapped_column(String(100), nullable=False)
    semantic_score: Mapped[float] = mapped_column(Float, nullable=False)
    preference_boost: Mapped[float] = mapped_column(Float, default=0.0)
    freshness_bonus: Mapped[float] = mapped_column(Float, default=0.0)
    repetition_penalty: Mapped[float] = mapped_column(Float, default=0.0)
    source_diversity_adjustment: Mapped[float] = mapped_column(Float, default=0.0)
    final_score: Mapped[float] = mapped_column(Float, nullable=False)
    decision: Mapped[str] = mapped_column(String(50), nullable=False)
    analyzed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)

    item: Mapped[ContentItem] = relationship(back_populates="analysis")
    agent_run: Mapped[AgentRun] = relationship(back_populates="analysis")
    newsletter_memberships: Mapped[list["NewsletterItem"]] = relationship(back_populates="decision")


class Newsletter(Base):
    __tablename__ = "newsletters"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    issue_date: Mapped[date] = mapped_column(Date, nullable=False, unique=True)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    markdown_body: Mapped[str] = mapped_column(Text, nullable=False)
    html_body: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(50), default=NewsletterStatus.DRAFT.value)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now
    )

    items: Mapped[list["NewsletterItem"]] = relationship(
        back_populates="newsletter",
        order_by="NewsletterItem.position",
        cascade="all, delete-orphan",
    )


class NewsletterItem(Base):
    __tablename__ = "newsletter_items"
    __table_args__ = (
        UniqueConstraint("newsletter_id", "content_item_id", name="uq_newsletter_items_member"),
        UniqueConstraint("newsletter_id", "position", name="uq_newsletter_items_position"),
        CheckConstraint("position > 0", name="ck_newsletter_items_position"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    newsletter_id: Mapped[int] = mapped_column(ForeignKey("newsletters.id"), nullable=False)
    content_item_id: Mapped[int] = mapped_column(ForeignKey("content_items.id"), nullable=False)
    decision_id: Mapped[int] = mapped_column(ForeignKey("analysis_results.id"), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    section: Mapped[str] = mapped_column(String(100), nullable=False)
    final_score: Mapped[float] = mapped_column(Float, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)

    newsletter: Mapped[Newsletter] = relationship(back_populates="items")
    content_item: Mapped[ContentItem] = relationship(back_populates="newsletter_memberships")
    decision: Mapped[AnalysisResult] = relationship(back_populates="newsletter_memberships")


class Feedback(Base):
    __tablename__ = "feedback"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    content_item_id: Mapped[int] = mapped_column(ForeignKey("content_items.id"), nullable=False)
    feedback_type: Mapped[str] = mapped_column(String(50), nullable=False)
    note: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class JobRun(Base):
    __tablename__ = "job_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    job_type: Mapped[str] = mapped_column(String(100), nullable=False)
    status: Mapped[str] = mapped_column(String(50), default=JobRunStatus.RUNNING.value)
    error_message: Mapped[str | None] = mapped_column(Text)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    events: Mapped[list["JobEvent"]] = relationship(
        back_populates="job_run", order_by="JobEvent.id", cascade="all, delete-orphan"
    )


class JobEvent(Base):
    __tablename__ = "job_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    job_run_id: Mapped[int] = mapped_column(ForeignKey("job_runs.id"), nullable=False)
    level: Mapped[str] = mapped_column(String(20), nullable=False)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    details: Mapped[dict[str, object]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)

    job_run: Mapped[JobRun] = relationship(back_populates="events")
