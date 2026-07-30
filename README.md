# LetterMate

[English](./README_EN.md)

LetterMate 是个人信息发现工作台。用户可以用一个完整关键词精准追踪新内容；系统也会从外部技术趋势榜单收集搜索种子。两类候选都经过多来源搜索、正文补全、事实支持过滤、去重和 AI 评审，最终在统一 Feed 中显示带原始链接的中文摘要。

> 当前核心发现流程、调度、统一 Feed 和刷新反馈已经实现。身份层仍是开发版：Web 固定发送 `x-user-id: user-a`，API 仅按该请求头隔离数据，尚未实现可用于生产的登录、会话和 CSRF 流程。真实外部来源还需使用本地凭据分别完成联调。

## 当前能力

- 精准关键词：保留产品名、项目名和版本段。`gpt-5.7` 不会宽化为一般 GPT/AI 内容，也不会匹配 `gpt-5.7.1`。
- 主发现连接器：OpenRouter Web Search、TwitterAPI.io（X）、RSS/Atom、Hacker News、arXiv、GitHub、Brave-compatible Search、YouTube、Reddit、Bluesky 和 Bilibili。
- 趋势输入：X/TwitterAPI.io、Hacker News、YouTube、Reddit、Bilibili 和 Google Trends RSS；它们只产生种子，不能直接产生 Feed 条目。
- 高精度管线：技术垂直分类、多来源搜索、正文补全、核心事实支持门控、精确与近似去重、历史增量判断、来源多样性和中文摘要。
- 两类调度：缺少 TrendMonitor 时以默认 4 小时间隔创建，之后按其持久化周期运行；Topic 创建后立即运行，之后按 6、12 或 24 小时自适应更新。
- 统一 Feed：`all | topic | trend` 来源筛选，`1d | 3d | 7d | 30d | 90d | all` 时间范围，默认 `30d`，并按自然时间分组。
- 权威刷新反馈：点击或移动端顶部下拉后显示非阻塞进度，完成数量来自持久化运行摘要。

趋势榜单出现不代表事实成立。只有找到支持核心事实的正文、一手平台记录、官方发布、代码 Release、论文或其他实质材料后，内容才可能入库。产品不显示可信分数、来源排名、证据数量、内部评分或“已核实”标签。

## 本地开发

要求 Node.js 24+、npm 11+、PostgreSQL 和 Redis（可使用 Docker Desktop）。

```powershell
npm install
Copy-Item .env.example .env
docker compose -f infra/compose.yaml up -d
npm run db:generate
npm run db:deploy
npm run dev
```

另开终端启动 Worker；否则 API 入队的 Topic 和趋势任务不会被消费：

```powershell
npm run dev -w @lettermate/worker
```

Web 地址为 [http://localhost:5173](http://localhost:5173)，API 默认为 `http://localhost:3000`。

## 配置

以 `.env.example` 为准。所有 Key、Session/CSRF secret、私有 Feed URL 和授权头只允许 API/Worker 服务端读取。真实值只能写入未跟踪的本地 `.env`，不得提交。

| 配置 | 用途 |
| --- | --- |
| `DATABASE_URL`, `REDIS_URL` | PostgreSQL 和 Redis |
| `SESSION_SECRET`, `CSRF_SECRET`, `WEB_ORIGIN` | 服务端会话、CSRF 和 Web Origin |
| `AI_API_KEY`, `AI_MODEL`, `AI_WEB_SEARCH`, `AI_TIMEOUT_MS` | OpenRouter 扩展、分类、评审、生成和可选 Web Search |
| `TWITTERAPI_IO_API_KEY` | TwitterAPI.io 的 X 搜索、线程和 Trends |
| `GITHUB_TOKEN` | 可选 GitHub API 高配额 |
| `YOUTUBE_API_KEY` | YouTube 搜索和 Most Popular |
| `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` | Reddit OAuth 搜索和社区 Hot |
| `SEARCH_PROVIDER`, `SEARCH_API_KEY`, `SEARCH_API_BASE_URL` | Brave-compatible Search 及可选兼容端点 |
| `DISCOVERY_RSS_FEED_URLS` | 逗号分隔的主发现 RSS/Atom URL |
| `DISCOVERY_RUN_TIMEOUT_MS`, `DISCOVERY_CONNECTOR_CONCURRENCY`, `DISCOVERY_SCHEDULER_ENABLED` | 发现运行时限、连接器并发和 Topic 自动调度 |
| `TREND_MONITOR_ENABLED`, `TREND_INTERVAL_HOURS` | 趋势自动调度开关；间隔默认 4 小时，仅用于创建缺失的 TrendMonitor。已有记录以持久化的 `intervalHours` 为准，环境变量变化不会修改它 |
| `TREND_X_WOEIDS` | X Trends 地区 ID，逗号分隔 |
| `TREND_YOUTUBE_REGION` | YouTube 两位地区代码 |
| `TREND_REDDIT_COMMUNITIES` | Reddit 社区名称，逗号分隔 |
| `TREND_GOOGLE_RSS_URLS` | Google Trends HTTPS RSS URL，逗号分隔 |

Hacker News、arXiv、Bluesky 和 Bilibili 不需要平台 Key；GitHub 公共 API 无 Token 也可使用。RSS/Atom 和 Google Trends RSS 不需要 Key，但必须配置对应 URL。缺少其他可选凭据时只禁用对应渠道。

## API

- `POST /api/v1/topics`：创建完整关键词 Topic 并触发首次发现。
- `GET /api/v1/topics`：读取 Topic 调度、状态和最新运行摘要。
- `POST /api/v1/topics/:id/refresh`：登记 Topic 手动刷新。
- `GET /api/v1/trends/status`：读取当前用户的安全趋势状态和最新运行摘要。
- `POST /api/v1/trends/refresh`：登记趋势手动刷新。
- `GET /api/v1/feed?range=1d|3d|7d|30d|90d|all&origin=all|topic|trend&kind=hot|quality&topicId=...`：读取统一 Feed；默认 `range=30d&origin=all`。
- `GET /api/v1/items/:id`：读取 Topic 或趋势条目的摘要、理由和原始链接。
- `GET /api/v1/discovery-sources`：读取脱敏连接器启用状态。

指定 `topicId` 时不能使用 `origin=trend`。Feed 历史永久保留，时间范围只控制服务端查询窗口。

## 验证

```powershell
npm run db:generate
npm run db:deploy
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
```

默认测试不访问外网。Live smoke test 必须同时提供开关和对应 Key：

```powershell
$env:RUN_LIVE_AI_TESTS='1'
# 同时设置 AI_API_KEY
npm test -- apps/worker/src/openrouter.live.test.ts

$env:RUN_LIVE_TWITTERAPI_IO_TESTS='1'
# 同时设置 TWITTERAPI_IO_API_KEY
npm test -- apps/worker/src/twitterapi-io.live.test.ts
```

缺少 live 凭据时测试会跳过。Playwright 使用确定性 Fake 流程覆盖 1440px 桌面、平板、手机和 320px 紧凑视口。

详细文档：

- [产品需求](./docs/requirements.md)
- [技术方案](./docs/design.md)
