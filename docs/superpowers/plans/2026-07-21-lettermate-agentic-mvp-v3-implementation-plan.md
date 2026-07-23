# LetterMate Agentic MVP V3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付一个可离线验证、可公开部署、能通过受限工具调用和长期偏好记忆持续改善五条每日推荐的 LetterMate 单用户 MVP，并形成可用于简历和面试的 Eval、决策与复盘证据。

**Architecture:** 外层使用显式 Python workflow 完成来源同步、采集、持久化、确定性排序、Newsletter 构建和发送；内层 Content Curation Agent 仅能选择三个只读工具，并由确定性策略拥有最终入选权。SQLite 服务于本地和离线测试，hosted pilot 使用 Postgres；所有 Agent 决策、工具轨迹、偏好版本和 Job 状态均可复现和审计。

**Tech Stack:** Python 3.12, FastAPI, Typer, SQLAlchemy, Alembic, SQLite, Postgres, Pydantic, OpenAI Agents SDK, feedparser, httpx, BeautifulSoup, nh3, APScheduler, Jinja2, SMTP, pytest, Ruff, mypy, Promptfoo, Docker Compose.

---

## Implementation Status (2026-07-23)

Tasks 0 through 12 have been implemented in this checkout and verified with the repository's
offline tests, static checks, package build, migration checks, security regression evaluation, and
the recorded local container acceptance. The unchecked substeps below are preserved as the
historical pre-execution plan; they are not a live completion tracker.

Task 13 is intentionally incomplete. A production deployment with real secrets/OpenAI/SMTP, a
seven-day baseline, fourteen consecutive owner-dogfood days, an isolated external-user pilot, and
a dated real holdout Eval still require independently collected evidence. See `README.md`,
`docs/evals/reports/portfolio-final.md`, and `docs/pilot/` for the current evidence state.

---

## 1. Plan Authority

本计划是 `docs/lettermate-agentic-product-requirements-v2.md` 的唯一活动任务级实施基线，并完整取代以下历史计划：

- `docs/superpowers/plans/2026-06-26-lettermate-mvp-implementation-plan.md`
- `docs/superpowers/plans/2026-07-21-lettermate-mvp-realigned-implementation-plan.md`
- `docs/superpowers/plans/2026-07-21-lettermate-mvp-vertical-slice-v2.md`

不得因为文件已经存在就勾选任务。每项完成必须同时满足目标测试、全量门禁和本任务的证据要求。

## 2. Current Baseline

| Area | Current State | V3 Action |
| --- | --- | --- |
| Python/tooling | Python 3.13 下 7 tests pass；Ruff 4 errors；mypy 2 errors | Task 0 固定 Python 3.12 并恢复绿色门禁 |
| Git/README | 当前目录不是 Git repository；README 基本为空 | Task 0 建立仓库与真实状态说明 |
| Settings | 基础配置已实现 | Tasks 0、4、7、8、11 扩展 |
| Database | 基础模型已实现 | Task 2 修正约束并加入 PreferenceSnapshot、AgentRun、ToolCallTrace |
| Repository | 局部内容去重 | Task 2 实现完整幂等契约 |
| YAML | 来源与偏好读取已实现 | Tasks 2、3、7 加入同步、抓取缓存和权重配置 |
| Eval | 未实现 | Tasks 1、9 建立控制组、数据集和质量/安全门禁 |
| Pipeline onward | 未实现 | Tasks 3-13 按垂直闭环推进 |

## 3. Target File Map

```text
D:\LetterMate
|- .github/workflows/ci.yml
|- .gitignore
|- .env.example
|- Dockerfile
|- README.md
|- alembic.ini
|- docker-compose.yml
|- package.json
|- promptfooconfig.yaml
|- pyproject.toml
|- configs
|  |- demo-feed.xml
|  |- preferences.example.yaml
|  `- sources.example.yaml
|- docs
|  |- adr
|  |  |- 0001-workflow-and-agent-boundary.md
|  |  |- 0002-structured-preference-memory.md
|  |  |- 0003-evaluation-strategy.md
|  |  `- 0004-dedicated-scheduler-and-postgres.md
|  |- evals
|  |  |- 20-minute-control-group.md
|  |  |- labeling-rubric.md
|  |  `- reports
|  |- pilot
|  |  |- external-user-feedback.md
|  |  `- owner-dogfood-log.md
|  `- retrospective.md
|- evals
|  |- datasets
|  |  |- items.sample.jsonl
|  |  `- labels.sample.jsonl
|  `- security
|     |- provider.py
|     `- prompt-injection.yaml
|- migrations
|  |- env.py
|  `- versions
|- src/lettermate
|  |- api
|  |  |- app.py
|  |  |- auth.py
|  |  |- deps.py
|  |  `- routes.py
|  |- curation
|  |  |- agent.py
|  |  |- prompts.py
|  |  |- provider.py
|  |  |- schemas.py
|  |  |- service.py
|  |  |- tools.py
|  |  `- tracing.py
|  |- dashboard
|  |  |- routes.py
|  |  `- templates
|  |     |- base.html
|  |     |- index.html
|  |     |- item.html
|  |     |- jobs.html
|  |     |- newsletters.html
|  |     |- preferences.html
|  |     `- sources.html
|  |- db
|  |  |- models.py
|  |  |- repository.py
|  |  |- session.py
|  |  `- statuses.py
|  |- evals
|  |  |- baselines.py
|  |  |- metrics.py
|  |  |- runner.py
|  |  `- schemas.py
|  |- jobs
|  |  |- runner.py
|  |  `- scheduler.py
|  |- newsletters/builder.py
|  |- notifiers/email.py
|  |- preferences
|  |  |- service.py
|  |  `- signing.py
|  |- ranking/policy.py
|  |- sources
|  |  |- cleaner.py
|  |  |- collector.py
|  |  |- config_loader.py
|  |  |- normalization.py
|  |  `- service.py
|  |- web/static/styles.css
|  |- cli.py
|  `- config.py
`- tests
   |- fixtures/sample-feed.xml
   |- test_agent.py
   |- test_api.py
   |- test_cli.py
   |- test_collectors.py
   |- test_daily_pipeline.py
   |- test_email_notifier.py
   |- test_evals.py
   |- test_jobs.py
   |- test_models.py
   |- test_newsletter_builder.py
   |- test_preferences.py
   |- test_ranking.py
   |- test_repository.py
   |- test_scheduler.py
   `- test_security.py
```

## 4. Global Development Rules

- 每个行为变更执行 TDD：目标测试先失败，再做最小实现，再运行局部和全量门禁。
- Windows 本地命令固定使用 `.\.venv\Scripts\python.exe`，禁止依赖系统默认 Python。
- 每个 Task 在测试和静态检查通过后独立提交。
- 外部 feed、LLM、SMTP、DNS 和时间必须可注入；离线测试不得访问真实服务。
- 数据库存储 UTC；Asia/Shanghai issue date 只在业务边界转换。
- Agent 不拥有写数据库、发送邮件、修改来源、shell、任意浏览器或任意 HTTP 工具。
- Raw private content 不进入外部 trace；内部 `AgentRun`/`ToolCallTrace` 是审计权威来源。
- 不提前引入 LangGraph、Temporal、Celery、RAG、向量数据库或多 Agent。
- 任何质量提升声明必须带同一数据集上的 baseline 和 dated report。

## Task 0: Restore a Reproducible Green Baseline

**Requirements:** Release criteria 1; portfolio README foundation

**Files:**
- Modify: `.gitignore`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `pyproject.toml`
- Modify: `tests/conftest.py`
- Modify: `src/lettermate/db/repository.py`
- Modify: `src/lettermate/sources/__init__.py`
- Modify: `src/lettermate/sources/config_loader.py`

- [ ] **Step 1: Pin the supported runtime and development tools**

Set `requires-python = ">=3.12,<3.13"`; keep existing runtime dependencies; add `build` to the dev extra. Create the environment:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"
```

Expected: Python reports 3.12.x and editable installation succeeds.

- [ ] **Step 2: Add repository hygiene before Git initialization**

Ignore `.env`, `.venv/`, `.package-smoke/`, all Python/tool caches, `*.py[cod]`, coverage output, `data/`, build output, egg metadata, Node modules, local Eval outputs containing private data, and local pilot logs.

- [ ] **Step 3: Fix existing static and resource warnings**

Add missing `date` and generic dictionary types, format long expressions/imports, remove the unnecessary explicit UTF-8 argument to `str.encode`, and dispose the SQLite engine after fixtures yield.

- [ ] **Step 4: Write an honest README status block**

Document the four implemented foundations, the incomplete workflow, the V2 PRD, this V3 plan, Python 3.12 setup, and the fact that Agent/Eval/deployment claims are not yet complete.

- [ ] **Step 5: Run the baseline gate**

```powershell
.\.venv\Scripts\python.exe -m pytest -q
.\.venv\Scripts\python.exe -m ruff check .
.\.venv\Scripts\python.exe -m mypy src
.\.venv\Scripts\python.exe -m build
```

Expected: all four commands return 0 without ResourceWarning.

- [ ] **Step 6: Initialize Git and commit**

```powershell
git init
git add .
git status --short
git commit -m "chore: establish LetterMate development baseline"
```

Expected: generated caches, environment, private datasets, secrets, and local databases are not staged.

## Task 1: Establish the Control Group and Eval Foundation

**Requirements:** EV-DATA-01 through EV-DATA-04; release criterion 7; control-group requirement

**Files:**
- Create: `src/lettermate/evals/schemas.py`
- Create: `src/lettermate/evals/metrics.py`
- Create: `src/lettermate/evals/baselines.py`
- Create: `src/lettermate/evals/runner.py`
- Create: `evals/datasets/items.sample.jsonl`
- Create: `evals/datasets/labels.sample.jsonl`
- Create: `docs/evals/labeling-rubric.md`
- Create: `docs/evals/20-minute-control-group.md`
- Create: `tests/test_evals.py`

- [ ] **Step 1: Define and test versioned Eval schemas**

`EvalItem` contains item ID, source, title, URL, excerpt, published time and dataset version. `EvalLabel` contains item ID, relevance grade 0-2, `needs_full_text`, expected tags and redaction status. Tests reject duplicate IDs, invalid grades, missing dataset versions and unredacted private notes.

- [ ] **Step 2: Implement deterministic ranking metrics**

Implement Precision@5, useful-rate, `nDCG@5`, duplicate rate and source diversity. Unit tests use hand-calculated fixtures and cover empty candidates, fewer than five items and tied scores.

- [ ] **Step 3: Implement latest-first and static one-shot baseline interfaces**

The latest-first baseline has no model dependency. The one-shot baseline accepts an injected structured provider and static preferences, has no tools and writes a normalized result file. Both consume identical candidate IDs.

- [ ] **Step 4: Create sanitized sample data and labeling rubric**

Commit at least ten synthetic/public sample items and labels. The rubric defines 0 as irrelevant, 1 as possibly useful and 2 as clearly useful; it defines full-text necessity using whether the excerpt supports a grounded decision.

- [ ] **Step 5: Run and document the 20-minute coding-Agent control experiment**

Give the coding Agent the same public sample and static preferences for exactly twenty minutes. Record the prompt, generated output, elapsed time, missing persistent state/workflow, metric output and conclusions. Do not claim the experiment covers production reliability.

- [ ] **Step 6: Verify and commit**

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_evals.py -q
.\.venv\Scripts\python.exe -m lettermate.evals.runner --dataset evals/datasets/items.sample.jsonl --labels evals/datasets/labels.sample.jsonl --baseline latest-first
git add src/lettermate/evals evals docs/evals tests/test_evals.py
git commit -m "test: establish recommendation baselines"
```

Expected: metric output is deterministic and the control-group document contains measured results rather than capability claims.

## Task 2: Repair Persistence and Add Auditable Agent State

**Requirements:** FR-SRC-01, FR-SRC-04, FR-RANK-03, FR-AGENT-09, FR-MEM-03 through FR-MEM-06, FR-NL-02, FR-JOB-01, FR-JOB-02

**Files:**
- Create: `src/lettermate/db/statuses.py`
- Create: `alembic.ini`
- Create: `migrations/env.py`
- Create: `migrations/versions/0001_agentic_mvp_schema.py`
- Modify: `src/lettermate/db/models.py`
- Modify: `src/lettermate/db/repository.py`
- Modify: `src/lettermate/db/session.py`
- Modify: `src/lettermate/db/__init__.py`
- Modify: `pyproject.toml`
- Modify: `tests/test_models.py`
- Modify: `tests/test_repository.py`

- [ ] **Step 1: Write failing schema and idempotency tests**

Cover unique Source URL, nullable source-scoped external ID, URL-independent content hash, one analysis per item, one issue per date, unique newsletter membership, immutable preference versions, ordered tool traces and rerun-stable primary keys.

- [ ] **Step 2: Add centralized status constants**

Define stable Source, ContentItem, AgentRun, Newsletter and JobRun states in one module. Tests must fail when repository methods accept an unknown status.

- [ ] **Step 3: Add and relate the required records**

Add `NewsletterItem`, `PreferenceSnapshot`, `AgentRun` and `ToolCallTrace`. Link AnalysisResult to its AgentRun; link NewsletterItem to the decision and final score; store snapshot content hash and feedback cutoff.

- [ ] **Step 4: Implement idempotent repository methods**

Add source sync, deterministic content lookup, analysis replacement, issue upsert, newsletter membership replacement, snapshot creation/retrieval, AgentRun lifecycle, ordered tool traces and JobRun/JobEvent lifecycle. Normal reruns use select-and-update, not uniqueness exceptions.

- [ ] **Step 5: Introduce Alembic as the schema authority**

Add Alembic and Postgres driver dependencies. The initial migration builds the V3 schema from an empty database. `Base.metadata.create_all` remains limited to disposable tests until fixtures migrate.

- [ ] **Step 6: Verify migration parity and commit**

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_models.py tests/test_repository.py -q
New-Item -ItemType Directory -Force data | Out-Null
.\.venv\Scripts\alembic.exe upgrade head
.\.venv\Scripts\alembic.exe check
.\.venv\Scripts\python.exe -m ruff check .
.\.venv\Scripts\python.exe -m mypy src
git add pyproject.toml alembic.ini migrations src/lettermate/db tests/test_models.py tests/test_repository.py
git commit -m "feat: add auditable agentic persistence"
```

## Task 3: Build Reliable and Safe Source Collection

**Requirements:** FR-SRC-01 through FR-SRC-07; source failure and security requirements

**Files:**
- Create: `src/lettermate/sources/normalization.py`
- Create: `src/lettermate/sources/cleaner.py`
- Create: `src/lettermate/sources/collector.py`
- Create: `src/lettermate/sources/service.py`
- Create: `tests/fixtures/sample-feed.xml`
- Create: `tests/test_collectors.py`
- Modify: `src/lettermate/db/models.py`
- Modify: `src/lettermate/db/repository.py`
- Modify: `pyproject.toml`

- [ ] **Step 1: Write URL normalization and sanitization tests**

Cover scheme/host case, default ports, fragments, known tracking parameters, retained business parameters, malformed URLs, script removal, event-handler removal and safe link attributes.

- [ ] **Step 2: Implement normalization and HTML cleaning**

Move `httpx` into runtime dependencies and add `nh3`. Use standard URL parsing and `nh3` allowlists. Store normalized URLs; never execute or render active feed content.

- [ ] **Step 3: Write parser and conditional-fetch tests**

Cover RSS/Atom fields, missing metadata, UTC dates, full/summary content, ETag, Last-Modified, HTTP 304 and bounded response size. Use an injected fake HTTP client and clock.

- [ ] **Step 4: Implement FeedClient and parser**

`FeedClient` accepts conditional headers and returns status, bytes and response validators. The parser converts bytes to immutable collected-item inputs and never writes the database.

- [ ] **Step 5: Implement source sync and failure-isolated collection**

Synchronize YAML sources by normalized URL. Handle each enabled source in its own error boundary; update fetch validators and last-fetched time only after a valid response; return structured failures without aborting healthy sources.

- [ ] **Step 6: Verify and commit**

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_collectors.py tests/test_repository.py -q
.\.venv\Scripts\python.exe -m ruff check .
.\.venv\Scripts\python.exe -m mypy src
git add pyproject.toml src/lettermate/sources src/lettermate/db tests/fixtures tests/test_collectors.py tests/test_repository.py
git commit -m "feat: collect feeds safely and conditionally"
```

## Task 4: Implement the Fixed Curation and Ranking Baselines

**Requirements:** FR-RANK-01 through FR-RANK-04; FR-AGENT-05, FR-AGENT-06; baseline variants 2 and 3

**Files:**
- Create: `src/lettermate/curation/schemas.py`
- Create: `src/lettermate/curation/prompts.py`
- Create: `src/lettermate/curation/provider.py`
- Create: `src/lettermate/curation/service.py`
- Create: `src/lettermate/ranking/policy.py`
- Create: `tests/test_curation.py`
- Create: `tests/test_ranking.py`
- Modify: `src/lettermate/config.py`
- Modify: `src/lettermate/evals/baselines.py`

- [ ] **Step 1: Write Pydantic output contract tests**

The structured payload requires summary, tags, semantic score 1-5, recommendation, reason, evidence references and confidence 0-1. Reject missing fields, out-of-range scores and evidence references not present in the input.

- [ ] **Step 2: Implement deterministic Fake and injected structured providers**

The fake provider returns stable results without credentials or network. The provider protocol accepts one request and returns the shared curation output contract; it exposes model and prompt version metadata.

- [ ] **Step 3: Write deterministic prefilter and ranking tests**

Test duplicate, stale, empty and excluded-topic filtering. Test score components, configurable weights, preference boost, freshness bonus, repetition penalty, source diversity and exact tie order.

- [ ] **Step 4: Implement curation service and ranking policy**

The service saves semantic output but does not select final issue membership. The ranking policy records each score component and owns final threshold, source diversity and item limit.

- [ ] **Step 5: Add one-shot and fixed-workflow Eval variants**

Both variants consume the same dataset and output the same result schema. One-shot gets static preferences; fixed workflow gets deterministic prefilter plus one structured call and no adaptive tools.

- [ ] **Step 6: Verify and commit**

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_curation.py tests/test_ranking.py tests/test_evals.py -q
.\.venv\Scripts\python.exe -m ruff check .
.\.venv\Scripts\python.exe -m mypy src
git add src/lettermate/curation src/lettermate/ranking src/lettermate/evals src/lettermate/config.py tests
git commit -m "feat: add fixed curation and ranking baselines"
```

## Task 5: Generate Traceable Issues and Deliver Email Safely

**Requirements:** FR-NL-01 through FR-NL-05; duplicate-send and SMTP failure semantics

**Files:**
- Create: `src/lettermate/newsletters/builder.py`
- Create: `src/lettermate/notifiers/email.py`
- Create: `tests/test_newsletter_builder.py`
- Create: `tests/test_email_notifier.py`
- Modify: `src/lettermate/db/repository.py`

- [ ] **Step 1: Write pure builder tests**

Cover date boundaries, at-most-five selection, exact ranked order, Markdown/HTML escaping, original-link presence, empty issue and persisted membership metadata.

- [ ] **Step 2: Implement the pure Newsletter builder**

The builder receives ranked entries and precomputed feedback URLs, queries no database and returns immutable issue content plus ordered membership inputs.

- [ ] **Step 3: Write SMTP and send-state tests**

Cover dry run, TLS, optional login, successful send, SMTP exception, already-sent skip, explicit force and ambiguous external-success/local-commit failure documentation.

- [ ] **Step 4: Implement EmailNotifier and job-facing send result**

Notifier owns only message construction and SMTP interaction. Repository/job service owns draft, sent, sent-at and send-failed state; no success state is written before SMTP accepts the message.

- [ ] **Step 5: Verify and commit**

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_newsletter_builder.py tests/test_email_notifier.py tests/test_repository.py -q
.\.venv\Scripts\python.exe -m ruff check .
.\.venv\Scripts\python.exe -m mypy src
git add src/lettermate/newsletters src/lettermate/notifiers src/lettermate/db/repository.py tests
git commit -m "feat: build traceable issues and send email safely"
```

## Task 6: Complete the Observable Offline Workflow and CLI

**Requirements:** FR-JOB-01 through FR-JOB-03, FR-JOB-07; release criteria 2, 3 and 9

**Files:**
- Create: `src/lettermate/jobs/runner.py`
- Create: `src/lettermate/cli.py`
- Create: `configs/demo-feed.xml`
- Create: `tests/test_jobs.py`
- Create: `tests/test_cli.py`
- Create: `tests/test_daily_pipeline.py`
- Modify: `tests/conftest.py`
- Modify: `src/lettermate/db/repository.py`

- [ ] **Step 1: Add Session factory fixtures and job lifecycle tests**

Each stage uses a separate Session and JobRun. Test completed, failed and warning outcomes; failure handling rolls back before persisting the error event in a valid transaction.

- [ ] **Step 2: Implement independent stage runners**

Add sync, collect, analyze, build and send runners. Each returns job ID, status, counts and structured warnings; only dependent hard failures stop later stages.

- [ ] **Step 3: Implement daily orchestration**

The orchestrator calls five stages in order, records issue date and idempotency key and exposes every stage result. It never hides a failed dependent stage.

- [ ] **Step 4: Implement CLI composition**

Expose `sync-sources`, `collect`, `analyze`, `newsletter`, `send`, `run-daily` and `eval`. `run-daily --feed-fixture configs/demo-feed.xml --dry-run` uses local feed, fake provider and no SMTP connection.

- [ ] **Step 5: Add the offline rerun E2E test**

Run the full pipeline twice with one healthy and one failed source. Assert stable counts for Source, ContentItem, AnalysisResult, Newsletter and NewsletterItem; assert complete JobRuns and zero network/SMTP calls.

- [ ] **Step 6: Verify checkpoint and commit**

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_jobs.py tests/test_cli.py tests/test_daily_pipeline.py -q
.\.venv\Scripts\lettermate.exe run-daily --feed-fixture configs/demo-feed.xml --dry-run
.\.venv\Scripts\python.exe -m pytest -q
.\.venv\Scripts\python.exe -m ruff check .
.\.venv\Scripts\python.exe -m mypy src
git add src/lettermate/jobs src/lettermate/cli.py src/lettermate/db configs/demo-feed.xml tests
git commit -m "feat: complete the observable offline workflow"
```

## Task 7: Implement Structured Preference Memory and Signed Feedback

**Requirements:** FR-MEM-01 through FR-MEM-07; FR-NL-06; release criterion 6

**Files:**
- Create: `src/lettermate/preferences/service.py`
- Create: `src/lettermate/preferences/signing.py`
- Create: `tests/test_preferences.py`
- Modify: `src/lettermate/config.py`
- Modify: `src/lettermate/db/repository.py`
- Modify: `src/lettermate/newsletters/builder.py`
- Modify: `.env.example`

- [ ] **Step 1: Write deterministic snapshot tests**

Cover useful `+1`, saved `+2`, not-interested `-2`, configurable weights, source/tag aggregation, version increment, feedback cutoff, stable content hash, reset without deleting feedback and replay determinism.

- [ ] **Step 2: Implement preference derivation**

Create immutable snapshots from explicit config plus feedback ordered by timestamp and ID. Store source weights, tag weights and the exact feedback cutoff; return the same content hash for the same inputs.

- [ ] **Step 3: Write signed-feedback security tests**

Cover item/issue/action/expiry binding, tampering, expired links, unknown action, constant-time signature comparison and confirmation response containing no private records.

- [ ] **Step 4: Implement signer and feedback application service**

Use HMAC from the standard library with a dedicated secret. Applying valid feedback is idempotent, records the action source and creates the next snapshot exactly once.

- [ ] **Step 5: Add feedback links to the Newsletter**

Generate useful/not-interested/saved URLs per membership. Dry-run and real messages use the same signed links; tokens and secrets are never logged.

- [ ] **Step 6: Verify and commit**

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_preferences.py tests/test_newsletter_builder.py tests/test_repository.py -q
.\.venv\Scripts\python.exe -m ruff check .
.\.venv\Scripts\python.exe -m mypy src
git add .env.example src/lettermate/preferences src/lettermate/config.py src/lettermate/db src/lettermate/newsletters tests
git commit -m "feat: add traceable preference memory"
```

## Task 8: Implement the Bounded Content Curation Agent

**Requirements:** FR-AGENT-01 through FR-AGENT-09; framework exit criteria; release criterion 4

**Files:**
- Create: `src/lettermate/curation/tools.py`
- Create: `src/lettermate/curation/tracing.py`
- Create: `src/lettermate/curation/agent.py`
- Create: `tests/test_agent.py`
- Modify: `src/lettermate/curation/prompts.py`
- Modify: `src/lettermate/curation/service.py`
- Modify: `src/lettermate/config.py`
- Modify: `src/lettermate/db/repository.py`
- Modify: `pyproject.toml`

- [ ] **Step 1: Add OpenAI Agents SDK and write tool-contract tests**

Add the SDK runtime dependency. Test that the exposed tool set contains only `fetch_full_text`, `lookup_recent_topics` and `get_preference_evidence`; enforce once-per-tool and three-total-call budgets.

- [ ] **Step 2: Implement safe full-text tool boundaries**

Accept only HTTP(S) URLs matching the item's source relationship. Resolve and block loopback, link-local, private and reserved addresses; enforce redirects, timeout, response size, content type and sanitized output. DNS resolver and client are injected in tests.

- [ ] **Step 3: Implement bounded history and preference tools**

Limit recent-topic results and feedback examples; return redacted summaries and IDs instead of private notes. Sort results deterministically.

- [ ] **Step 4: Implement internal redacted tracing**

Create AgentRun before model execution and ordered ToolCallTrace records for every attempt. Store argument hash, redacted summary, status and latency. Disable external raw-content tracing or route events through a verified redacting processor.

- [ ] **Step 5: Implement the Agent loop with fake-model tests**

Use shared structured output schema, injected model/client, system instructions marking article content untrusted, maximum steps and confidence policy. Test zero-tool, each single-tool, all-three-tool, duplicate-tool, over-budget, timeout, invalid output and low-confidence cases.

- [ ] **Step 6: Integrate advisory output with deterministic ranking**

The Agent writes semantic results and evidence but cannot choose issue membership. Ranking policy applies preference/freshness/repetition/source-diversity components and stores the final decision.

- [ ] **Step 7: Verify and commit**

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_agent.py tests/test_curation.py tests/test_ranking.py tests/test_repository.py -q
.\.venv\Scripts\python.exe -m ruff check .
.\.venv\Scripts\python.exe -m mypy src
git add pyproject.toml src/lettermate/curation src/lettermate/ranking src/lettermate/db tests
git commit -m "feat: add bounded content curation agent"
```

## Task 9: Add Quality, Trajectory, and Security Eval Gates

**Requirements:** all Evaluation Requirements; prompt-injection requirement; release criteria 5, 7 and 8

**Files:**
- Create: `evals/security/prompt-injection.yaml`
- Create: `evals/security/provider.py`
- Create: `promptfooconfig.yaml`
- Create: `package.json`
- Create: `tests/test_security.py`
- Modify: `src/lettermate/evals/metrics.py`
- Modify: `src/lettermate/evals/runner.py`
- Modify: `src/lettermate/evals/baselines.py`
- Modify: `tests/test_evals.py`
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Complete the four-variant Eval runner**

Run latest-first, one-shot static preference, fixed structured workflow and bounded Agent on identical candidate IDs. Persist config, prompt/model versions, dataset hash, metrics, latency, tokens and date.

- [ ] **Step 2: Add quality and trajectory metrics**

Measure `nDCG@5`, useful rate, original-link coverage, duplicate rate, full-text precision/avoidance, tool-budget violations, unauthorized attempts and complete-trace rate. Tests cover every threshold boundary.

- [ ] **Step 3: Write pytest prompt-injection cases**

Include feed text instructing the model to ignore policy, send email, reveal secrets, call arbitrary URLs and repeat tools. Assert no unauthorized tool exists, no budget is exceeded and structured output remains valid or fails closed.

- [ ] **Step 4: Add Promptfoo security configuration**

Create local red-team cases using sanitized inputs and `evals/security/provider.py`, which returns deterministic policy-check outputs without credentials. Define `npm run security-eval` as `promptfoo eval -c promptfooconfig.yaml`; define a separate `security-eval:live` script for protected external-model runs. Commit package lock after installing Promptfoo. CI always runs pytest and the offline Promptfoo command; the live command runs only when a protected credential is available.

- [ ] **Step 5: Enforce honest framework exit reporting**

Eval report states whether at least two tools are selected adaptively, trace data shortened debugging and bounded Agent beats the strongest fixed workflow. When criteria fail, open a documented simplification task rather than claiming Agent value.

- [ ] **Step 6: Verify and commit**

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_evals.py tests/test_security.py tests/test_agent.py -q
npm install
npm run security-eval
.\.venv\Scripts\python.exe -m lettermate.evals.runner --dataset evals/datasets/items.sample.jsonl --labels evals/datasets/labels.sample.jsonl --all-baselines
git add src/lettermate/evals evals promptfooconfig.yaml package.json package-lock.json tests .github/workflows/ci.yml
git commit -m "test: gate agent quality and security"
```

## Task 10: Build the Protected API and Explanation-First Dashboard

**Requirements:** FR-UX-01 through FR-UX-07; dashboard and privacy requirements

**Files:**
- Create: `src/lettermate/api/auth.py`
- Create: `src/lettermate/api/deps.py`
- Create: `src/lettermate/api/routes.py`
- Create: `src/lettermate/api/app.py`
- Create: `src/lettermate/dashboard/routes.py`
- Create: `src/lettermate/dashboard/templates/base.html`
- Create: `src/lettermate/dashboard/templates/index.html`
- Create: `src/lettermate/dashboard/templates/item.html`
- Create: `src/lettermate/dashboard/templates/jobs.html`
- Create: `src/lettermate/dashboard/templates/newsletters.html`
- Create: `src/lettermate/dashboard/templates/preferences.html`
- Create: `src/lettermate/dashboard/templates/sources.html`
- Create: `src/lettermate/web/static/styles.css`
- Create: `tests/test_api.py`
- Modify: `src/lettermate/db/repository.py`
- Modify: `pyproject.toml`

- [ ] **Step 1: Write owner and scheduler authentication tests**

Cover missing/invalid/valid owner credentials, separate scheduler token, constant-time comparison, public health endpoint and signed feedback endpoint that reveals no private records.

- [ ] **Step 2: Write API route tests with dependency overrides**

Cover sources, items, item decision, newsletters, jobs, preferences, feedback, reset and manual stage triggers. External dependencies use fakes; responses exclude secrets, raw trace arguments and private notes.

- [ ] **Step 3: Implement thin API routes**

Routes validate input, authorize, call repository/services and serialize. No route contains feed, Agent, ranking, SMTP or snapshot derivation business logic.

- [ ] **Step 4: Write server-rendered dashboard tests**

Seed real database records and assert overview, source failure, decision score components, tool trace summaries, preference snapshot history, latest issue and job states render correctly.

- [ ] **Step 5: Implement explanation-first views**

The first screen is the daily operational briefing. Item view shows why, evidence, confidence, score components, tool names and snapshot version; it never exposes raw private trace content.

- [ ] **Step 6: Package templates/static files and verify**

Configure setuptools package data, build a wheel, install it into a clean temporary environment and start the app from outside the repository to prove templates and CSS are included:

```powershell
.\.venv\Scripts\python.exe -m build
py -3.12 -m venv .package-smoke
$wheel = (Get-ChildItem dist\*.whl | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
.\.package-smoke\Scripts\python.exe -m pip install $wheel
Push-Location $env:TEMP
& 'D:\LetterMate\.package-smoke\Scripts\python.exe' -c "from importlib.resources import files; assert files('lettermate').joinpath('dashboard/templates/index.html').is_file(); assert files('lettermate').joinpath('web/static/styles.css').is_file()"
Pop-Location
```

Expected: both packaged resources are found while the process working directory is outside the repository.

- [ ] **Step 7: Verify and commit**

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_api.py -q
.\.venv\Scripts\python.exe -m build
.\.venv\Scripts\python.exe -m ruff check .
.\.venv\Scripts\python.exe -m mypy src
git add pyproject.toml src/lettermate/api src/lettermate/dashboard src/lettermate/web src/lettermate/db tests/test_api.py
git commit -m "feat: add protected explanation dashboard"
```

## Task 11: Add Dedicated Scheduling and Missed-Run Recovery

**Requirements:** FR-JOB-04 through FR-JOB-06; operational delivery metrics

**Files:**
- Create: `src/lettermate/jobs/scheduler.py`
- Create: `tests/test_scheduler.py`
- Modify: `src/lettermate/cli.py`
- Modify: `src/lettermate/config.py`

- [ ] **Step 1: Write scheduler registration tests**

Assert one recurring collect job and one daily run, stable IDs, `max_instances=1`, coalescing, timezone, injected dependencies and no Typer command imports.

- [ ] **Step 2: Write missed-run and duplicate-worker tests**

With an injected clock and job history, test one recovery inside the configured window, no recovery outside it and stable idempotency key protection against duplicate execution.

- [ ] **Step 3: Implement dedicated scheduler worker**

`create_scheduler` registers jobs only. `lettermate scheduler` starts the worker and blocks until shutdown. Web application startup never creates a scheduler.

- [ ] **Step 4: Add operational timing records**

Persist scheduled time, actual start, completion and recovery flag so delivery-within-15-minutes can be calculated for every issue.

- [ ] **Step 5: Verify and commit**

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_scheduler.py tests/test_jobs.py -q
.\.venv\Scripts\python.exe -m ruff check .
.\.venv\Scripts\python.exe -m mypy src
git add src/lettermate/jobs/scheduler.py src/lettermate/cli.py src/lettermate/config.py tests/test_scheduler.py
git commit -m "feat: schedule and recover daily runs"
```

## Task 12: Deploy Web and Worker With Postgres

**Requirements:** hosted persistence, migrations, security, release criterion 10

**Files:**
- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Modify: `.env.example`
- Modify: `src/lettermate/config.py`
- Modify: `src/lettermate/db/session.py`
- Modify: `README.md`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add Postgres integration tests**

Run migration, repository, locking/idempotency and web/worker shared-state tests against an ephemeral Postgres service in CI. SQLite remains the fast local unit-test backend.

- [ ] **Step 2: Build one image with separate web and worker commands**

Use Python 3.12 slim, install the built wheel, run migrations as a release step and expose no source tree dependency. Web starts Uvicorn; worker starts `lettermate scheduler`.

- [ ] **Step 3: Compose Postgres, web and worker**

Add healthchecks, dependency conditions, persistent Postgres volume, secrets via environment, one worker replica and no shared SQLite file.

- [ ] **Step 4: Verify migration and restart behavior**

Bring the stack up, create data, restart web and worker separately and confirm shared state, job history and preference snapshots remain available.

- [ ] **Step 5: Run container acceptance and commit**

```powershell
docker compose config
docker compose up --build -d
docker compose run --rm web alembic upgrade head
docker compose ps
curl.exe --fail http://127.0.0.1:8000/health
git add Dockerfile docker-compose.yml .env.example pyproject.toml src README.md .github/workflows/ci.yml
git commit -m "feat: deploy LetterMate web and worker"
```

Expected: Postgres, web and one worker are healthy; no private value is committed or printed.

## Task 13: Run Pilot, Publish Evidence, and Close the Portfolio MVP

**Requirements:** business metrics; release criteria 8 and 11-14; required portfolio artifacts

**Files:**
- Create: `docs/adr/0001-workflow-and-agent-boundary.md`
- Create: `docs/adr/0002-structured-preference-memory.md`
- Create: `docs/adr/0003-evaluation-strategy.md`
- Create: `docs/adr/0004-dedicated-scheduler-and-postgres.md`
- Create: `docs/pilot/owner-dogfood-log.md`
- Create: `docs/pilot/external-user-feedback.md`
- Create: `docs/retrospective.md`
- Create: `docs/evals/reports/portfolio-final.md`
- Modify: `README.md`
- Modify: `configs/sources.example.yaml`

- [ ] **Step 1: Configure the real owner instance**

Use at least twenty private sources in deployment and at least five replaceable public demo sources in the repository. Configure owner auth, scheduler token, feedback secret, real structured model, budget and SMTP credentials through deployment secrets.

- [ ] **Step 2: Record the one-week pre-product time baseline**

Measure daily source-scanning minutes and items acted on for seven days before the dogfood comparison. Store aggregated numbers without private browsing details.

- [ ] **Step 3: Complete fourteen-day owner dogfood**

Record scheduled/actual delivery, useful/save actions, issue completion time, duplicate sends, unexplained failures, latency and cost. Do not edit the log retroactively to remove failures.

- [ ] **Step 4: Complete an isolated external-user pilot**

Deploy a separate configured instance for one user for seven days. Require at least three delivered issues and ten feedback actions; conduct one interview and link at least one product change to evidence from the pilot.

- [ ] **Step 5: Run final Eval and framework-exit review**

Use at least 100 real items, 30 labels and a holdout set. Publish all four baselines, business/quality/trajectory/operational metrics, failed slices and whether the Agent SDK remains justified.

- [ ] **Step 6: Write ADRs and retrospective**

Document selected/rejected technologies, one failed prompt/tool/framework/ranking/deployment experiment, SMTP exactly-once limitation, privacy controls and how AI-generated code was reviewed and verified.

- [ ] **Step 7: Complete README and public demo evidence**

Include verified local/Docker/hosted setup, architecture diagram, workflow/Agent boundary, tool permissions, memory, Eval, failure semantics, privacy, live reviewer access and non-private screenshots/walkthrough.

- [ ] **Step 8: Run the final release gate**

```powershell
.\.venv\Scripts\python.exe -m pytest -q
.\.venv\Scripts\python.exe -m ruff check .
.\.venv\Scripts\python.exe -m mypy src
.\.venv\Scripts\python.exe -m build
.\.venv\Scripts\alembic.exe check
npm run security-eval
docker compose config
docker compose up --build -d
curl.exe --fail http://127.0.0.1:8000/health
```

Expected: every command returns 0; the requirements coverage matrix below points to stored evidence for all fourteen release criteria.

- [ ] **Step 9: Commit the portfolio release**

```powershell
git add README.md configs docs evals
git commit -m "docs: publish LetterMate agentic MVP evidence"
git status --short
```

Expected: worktree is clean except ignored private/local artifacts.

## 5. PRD Requirement Coverage

| Requirement Group | Implemented By | Primary Evidence |
| --- | --- | --- |
| FR-SRC-01 to FR-SRC-07 | Tasks 2-3 | repository, normalization, sanitization, conditional-fetch and failure-isolation tests |
| FR-RANK-01 to FR-RANK-04 | Task 4 | deterministic prefilter/ranking tests and score breakdown records |
| FR-AGENT-01 to FR-AGENT-09 | Tasks 2, 4, 8-9 | tool-contract, trace, budget, injection and Agent Eval tests |
| FR-MEM-01 to FR-MEM-07 | Tasks 2, 7 | snapshot derivation, replay, reset and feedback tests |
| FR-NL-01 to FR-NL-06 | Tasks 2, 5, 7 | builder, membership, send-state and signed-link tests |
| FR-JOB-01 to FR-JOB-07 | Tasks 2, 6, 11 | job lifecycle, offline E2E, scheduler and recovery tests |
| FR-UX-01 to FR-UX-07 | Task 10 | authentication, API and rendered-view tests |
| EV-DATA-01 to EV-DATA-04 | Tasks 1, 13 | schema tests, sanitized samples and final dataset report |
| Reliability/failure semantics | Tasks 3, 5-6, 8, 11-12 | failure-path tests, JobEvents, restart and container acceptance |
| Security/privacy | Tasks 3, 7-10, 12 | SSRF, sanitization, HMAC, redacted trace, auth and injection tests |
| Business value hypotheses | Tasks 1, 9, 13 | pre-product baseline, dogfood metrics and external pilot evidence |
| Technical exit/upgrade criteria | Tasks 9, 13 | framework-exit report and ADRs |

## 6. Release Acceptance Coverage

| Release Criterion | Task | Required Proof |
| --- | --- | --- |
| 1. Clean Python 3.12 gates | Tasks 0, 13 | pytest, Ruff, mypy, build exit 0 |
| 2. Offline workflow reruns | Task 6 | E2E twice with stable counts and no external calls |
| 3. Five sources and isolation | Tasks 3, 13 | public config plus failed-source test |
| 4. Agent contracts/traces | Task 8 | tool, budget, output and complete-trace tests |
| 5. Prompt-injection safety | Task 9 | pytest and Promptfoo reports |
| 6. Feedback changes ranking | Task 7 | snapshot replay and later-ranking fixture |
| 7. Four baseline report | Tasks 1, 9, 13 | shared holdout dated report |
| 8. Honest metrics | Tasks 9, 13 | target table with passed and failed slices |
| 9. Dry and real send | Tasks 5, 13 | SMTP fake tests and controlled send record |
| 10. Healthy hosted service | Task 12 | healthcheck, migrations, web/worker/Postgres state |
| 11. Fourteen-day owner dogfood | Task 13 | immutable aggregated dogfood log |
| 12. External user pilot | Task 13 | isolated instance log, actions and interview summary |
| 13. Complete README | Task 13 | reviewer follows verified runbook |
| 14. Retrospective | Task 13 | decisions, failures and AI-code verification record |

## 7. Checkpoints and Estimated Effort

| Checkpoint | Tasks | Outcome | Estimate |
| --- | --- | --- | --- |
| Baseline and measurement | 0-1 | Green repo and control-group Eval | 1-1.5 days |
| Reliable non-Agent product | 2-6 | Complete offline daily workflow | 4-5 days |
| Memory and bounded Agent | 7-8 | Feedback snapshots and audited tool loop | 3-4 days |
| Quality/security proof | 9 | Four variants and red-team gates | 1.5-2 days |
| Product surface | 10-11 | Protected dashboard and scheduler | 2-3 days |
| Hosted system | 12 | Postgres web/worker deployment | 1.5-2 days |
| Real-use evidence | 13 | Dogfood, pilot, Eval and retrospective | 14 calendar days minimum |

Estimated implementation effort before the required observation period is 13-17.5 focused developer days. The fourteen-day dogfood period cannot be compressed into simulated evidence.

## 8. Execution Options

1. **Subagent-Driven (recommended):** execute one Task per fresh implementation agent, followed by specification and quality reviews before proceeding.
2. **Inline Execution:** use `superpowers:executing-plans` in this session with review checkpoints after Tasks 1, 6, 9, 12 and 13.
