# LetterMate 精准追踪与趋势发现技术方案

**状态：** 当前有效
**更新日期：** 2026-08-02

## 当前开发进度

已实现 Topic 精准追踪、11 个主发现连接器、6 个趋势输入、正文和事实支持门控、Topic/Trend 调度、运行租约、统一 Feed、已入库文章搜索、时间与来源筛选、点击/下拉刷新、持久化新增计数，以及对应 Prisma 迁移和默认离线自动化测试。

当前仍有两个生产交付缺口：

- Web 固定发送 `x-user-id: user-a`，API 直接信任该请求头。真实登录、服务端会话和 CSRF 尚未实现，`SESSION_SECRET` 与 `CSRF_SECRET` 目前只是预留配置。
- 外部连接器的默认测试使用 Fake 或固定响应；OpenRouter、TwitterAPI.io 及其他凭据型来源仍需在目标环境完成 live smoke test、配额和故障行为验收。

## 1. 架构决策

系统保留 Topic 精准追踪和自动趋势发现两条独立、可持久化的运行管线。趋势榜单适配器只产生搜索种子，不产生 Feed 条目；两条管线共享主发现连接器、正文补全、来源验证、事实支持门控、去重、AI 评审和中文内容生成。

```text
Topic keyword
  -> exact KeywordPolicy
  -> SourceRouter + main discovery connectors
  -> content enrichment + keyword/fact-support gates
  -> dedupe + Chinese composition
  -> DiscoveryItem

External trend inputs
  -> TrendSeed normalization + recent-seed dedupe
  -> technology vertical classification
  -> precise source query plans
  -> main discovery connectors
  -> content enrichment + fact-support gate
  -> dedupe + Chinese composition
  -> RadarItem

DiscoveryItem + RadarItem
  -> NestJS unified Feed API
  -> persisted article search and range/origin filters
  -> React calendar groups
```

React Web 只调用 NestJS API。API 负责认证、用户边界、输入验证和 BullMQ 入队；Worker 负责外部网络访问和发现编排；PostgreSQL/Prisma 保存调度与运行真实状态；Redis/BullMQ 传递任务。所有外部密钥和鉴权头只在 API/Worker 服务端存在。

## 2. 模块边界

| 路径 | 职责 |
| --- | --- |
| `apps/web` | Feed、筛选、分组、刷新协调、Topic 管理和安全来源状态 |
| `apps/api` | 用户边界、验证、Feed 合并、运行摘要、Topic/Trend 入队 |
| `apps/worker/src/connectors` | 主发现连接器、候选标准化和安全错误映射 |
| `apps/worker/src/trends` | 趋势榜单适配器和最小化 TrendSeed 收集 |
| `apps/worker/src/keyword-policy.ts` | 完整关键词、必要标识符和有限形式别名 |
| `apps/worker/src/quality-pipeline.ts` | 正文、关键词、事实支持、去重、质量与多样性规则 |
| `apps/worker/src/discovery-service.ts` | Topic 发现编排和原子持久化 |
| `apps/worker/src/trend-service.ts` | 趋势分类、再搜索、质量管线和 RadarItem 持久化 |
| `apps/worker/src/scheduler.ts` | 6/12/24 小时 Topic 调度和租约 |
| `apps/worker/src/trend-scheduler.ts` | 按持久化周期执行 TrendMonitor 调度和租约，并以默认 4 小时补建缺失记录 |
| `packages/contracts` | API、Worker 与 Web 共用 DTO 和 Zod schema |
| `packages/domain` | 来源证明、URL、质量门槛、去重和多样性规则 |
| `packages/config` | 服务端环境配置解析与默认值 |
| `prisma/schema.prisma` | 用户、Topic、Trend、运行和发现条目持久化 |

提供商专有响应不得进入共享契约。完整正文仅在单次 Worker 运行内短期使用，不写入 Feed 条目。

## 3. 来源模型

### 3.1 主发现连接器

`SourceConnector` 接收有限的 `SourceQueryPlan`，返回标准化候选和 `SourceProof`。当前运行时注册：

| 连接器 | 配置 | 用途 |
| --- | --- | --- |
| OpenRouter Web Search | `AI_API_KEY`, `AI_MODEL`, `AI_WEB_SEARCH` | 只接受本次 citation annotation 的 URL |
| TwitterAPI.io | `TWITTERAPI_IO_API_KEY` | X 搜索、原创帖、引用和线程上下文 |
| RSS/Atom | `DISCOVERY_RSS_FEED_URLS` | 配置的 Feed |
| Hacker News | 无 Key | 技术社区条目 |
| arXiv | 无 Key | 论文元数据和摘要 |
| GitHub | 可选 `GITHUB_TOKEN` | 仓库、README、Release 和讨论 |
| Brave-compatible Search | `SEARCH_PROVIDER=brave`, `SEARCH_API_KEY`, 可选 `SEARCH_API_BASE_URL` | 额外 Web 搜索 |
| YouTube | `YOUTUBE_API_KEY` | 视频说明和结构化元数据 |
| Reddit | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` | 结构化社区内容 |
| Bluesky | 无 Key | 公共社交记录 |
| Bilibili | 无 Key | 公共视频内容 |

主发现连接器用于 Topic 搜索，也用于趋势种子的后续验证。缺少可选配置时，对应连接器返回 `not_configured`，不会阻塞公共连接器。

### 3.2 趋势输入

趋势适配器使用独立 `TrendSource` 契约，只返回 `sourceId`、平台、外部 ID、标题、原始 HTTP(S) URL 和可用发布时间：

| 趋势输入 | 配置/入口 |
| --- | --- |
| X Trends | TwitterAPI.io `/twitter/trends`；`TWITTERAPI_IO_API_KEY`, `TREND_X_WOEIDS` |
| Hacker News | 官方 Top Stories；无 Key |
| YouTube | `mostPopular`；`YOUTUBE_API_KEY`, `TREND_YOUTUBE_REGION` |
| Reddit | 指定社区 Hot；Reddit OAuth, `TREND_REDDIT_COMMUNITIES` |
| Bilibili | 公共热门接口；无 Key |
| Google Trends | 配置的 HTTPS Trending RSS；`TREND_GOOGLE_RSS_URLS` |

GitHub 没有在本项目中作为趋势榜单输入；它和 arXiv、RSS/Atom、Web 等主连接器可支持趋势种子的后续内容检索。趋势输入不保存平台顺序、完整响应或敏感请求信息。

## 4. 精准关键词策略

`buildKeywordPolicy` 规范化 Unicode 宽度、大小写和空白，但保留数字版本段和实体边界。确定性别名只改变标点和间距，不创建语义近义词。`SourceRouter` 会丢弃不包含精确短语或必要标识符的 AI 查询，并补充包含完整短语的 release、update、documentation 等有限意图查询。

Topic 首次运行在 `variantsInitialized=false` 时生成扩展词并将其初始化；此后 `expandedTerms` 是用户管理数据，即使为空也不会再次调用 AI 扩展。编辑主关键词或扩展词会保存完整的新集合并登记一次发现运行。

候选必须在标题或正文中命中完整短语或确认变体。例如：

- `gpt-5.7`、`GPT 5.7`、`gpt5.7` 可以表示同一形式标识；
- `GPT`、`latest GPT model` 和宽泛 AI 内容不匹配；
- `gpt-5.7.1` 是另一个版本，不能作为 `gpt-5.7` 的命中。

命中检查发生在 AI 质量评审之前。这样即使上游扩展或搜索结果过宽，也不能越过 Topic 的完整关键词边界。

## 5. 趋势编排

1. `TrendRegistry` 对启用的趋势源执行有限并发、单源超时、schema 验证、URL 规范化和失败隔离。
2. `TrendDiscoveryService` 按外部 ID、规范化 URL 和标题指纹去重，并跳过近期已处理的种子。
3. OpenRouter 的结构化分类仅接受 AI、技术、软件产品、工程和研究种子，并保留实体、产品名和版本标识。
4. 接受的种子转换为精准 `SourceQueryPlan`，通过主发现连接器执行多来源搜索。
5. 候选进入与 Topic 相同的正文补全、事实支持门控、去重、质量和中文内容生成流程。
6. 最终条目在一个事务中写入 `RadarItem`，`newItemCount` 来自实际新插入行。

趋势榜单中的出现和热度不构成事实证明。若标题声称发布、上线或其他事件，而正文、一手平台记录、代码 Release 或论文记录不能支持核心事实，候选必须被拒绝。至少一个趋势源成功且后续质量管线完成时，零结果是成功；所有趋势源失败或 AI 阶段失败时，不写半成品。

## 6. 质量、安全与去重

统一管线按以下顺序处理：

1. 验证候选结构、时间、HTTP(S) URL 和 `SourceProof`。
2. 过滤搜索页、分类页、登录页、广告页、采集模板、明显无关和过期内容。
3. 按平台 ID、规范化 URL 和已知重定向精确去重。
4. 补全网页正文、线程、README、Release Notes、论文摘要、视频说明或字幕。
5. 对 Topic 应用精确关键词命中；对两类候选应用 `claimSupport === 'supported'` 门控。
6. 按标题和正文指纹近似去重，并与当前用户历史比较信息增量。
7. AI 批量评审相关性、原创性、实质性、时效性和可理解性。
8. 应用来源多样性后，仅为最终结果生成中文摘要、推荐理由和 `hot | quality` 分类。

AI 只能引用已验证候选池中的 URL。外部抓取在每次请求和重定向前执行 DNS/地址检查，拒绝 localhost、环回、私网、链路本地和云元数据地址，并限制 MIME、大小、重定向数和超时。

事实支持判断是内部运行门控，不持久化为用户状态。数据库、API 和 Web 不暴露可信分数、来源排名、证据数量、内部评分或“已核实”标签。

## 7. 数据与一致性

- `Topic`：完整关键词、用户管理的扩展词、`variantsInitialized`、软删除时间、运行状态、`queuedTrigger`、`nextRunAt`、6/12/24 小时周期和最新安全运行摘要。
- `DiscoveryRun`：Topic 触发方式、状态、开始/结束时间、运行时关键词/扩展词快照和实际新增数。
- `DiscoveryItem`：Topic 所有的最终中文内容、原始 URL、来源元数据和发现时关键词快照。
- `TrendMonitor`：用户唯一的趋势状态、持久化 `intervalHours`、`nextRunAt`、租约和待处理手动刷新；缺失记录的间隔默认按 4 小时创建。
- `TrendRun`：趋势触发方式、状态、候选/录取/新增数和安全错误；手动刷新在入队前先创建持久化的 `queued` 运行。
- `TrendSeed`：最小化来源、外部 ID、标题、URL、指纹和精准查询词。
- `RadarItem`：用户所有的最终趋势内容，按 `(userId, canonicalPrimaryUrl)` 唯一。

Topic 和趋势完成事务都从实际插入数写入 `newItemCount`。运行中数量为 `null`。刷新协调只接受请求开始之后的新 `manual` 运行 ID，因此页面提示来自持久化终态，而不是入队响应或客户端猜测。

## 8. 调度和队列

- 新 Topic 使用 `initial` 任务；手动刷新使用 `manual`；调度使用 `scheduled`。
- `Topic.queuedTrigger` 区分排队中的 `initial | manual | scheduled`。初始或定时任务排队时收到手动刷新，只登记一个 pending 请求；当前任务终止后再创建后续手动任务。
- Topic 首次成功后默认为 12 小时；连续两个高产定时运行缩短为 6 小时，连续两个空定时运行延长为 24 小时。
- `TREND_INTERVAL_HOURS` 默认为 4，只在缺少 TrendMonitor 时提供创建值；已有记录的持久化 `intervalHours` 是后续调度的权威值，环境变量变化不回写已有记录。
- 两类 scheduler 每 10 分钟扫描，PostgreSQL `nextRunAt` 是真实状态，BullMQ job ID 确保幂等。
- Topic 使用稳定 ±10% 抖动；手动运行不改变 Topic streak、Topic 自动周期或趋势自动周期。
- Topic 和 TrendMonitor 都使用运行租约恢复 Worker 中断；同一目标最多一个运行，重复手动请求只保留一个 pending 刷新。
- 趋势手动刷新在数据库事务中创建带短租约的 `TrendRun`，BullMQ job 携带其 `runId`。入队失败时只补偿尚未被 Worker 认领的登记，旧版无 `runId` 的遗留任务不会重复执行。

## 9. API

所有业务端点位于 `/api/v1`：

| Method | Path | 行为 |
| --- | --- | --- |
| `POST` | `/topics` | 创建完整关键词 Topic 并入队首次运行 |
| `GET` | `/topics` | 返回 Topic 状态、调度和最新运行摘要 |
| `PATCH` | `/topics/:id` | 修改主关键词和扩展词，并按新配置登记发现运行 |
| `DELETE` | `/topics/:id` | 软删除 Topic 并停止调度，保留历史 Feed |
| `POST` | `/topics/:id/refresh` | 登记 Topic 手动刷新，不改变自动周期 |
| `GET` | `/trends/status` | 返回当前用户的安全 TrendMonitor/TrendRun 摘要 |
| `POST` | `/trends/refresh` | 登记趋势手动刷新，返回 `202` |
| `GET` | `/feed` | 合并 Topic/Radar 条目并在服务端筛选、排序 |
| `GET` | `/items/:id` | 在用户所有权检查后读取 Topic 或 Radar 详情 |
| `GET` | `/discovery-sources` | 只返回连接器名称、类别和安全启用状态 |

Feed 参数：

- `range=1d|3d|7d|30d|90d|all`，默认 `30d`；
- `origin=all|topic|trend`，默认 `all`；
- 可选 `kind=hot|quality`、`topicId` 和最长 100 字符的 `q`；
- `topicId` 与 `origin=trend` 非法，API 返回 `VALIDATION_ERROR`。

服务端始终执行用户边界和已有筛选。没有 `q` 时按 `publishedAt ?? discoveredAt`、ID 稳定倒序排列，`all` 不设置起始时间；有 `q` 时只查询已持久化的 `DiscoveryItem` 与 `RadarItem`，不会入队或访问外部来源。搜索使用 `pg_trgm` GIN 索引匹配标题、摘要和推荐理由，按标题 > 摘要 > 推荐理由的权重计算相关性，再按文章时间和 ID 稳定排序。Topic 与趋势结果各自取出相关性排名后，在 API 中执行同一稳定合并顺序；所有 SQL 值参数化，通配符按字面量转义。

## 10. Web 交互

Feed 顶部提供已入库文章搜索框、来源 segmented control、分类 control、原生时间 `<select>` 和适用时的 Topic select。输入草稿与已提交搜索词分离，只有回车或点击搜索按钮才发送查询；清除按钮移除 `q` 并保留其他筛选。搜索失败保留输入上下文供重试，空结果显示专用状态。六个时间范围共用一个服务端查询，默认近 30 天。返回条目按“今天、昨天、近 3 天、近 7 天、本月更早、更早”互斥分组，空组不渲染。

Topic 页面提供主关键词和扩展词的内联编辑，以及带确认对话框的删除操作。删除成功后 Topic 立即离开活动列表；Feed 仍用 `DiscoveryItem.topicKeyword` 展示历史归属，并在 Topic 已删除或当前关键词与快照不一致时显示“关键词已失效”。

刷新协调范围：

- 选择具体 Topic：只刷新该 Topic；
- `origin=topic`：刷新 Topic；
- `origin=trend`：只刷新趋势；
- `origin=all`：刷新 Topic 和趋势。

点击或移动端顶部下拉触发后，刷新按钮立即设置 `aria-busy=true`，固定尺寸图标显示进行中状态，非阻塞状态行显示目标数。前端以 1.5 秒状态轮询等待持久化的后续 `manual` 运行，全部终止后重新读取 Feed 并汇总 `newItemCount`。成功有新增时精确显示“刷新完成，新增 N 条内容”；零新增、部分失败和全部失败有独立文案。`aria-live="polite"` 公布结果，已有内容始终可浏览。

下拉刷新只在 `scrollY === 0`、单指主要向下、超过 72px、目标不是表单控件且没有活动刷新时触发。`prefers-reduced-motion` 下不依赖连续动画表达状态。布局在 1440px 桌面、平板、移动端和 320px 紧凑视口中让控件换行，不产生水平溢出。

## 11. 配置

完整示例见根目录 `.env.example`。相关服务端变量如下：

```env
AI_API_KEY=
AI_MODEL=openrouter/auto
AI_WEB_SEARCH=true
AI_TIMEOUT_MS=60000

TWITTERAPI_IO_API_KEY=
GITHUB_TOKEN=
YOUTUBE_API_KEY=
REDDIT_CLIENT_ID=
REDDIT_CLIENT_SECRET=
SEARCH_PROVIDER=
SEARCH_API_KEY=
SEARCH_API_BASE_URL=
DISCOVERY_RSS_FEED_URLS=

DISCOVERY_RUN_TIMEOUT_MS=600000
DISCOVERY_CONNECTOR_CONCURRENCY=4
DISCOVERY_SCHEDULER_ENABLED=true

TREND_MONITOR_ENABLED=true
TREND_INTERVAL_HOURS=4
TREND_X_WOEIDS=1
TREND_YOUTUBE_REGION=US
TREND_REDDIT_COMMUNITIES=MachineLearning,LocalLLaMA,programming,technology
TREND_GOOGLE_RSS_URLS=
```

`TREND_MONITOR_ENABLED=false` 只关闭自动趋势调度，不删除历史，也不禁用手动趋势处理。`TREND_INTERVAL_HOURS` 默认为 4，且只用于创建缺失的 TrendMonitor；已有记录继续使用持久化的 `intervalHours`，环境变量变化不会修改它。所有 Key、`SESSION_SECRET` 和 `CSRF_SECRET` 只供服务端读取。真实 `.env`、私有 Feed URL 和授权头不得提交。

## 12. 运行与验证

本地需要 PostgreSQL 和 Redis。API/Web 可用根 `npm run dev` 启动，Worker 必须在另一个终端运行 `npm run dev -w @lettermate/worker`，否则排队的发现任务不会被消费。

验证顺序：

```powershell
npm run db:generate
npm run db:deploy
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
```

默认测试不访问外网。OpenRouter live smoke test 要求同时设置 `RUN_LIVE_AI_TESTS=1` 和 `AI_API_KEY`；TwitterAPI.io live smoke test 要求同时设置 `RUN_LIVE_TWITTERAPI_IO_TESTS=1` 和 `TWITTERAPI_IO_API_KEY`。数据库搜索集成测试还要求 `RUN_DATABASE_TESTS=1` 和可用的 `DATABASE_URL`。Playwright 使用确定性 API 覆盖四个配置视口、六范围中的默认 `30d`/交互 `3d`、来源过滤、提交式文章搜索、点击/下拉刷新、持久化计数、时间分组、禁用措辞和水平溢出。
