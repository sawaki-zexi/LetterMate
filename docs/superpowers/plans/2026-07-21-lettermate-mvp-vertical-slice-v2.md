# LetterMate MVP Vertical Slice V2 Implementation Plan

> **Paused on 2026-07-21:** `docs/lettermate-agentic-product-requirements-v2.md`
> introduces the bounded curation Agent, preference snapshots, formal Eval,
> hosted pilot, and real-user acceptance. Do not execute this plan as the active
> baseline. It is replaced by
> `docs/superpowers/plans/2026-07-21-lettermate-agentic-mvp-v3-implementation-plan.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付一个可重复运行、可离线演示、可接入真实 OpenAI 和 SMTP、并通过 API/Dashboard 观察运行状态的 LetterMate MVP。

**Architecture:** 保留 Python/FastAPI/SQLAlchemy/SQLite 模块化单体，按 `sync sources -> collect -> analyze -> build -> send` 垂直闭环推进。外部 feed、LLM、SMTP 都通过可注入协议隔离；持久化写入必须幂等；每个流水线阶段独立记录 `JobRun` 和失败事件。

**Tech Stack:** Python 3.12, FastAPI, Typer, SQLAlchemy, SQLite, Pydantic, feedparser, BeautifulSoup, httpx, APScheduler, Jinja2, OpenAI Python SDK, pytest, Ruff, mypy, Docker Compose.

---

## 1. 文档状态

本计划原为 2026-07-21 的任务级开发基线，现因 Agentic Product Requirements V2 引入新范围而暂停。它仅保留为规划历史，并曾取代：

- `docs/superpowers/plans/2026-06-26-lettermate-mvp-implementation-plan.md`
- `docs/superpowers/plans/2026-07-21-lettermate-mvp-realigned-implementation-plan.md`

当前产品范围、Agent 边界和验收目标以 `docs/lettermate-agentic-product-requirements-v2.md` 为准。本计划不覆盖新增的 Agent、偏好记忆、Eval、部署和真实用户要求，因此不再定义执行顺序。

当前事实基线：

| 范围 | 状态 | 证据 |
| --- | --- | --- |
| Settings | 已实现 | `src/lettermate/config.py` |
| SQLAlchemy 模型 | 部分实现 | 缺 `NewsletterItem` 和完整唯一约束 |
| Repository | 部分实现 | 内容去重不符合新契约，分析与 Newsletter 不幂等 |
| YAML 配置 | 已实现 | 仅验证单来源，缺配置同步服务 |
| 测试 | 局部绿色 | Python 3.13 下 7 个测试通过；目标 Python 3.12 环境未建立 |
| 静态检查 | 未通过 | Ruff 4 个错误，mypy 2 个错误 |
| 业务闭环 | 未实现 | Collector、LLM、Builder、Notifier、Jobs、CLI 均缺失 |
| 产品界面 | 未实现 | FastAPI、Dashboard 均缺失 |
| 交付 | 未实现 | Git、README、Docker、安装态验收均缺失 |

## 2. MVP 验收标准

以下条件必须全部满足，才能将 MVP 标记为完成：

1. Python 3.12 虚拟环境中 `pytest`、`ruff`、`mypy`、`build` 均返回 0。
2. 至少 5 个 RSS/RSSHub 来源可通过 YAML 幂等同步，重复同步不产生重复来源。
3. 单个命令可完成采集、分析、Newsletter 生成和邮件 dry-run/真实发送。
4. 一个来源失败不影响其他来源；失败原因写入 `JobEvent`。
5. 重复运行任一阶段不会产生重复 Source、ContentItem、AnalysisResult、Newsletter、NewsletterItem 或重复邮件发送。
6. 内容按规范化 URL、来源内 external ID、内容 hash 三层顺序去重；内容 hash 不包含 URL。
7. Fake LLM 完全确定且不访问网络；真实运行支持 OpenAI structured output。
8. 每个流水线阶段创建独立 `JobRun`，记录开始、完成、失败时间和错误事件。
9. Dashboard 展示来源、内容与分析、Newsletter、最近任务和来源失败。
10. 完整离线端到端测试覆盖首次运行和重复运行，不访问真实 RSS、LLM 或 SMTP。
11. 安装后的 `lettermate` 命令、Jinja 模板和静态资源可用，不依赖源码目录偶然存在。
12. Docker healthcheck 正常，README 中的本地与 Docker 指令经过实际验证。

## 3. 目标文件结构

```text
D:\LetterMate
|- .gitignore
|- Dockerfile
|- README.md
|- docker-compose.yml
|- pyproject.toml
|- configs
|  |- demo-feed.xml
|  |- preferences.example.yaml
|  `- sources.example.yaml
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
|  |  |- session.py
|  |  `- statuses.py
|  |- jobs
|  |  |- runner.py
|  |  `- scheduler.py
|  |- llm
|  |  |- prompts.py
|  |  |- provider.py
|  |  |- schemas.py
|  |  `- service.py
|  |- newsletters
|  |  `- builder.py
|  |- notifiers
|  |  `- email.py
|  |- sources
|  |  |- cleaner.py
|  |  |- collector.py
|  |  |- config_loader.py
|  |  |- normalization.py
|  |  `- service.py
|  |- web/static/styles.css
|  `- cli.py
`- tests
   |- fixtures/sample-feed.xml
   |- test_api.py
   |- test_cli.py
   |- test_collectors.py
   |- test_daily_pipeline.py
   |- test_email_notifier.py
   |- test_jobs.py
   |- test_llm_analysis.py
   |- test_models.py
   |- test_newsletter_builder.py
   |- test_repository.py
   `- test_scheduler.py
```

## 4. 开发规则

- 所有行为变更执行 TDD：先写失败测试，再最小实现，再运行目标测试和全量门禁。
- 所有本地命令固定使用 `.\.venv\Scripts\python.exe`，禁止依赖系统默认 `python`。
- 持久化使用 UTC；Asia/Shanghai 的 Newsletter 日期只在服务边界转换。
- 状态值集中定义在 `src/lettermate/db/statuses.py`，不在业务文件散落字符串。
- Feed、LLM、SMTP 客户端必须可注入，测试不得 monkeypatch 网络底层。
- 每个流水线阶段拥有独立数据库 Session；失败时先 rollback，再用可用事务记录失败状态。
- 本 MVP 不引入 Alembic、LangGraph、任务队列、多用户权限、RAG 或非 RSS 抓取。
- 每个 Task 通过验收后单独提交；不得把多个失败门禁积压到最后修复。

## Task 0: 建立可复现的绿色开发基线

**Files:**
- Modify: `.gitignore`
- Modify: `README.md`
- Modify: `pyproject.toml`
- Modify: `tests/conftest.py`
- Modify: `src/lettermate/db/repository.py`
- Modify: `src/lettermate/sources/__init__.py`
- Modify: `src/lettermate/sources/config_loader.py`

- [ ] **Step 1: 固定 Python 3.12 与开发依赖**

将 `requires-python` 改为 `>=3.12,<3.13`，在 dev extra 中加入 `build>=1.2.2`。执行：

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"
```

Expected: `python.exe --version` 输出 Python 3.12.x，依赖安装成功。

- [ ] **Step 2: 建立仓库卫生规则**

`.gitignore` 必须覆盖 `.env`、`.venv/`、三类工具缓存、`__pycache__/`、覆盖率产物、构建产物、`data/` 和 `*.egg-info/`。

- [ ] **Step 3: 写入当前真实状态 README**

README 只声明已实现的 Settings、数据库基础、Repository 和 YAML 配置；明确完整流水线、API 与 Dashboard 尚未完成，并链接本计划。

- [ ] **Step 4: 修复现有静态检查错误与测试资源释放**

为 `save_newsletter.issue_date` 增加 `date` 类型，为 `read_yaml` 使用 `dict[str, Any]`，格式化超长导入与表达式。`temp_db_session` fixture 在 `yield` 后执行 `engine.dispose()`，消除 SQLite 连接警告。

- [ ] **Step 5: 运行基线门禁**

```powershell
.\.venv\Scripts\python.exe -m pytest -q
.\.venv\Scripts\python.exe -m ruff check .
.\.venv\Scripts\python.exe -m mypy src
.\.venv\Scripts\python.exe -m build
```

Expected: 四条命令全部返回 0，无 ResourceWarning。

- [ ] **Step 6: 初始化 Git 并提交**

```powershell
git init
git add .
git status --short
git commit -m "chore: establish reproducible development baseline"
```

Expected: 缓存、`.venv`、`.env`、数据库和构建产物不在暂存区。

## Task 1: 修复持久化、来源同步与去重契约

**Files:**
- Create: `src/lettermate/db/statuses.py`
- Create: `src/lettermate/sources/normalization.py`
- Modify: `src/lettermate/db/models.py`
- Modify: `src/lettermate/db/repository.py`
- Modify: `src/lettermate/db/__init__.py`
- Modify: `tests/test_models.py`
- Modify: `tests/test_repository.py`

- [ ] **Step 1: 写 URL、guid、hash 和 Source 同步失败测试**

测试必须证明：URL fragment 被移除；scheme/host 大小写统一；同一来源相同 external ID 去重；相同正文跨 URL 去重；同一 Source URL 重复同步更新名称、标签和 enabled，而不是新增记录。

- [ ] **Step 2: 运行测试并确认当前实现失败**

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_repository.py -q
```

Expected: 新增的 URL 规范化、guid、跨 URL hash、Source 同步测试失败。

- [ ] **Step 3: 定义稳定状态与模型约束**

`statuses.py` 定义 Source/Content/Newsletter/Job 使用的常量。`ContentItem.external_id` 改为 `str | None`，并增加唯一约束：全局规范化 URL、`(source_id, external_id)`、全局内容 hash。`Source.url` 使用唯一约束。

- [ ] **Step 4: 增加可追溯 NewsletterItem**

`NewsletterItem` 包含 `newsletter_id`、`content_item_id`、`rank`、`section`，并对 `(newsletter_id, content_item_id)` 建唯一约束；`Newsletter` 和 `ContentItem` 增加双向关系。

- [ ] **Step 5: 实现确定性规范化和查找顺序**

`normalize_url(value: str) -> str` 移除 fragment、统一 scheme/host、移除默认端口并保留业务 query。内容 hash 仅由规范化标题与清洗正文组成。查找顺序固定为 URL、来源内 external ID、内容 hash。

- [ ] **Step 6: 实现幂等写入方法**

Repository 增加 `sync_source`、`replace_newsletter_items`、`mark_newsletter_sent`、`mark_newsletter_send_failed`。`save_analysis` 更新已有一对一记录；`save_newsletter` 更新同一 issue date；重复调用保留原主键。

- [ ] **Step 7: 验证并提交**

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_models.py tests/test_repository.py -q
.\.venv\Scripts\python.exe -m ruff check .
.\.venv\Scripts\python.exe -m mypy src
git add src/lettermate/db src/lettermate/sources/normalization.py tests/test_models.py tests/test_repository.py
git commit -m "fix: make persistence and source sync idempotent"
```

## Task 2: 实现可隔离失败的 RSS/RSSHub 采集

**Files:**
- Create: `src/lettermate/sources/cleaner.py`
- Create: `src/lettermate/sources/collector.py`
- Create: `src/lettermate/sources/service.py`
- Create: `tests/fixtures/sample-feed.xml`
- Create: `tests/test_collectors.py`
- Modify: `pyproject.toml`

- [ ] **Step 1: 将 httpx 移入运行时依赖**

Collector 在生产运行中使用 `httpx.Client`，因此 `httpx>=0.27.2` 必须位于 `[project].dependencies`，不能只在 dev extra 中。

- [ ] **Step 2: 写解析和清洗失败测试**

覆盖 RSS/Atom 字节解析、HTML 清洗、缺少作者/时间、无效条目、UTC 时间、空正文和相对链接。fixture 只使用本地 XML。

- [ ] **Step 3: 实现纯解析组件**

`clean_html(value: str) -> str` 只负责正文清洗；`parse_feed_bytes(payload: bytes) -> list[CollectedItem]` 只负责 feed 到领域输入的转换，不读网络、不写数据库。

- [ ] **Step 4: 写多来源隔离测试**

Fake client 对一个 URL 返回 feed bytes，对另一个 URL 抛出异常。断言成功来源的数据被保存、失败来源被收集到 `CollectionResult.failures`、成功来源的 `last_fetched_at` 被更新。

- [ ] **Step 5: 实现 FeedClient 与采集服务**

定义 `FeedClient.fetch(url: str) -> bytes` 协议和 `HttpFeedClient`。`collect_enabled_sources` 对每个来源建立独立错误边界，返回成功数、新增/重复条目数和结构化失败列表，不直接创建 `JobRun`。

- [ ] **Step 6: 验证并提交**

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_collectors.py -q
.\.venv\Scripts\python.exe -m ruff check .
.\.venv\Scripts\python.exe -m mypy src
git add pyproject.toml src/lettermate/sources tests/fixtures tests/test_collectors.py
git commit -m "feat: collect and normalize RSS sources"
```

## Task 3: 实现确定性的 Fake LLM 分析链路

**Files:**
- Create: `src/lettermate/llm/schemas.py`
- Create: `src/lettermate/llm/prompts.py`
- Create: `src/lettermate/llm/provider.py`
- Create: `src/lettermate/llm/service.py`
- Create: `tests/test_llm_analysis.py`
- Modify: `src/lettermate/config.py`
- Modify: `.env.example`

- [ ] **Step 1: 写 schema 与 Fake provider 测试**

测试 `score` 只能为 1-5；输出必须包含 summary、tags、score、reason、actionable_insight、should_include、model；相同输入的 Fake provider 返回完全相同结果。

- [ ] **Step 2: 运行测试并确认模块尚不存在**

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_llm_analysis.py -q
```

Expected: collection error 指向 `lettermate.llm` 模块缺失。

- [ ] **Step 3: 实现 schema、prompt 与协议**

定义 `AnalysisRequest`、`AnalysisPayload`、`AnalysisOutput`；`AnalysisPayload.score` 使用 Pydantic `Field(ge=1, le=5)`；定义 `LLMProvider.analyze(request) -> AnalysisOutput` 协议。

- [ ] **Step 4: 实现 FakeLLMProvider**

Fake provider 不读 API key、不访问网络，以稳定规则生成分数、标签和 inclusion decision，并固定 `model="fake-local"`。

- [ ] **Step 5: 实现分析服务幂等测试与服务**

测试重复分析同一 item 只保留一个 `AnalysisResult`。服务读取 pending items、调用 provider、保存结果；单条失败记录在结果中并继续其他 item，JobEvent 由后续 job 层统一创建。

- [ ] **Step 6: 验证并提交**

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_llm_analysis.py tests/test_repository.py -q
.\.venv\Scripts\python.exe -m ruff check .
.\.venv\Scripts\python.exe -m mypy src
git add .env.example src/lettermate/config.py src/lettermate/llm tests/test_llm_analysis.py
git commit -m "feat: add deterministic structured analysis"
```

## Task 4: 实现 Newsletter 构建与安全邮件发送

**Files:**
- Create: `src/lettermate/newsletters/builder.py`
- Create: `src/lettermate/notifiers/email.py`
- Create: `tests/test_newsletter_builder.py`
- Create: `tests/test_email_notifier.py`
- Modify: `src/lettermate/db/repository.py`

- [ ] **Step 1: 写纯 Newsletter builder 测试**

覆盖 score 降序、同分按时间降序、阈值、max_items、HTML 转义、空 Newsletter 和 Asia/Shanghai 日期窗口。

- [ ] **Step 2: 实现纯 builder 与日期窗口查询**

`build_newsletter` 不访问数据库，返回 issue_date、title、markdown、html、item_ids。Repository 查询把 Asia/Shanghai 当日边界转换为 UTC，筛选 `should_include` 并保持确定顺序。

- [ ] **Step 3: 写 dry-run 与 SMTP 测试**

覆盖 dry-run 不创建 SMTP 连接、TLS、可选登录、发送成功和 SMTP 异常。Notifier 测试不创建 Newsletter，也不访问 Repository。

- [ ] **Step 4: 实现 EmailNotifier**

使用 `EmailMessage`、`EmailSendResult` 和可注入 SMTP factory。Notifier 只返回 dry-run/发送结果或抛出发送异常，不修改 Newsletter；draft、sent、send_failed 状态由 Task 5 的 `run_send` 统一管理。

- [ ] **Step 5: 验证并提交**

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_newsletter_builder.py tests/test_email_notifier.py tests/test_repository.py -q
.\.venv\Scripts\python.exe -m ruff check .
.\.venv\Scripts\python.exe -m mypy src
git add src/lettermate/newsletters src/lettermate/notifiers src/lettermate/db/repository.py tests/test_newsletter_builder.py tests/test_email_notifier.py
git commit -m "feat: build newsletters and deliver email safely"
```

## Task 5: 打通可观察的离线每日闭环与 CLI

**Files:**
- Create: `src/lettermate/jobs/runner.py`
- Create: `src/lettermate/cli.py`
- Create: `configs/demo-feed.xml`
- Create: `tests/test_jobs.py`
- Create: `tests/test_cli.py`
- Create: `tests/test_daily_pipeline.py`
- Modify: `tests/conftest.py`
- Modify: `src/lettermate/db/repository.py`

- [ ] **Step 1: 增加 Session factory fixture 与 JobRun 生命周期测试**

测试成功任务写 completed/finished_at；失败任务 rollback 后写 failed 和 error `JobEvent`；collect 的单来源失败写 warning 事件但阶段可完成。发送测试证明 dry-run 保持 draft、真实成功写 sent/sent_at、异常写 send_failed、已发送 issue 默认跳过且 `force=True` 才允许显式重发。

- [ ] **Step 2: 实现独立阶段 runner**

实现 `run_sync_sources`、`run_collect`、`run_analyze`、`run_newsletter`、`run_send`。每个 runner 创建独立 Session 和 `JobRun`；异常时 rollback 后重新获取可用事务记录失败，再抛出原异常。`run_send` 是 Newsletter 发送状态的唯一写入边界。

- [ ] **Step 3: 实现 run_daily**

阶段严格按 sync sources、collect、analyze、newsletter、send 顺序运行。来源局部失败不阻断；同步、分析、构建或发送阶段失败时停止后续依赖阶段。返回每个阶段的 job ID、状态和计数。

- [ ] **Step 4: 写 CLI 测试并实现命令**

实现 `sync-sources`、`collect`、`analyze`、`newsletter`、`send`、`run-daily`。所有命令打印 job ID 和结果计数。`run-daily --feed-fixture configs/demo-feed.xml --dry-run` 先同步 YAML 来源，再使用对任意来源 URL 返回同一本地 XML 的 `FixtureFeedClient`、Fake LLM 和邮件 dry-run，不访问网络。

- [ ] **Step 5: 写完整离线重复运行测试**

同一数据连续执行 `run_daily` 两次，断言 Source、ContentItem、AnalysisResult、Newsletter、NewsletterItem 各只有一份业务记录；两轮 JobRun 均完整；SMTP factory 调用次数为 0。

- [ ] **Step 6: 运行垂直切片检查点**

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_jobs.py tests/test_cli.py tests/test_daily_pipeline.py -q
.\.venv\Scripts\lettermate.exe run-daily --feed-fixture configs/demo-feed.xml --dry-run
.\.venv\Scripts\python.exe -m pytest -q
.\.venv\Scripts\python.exe -m ruff check .
.\.venv\Scripts\python.exe -m mypy src
```

Expected: 所有命令返回 0；CLI 输出完成的五阶段 job ID；没有网络或 SMTP 流量。

- [ ] **Step 7: 提交**

```powershell
git add src/lettermate/jobs src/lettermate/cli.py src/lettermate/db/repository.py configs/demo-feed.xml tests
git commit -m "feat: complete the offline daily workflow"
```

## Task 6: 接入真实 OpenAI structured output

**Files:**
- Modify: `src/lettermate/llm/provider.py`
- Modify: `src/lettermate/config.py`
- Modify: `.env.example`
- Modify: `pyproject.toml`
- Modify: `tests/test_llm_analysis.py`

- [ ] **Step 1: 增加运行时依赖与配置**

加入 `openai` 运行时依赖，以及 `LLM_PROVIDER`、`LLM_MODEL`、`LLM_TIMEOUT_SECONDS`、`LLM_MAX_RETRIES`、`OPENAI_API_KEY`。模型名只来自配置。

- [ ] **Step 2: 写注入 Fake SDK client 的测试**

测试 parsed structured output 正确映射；缺少 parsed output 抛领域错误；未知 provider 名被拒绝；Fake provider 在无 key 时仍可创建。

- [ ] **Step 3: 实现 OpenAIProvider 与 factory**

使用 OpenAI Responses structured-output API，把 `AnalysisPayload` 作为解析 schema。SDK client 从构造函数注入；factory 根据配置创建 fake 或 OpenAI provider。

- [ ] **Step 4: 验证无真实网络测试并提交**

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_llm_analysis.py tests/test_daily_pipeline.py -q
.\.venv\Scripts\python.exe -m ruff check .
.\.venv\Scripts\python.exe -m mypy src
git add pyproject.toml .env.example src/lettermate/config.py src/lettermate/llm tests/test_llm_analysis.py
git commit -m "feat: add OpenAI structured output provider"
```

## Task 7: 建立 API 与操作型 Dashboard

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
- Modify: `src/lettermate/db/repository.py`

- [ ] **Step 1: 写 API 查询和任务触发测试**

覆盖 `/health`、sources、items、newsletters、jobs 查询，以及 collect、analyze、newsletter、send、feedback 写入。测试通过 FastAPI dependency override 注入 Session factory 和 fake clients。

- [ ] **Step 2: 实现薄 API 路由**

路由只做输入校验、调用 Repository/Job service 和序列化，不包含 feed、LLM、构建或 SMTP 逻辑。任务触发响应包含 job ID、状态和计数。

- [ ] **Step 3: 写 Dashboard 渲染测试**

为 `/`、`/dashboard/sources`、`/dashboard/items`、`/dashboard/newsletters`、`/dashboard/jobs` 写数据库种子测试，断言真实表格内容、失败状态和最新 Newsletter 出现。

- [ ] **Step 4: 实现操作型页面**

首屏为运行概览，不做营销 landing page。展示紧凑计数、最新流水线、最近高分内容、最近 Newsletter 和来源失败；子页面使用可扫描表格。

- [ ] **Step 5: 验证并提交**

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_api.py -q
.\.venv\Scripts\python.exe -m ruff check .
.\.venv\Scripts\python.exe -m mypy src
git add src/lettermate/api src/lettermate/dashboard src/lettermate/web src/lettermate/db/repository.py tests/test_api.py
git commit -m "feat: add operational API and dashboard"
```

## Task 8: 完成调度、安装态资源和 Docker

**Files:**
- Create: `src/lettermate/jobs/scheduler.py`
- Create: `tests/test_scheduler.py`
- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Modify: `src/lettermate/cli.py`
- Modify: `pyproject.toml`

- [ ] **Step 1: 写 scheduler 注册测试**

断言存在每 6 小时 collect 和按偏好时间执行的 daily job；二者均设置 `max_instances=1`、`coalesce=True`，并使用可注入的 Session factory 与 clients。

- [ ] **Step 2: 实现 scheduler 与 CLI 入口**

`create_scheduler` 只注册任务；`lettermate scheduler` 启动并阻塞到中断。Scheduler 不导入 Typer command 函数。

- [ ] **Step 3: 配置安装态 package data**

在 `pyproject.toml` 增加：

```toml
[tool.setuptools.package-data]
lettermate = ["dashboard/templates/*.html", "web/static/*.css"]
```

构建 wheel 后在干净临时虚拟环境安装，验证 CLI、模板和 CSS 均存在。

- [ ] **Step 4: 添加容器配置**

Docker 使用 `python:3.12-slim`，安装 wheel，创建 `/app/data`，暴露 8000，使用 Uvicorn 启动。Compose 挂载 `data` 和 `configs`，加载 `.env`，并用 `/health` 做健康检查。

- [ ] **Step 5: 验证并提交**

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_scheduler.py tests/test_api.py -q
.\.venv\Scripts\python.exe -m build
docker compose config
git add src/lettermate/jobs/scheduler.py src/lettermate/cli.py tests/test_scheduler.py pyproject.toml Dockerfile docker-compose.yml
git commit -m "feat: schedule and package the LetterMate service"
```

## Task 9: 文档化并执行最终 MVP 验收

**Files:**
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `configs/sources.example.yaml`
- Modify: `docs/project-proposal-and-architecture.md`

- [ ] **Step 1: 配置 5 个演示来源**

`sources.example.yaml` 至少包含 5 个可替换 RSS/RSSHub 来源；环境相关的 RSSHub host 必须明确标注，不在代码硬编码。

- [ ] **Step 2: 写真实运行手册**

README 包含产品能力、架构图、Python 3.12 建环境指令、离线 fixture demo、真实 OpenAI、SMTP dry-run/real send、API/Dashboard URL、Docker、失败与重跑语义、测试命令、MVP 排除项。

- [ ] **Step 3: 执行本地验收**

```powershell
.\.venv\Scripts\python.exe -m pytest -q
.\.venv\Scripts\python.exe -m ruff check .
.\.venv\Scripts\python.exe -m mypy src
.\.venv\Scripts\python.exe -m build
.\.venv\Scripts\lettermate.exe run-daily --feed-fixture configs/demo-feed.xml --dry-run
.\.venv\Scripts\uvicorn.exe lettermate.api.app:app --host 127.0.0.1 --port 8000
```

Expected: 前五条命令返回 0；`GET /health` 返回 `{"status":"ok"}`；Dashboard 展示离线 demo 数据和最近 JobRun。

- [ ] **Step 4: 验证重复运行与真实资源可见性**

再次执行离线 daily command，确认业务表无重复记录；从构建 wheel 安装的新环境启动 API，确认模板和 CSS 正常加载。

- [ ] **Step 5: 执行 Docker 验收**

```powershell
docker compose up --build
```

Expected: healthcheck 进入 healthy，端口 8000 可访问，容器日志没有导入或模板缺失错误。

- [ ] **Step 6: 完成最终门禁与提交**

```powershell
git status --short
git add README.md .env.example configs docs/project-proposal-and-architecture.md
git commit -m "docs: publish the LetterMate MVP runbook"
```

Expected: 除明确的本地 `.env` 和 `data/` 外工作区干净，12 条 MVP 验收标准均有对应命令或运行证据。

## 5. 阶段检查点

| 检查点 | 完成任务 | 可证明结果 |
| --- | --- | --- |
| Baseline | Task 0 | Python 3.12、Git、四项工具门禁可用 |
| Persistence | Task 1 | Source/内容/分析/Newsletter 重跑幂等 |
| Offline Vertical Slice | Tasks 2-5 | 无网络完成完整 daily workflow |
| Real Runtime | Task 6 | OpenAI structured output 可配置 |
| Product Surface | Task 7 | API 与 Dashboard 展示真实数据 |
| Delivery | Tasks 8-9 | 调度、wheel、Docker、README 通过验收 |

## 6. 验收覆盖矩阵

| 验收标准 | 实现任务 | 权威证据 |
| --- | --- | --- |
| Python 3.12 四项门禁 | Tasks 0、9 | pytest、Ruff、mypy、build 返回 0 |
| 5 个来源幂等同步 | Tasks 1、5、9 | Repository/CLI 测试与重复同步计数 |
| 单命令完整流水线 | Task 5 | 离线 `run-daily` 命令返回 0 |
| 来源失败隔离 | Tasks 2、5 | collector 测试和 warning JobEvent |
| 全链路幂等 | Tasks 1、3-5 | 两次 E2E 后业务表计数不变 |
| 三层内容去重 | Task 1 | URL、guid、hash 独立测试 |
| Fake 与真实 LLM | Tasks 3、6 | Fake 确定性测试和 injected SDK test |
| JobRun/JobEvent | Task 5 | 成功、失败、局部失败生命周期测试 |
| Dashboard 真实数据 | Task 7 | 数据库种子渲染测试与人工页面验收 |
| 离线 E2E | Task 5 | 网络和 SMTP 调用次数为 0 |
| 安装态资源 | Tasks 8、9 | wheel 安装后的 CLI、模板、CSS 验证 |
| Docker 与 README | Task 9 | healthy healthcheck 和逐条运行记录 |

## 7. 估算与优先级

| 优先级 | 任务 | 估算 |
| --- | --- | --- |
| P0 | Task 0 | 0.5-1 天 |
| P1 | Task 1 | 1-1.5 天 |
| P2 | Tasks 2-5 | 3-4 天 |
| P3 | Tasks 6-7 | 2-2.5 天 |
| P4 | Tasks 8-9 | 1-1.5 天 |

单人连续开发预计 7.5-10.5 个工作日。任何阶段出现门禁失败时，先恢复当前检查点，不跨阶段积累失败。

## 8. 执行方式

1. **Subagent-Driven（推荐）**：每个 Task 使用新的执行 agent，Task 结束后进行规格与质量双重审查。
2. **Inline Execution**：在当前会话使用 `superpowers:executing-plans`，于 Tasks 0、1、5、7、9 后设置人工检查点。
