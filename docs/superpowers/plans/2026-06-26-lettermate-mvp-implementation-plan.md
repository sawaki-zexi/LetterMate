# LetterMate MVP Implementation Plan

> **Superseded on 2026-07-21:** This plan has been replaced in full by
> `docs/superpowers/plans/2026-07-21-lettermate-mvp-vertical-slice-v2.md`.
> Keep this file only as planning history; do not execute its tasks.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the LetterMate MVP: a single-user Personal Intelligence Agent that collects RSS/RSSHub content, deduplicates and cleans items, produces structured LLM summaries and value scores, generates a daily newsletter, sends it by email, and exposes a lightweight dashboard/API for demo and resume use.

**Architecture:** Use a modular Python/FastAPI monolith with clear internal boundaries: configuration, persistence, collectors, analysis agent, newsletter builder, notifier, API, dashboard, CLI, and scheduled jobs. Store state in SQLite through SQLAlchemy, keep LLM and email integrations behind interfaces, and make the full MVP runnable locally with Docker Compose.

**Tech Stack:** Python 3.12, FastAPI, Typer, SQLAlchemy, SQLite, Pydantic, feedparser, BeautifulSoup, APScheduler, Jinja2, pytest, ruff, mypy, Docker Compose.

---

## Scope

This plan implements the first resume-ready MVP only:

- RSS/Atom and RSSHub source collection.
- Content normalization, cleaning, and deduplication.
- SQLite persistence for sources, content items, analysis results, newsletters, feedback, and job logs.
- Structured LLM analysis through a provider interface with a deterministic fake provider for tests.
- Daily newsletter generation as Markdown and HTML.
- SMTP email sending with dry-run support.
- FastAPI endpoints and a simple server-rendered dashboard.
- Typer CLI commands for local demos.
- APScheduler jobs for scheduled collection, analysis, newsletter generation, and email sending.
- Docker Compose and README updates.

Not included in this MVP:

- Full 小红书 scraping.
- 任意微信公众号关注列表同步.
- X API integration.
- Multi-user auth.
- Vector database or RAG knowledge base.
- LangGraph workflow. The code should leave an upgrade path but not depend on LangGraph in this MVP.

## Target File Structure

Create this project layout:

```text
D:\LetterMate
├── .env.example
├── .gitignore
├── Dockerfile
├── README.md
├── docker-compose.yml
├── pyproject.toml
├── configs
│   ├── preferences.example.yaml
│   └── sources.example.yaml
├── docs
│   ├── newsletter-assistant-tech-selection.md
│   ├── project-proposal-and-architecture.md
│   └── superpowers
│       └── plans
│           └── 2026-06-26-lettermate-mvp-implementation-plan.md
├── src
│   └── lettermate
│       ├── __init__.py
│       ├── api
│       │   ├── __init__.py
│       │   ├── app.py
│       │   ├── deps.py
│       │   └── routes.py
│       ├── cli.py
│       ├── config.py
│       ├── dashboard
│       │   ├── __init__.py
│       │   ├── routes.py
│       │   └── templates
│       │       ├── base.html
│       │       ├── index.html
│       │       ├── items.html
│       │       ├── newsletters.html
│       │       └── sources.html
│       ├── db
│       │   ├── __init__.py
│       │   ├── models.py
│       │   ├── repository.py
│       │   └── session.py
│       ├── jobs
│       │   ├── __init__.py
│       │   ├── runner.py
│       │   └── scheduler.py
│       ├── llm
│       │   ├── __init__.py
│       │   ├── prompts.py
│       │   ├── provider.py
│       │   └── schemas.py
│       ├── newsletters
│       │   ├── __init__.py
│       │   └── builder.py
│       ├── notifiers
│       │   ├── __init__.py
│       │   └── email.py
│       ├── sources
│       │   ├── __init__.py
│       │   ├── cleaner.py
│       │   ├── collector.py
│       │   └── config_loader.py
│       └── web
│           └── static
│               └── styles.css
└── tests
    ├── conftest.py
    ├── fixtures
    │   └── sample-feed.xml
    ├── test_api.py
    ├── test_collectors.py
    ├── test_config_loader.py
    ├── test_models.py
    ├── test_newsletter_builder.py
    └── test_repository.py
```

## Development Rules

- Use TDD for core behavior: write a failing test, run it, implement, then rerun.
- Use deterministic fake services in tests. Do not call real LLM APIs or SMTP servers in tests.
- Every persisted item must have a stable status field so jobs can resume safely.
- Every external integration must have a dry-run or fake mode.
- Keep modules small and focused. Avoid putting business logic inside route handlers.
- Commit after each task when this directory is initialized as a Git repository.

## Task 1: Project Scaffold and Tooling

**Files:**
- Create: `pyproject.toml`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `README.md`
- Create: `src/lettermate/__init__.py`
- Create: `src/lettermate/config.py`
- Create: `tests/conftest.py`

- [ ] **Step 1: Create dependency and tooling configuration**

Add `pyproject.toml`:

```toml
[project]
name = "lettermate"
version = "0.1.0"
description = "Personal Intelligence Agent for multi-source newsletter generation"
requires-python = ">=3.12"
dependencies = [
  "apscheduler>=3.10.4",
  "beautifulsoup4>=4.12.3",
  "email-validator>=2.2.0",
  "fastapi>=0.115.0",
  "feedparser>=6.0.11",
  "jinja2>=3.1.4",
  "pydantic>=2.8.0",
  "pydantic-settings>=2.4.0",
  "python-dotenv>=1.0.1",
  "pyyaml>=6.0.2",
  "sqlalchemy>=2.0.32",
  "typer>=0.12.5",
  "uvicorn>=0.30.6"
]

[project.optional-dependencies]
dev = [
  "httpx>=0.27.2",
  "mypy>=1.11.2",
  "pytest>=8.3.2",
  "pytest-cov>=5.0.0",
  "ruff>=0.6.3"
]

[project.scripts]
lettermate = "lettermate.cli:app"

[build-system]
requires = ["setuptools>=72.0.0"]
build-backend = "setuptools.build_meta"

[tool.setuptools.packages.find]
where = ["src"]

[tool.pytest.ini_options]
testpaths = ["tests"]
pythonpath = ["src"]
addopts = "-q"

[tool.ruff]
line-length = 100
target-version = "py312"

[tool.ruff.lint]
select = ["E", "F", "I", "UP", "B"]

[tool.mypy]
python_version = "3.12"
strict = true
ignore_missing_imports = true
```

- [ ] **Step 2: Add environment example**

Add `.env.example`:

```env
DATABASE_URL=sqlite:///./data/lettermate.db
APP_ENV=local
LOG_LEVEL=INFO

LLM_PROVIDER=fake
LLM_MODEL=fake-local
OPENAI_API_KEY=

SMTP_HOST=localhost
SMTP_PORT=1025
SMTP_USERNAME=
SMTP_PASSWORD=
SMTP_FROM=lettermate@example.com
SMTP_TO=you@example.com
SMTP_USE_TLS=false
EMAIL_DRY_RUN=true
```

- [ ] **Step 3: Add Python settings model**

Add `src/lettermate/config.py`:

```python
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str = Field(default="sqlite:///./data/lettermate.db")
    app_env: str = Field(default="local")
    log_level: str = Field(default="INFO")

    llm_provider: str = Field(default="fake")
    llm_model: str = Field(default="fake-local")
    openai_api_key: str = Field(default="")

    smtp_host: str = Field(default="localhost")
    smtp_port: int = Field(default=1025)
    smtp_username: str = Field(default="")
    smtp_password: str = Field(default="")
    smtp_from: str = Field(default="lettermate@example.com")
    smtp_to: str = Field(default="you@example.com")
    smtp_use_tls: bool = Field(default=False)
    email_dry_run: bool = Field(default=True)

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")


def get_settings() -> Settings:
    return Settings()
```

- [ ] **Step 4: Add test fixture for settings**

Add `tests/conftest.py`:

```python
from collections.abc import Iterator
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from lettermate.db.models import Base


@pytest.fixture()
def temp_db_session(tmp_path: Path) -> Iterator[Session]:
    db_path = tmp_path / "test.db"
    engine = create_engine(f"sqlite:///{db_path}", future=True)
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)
    with session_factory() as session:
        yield session
```

This fixture imports models created in Task 2, so the full test suite will pass after Task 2.

- [ ] **Step 5: Verify tooling installation**

Run:

```powershell
python -m pip install -e ".[dev]"
python -m pytest
```

Expected after Task 1 only: pytest may fail because `lettermate.db.models` is created in Task 2. This is acceptable only before Task 2. After Task 2, the command must exit with code 0.

## Task 2: Database Models and Session Management

**Files:**
- Create: `src/lettermate/db/__init__.py`
- Create: `src/lettermate/db/models.py`
- Create: `src/lettermate/db/session.py`
- Create: `tests/test_models.py`

- [ ] **Step 1: Write model creation test**

Add `tests/test_models.py`:

```python
from datetime import UTC, datetime

from lettermate.db.models import AnalysisResult, ContentItem, Newsletter, Source


def test_create_source_content_analysis_and_newsletter(temp_db_session):
    source = Source(
        name="Example Blog",
        platform="blog",
        source_type="rss",
        url="https://example.com/feed.xml",
        tags=["AI", "Career"],
        enabled=True,
    )
    temp_db_session.add(source)
    temp_db_session.flush()

    item = ContentItem(
        source_id=source.id,
        external_id="entry-1",
        title="Agent engineering notes",
        url="https://example.com/agent",
        author="Example Author",
        published_at=datetime(2026, 6, 26, tzinfo=UTC),
        raw_content="Useful article about agent engineering.",
        content_hash="hash-1",
        status="pending_analysis",
    )
    temp_db_session.add(item)
    temp_db_session.flush()

    analysis = AnalysisResult(
        content_item_id=item.id,
        summary="A short summary.",
        tags=["AI"],
        score=4,
        reason="Relevant to agent engineering.",
        actionable_insight="Add evaluation metrics to the project.",
        should_include=True,
        model="fake-local",
    )
    temp_db_session.add(analysis)

    newsletter = Newsletter(
        issue_date=datetime(2026, 6, 26, tzinfo=UTC).date(),
        title="LetterMate Daily - 2026-06-26",
        markdown_body="# Daily",
        html_body="<h1>Daily</h1>",
        status="draft",
    )
    temp_db_session.add(newsletter)
    temp_db_session.commit()

    assert source.id is not None
    assert item.id is not None
    assert analysis.id is not None
    assert newsletter.id is not None
```

- [ ] **Step 2: Run test to verify failure**

Run:

```powershell
python -m pytest tests/test_models.py -q
```

Expected: FAIL with import errors because `lettermate.db.models` is not implemented yet.

- [ ] **Step 3: Implement SQLAlchemy models**

Add `src/lettermate/db/models.py`:

```python
from datetime import UTC, date, datetime

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship
from sqlalchemy.types import JSON


def utc_now() -> datetime:
    return datetime.now(UTC)


class Base(DeclarativeBase):
    pass


class Source(Base):
    __tablename__ = "sources"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    platform: Mapped[str] = mapped_column(String(50), nullable=False)
    source_type: Mapped[str] = mapped_column(String(50), nullable=False)
    url: Mapped[str] = mapped_column(Text, nullable=False)
    tags: Mapped[list[str]] = mapped_column(JSON, default=list)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
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
        UniqueConstraint("content_hash", name="uq_content_items_hash"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    source_id: Mapped[int] = mapped_column(ForeignKey("sources.id"), nullable=False)
    external_id: Mapped[str] = mapped_column(String(300), default="")
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    url: Mapped[str] = mapped_column(Text, nullable=False)
    author: Mapped[str] = mapped_column(String(200), default="")
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    raw_content: Mapped[str] = mapped_column(Text, default="")
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(50), default="pending_analysis")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now
    )

    source: Mapped[Source] = relationship(back_populates="items")
    analysis: Mapped["AnalysisResult | None"] = relationship(back_populates="item")


class AnalysisResult(Base):
    __tablename__ = "analysis_results"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    content_item_id: Mapped[int] = mapped_column(ForeignKey("content_items.id"), unique=True)
    summary: Mapped[str] = mapped_column(Text, nullable=False)
    tags: Mapped[list[str]] = mapped_column(JSON, default=list)
    score: Mapped[int] = mapped_column(Integer, nullable=False)
    reason: Mapped[str] = mapped_column(Text, default="")
    actionable_insight: Mapped[str] = mapped_column(Text, default="")
    should_include: Mapped[bool] = mapped_column(Boolean, default=False)
    model: Mapped[str] = mapped_column(String(100), nullable=False)
    analyzed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)

    item: Mapped[ContentItem] = relationship(back_populates="analysis")


class Newsletter(Base):
    __tablename__ = "newsletters"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    issue_date: Mapped[date] = mapped_column(Date, nullable=False, unique=True)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    markdown_body: Mapped[str] = mapped_column(Text, nullable=False)
    html_body: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(50), default="draft")
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


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
    status: Mapped[str] = mapped_column(String(50), nullable=False)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class JobEvent(Base):
    __tablename__ = "job_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    job_run_id: Mapped[int] = mapped_column(ForeignKey("job_runs.id"), nullable=False)
    level: Mapped[str] = mapped_column(String(20), nullable=False)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
```

Add `src/lettermate/db/session.py`:

```python
from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from lettermate.config import Settings, get_settings
from lettermate.db.models import Base


def create_session_factory(settings: Settings | None = None) -> sessionmaker[Session]:
    resolved = settings or get_settings()
    engine = create_engine(resolved.database_url, future=True)
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, expire_on_commit=False, future=True)


def get_session() -> Iterator[Session]:
    session_factory = create_session_factory()
    with session_factory() as session:
        yield session
```

Add `src/lettermate/db/__init__.py`:

```python
from lettermate.db.models import (
    AnalysisResult,
    Base,
    ContentItem,
    Feedback,
    JobEvent,
    JobRun,
    Newsletter,
    Source,
)

__all__ = [
    "AnalysisResult",
    "Base",
    "ContentItem",
    "Feedback",
    "JobEvent",
    "JobRun",
    "Newsletter",
    "Source",
]
```

- [ ] **Step 4: Run model tests**

Run:

```powershell
python -m pytest tests/test_models.py -q
```

Expected: PASS.

## Task 3: Repository Layer

**Files:**
- Create: `src/lettermate/db/repository.py`
- Create: `tests/test_repository.py`

- [ ] **Step 1: Write repository tests**

Add `tests/test_repository.py`:

```python
from lettermate.db.models import Source
from lettermate.db.repository import ContentInput, Repository


def test_repository_creates_source_and_skips_duplicate_content(temp_db_session):
    repo = Repository(temp_db_session)
    source = repo.create_source(
        name="Example",
        platform="blog",
        source_type="rss",
        url="https://example.com/feed.xml",
        tags=["AI"],
    )

    item_input = ContentInput(
        source_id=source.id,
        external_id="entry-1",
        title="Title",
        url="https://example.com/post",
        author="Author",
        published_at=None,
        raw_content="Body",
    )

    first = repo.upsert_content_item(item_input)
    second = repo.upsert_content_item(item_input)

    assert first.id == second.id
    assert repo.count_content_items() == 1


def test_repository_lists_pending_analysis_items(temp_db_session):
    repo = Repository(temp_db_session)
    source = Source(
        name="Example",
        platform="blog",
        source_type="rss",
        url="https://example.com/feed.xml",
        tags=[],
        enabled=True,
    )
    temp_db_session.add(source)
    temp_db_session.flush()

    repo.upsert_content_item(
        ContentInput(
            source_id=source.id,
            external_id="entry-1",
            title="Title",
            url="https://example.com/post",
            author="Author",
            published_at=None,
            raw_content="Body",
        )
    )

    pending = repo.list_pending_analysis_items(limit=10)

    assert len(pending) == 1
    assert pending[0].status == "pending_analysis"
```

- [ ] **Step 2: Run test to verify failure**

Run:

```powershell
python -m pytest tests/test_repository.py -q
```

Expected: FAIL because `Repository` is not implemented.

- [ ] **Step 3: Implement repository**

Add `src/lettermate/db/repository.py`:

```python
from dataclasses import dataclass
from datetime import datetime
from hashlib import sha256

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from lettermate.db.models import AnalysisResult, ContentItem, Newsletter, Source


@dataclass(frozen=True)
class ContentInput:
    source_id: int
    external_id: str
    title: str
    url: str
    author: str
    published_at: datetime | None
    raw_content: str


def make_content_hash(title: str, url: str, raw_content: str) -> str:
    payload = f"{title.strip()}|{url.strip()}|{raw_content.strip()}".encode("utf-8")
    return sha256(payload).hexdigest()


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
    ) -> Source:
        source = Source(
            name=name,
            platform=platform,
            source_type=source_type,
            url=url,
            tags=tags,
            enabled=enabled,
        )
        self.session.add(source)
        self.session.commit()
        return source

    def list_enabled_sources(self) -> list[Source]:
        statement = select(Source).where(Source.enabled.is_(True)).order_by(Source.id)
        return list(self.session.scalars(statement))

    def upsert_content_item(self, item: ContentInput) -> ContentItem:
        content_hash = make_content_hash(item.title, item.url, item.raw_content)
        existing = self.session.scalar(select(ContentItem).where(ContentItem.url == item.url))
        if existing is not None:
            return existing

        model = ContentItem(
            source_id=item.source_id,
            external_id=item.external_id,
            title=item.title,
            url=item.url,
            author=item.author,
            published_at=item.published_at,
            raw_content=item.raw_content,
            content_hash=content_hash,
            status="pending_analysis",
        )
        self.session.add(model)
        try:
            self.session.commit()
        except IntegrityError:
            self.session.rollback()
            duplicate = self.session.scalar(
                select(ContentItem).where(ContentItem.content_hash == content_hash)
            )
            if duplicate is None:
                duplicate = self.session.scalar(select(ContentItem).where(ContentItem.url == item.url))
            if duplicate is None:
                raise
            return duplicate
        return model

    def count_content_items(self) -> int:
        return len(list(self.session.scalars(select(ContentItem.id))))

    def list_pending_analysis_items(self, limit: int) -> list[ContentItem]:
        statement = (
            select(ContentItem)
            .where(ContentItem.status == "pending_analysis")
            .order_by(ContentItem.created_at)
            .limit(limit)
        )
        return list(self.session.scalars(statement))

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
    ) -> AnalysisResult:
        analysis = AnalysisResult(
            content_item_id=item.id,
            summary=summary,
            tags=tags,
            score=score,
            reason=reason,
            actionable_insight=actionable_insight,
            should_include=should_include,
            model=model,
        )
        item.status = "analyzed"
        self.session.add(analysis)
        self.session.commit()
        return analysis

    def save_newsletter(
        self,
        issue_date,
        title: str,
        markdown_body: str,
        html_body: str,
        status: str,
    ) -> Newsletter:
        newsletter = Newsletter(
            issue_date=issue_date,
            title=title,
            markdown_body=markdown_body,
            html_body=html_body,
            status=status,
        )
        self.session.add(newsletter)
        self.session.commit()
        return newsletter
```

- [ ] **Step 4: Run repository tests**

Run:

```powershell
python -m pytest tests/test_repository.py -q
```

Expected: PASS.

## Task 4: Source Configuration Loader

**Files:**
- Create: `configs/sources.example.yaml`
- Create: `configs/preferences.example.yaml`
- Create: `src/lettermate/sources/__init__.py`
- Create: `src/lettermate/sources/config_loader.py`
- Create: `tests/test_config_loader.py`

- [ ] **Step 1: Write config loader tests**

Add `tests/test_config_loader.py`:

```python
from pathlib import Path

from lettermate.sources.config_loader import load_preferences, load_sources


def test_load_sources_from_yaml(tmp_path: Path):
    path = tmp_path / "sources.yaml"
    path.write_text(
        """
sources:
  - name: Example Blog
    platform: blog
    type: rss
    url: https://example.com/feed.xml
    tags: [AI, Career]
    enabled: true
""",
        encoding="utf-8",
    )

    sources = load_sources(path)

    assert len(sources) == 1
    assert sources[0].name == "Example Blog"
    assert sources[0].source_type == "rss"
    assert sources[0].tags == ["AI", "Career"]


def test_load_preferences_defaults(tmp_path: Path):
    path = tmp_path / "preferences.yaml"
    path.write_text(
        """
profile:
  interests:
    - agent engineering
newsletter:
  max_items: 8
""",
        encoding="utf-8",
    )

    preferences = load_preferences(path)

    assert preferences.profile.interests == ["agent engineering"]
    assert preferences.newsletter.max_items == 8
    assert preferences.newsletter.min_score_to_include == 4
```

- [ ] **Step 2: Run test to verify failure**

Run:

```powershell
python -m pytest tests/test_config_loader.py -q
```

Expected: FAIL because config loader is not implemented.

- [ ] **Step 3: Implement YAML config loader**

Add `src/lettermate/sources/config_loader.py`:

```python
from pathlib import Path

import yaml
from pydantic import BaseModel, Field, HttpUrl


class SourceConfig(BaseModel):
    name: str
    platform: str
    source_type: str = Field(alias="type")
    url: HttpUrl
    tags: list[str] = Field(default_factory=list)
    enabled: bool = True


class SourcesFile(BaseModel):
    sources: list[SourceConfig]


class ProfilePreferences(BaseModel):
    interests: list[str] = Field(default_factory=list)
    exclude: list[str] = Field(default_factory=list)


class NewsletterPreferences(BaseModel):
    schedule: str = "08:30"
    max_items: int = 10
    language: str = "zh-CN"
    min_score_to_include: int = 4


class Preferences(BaseModel):
    profile: ProfilePreferences = Field(default_factory=ProfilePreferences)
    newsletter: NewsletterPreferences = Field(default_factory=NewsletterPreferences)


def read_yaml(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as file:
        data = yaml.safe_load(file) or {}
    if not isinstance(data, dict):
        raise ValueError(f"YAML root must be an object: {path}")
    return data


def load_sources(path: Path) -> list[SourceConfig]:
    return SourcesFile.model_validate(read_yaml(path)).sources


def load_preferences(path: Path) -> Preferences:
    return Preferences.model_validate(read_yaml(path))
```

Add `src/lettermate/sources/__init__.py`:

```python
from lettermate.sources.config_loader import Preferences, SourceConfig, load_preferences, load_sources

__all__ = ["Preferences", "SourceConfig", "load_preferences", "load_sources"]
```

Add `configs/sources.example.yaml`:

```yaml
sources:
  - name: OpenAI Blog
    platform: blog
    type: rss
    url: https://openai.com/news/rss.xml
    tags: [AI, LLM]
    enabled: true
  - name: Bilibili UP Video Feed
    platform: bilibili
    type: rsshub
    url: https://rsshub.example.com/bilibili/user/video/123456
    tags: [AI, Video]
    enabled: true
```

Add `configs/preferences.example.yaml`:

```yaml
profile:
  interests:
    - agent engineering
    - LLM applications
    - product design
    - career growth
  exclude:
    - pure marketing
    - low information density
    - repeated news
newsletter:
  schedule: "08:30"
  max_items: 10
  language: zh-CN
  min_score_to_include: 4
```

- [ ] **Step 4: Run config tests**

Run:

```powershell
python -m pytest tests/test_config_loader.py -q
```

Expected: PASS.

## Task 5: RSS/RSSHub Collector and Cleaner

**Files:**
- Create: `src/lettermate/sources/cleaner.py`
- Create: `src/lettermate/sources/collector.py`
- Create: `tests/fixtures/sample-feed.xml`
- Create: `tests/test_collectors.py`

- [ ] **Step 1: Add sample feed fixture**

Add `tests/fixtures/sample-feed.xml`:

```xml
<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0">
  <channel>
    <title>Example Feed</title>
    <link>https://example.com</link>
    <description>Example RSS feed</description>
    <item>
      <guid>entry-1</guid>
      <title>Agent Engineering Notes</title>
      <link>https://example.com/agent-engineering</link>
      <author>author@example.com</author>
      <pubDate>Fri, 26 Jun 2026 08:00:00 GMT</pubDate>
      <description><![CDATA[<p>Useful notes about agent engineering.</p>]]></description>
    </item>
  </channel>
</rss>
```

- [ ] **Step 2: Write collector tests**

Add `tests/test_collectors.py`:

```python
from pathlib import Path

from lettermate.sources.collector import parse_feed_bytes


def test_parse_feed_bytes_normalizes_rss_items():
    payload = Path("tests/fixtures/sample-feed.xml").read_bytes()

    items = parse_feed_bytes(payload)

    assert len(items) == 1
    assert items[0].external_id == "entry-1"
    assert items[0].title == "Agent Engineering Notes"
    assert items[0].url == "https://example.com/agent-engineering"
    assert items[0].raw_content == "Useful notes about agent engineering."
```

- [ ] **Step 3: Run test to verify failure**

Run:

```powershell
python -m pytest tests/test_collectors.py -q
```

Expected: FAIL because collector is not implemented.

- [ ] **Step 4: Implement cleaner and feed parser**

Add `src/lettermate/sources/cleaner.py`:

```python
from bs4 import BeautifulSoup


def clean_html(value: str) -> str:
    soup = BeautifulSoup(value or "", "html.parser")
    text = soup.get_text(" ", strip=True)
    return " ".join(text.split())
```

Add `src/lettermate/sources/collector.py`:

```python
from dataclasses import dataclass
from datetime import datetime

import feedparser

from lettermate.sources.cleaner import clean_html


@dataclass(frozen=True)
class CollectedItem:
    external_id: str
    title: str
    url: str
    author: str
    published_at: datetime | None
    raw_content: str


def parse_feed_bytes(payload: bytes) -> list[CollectedItem]:
    feed = feedparser.parse(payload)
    items: list[CollectedItem] = []
    for entry in feed.entries:
        published_at = None
        if getattr(entry, "published_parsed", None):
            parsed = entry.published_parsed
            published_at = datetime(*parsed[:6])
        raw_content = getattr(entry, "summary", "") or getattr(entry, "description", "")
        items.append(
            CollectedItem(
                external_id=getattr(entry, "id", "") or getattr(entry, "guid", "") or getattr(entry, "link", ""),
                title=getattr(entry, "title", "").strip(),
                url=getattr(entry, "link", "").strip(),
                author=getattr(entry, "author", "").strip(),
                published_at=published_at,
                raw_content=clean_html(raw_content),
            )
        )
    return [item for item in items if item.title and item.url]
```

- [ ] **Step 5: Run collector tests**

Run:

```powershell
python -m pytest tests/test_collectors.py -q
```

Expected: PASS.

## Task 6: LLM Analysis Agent

**Files:**
- Create: `src/lettermate/llm/__init__.py`
- Create: `src/lettermate/llm/schemas.py`
- Create: `src/lettermate/llm/prompts.py`
- Create: `src/lettermate/llm/provider.py`
- Create: `tests/test_llm_analysis.py`

- [ ] **Step 1: Write analysis provider tests**

Add `tests/test_llm_analysis.py`:

```python
from lettermate.llm.provider import FakeLLMProvider
from lettermate.llm.schemas import AnalysisRequest


def test_fake_llm_provider_returns_structured_result():
    provider = FakeLLMProvider(model="fake-local")
    result = provider.analyze(
        AnalysisRequest(
            title="Agent engineering notes",
            author="Author",
            platform="blog",
            url="https://example.com/post",
            raw_content="This article explains agent engineering patterns.",
            interests=["agent engineering"],
            exclude=["pure marketing"],
        )
    )

    assert result.score == 4
    assert result.should_include is True
    assert "agent" in result.summary.lower()
```

- [ ] **Step 2: Run test to verify failure**

Run:

```powershell
python -m pytest tests/test_llm_analysis.py -q
```

Expected: FAIL because LLM modules are not implemented.

- [ ] **Step 3: Implement schemas and fake provider**

Add `src/lettermate/llm/schemas.py`:

```python
from pydantic import BaseModel, Field, HttpUrl


class AnalysisRequest(BaseModel):
    title: str
    author: str = ""
    platform: str
    url: HttpUrl
    raw_content: str
    interests: list[str] = Field(default_factory=list)
    exclude: list[str] = Field(default_factory=list)


class AnalysisOutput(BaseModel):
    summary: str
    tags: list[str]
    score: int = Field(ge=1, le=5)
    reason: str
    actionable_insight: str
    should_include: bool
    model: str
```

Add `src/lettermate/llm/prompts.py`:

```python
SYSTEM_PROMPT = """You are LetterMate, a personal intelligence agent.
Analyze one content item and return structured JSON with summary, tags, score, reason,
actionable_insight, and should_include. Prefer concise Chinese output."""
```

Add `src/lettermate/llm/provider.py`:

```python
from typing import Protocol

from lettermate.llm.schemas import AnalysisOutput, AnalysisRequest


class LLMProvider(Protocol):
    def analyze(self, request: AnalysisRequest) -> AnalysisOutput:
        raise NotImplementedError


class FakeLLMProvider:
    def __init__(self, model: str = "fake-local") -> None:
        self.model = model

    def analyze(self, request: AnalysisRequest) -> AnalysisOutput:
        content = f"{request.title} {request.raw_content}".lower()
        matches_interest = any(interest.lower() in content for interest in request.interests)
        score = 4 if matches_interest else 3
        should_include = score >= 4
        return AnalysisOutput(
            summary=f"{request.title}：这是一条关于 {request.platform} 来源内容的简要摘要。",
            tags=[request.platform, *request.interests[:2]],
            score=score,
            reason="内容与用户关注方向相关。" if should_include else "内容相关性一般。",
            actionable_insight="可将其中的观点整理到项目复盘或学习笔记中。" if should_include else "",
            should_include=should_include,
            model=self.model,
        )
```

Add `src/lettermate/llm/__init__.py`:

```python
from lettermate.llm.provider import FakeLLMProvider, LLMProvider
from lettermate.llm.schemas import AnalysisOutput, AnalysisRequest

__all__ = ["AnalysisOutput", "AnalysisRequest", "FakeLLMProvider", "LLMProvider"]
```

- [ ] **Step 4: Run analysis tests**

Run:

```powershell
python -m pytest tests/test_llm_analysis.py -q
```

Expected: PASS.

## Task 7: Newsletter Builder

**Files:**
- Create: `src/lettermate/newsletters/__init__.py`
- Create: `src/lettermate/newsletters/builder.py`
- Create: `tests/test_newsletter_builder.py`

- [ ] **Step 1: Write builder tests**

Add `tests/test_newsletter_builder.py`:

```python
from datetime import date

from lettermate.newsletters.builder import NewsletterEntry, build_newsletter


def test_build_newsletter_includes_high_score_items():
    entries = [
        NewsletterEntry(
            title="Agent article",
            url="https://example.com/agent",
            source_name="Example",
            platform="blog",
            summary="Good summary",
            tags=["AI"],
            score=5,
            reason="High value",
            actionable_insight="Apply it to LetterMate.",
        )
    ]

    newsletter = build_newsletter(issue_date=date(2026, 6, 26), entries=entries)

    assert "LetterMate Daily - 2026-06-26" in newsletter.title
    assert "Agent article" in newsletter.markdown_body
    assert "<html" in newsletter.html_body
```

- [ ] **Step 2: Run test to verify failure**

Run:

```powershell
python -m pytest tests/test_newsletter_builder.py -q
```

Expected: FAIL because newsletter builder is not implemented.

- [ ] **Step 3: Implement newsletter builder**

Add `src/lettermate/newsletters/builder.py`:

```python
from dataclasses import dataclass
from datetime import date
from html import escape


@dataclass(frozen=True)
class NewsletterEntry:
    title: str
    url: str
    source_name: str
    platform: str
    summary: str
    tags: list[str]
    score: int
    reason: str
    actionable_insight: str


@dataclass(frozen=True)
class BuiltNewsletter:
    issue_date: date
    title: str
    markdown_body: str
    html_body: str


def build_newsletter(issue_date: date, entries: list[NewsletterEntry]) -> BuiltNewsletter:
    title = f"LetterMate Daily - {issue_date.isoformat()}"
    sorted_entries = sorted(entries, key=lambda entry: entry.score, reverse=True)
    markdown_lines = [f"# {title}", "", "## 今日重点", ""]
    html_items: list[str] = []

    if not sorted_entries:
        markdown_lines.append("今天没有达到推送阈值的内容。")
    for entry in sorted_entries:
        tags = ", ".join(entry.tags)
        markdown_lines.extend(
            [
                f"### [{entry.title}]({entry.url})",
                f"- 来源：{entry.source_name} / {entry.platform}",
                f"- 评分：{entry.score}",
                f"- 标签：{tags}",
                f"- 摘要：{entry.summary}",
                f"- 推荐理由：{entry.reason}",
                f"- 可行动洞察：{entry.actionable_insight}",
                "",
            ]
        )
        html_items.append(
            "<article>"
            f"<h2><a href=\"{escape(entry.url)}\">{escape(entry.title)}</a></h2>"
            f"<p><strong>来源：</strong>{escape(entry.source_name)} / {escape(entry.platform)}</p>"
            f"<p><strong>评分：</strong>{entry.score}</p>"
            f"<p><strong>标签：</strong>{escape(tags)}</p>"
            f"<p><strong>摘要：</strong>{escape(entry.summary)}</p>"
            f"<p><strong>推荐理由：</strong>{escape(entry.reason)}</p>"
            f"<p><strong>可行动洞察：</strong>{escape(entry.actionable_insight)}</p>"
            "</article>"
        )

    html_body = (
        "<html><head><meta charset=\"utf-8\"><title>"
        + escape(title)
        + "</title></head><body><h1>"
        + escape(title)
        + "</h1>"
        + "".join(html_items)
        + "</body></html>"
    )
    return BuiltNewsletter(
        issue_date=issue_date,
        title=title,
        markdown_body="\n".join(markdown_lines),
        html_body=html_body,
    )
```

Add `src/lettermate/newsletters/__init__.py`:

```python
from lettermate.newsletters.builder import BuiltNewsletter, NewsletterEntry, build_newsletter

__all__ = ["BuiltNewsletter", "NewsletterEntry", "build_newsletter"]
```

- [ ] **Step 4: Run newsletter tests**

Run:

```powershell
python -m pytest tests/test_newsletter_builder.py -q
```

Expected: PASS.

## Task 8: Job Runner for Collect, Analyze, and Newsletter

**Files:**
- Create: `src/lettermate/jobs/__init__.py`
- Create: `src/lettermate/jobs/runner.py`
- Create: `tests/test_jobs.py`

- [ ] **Step 1: Write job runner integration test**

Add `tests/test_jobs.py`:

```python
from datetime import date

from lettermate.db.models import Source
from lettermate.jobs.runner import analyze_pending_items, generate_daily_newsletter
from lettermate.llm.provider import FakeLLMProvider


def test_analyze_pending_items_and_generate_newsletter(temp_db_session):
    source = Source(
        name="Example",
        platform="blog",
        source_type="rss",
        url="https://example.com/feed.xml",
        tags=["AI"],
        enabled=True,
    )
    temp_db_session.add(source)
    temp_db_session.commit()

    from lettermate.db.repository import ContentInput, Repository

    repo = Repository(temp_db_session)
    repo.upsert_content_item(
        ContentInput(
            source_id=source.id,
            external_id="entry-1",
            title="Agent engineering notes",
            url="https://example.com/agent",
            author="Author",
            published_at=None,
            raw_content="This article explains agent engineering patterns.",
        )
    )

    analyzed_count = analyze_pending_items(
        session=temp_db_session,
        provider=FakeLLMProvider(),
        interests=["agent engineering"],
        exclude=[],
        limit=10,
    )
    newsletter = generate_daily_newsletter(session=temp_db_session, issue_date=date(2026, 6, 26))

    assert analyzed_count == 1
    assert "Agent engineering notes" in newsletter.markdown_body
```

- [ ] **Step 2: Run test to verify failure**

Run:

```powershell
python -m pytest tests/test_jobs.py -q
```

Expected: FAIL because job runner is not implemented.

- [ ] **Step 3: Implement job runner**

Add `src/lettermate/jobs/runner.py`:

```python
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from lettermate.db.models import AnalysisResult, ContentItem, Newsletter, Source
from lettermate.db.repository import Repository
from lettermate.llm.provider import LLMProvider
from lettermate.llm.schemas import AnalysisRequest
from lettermate.newsletters.builder import NewsletterEntry, build_newsletter


def analyze_pending_items(
    session: Session,
    provider: LLMProvider,
    interests: list[str],
    exclude: list[str],
    limit: int,
) -> int:
    repo = Repository(session)
    items = repo.list_pending_analysis_items(limit=limit)
    count = 0
    for item in items:
        source = session.get(Source, item.source_id)
        if source is None:
            continue
        output = provider.analyze(
            AnalysisRequest(
                title=item.title,
                author=item.author,
                platform=source.platform,
                url=item.url,
                raw_content=item.raw_content,
                interests=interests,
                exclude=exclude,
            )
        )
        repo.save_analysis(
            item=item,
            summary=output.summary,
            tags=output.tags,
            score=output.score,
            reason=output.reason,
            actionable_insight=output.actionable_insight,
            should_include=output.should_include,
            model=output.model,
        )
        count += 1
    return count


def generate_daily_newsletter(session: Session, issue_date: date) -> Newsletter:
    rows = session.execute(
        select(ContentItem, Source, AnalysisResult)
        .join(Source, Source.id == ContentItem.source_id)
        .join(AnalysisResult, AnalysisResult.content_item_id == ContentItem.id)
        .where(AnalysisResult.should_include.is_(True))
        .order_by(AnalysisResult.score.desc(), ContentItem.created_at.desc())
    ).all()
    entries = [
        NewsletterEntry(
            title=item.title,
            url=item.url,
            source_name=source.name,
            platform=source.platform,
            summary=analysis.summary,
            tags=analysis.tags,
            score=analysis.score,
            reason=analysis.reason,
            actionable_insight=analysis.actionable_insight,
        )
        for item, source, analysis in rows
    ]
    built = build_newsletter(issue_date=issue_date, entries=entries)
    repo = Repository(session)
    return repo.save_newsletter(
        issue_date=built.issue_date,
        title=built.title,
        markdown_body=built.markdown_body,
        html_body=built.html_body,
        status="draft",
    )
```

Add `src/lettermate/jobs/__init__.py`:

```python
from lettermate.jobs.runner import analyze_pending_items, generate_daily_newsletter

__all__ = ["analyze_pending_items", "generate_daily_newsletter"]
```

- [ ] **Step 4: Run job tests**

Run:

```powershell
python -m pytest tests/test_jobs.py -q
```

Expected: PASS.

## Task 9: Email Notifier

**Files:**
- Create: `src/lettermate/notifiers/__init__.py`
- Create: `src/lettermate/notifiers/email.py`
- Create: `tests/test_email_notifier.py`

- [ ] **Step 1: Write email dry-run test**

Add `tests/test_email_notifier.py`:

```python
from lettermate.notifiers.email import EmailMessage, EmailNotifier


def test_email_notifier_dry_run_returns_preview():
    notifier = EmailNotifier(
        host="localhost",
        port=1025,
        username="",
        password="",
        sender="from@example.com",
        recipient="to@example.com",
        use_tls=False,
        dry_run=True,
    )

    result = notifier.send(
        EmailMessage(
            subject="LetterMate Daily",
            text_body="# Daily",
            html_body="<h1>Daily</h1>",
        )
    )

    assert result.sent is False
    assert result.preview_subject == "LetterMate Daily"
```

- [ ] **Step 2: Run test to verify failure**

Run:

```powershell
python -m pytest tests/test_email_notifier.py -q
```

Expected: FAIL because notifier is not implemented.

- [ ] **Step 3: Implement email notifier**

Add `src/lettermate/notifiers/email.py`:

```python
import smtplib
from dataclasses import dataclass
from email.message import EmailMessage as StdlibEmailMessage


@dataclass(frozen=True)
class EmailMessage:
    subject: str
    text_body: str
    html_body: str


@dataclass(frozen=True)
class EmailSendResult:
    sent: bool
    preview_subject: str


class EmailNotifier:
    def __init__(
        self,
        host: str,
        port: int,
        username: str,
        password: str,
        sender: str,
        recipient: str,
        use_tls: bool,
        dry_run: bool,
    ) -> None:
        self.host = host
        self.port = port
        self.username = username
        self.password = password
        self.sender = sender
        self.recipient = recipient
        self.use_tls = use_tls
        self.dry_run = dry_run

    def send(self, message: EmailMessage) -> EmailSendResult:
        if self.dry_run:
            return EmailSendResult(sent=False, preview_subject=message.subject)

        email = StdlibEmailMessage()
        email["Subject"] = message.subject
        email["From"] = self.sender
        email["To"] = self.recipient
        email.set_content(message.text_body)
        email.add_alternative(message.html_body, subtype="html")

        with smtplib.SMTP(self.host, self.port, timeout=30) as client:
            if self.use_tls:
                client.starttls()
            if self.username:
                client.login(self.username, self.password)
            client.send_message(email)
        return EmailSendResult(sent=True, preview_subject=message.subject)
```

Add `src/lettermate/notifiers/__init__.py`:

```python
from lettermate.notifiers.email import EmailMessage, EmailNotifier, EmailSendResult

__all__ = ["EmailMessage", "EmailNotifier", "EmailSendResult"]
```

- [ ] **Step 4: Run notifier tests**

Run:

```powershell
python -m pytest tests/test_email_notifier.py -q
```

Expected: PASS.

## Task 10: FastAPI Routes and Dashboard

**Files:**
- Create: `src/lettermate/api/__init__.py`
- Create: `src/lettermate/api/deps.py`
- Create: `src/lettermate/api/routes.py`
- Create: `src/lettermate/api/app.py`
- Create: `src/lettermate/dashboard/__init__.py`
- Create: `src/lettermate/dashboard/routes.py`
- Create: `src/lettermate/dashboard/templates/base.html`
- Create: `src/lettermate/dashboard/templates/index.html`
- Create: `src/lettermate/dashboard/templates/sources.html`
- Create: `src/lettermate/dashboard/templates/items.html`
- Create: `src/lettermate/dashboard/templates/newsletters.html`
- Create: `src/lettermate/web/static/styles.css`
- Create: `tests/test_api.py`

- [ ] **Step 1: Write API smoke tests**

Add `tests/test_api.py`:

```python
from fastapi.testclient import TestClient

from lettermate.api.app import create_app


def test_health_endpoint():
    client = TestClient(create_app())

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
```

- [ ] **Step 2: Run test to verify failure**

Run:

```powershell
python -m pytest tests/test_api.py -q
```

Expected: FAIL because API app is not implemented.

- [ ] **Step 3: Implement minimal API**

Add `src/lettermate/api/routes.py`:

```python
from fastapi import APIRouter

router = APIRouter()


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
```

Add `src/lettermate/api/app.py`:

```python
from fastapi import FastAPI

from lettermate.api.routes import router as api_router


def create_app() -> FastAPI:
    app = FastAPI(title="LetterMate")
    app.include_router(api_router)
    return app


app = create_app()
```

Add `src/lettermate/api/__init__.py`:

```python
from lettermate.api.app import app, create_app

__all__ = ["app", "create_app"]
```

Add `src/lettermate/api/deps.py`:

```python
from collections.abc import Iterator

from sqlalchemy.orm import Session

from lettermate.db.session import get_session


def get_db_session() -> Iterator[Session]:
    yield from get_session()
```

- [ ] **Step 4: Add dashboard skeleton**

Add `src/lettermate/dashboard/templates/base.html`:

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <title>LetterMate</title>
    <link rel="stylesheet" href="/static/styles.css">
  </head>
  <body>
    <nav>
      <a href="/">Overview</a>
      <a href="/dashboard/sources">Sources</a>
      <a href="/dashboard/items">Items</a>
      <a href="/dashboard/newsletters">Newsletters</a>
    </nav>
    <main>{% block content %}{% endblock %}</main>
  </body>
</html>
```

Add `src/lettermate/dashboard/templates/index.html`:

```html
{% extends "base.html" %}
{% block content %}
<h1>LetterMate</h1>
<p>Personal Intelligence Agent dashboard.</p>
{% endblock %}
```

Add `src/lettermate/web/static/styles.css`:

```css
body {
  margin: 0;
  font-family: Arial, sans-serif;
  color: #1f2937;
  background: #f8fafc;
}

nav {
  display: flex;
  gap: 16px;
  padding: 16px 24px;
  background: #111827;
}

nav a {
  color: #ffffff;
  text-decoration: none;
}

main {
  max-width: 1040px;
  margin: 0 auto;
  padding: 24px;
}
```

- [ ] **Step 5: Run API tests**

Run:

```powershell
python -m pytest tests/test_api.py -q
```

Expected: PASS.

## Task 11: CLI and Scheduler

**Files:**
- Create: `src/lettermate/cli.py`
- Create: `src/lettermate/jobs/scheduler.py`

- [ ] **Step 1: Add CLI commands**

Add `src/lettermate/cli.py`:

```python
from datetime import UTC, datetime

import typer

from lettermate.db.session import create_session_factory
from lettermate.jobs.runner import analyze_pending_items, generate_daily_newsletter
from lettermate.llm.provider import FakeLLMProvider

app = typer.Typer(help="LetterMate local development CLI")


@app.command()
def analyze(limit: int = 20) -> None:
    session_factory = create_session_factory()
    with session_factory() as session:
        count = analyze_pending_items(
            session=session,
            provider=FakeLLMProvider(),
            interests=["agent engineering", "LLM applications"],
            exclude=["pure marketing"],
            limit=limit,
        )
    typer.echo(f"Analyzed {count} item(s).")


@app.command()
def newsletter() -> None:
    session_factory = create_session_factory()
    with session_factory() as session:
        result = generate_daily_newsletter(session=session, issue_date=datetime.now(UTC).date())
    typer.echo(f"Generated newsletter: {result.title}")
```

- [ ] **Step 2: Add scheduler factory**

Add `src/lettermate/jobs/scheduler.py`:

```python
from apscheduler.schedulers.background import BackgroundScheduler

from lettermate.cli import analyze, newsletter


def create_scheduler() -> BackgroundScheduler:
    scheduler = BackgroundScheduler(timezone="Asia/Shanghai")
    scheduler.add_job(analyze, "interval", hours=6, id="analyze")
    scheduler.add_job(newsletter, "cron", hour=8, minute=30, id="newsletter")
    return scheduler
```

- [ ] **Step 3: Run CLI smoke commands**

Run:

```powershell
lettermate --help
lettermate analyze --limit 1
lettermate newsletter
```

Expected: Help text renders. The analyze command returns `Analyzed 0 item(s).` on an empty database. The newsletter command creates an empty draft newsletter.

## Task 12: Docker, README, and Final Verification

**Files:**
- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Modify: `README.md`

- [ ] **Step 1: Add Dockerfile**

Add `Dockerfile`:

```dockerfile
FROM python:3.12-slim

WORKDIR /app

COPY pyproject.toml README.md ./
COPY src ./src
COPY configs ./configs

RUN pip install --no-cache-dir -e .

EXPOSE 8000

CMD ["uvicorn", "lettermate.api.app:app", "--host", "0.0.0.0", "--port", "8000"]
```

- [ ] **Step 2: Add docker-compose.yml**

Add `docker-compose.yml`:

```yaml
services:
  lettermate:
    build: .
    env_file:
      - .env
    ports:
      - "8000:8000"
    volumes:
      - ./data:/app/data
      - ./configs:/app/configs
```

- [ ] **Step 3: Update README with runbook**

Update `README.md` with:

```markdown
# LetterMate

LetterMate is a Personal Intelligence Agent that collects RSS/RSSHub content,
deduplicates items, generates structured LLM summaries and value scores, builds a
daily newsletter, and sends it by email.

## MVP Capabilities

- RSS/Atom and RSSHub source collection
- SQLite persistence
- Content deduplication
- Structured summary, tags, score, reason, and actionable insight
- Daily Markdown/HTML newsletter generation
- Email dry-run support
- FastAPI health endpoint and dashboard foundation
- Typer CLI for local demos

## Local Setup

```powershell
python -m pip install -e ".[dev]"
Copy-Item .env.example .env
python -m pytest
uvicorn lettermate.api.app:app --reload
```

Open `http://localhost:8000/health`.

## CLI Demo

```powershell
lettermate analyze --limit 5
lettermate newsletter
```

## Docker

```powershell
Copy-Item .env.example .env
docker compose up --build
```

## Architecture

See `docs/project-proposal-and-architecture.md`.
```

- [ ] **Step 4: Run final verification**

Run:

```powershell
python -m pytest
python -m ruff check .
python -m mypy src
```

Expected: all commands exit with code 0.

- [ ] **Step 5: Commit**

Run:

```powershell
git add .
git commit -m "feat: implement LetterMate MVP foundation"
```

Expected: commit succeeds if the repository has been initialized. If this directory is not a Git repository, initialize it before committing:

```powershell
git init
git add .
git commit -m "feat: implement LetterMate MVP foundation"
```

## Coverage Checklist

- Project scaffold: Task 1.
- Database models: Task 2.
- Repository and deduplication persistence: Task 3.
- YAML configuration: Task 4.
- RSS/RSSHub feed parsing and cleaning: Task 5.
- LLM structured analysis interface: Task 6.
- Newsletter generation: Task 7.
- Job orchestration: Task 8.
- Email notification: Task 9.
- API and dashboard foundation: Task 10.
- CLI and scheduler: Task 11.
- Docker, README, and verification: Task 12.

## Execution Choice

Plan complete. Execute it with one of these approaches:

1. **Subagent-Driven (recommended)** - dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** - execute tasks in this session using executing-plans, batch execution with checkpoints.
