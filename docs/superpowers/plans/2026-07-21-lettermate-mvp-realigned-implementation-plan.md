# LetterMate MVP Realignment Implementation Plan

> **Superseded on 2026-07-21:** This plan has been replaced in full by
> `docs/superpowers/plans/2026-07-21-lettermate-mvp-vertical-slice-v2.md`.
> Keep this file only as planning history; do not execute its tasks.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete a resume-ready LetterMate MVP that can reliably run the full `collect -> persist -> analyze -> build -> send` workflow, expose the result through a lightweight dashboard/API, and remain deterministic in tests.

**Architecture:** Keep the existing modular Python/FastAPI monolith, but execute the remaining work as a vertical slice instead of isolated layers. Persistence operations must be idempotent, every scheduled stage must write job state, tests must use fake services, and normal runtime must support one real structured-output LLM provider.

**Tech Stack:** Python 3.12, FastAPI, Typer, SQLAlchemy, SQLite, Pydantic, feedparser, BeautifulSoup, httpx, APScheduler, Jinja2, OpenAI Python SDK, pytest, ruff, mypy, Docker Compose.

---

## Plan Status

This plan supersedes Tasks 5-12 in `2026-06-26-lettermate-mvp-implementation-plan.md`.

Current state on 2026-07-21:

| Area | Status | Required action |
| --- | --- | --- |
| Project scaffold and settings | Implemented, verification incomplete | Standardize Python, fix lint/type errors, add repository hygiene |
| Database models | Implemented, contract incomplete | Add newsletter membership and stronger uniqueness rules |
| Repository | Implemented, not idempotent enough | Repair deduplication and rerun behavior |
| YAML configuration | Implemented | Keep and extend only when required |
| Collector onward | Not implemented | Execute this plan in order |

Do not mark an area complete solely because files exist. Completion requires the commands and acceptance checks in the corresponding task to pass.

## Non-Negotiable MVP Acceptance Criteria

- At least five RSS/RSSHub sources can be configured.
- One command can collect, analyze, generate a newsletter, and perform an email dry run or real send.
- A failed source does not prevent other sources from being collected.
- Repeating collection, analysis, newsletter generation, or email dispatch does not create duplicate records or duplicate sends.
- Runtime supports both a deterministic fake LLM and one real OpenAI structured-output provider.
- Every pipeline stage creates a `JobRun`; failures create useful `JobEvent` records.
- The dashboard shows sources, collected items, analysis results, newsletters, and recent job runs.
- Offline tests never call a real feed, LLM API, or SMTP server.
- `pytest`, `ruff`, and `mypy` all exit with code 0.

## Target File Changes

```text
D:\LetterMate
|- .gitignore
|- README.md
|- pyproject.toml
|- src/lettermate
|  |- api
|  |  |- app.py
|  |  |- deps.py
|  |  `- routes.py
|  |- dashboard
|  |  |- routes.py
|  |  `- templates
|  |     |- base.html
|  |     |- index.html
|  |     |- items.html
|  |     |- jobs.html
|  |     |- newsletters.html
|  |     `- sources.html
|  |- db
|  |  |- models.py
|  |  |- repository.py
|  |  `- session.py
|  |- jobs
|  |  |- runner.py
|  |  `- scheduler.py
|  |- llm
|  |  |- prompts.py
|  |  |- provider.py
|  |  `- schemas.py
|  |- newsletters
|  |  `- builder.py
|  |- notifiers
|  |  `- email.py
|  |- sources
|  |  |- cleaner.py
|  |  |- collector.py
|  |  `- service.py
|  `- cli.py
`- tests
   |- fixtures/sample-feed.xml
   |- test_api.py
   |- test_collectors.py
   |- test_daily_pipeline.py
   |- test_email_notifier.py
   |- test_jobs.py
   |- test_llm_analysis.py
   |- test_newsletter_builder.py
   `- test_repository.py
```

## Development Rules

- Use TDD for every behavior change: failing test, minimal implementation, passing test.
- Commit after each task once Git is initialized.
- Use UTC in persistence and convert the configured local newsletter date at boundaries.
- Use stable string statuses with centralized constants or `Literal` types; do not scatter new status spellings.
- Keep external clients behind protocols so tests can inject fakes.
- Do not add Alembic during this MVP realignment. No production database exists yet; delete and recreate local development databases after the model contract changes.
- Do not add LangGraph, a task queue, multi-user authentication, RAG, or non-RSS scraping.

## Task 0: Restore a Green Development Baseline

**Files:**
- Modify: `.gitignore`
- Modify: `README.md`
- Modify: `pyproject.toml`
- Modify: `src/lettermate/db/repository.py`
- Modify: `src/lettermate/sources/__init__.py`
- Modify: `src/lettermate/sources/config_loader.py`

- [ ] **Step 1: Standardize the supported runtime**

Keep `requires-python = ">=3.12,<3.13"` and use Python 3.12 locally and in Docker. This removes the current Python 3.13/3.12 mismatch while the MVP is being stabilized.

- [ ] **Step 2: Add repository hygiene**

Set `.gitignore` to:

```gitignore
.env
.mypy_cache/
.pytest_cache/
.ruff_cache/
.venv/
__pycache__/
*.py[cod]
coverage.xml
htmlcov/
data/
dist/
*.egg-info/
```

- [ ] **Step 3: Fix existing static-check failures**

Make these narrow changes:

```python
# repository.py
from datetime import date, datetime

def make_content_hash(title: str, raw_content: str) -> str:
    payload = f"{title.strip()}|{raw_content.strip()}".encode()
    return sha256(payload).hexdigest()

def save_newsletter(
    self,
    issue_date: date,
    title: str,
    markdown_body: str,
    html_body: str,
    status: str,
) -> Newsletter:
    ...
```

```python
# config_loader.py
from typing import Any

def read_yaml(path: Path) -> dict[str, Any]:
    ...
```

Format `src/lettermate/sources/__init__.py` with one imported name per line or Ruff-compatible parentheses.

- [ ] **Step 4: Add a truthful README status section**

Document that Tasks 1-4 are implemented, the end-to-end workflow is not complete, and this realignment plan is the active development plan. Do not advertise unimplemented capabilities.

- [ ] **Step 5: Run the baseline verification**

Run:

```powershell
python -m pytest -q
python -m ruff check .
python -m mypy src
```

Expected: all commands exit with code 0.

- [ ] **Step 6: Initialize version control and commit**

Run only after `.gitignore` is correct:

```powershell
git init
git add .
git commit -m "chore: establish LetterMate development baseline"
```

Expected: generated caches and local data are not staged.

## Task 1: Repair Persistence Contracts and Deduplication

**Files:**
- Modify: `src/lettermate/db/models.py`
- Modify: `src/lettermate/db/repository.py`
- Modify: `src/lettermate/db/__init__.py`
- Modify: `tests/test_models.py`
- Modify: `tests/test_repository.py`

- [ ] **Step 1: Write failing deduplication tests**

Add tests proving each independent key works:

```python
def test_repository_deduplicates_same_source_guid(temp_db_session):
    first = make_input(external_id="guid-1", url="https://a.example/post")
    second = make_input(external_id="guid-1", url="https://b.example/post")

    assert repo.upsert_content_item(first).id == repo.upsert_content_item(second).id


def test_repository_deduplicates_same_content_across_urls(temp_db_session):
    first = make_input(title="Same", url="https://a.example/post", raw_content="Body")
    second = make_input(title="Same", url="https://b.example/post", raw_content="Body")

    assert repo.upsert_content_item(first).id == repo.upsert_content_item(second).id
```

- [ ] **Step 2: Run the tests and verify the current implementation fails**

Run:

```powershell
python -m pytest tests/test_repository.py -q
```

Expected: the new guid and cross-URL content tests fail.

- [ ] **Step 3: Define the corrected model constraints**

Change `ContentItem.external_id` to `str | None`, normalize empty values to `None`, and use:

```python
__table_args__ = (
    UniqueConstraint("url", name="uq_content_items_url"),
    UniqueConstraint("source_id", "external_id", name="uq_content_items_source_external_id"),
    UniqueConstraint("content_hash", name="uq_content_items_hash"),
)
```

The content hash must be derived from normalized title and cleaned content, not URL.

- [ ] **Step 4: Add newsletter membership records**

Add:

```python
class NewsletterItem(Base):
    __tablename__ = "newsletter_items"
    __table_args__ = (
        UniqueConstraint(
            "newsletter_id",
            "content_item_id",
            name="uq_newsletter_items_membership",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    newsletter_id: Mapped[int] = mapped_column(ForeignKey("newsletters.id"), nullable=False)
    content_item_id: Mapped[int] = mapped_column(ForeignKey("content_items.id"), nullable=False)
    rank: Mapped[int] = mapped_column(Integer, nullable=False)
    section: Mapped[str] = mapped_column(String(100), default="highlights")
```

Add relationships from `Newsletter` and `ContentItem`, and export the model from `db/__init__.py`.

- [ ] **Step 5: Implement deterministic lookup order**

`upsert_content_item` must check, in order:

1. normalized URL;
2. `(source_id, external_id)` when `external_id` is present;
3. content hash.

Retain the `IntegrityError` retry path for concurrent insertion.

- [ ] **Step 6: Verify and commit**

Run:

```powershell
python -m pytest tests/test_models.py tests/test_repository.py -q
python -m ruff check .
python -m mypy src
git add src/lettermate/db tests/test_models.py tests/test_repository.py
git commit -m "fix: make persisted content and newsletters traceable"
```

Expected: all checks pass.

## Task 2: Make Repository Writes Idempotent

**Files:**
- Modify: `src/lettermate/db/repository.py`
- Modify: `tests/test_repository.py`

- [ ] **Step 1: Write rerun tests**

```python
def test_save_analysis_replaces_existing_result(temp_db_session):
    first = repo.save_analysis(item=item, summary="old", **analysis_fields())
    second = repo.save_analysis(item=item, summary="new", **analysis_fields())

    assert first.id == second.id
    assert second.summary == "new"


def test_save_newsletter_updates_same_issue(temp_db_session):
    first = repo.save_newsletter(issue_date=ISSUE_DATE, title="First", ...)
    second = repo.save_newsletter(issue_date=ISSUE_DATE, title="Updated", ...)

    assert first.id == second.id
    assert second.title == "Updated"
```

- [ ] **Step 2: Verify the tests fail with uniqueness errors**

Run:

```powershell
python -m pytest tests/test_repository.py -q
```

Expected: both new rerun tests fail before implementation.

- [ ] **Step 3: Implement update-or-create behavior**

Use explicit select-and-update behavior for one-to-one analysis and issue-date newsletters. Do not catch a uniqueness error as the normal rerun path.

Add:

```python
def replace_newsletter_items(
    self,
    newsletter: Newsletter,
    ranked_item_ids: list[int],
) -> list[NewsletterItem]:
    ...

def mark_newsletter_sent(self, newsletter: Newsletter, sent_at: datetime) -> None:
    ...

def mark_newsletter_send_failed(self, newsletter: Newsletter) -> None:
    ...
```

Replacing newsletter membership must delete the old membership rows for that newsletter before inserting the new ranking.

- [ ] **Step 4: Verify and commit**

Run:

```powershell
python -m pytest tests/test_repository.py -q
git add src/lettermate/db/repository.py tests/test_repository.py
git commit -m "fix: make analysis and newsletter writes idempotent"
```

Expected: tests pass and generating the same issue twice retains one newsletter row.

## Task 3: Implement Feed Parsing and Collection Service

**Files:**
- Create: `src/lettermate/sources/cleaner.py`
- Create: `src/lettermate/sources/collector.py`
- Create: `src/lettermate/sources/service.py`
- Create: `tests/fixtures/sample-feed.xml`
- Create: `tests/test_collectors.py`
- Modify: `pyproject.toml`

- [ ] **Step 1: Move `httpx` into runtime dependencies**

The collector uses `httpx.Client`; keep it in `[project].dependencies`, not only the development extra.

- [ ] **Step 2: Write parser tests**

Cover RSS normalization, HTML cleaning, missing optional fields, invalid entries, and timezone-aware publication dates.

```python
def test_parse_feed_bytes_returns_utc_items():
    items = parse_feed_bytes(Path("tests/fixtures/sample-feed.xml").read_bytes())

    assert items[0].published_at is not None
    assert items[0].published_at.tzinfo is UTC
    assert items[0].raw_content == "Useful notes about agent engineering."
```

- [ ] **Step 3: Implement parser and cleaner**

Expose:

```python
@dataclass(frozen=True)
class CollectedItem:
    external_id: str | None
    title: str
    url: str
    author: str
    published_at: datetime | None
    raw_content: str


def clean_html(value: str) -> str:
    ...


def parse_feed_bytes(payload: bytes) -> list[CollectedItem]:
    ...
```

Use `datetime(*entry.published_parsed[:6], tzinfo=UTC)` when a parsed date exists.

- [ ] **Step 4: Write collection service tests with a fake client**

```python
class FakeFeedClient:
    def __init__(self, responses: dict[str, bytes | Exception]) -> None:
        self.responses = responses

    def fetch(self, url: str) -> bytes:
        result = self.responses[url]
        if isinstance(result, Exception):
            raise result
        return result


def test_collect_sources_isolates_failed_source(temp_db_session):
    result = collect_enabled_sources(...)

    assert result.succeeded_sources == 1
    assert result.failed_sources == 1
    assert repo.count_content_items() == 1
```

- [ ] **Step 5: Implement the fetch protocol and collection service**

```python
class FeedClient(Protocol):
    def fetch(self, url: str) -> bytes: ...


class HttpFeedClient:
    def __init__(self, timeout_seconds: float = 20.0) -> None: ...
    def fetch(self, url: str) -> bytes: ...


def collect_enabled_sources(
    session: Session,
    client: FeedClient,
    job_run: JobRun,
) -> CollectionResult:
    ...
```

Each source is handled in its own `try` block. Update `last_fetched_at` only after a successful fetch and parse. Record failure details as `JobEvent` rows without aborting remaining sources.

- [ ] **Step 6: Verify and commit**

Run:

```powershell
python -m pytest tests/test_collectors.py -q
python -m ruff check .
python -m mypy src
git add pyproject.toml src/lettermate/sources tests/fixtures tests/test_collectors.py
git commit -m "feat: collect and normalize RSS sources"
```

## Task 4: Implement Fake and Real Structured LLM Providers

**Files:**
- Create: `src/lettermate/llm/schemas.py`
- Create: `src/lettermate/llm/prompts.py`
- Create: `src/lettermate/llm/provider.py`
- Modify: `src/lettermate/config.py`
- Modify: `.env.example`
- Modify: `pyproject.toml`
- Create: `tests/test_llm_analysis.py`

- [ ] **Step 1: Add the OpenAI SDK dependency and settings**

Add `openai` to runtime dependencies. Add settings for provider, model, timeout, and retries. Keep the model value configurable; do not hardcode a time-sensitive model identifier in application code.

```env
LLM_PROVIDER=fake
LLM_MODEL=
LLM_TIMEOUT_SECONDS=30
LLM_MAX_RETRIES=2
OPENAI_API_KEY=
```

- [ ] **Step 2: Write schema and fake-provider tests**

The schema must constrain `score` to 1-5 and include summary, tags, reason, actionable insight, and inclusion decision.

```python
def test_fake_provider_returns_valid_analysis():
    output = FakeLLMProvider().analyze(request_for("agent engineering"))

    assert 1 <= output.score <= 5
    assert output.model == "fake-local"
```

- [ ] **Step 3: Implement request, payload, and output schemas**

Separate the model-generated payload from runtime metadata:

```python
class AnalysisPayload(BaseModel):
    summary: str
    tags: list[str]
    score: int = Field(ge=1, le=5)
    reason: str
    actionable_insight: str
    should_include: bool


class AnalysisOutput(AnalysisPayload):
    model: str
```

- [ ] **Step 4: Implement the provider protocol and fake provider**

```python
class LLMProvider(Protocol):
    def analyze(self, request: AnalysisRequest) -> AnalysisOutput: ...
```

The fake provider must remain deterministic and must not read environment credentials.

- [ ] **Step 5: Write a mocked OpenAI provider test**

Inject the SDK client. Do not patch network internals.

```python
def test_openai_provider_uses_parsed_structured_output():
    client = FakeOpenAIClient(parsed=AnalysisPayload(...))
    provider = OpenAIProvider(client=client, model="configured-model")

    result = provider.analyze(request_for("agent engineering"))

    assert result.model == "configured-model"
    assert result.summary == "Structured summary"
```

- [ ] **Step 6: Implement the OpenAI Responses API adapter and factory**

Use the OpenAI Python SDK structured-output helper documented at:

- `https://developers.openai.com/api/docs/guides/structured-outputs`

The adapter shape is:

```python
response = self.client.responses.parse(
    model=self.model,
    input=[
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": render_analysis_request(request)},
    ],
    text_format=AnalysisPayload,
)
payload = response.output_parsed
```

Raise a domain-specific error when parsed output is absent. Configure timeout and retries on the injected `OpenAI` client. Add `create_llm_provider(settings)` that returns fake or OpenAI based on configuration and rejects unknown provider names.

- [ ] **Step 7: Verify and commit**

Run:

```powershell
python -m pytest tests/test_llm_analysis.py -q
python -m ruff check .
python -m mypy src
git add .env.example pyproject.toml src/lettermate/config.py src/lettermate/llm tests/test_llm_analysis.py
git commit -m "feat: add structured LLM provider adapters"
```

Expected: tests use fakes only and make no network calls.

## Task 5: Build Date-Bounded, Traceable Newsletters

**Files:**
- Create: `src/lettermate/newsletters/builder.py`
- Modify: `src/lettermate/db/repository.py`
- Create: `tests/test_newsletter_builder.py`

- [ ] **Step 1: Write builder tests**

Cover score ordering, maximum item count, escaped HTML, the empty-newsletter message, and exclusion below the configured threshold.

```python
def test_build_newsletter_applies_threshold_and_limit():
    built = build_newsletter(
        issue_date=date(2026, 7, 21),
        entries=entries_with_scores(5, 4, 3),
        min_score=4,
        max_items=1,
    )

    assert built.item_ids == [HIGH_SCORE_ITEM_ID]
```

- [ ] **Step 2: Implement the pure builder**

```python
@dataclass(frozen=True)
class BuiltNewsletter:
    issue_date: date
    title: str
    markdown_body: str
    html_body: str
    item_ids: list[int]
```

`build_newsletter` must not query or commit database state.

- [ ] **Step 3: Add repository query for the issue window**

Query analyzed items created inside the configured Asia/Shanghai issue-day window, convert boundaries to UTC, filter `should_include`, order by score then recency, and apply `max_items`.

- [ ] **Step 4: Persist newsletter membership idempotently**

Generating the same issue again must update the body and replace `NewsletterItem` rows while retaining the same newsletter ID.

- [ ] **Step 5: Verify and commit**

Run:

```powershell
python -m pytest tests/test_newsletter_builder.py tests/test_repository.py -q
git add src/lettermate/newsletters src/lettermate/db/repository.py tests/test_newsletter_builder.py tests/test_repository.py
git commit -m "feat: generate traceable daily newsletters"
```

## Task 6: Implement Email Delivery With Safe Reruns

**Files:**
- Create: `src/lettermate/notifiers/email.py`
- Create: `tests/test_email_notifier.py`

- [ ] **Step 1: Write dry-run and SMTP tests**

Use an injected SMTP factory. Cover dry run, TLS, optional login, successful send, and raised SMTP errors.

```python
def test_email_notifier_dry_run_does_not_open_smtp():
    result = notifier.send(message)

    assert result.sent is False
    assert smtp_factory.calls == []
```

- [ ] **Step 2: Implement the notifier**

Keep `EmailMessage`, `EmailSendResult`, and `EmailNotifier`. Inject the SMTP factory with `smtplib.SMTP` as the runtime default.

- [ ] **Step 3: Add send-state tests at the job layer**

Define behavior explicitly:

- dry run returns a preview and leaves the newsletter in `draft`;
- successful real send changes status to `sent` and sets `sent_at`;
- failure changes status to `send_failed`;
- an already-sent issue is not sent again unless `force=True`.

- [ ] **Step 4: Verify and commit**

Run:

```powershell
python -m pytest tests/test_email_notifier.py -q
git add src/lettermate/notifiers tests/test_email_notifier.py
git commit -m "feat: add idempotent email delivery"
```

## Task 7: Implement Observable Pipeline Jobs

**Files:**
- Create: `src/lettermate/jobs/runner.py`
- Modify: `src/lettermate/db/repository.py`
- Create: `tests/test_jobs.py`

- [ ] **Step 1: Write JobRun lifecycle tests**

```python
def test_successful_job_records_completion(temp_db_session):
    result = run_analyze(...)

    assert result.job_run.status == "completed"
    assert result.job_run.finished_at is not None


def test_failed_job_records_error_before_reraising(temp_db_session):
    with pytest.raises(ProviderError):
        run_analyze(...)

    assert latest_job_run.status == "failed"
    assert latest_job_event.level == "error"
```

- [ ] **Step 2: Add repository helpers for job state**

```python
def start_job(self, job_type: str) -> JobRun: ...
def add_job_event(self, job_run: JobRun, level: str, message: str) -> JobEvent: ...
def complete_job(self, job_run: JobRun) -> None: ...
def fail_job(self, job_run: JobRun, message: str) -> None: ...
```

- [ ] **Step 3: Implement independent stage runners**

Expose:

```python
def run_collect(session: Session, client: FeedClient) -> JobResult: ...
def run_analyze(session: Session, provider: LLMProvider, preferences: Preferences) -> JobResult: ...
def run_newsletter(session: Session, preferences: Preferences, issue_date: date) -> JobResult: ...
def run_send(session: Session, notifier: EmailNotifier, newsletter_id: int, force: bool = False) -> JobResult: ...
```

Every function owns one `JobRun` and is safe to retry.

- [ ] **Step 4: Implement the daily orchestrator**

```python
def run_daily(
    session_factory: sessionmaker[Session],
    feed_client: FeedClient,
    provider: LLMProvider,
    notifier: EmailNotifier,
    preferences: Preferences,
    issue_date: date,
) -> DailyRunResult:
    ...
```

Run stages in order and return each stage result. Do not hide a failed stage. Collection may complete with per-source failures, but analysis, newsletter generation, and send failures must stop subsequent dependent stages.

- [ ] **Step 5: Verify and commit**

Run:

```powershell
python -m pytest tests/test_jobs.py -q
git add src/lettermate/jobs src/lettermate/db/repository.py tests/test_jobs.py
git commit -m "feat: orchestrate observable pipeline jobs"
```

## Task 8: Add CLI Commands and Complete Scheduling

**Files:**
- Create: `src/lettermate/cli.py`
- Create: `src/lettermate/jobs/scheduler.py`
- Create: `tests/test_cli.py`
- Create: `tests/test_scheduler.py`

- [ ] **Step 1: Write CLI smoke tests**

Use Typer's `CliRunner` and dependency factories. Cover:

```text
lettermate sync-sources
lettermate collect
lettermate analyze
lettermate newsletter
lettermate send
lettermate run-daily
lettermate scheduler
```

`run-daily --dry-run` is the primary local demo command.

- [ ] **Step 2: Implement runtime dependency factories**

CLI functions must resolve settings, session factory, source files, preferences, feed client, LLM provider, and notifier in one composition layer. Business logic remains in jobs and services.

- [ ] **Step 3: Implement all CLI commands**

Each command prints job ID, status, and relevant counts. `sync-sources` upserts YAML sources rather than creating duplicates.

- [ ] **Step 4: Write scheduler registration tests**

Assert the scheduler contains:

- recurring `collect` every six hours;
- daily `run_daily` at the configured newsletter time;
- `max_instances=1` and `coalesce=True` for both jobs.

- [ ] **Step 5: Implement and start the scheduler**

`create_scheduler` only registers jobs. The CLI `scheduler` command starts it and blocks until interrupted. Do not import Typer command functions into the scheduler.

- [ ] **Step 6: Verify and commit**

Run:

```powershell
python -m pytest tests/test_cli.py tests/test_scheduler.py -q
lettermate --help
lettermate run-daily --dry-run
git add src/lettermate/cli.py src/lettermate/jobs/scheduler.py tests/test_cli.py tests/test_scheduler.py
git commit -m "feat: expose and schedule the complete daily workflow"
```

Expected on an empty database: command completes without network access only when fake dependencies or fixtures are selected explicitly.

## Task 9: Build the API and Operational Dashboard

**Files:**
- Create: `src/lettermate/api/app.py`
- Create: `src/lettermate/api/deps.py`
- Create: `src/lettermate/api/routes.py`
- Create: `src/lettermate/dashboard/routes.py`
- Create: `src/lettermate/dashboard/templates/base.html`
- Create: `src/lettermate/dashboard/templates/index.html`
- Create: `src/lettermate/dashboard/templates/sources.html`
- Create: `src/lettermate/dashboard/templates/items.html`
- Create: `src/lettermate/dashboard/templates/newsletters.html`
- Create: `src/lettermate/dashboard/templates/jobs.html`
- Create: `src/lettermate/web/static/styles.css`
- Create: `tests/test_api.py`

- [ ] **Step 1: Write API route tests**

Required endpoints:

```text
GET  /health
GET  /api/sources
GET  /api/items
GET  /api/newsletters
GET  /api/jobs
POST /api/jobs/collect
POST /api/jobs/analyze
POST /api/jobs/newsletter
POST /api/newsletters/{id}/send
POST /api/items/{id}/feedback
```

Override FastAPI dependencies in tests. Job-trigger tests use fake external services.

- [ ] **Step 2: Implement thin API routes**

Routes validate input, call repository/job services, and serialize results. They do not contain collection, LLM, newsletter, or SMTP business logic.

- [ ] **Step 3: Write dashboard rendering tests**

Test `/`, `/dashboard/sources`, `/dashboard/items`, `/dashboard/newsletters`, and `/dashboard/jobs`. Seed database records and assert meaningful table content appears.

- [ ] **Step 4: Implement usable server-rendered views**

The first screen is the operational overview, not a landing page. Show compact counts, latest pipeline status, recent high-score items, and the latest newsletter. Other pages use dense tables suitable for repeated inspection.

- [ ] **Step 5: Verify and commit**

Run:

```powershell
python -m pytest tests/test_api.py -q
python -m ruff check .
python -m mypy src
git add src/lettermate/api src/lettermate/dashboard src/lettermate/web tests/test_api.py
git commit -m "feat: add LetterMate API and dashboard"
```

## Task 10: Add an Offline End-to-End Pipeline Test

**Files:**
- Create: `tests/test_daily_pipeline.py`
- Modify: `tests/fixtures/sample-feed.xml`

- [ ] **Step 1: Write the complete offline scenario**

The test must:

1. create two sources;
2. return one valid feed and one failed fetch;
3. persist the valid item once;
4. analyze it with `FakeLLMProvider`;
5. create one newsletter and one membership row;
6. perform an email dry run;
7. retain job history for every stage;
8. rerun the entire pipeline without duplicates.

```python
def test_daily_pipeline_is_observable_and_idempotent(temp_db_session_factory):
    first = run_daily(...)
    second = run_daily(...)

    assert first.newsletter_id == second.newsletter_id
    assert count(ContentItem) == 1
    assert count(Newsletter) == 1
    assert count(NewsletterItem) == 1
    assert all(run.finished_at is not None for run in list_job_runs())
```

- [ ] **Step 2: Run the test and fix only integration defects**

Run:

```powershell
python -m pytest tests/test_daily_pipeline.py -q
```

Expected: PASS with no network or SMTP traffic.

- [ ] **Step 3: Run the complete suite and commit**

```powershell
python -m pytest -q
python -m ruff check .
python -m mypy src
git add tests/test_daily_pipeline.py tests/fixtures/sample-feed.xml
git commit -m "test: cover the complete LetterMate daily pipeline"
```

## Task 11: Package, Document, and Demonstrate the MVP

**Files:**
- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Modify: `README.md`
- Modify: `.env.example`

- [ ] **Step 1: Add container packaging**

Use `python:3.12-slim`, install the package, create `/app/data`, expose port 8000, and run Uvicorn. Compose mounts `data` and `configs`, loads `.env`, and includes an HTTP healthcheck for `/health`.

- [ ] **Step 2: Write the final README runbook**

Include:

- product purpose and actual capabilities;
- architecture/data-flow diagram;
- Python 3.12 setup;
- fake/offline demo command;
- real OpenAI configuration;
- SMTP dry-run and real-send configuration;
- API and dashboard URLs;
- Docker commands;
- test/lint/type-check commands;
- failure and rerun semantics;
- known MVP exclusions and next-stage ideas.

- [ ] **Step 3: Configure five stable demo sources**

Update `configs/sources.example.yaml` with at least five RSS/RSSHub examples. Mark environment-specific RSSHub routes clearly and keep them replaceable without code changes.

- [ ] **Step 4: Run local acceptance**

Run:

```powershell
Copy-Item .env.example .env
python -m pip install -e ".[dev]"
python -m pytest -q
python -m ruff check .
python -m mypy src
lettermate run-daily --dry-run
uvicorn lettermate.api.app:app --host 127.0.0.1 --port 8000
```

Verify manually:

- `GET http://127.0.0.1:8000/health` returns `{"status":"ok"}`;
- dashboard pages render persisted demo data;
- repeated dry-run execution does not duplicate items or newsletters;
- recent job runs and source failures are visible.

- [ ] **Step 5: Run Docker acceptance**

```powershell
docker compose up --build
```

Expected: the healthcheck becomes healthy and the dashboard is reachable on port 8000.

- [ ] **Step 6: Commit the release-ready MVP**

```powershell
git add Dockerfile docker-compose.yml README.md .env.example configs
git commit -m "docs: package and document the LetterMate MVP"
```

## Final Coverage Matrix

| Requirement | Implemented by |
| --- | --- |
| RSS/RSSHub collection and source isolation | Task 3 |
| URL/guid/content deduplication | Tasks 1-2 |
| Structured fake and real LLM analysis | Task 4 |
| Date-bounded Markdown/HTML newsletter | Task 5 |
| Traceable newsletter membership | Tasks 1, 2, 5 |
| Dry-run and real SMTP delivery | Task 6 |
| Job state, failure events, and retries | Task 7 |
| Complete CLI and APScheduler workflow | Task 8 |
| API, dashboard, and feedback endpoint | Task 9 |
| Offline full-pipeline verification | Task 10 |
| Docker and reproducible demo | Task 11 |

## Execution Choice

Execute this plan using one of these approaches:

1. **Subagent-Driven (recommended)** - use a fresh subagent per task with review between tasks.
2. **Inline Execution** - use `superpowers:executing-plans` with checkpoints after Tasks 0, 4, 8, and 11.
