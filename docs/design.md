# LetterMate 多源发现技术方案

**状态：** 当前有效
**更新日期：** 2026-07-27
**详细规格：** [多源高精度发现设计](./superpowers/specs/2026-07-27-lettermate-multi-source-discovery-design.md)

## 1. 架构决策

采用“多连接器召回 + 单一高精度质量管线”。连接器只负责从各平台产生统一候选和来源证明；去重、正文补全、质量判断、来源多样性和最终摘要在同一管线执行。这样可以增加来源覆盖，同时避免不同渠道各自形成不一致的质量标准。

```text
React Web
  | REST
  v
NestJS API ---------- PostgreSQL / Prisma
  |                         ^
  | BullMQ job              | schedule source of truth
  v                         |
Worker ---------------------+
  |-- TopicExpander (OpenRouter)
  |-- ConnectorRegistry
  |    |-- OpenRouter Search / Brave-compatible Search / RSS
  |    |-- TwitterAPI.io / Bluesky
  |    |-- YouTube / Bilibili
  |    `-- GitHub / Hacker News / arXiv / Reddit
  |-- SSRF-safe ContentFetcher
  |-- CandidateQualityPipeline
  |-- AiGateway assessment and composition
  `-- DiscoveryRepository

Scheduler -- every 10 minutes --> claims due topics --> BullMQ
```

OpenRouter 不再是唯一搜索入口，但 `AI_API_KEY` 仍是主题扩展、候选评审和最终摘要的基础依赖。所有外部密钥和鉴权只存在于 API/Worker 服务端。

## 2. 模块边界

| 路径 | 职责 |
| --- | --- |
| `apps/web` | 工作台、来源元数据、历史范围和调度状态 |
| `apps/api` | 认证、用户边界、输入校验、查询 API 和任务入队 |
| `apps/worker/src/connectors` | 平台鉴权、分页、schema、错误映射和候选标准化 |
| `apps/worker/src/discovery-service.ts` | 扩展、路由、聚合、质量管线和原子持久化编排 |
| `apps/worker/src/scheduler.ts` | 到期主题认领、自适应周期和幂等任务 ID |
| `apps/worker/src/content-fetcher.ts` | 限制重定向、DNS、地址、MIME、大小和超时的正文读取 |
| `packages/contracts` | API、Worker 与 Web 共用 DTO 和 Zod schema |
| `packages/domain` | 来源证明、URL、质量门槛、去重和多样性规则 |
| `packages/config` | 服务端配置解析与默认值 |
| `prisma/schema.prisma` | 主题调度、发现条目和运行记录 |

连接器专有响应不得进入共享契约。Web 只消费 LetterMate API，不直接调用 OpenRouter、TwitterAPI.io 或其他外部服务。

## 3. 连接器模型

所有连接器实现统一接口：

```ts
interface SourceConnector {
  readonly id: string;
  readonly label: string;
  readonly sourceType: SourceType;
  isEnabled(): boolean;
  supports(plan: SourceQueryPlan): boolean;
  search(plan: SourceQueryPlan, signal: AbortSignal): Promise<ConnectorResult>;
}
```

候选包含 `connectorId`、`sourceType`、`platform`、原始 URL、可选平台内容 ID、正文/摘要、作者、发布时间、互动信息和 `SourceProof`。Registry 在边界验证并复制候选；一个连接器异常、超时或返回非法结构时只产生脱敏失败，不污染其他结果。

### 3.1 来源与配置

| 连接器 | 鉴权 | 说明 |
| --- | --- | --- |
| OpenRouter Search | `AI_API_KEY` | 只接受本次 `url_citation` annotation 中的 URL |
| TwitterAPI.io | `TWITTERAPI_IO_API_KEY` | X 的 Latest/Top、原创帖、引用与线程上下文 |
| RSS/Atom | `DISCOVERY_RSS_FEED_URLS` | 无 Key，Feed URL 逗号分隔 |
| Hacker News / arXiv / Bluesky / Bilibili | 无 | 公共接口 |
| GitHub | 可选 `GITHUB_TOKEN` | 无 Token 可访问公共 API，Token 提高配额 |
| Brave-compatible Search | `SEARCH_PROVIDER=brave`, `SEARCH_API_KEY` | 可选兼容 Base URL |
| YouTube | `YOUTUBE_API_KEY` | Data API |
| Reddit | OAuth client ID/secret | 结构化社区内容 |

不使用模拟登录、Cookie、验证码绕过或不稳定的个人会话抓取。

## 4. 来源证明与安全边界

`SourceProof` 有四种：OpenRouter citation、平台 API record、RSS feed entry 和经过安全抓取的页面。每个候选必须满足：

- URL 为有效 HTTP(S)，证明的 connector ID 与候选一致；
- API record 的外部 ID、citation URL 或 feed entry ID 与候选一致；
- AI 评审和生成只能引用已验证候选池中的 URL；
- 完整抓取正文只在内存中短期使用，不写入发现条目或公开响应。

正文抓取在每次请求及重定向前执行 DNS 和地址检查，拒绝 localhost、环回、私网、链路本地和云元数据地址；同时限制响应大小、MIME、重定向数和超时，不执行脚本或携带用户 Cookie。

## 5. 高精度质量管线

1. 验证候选结构、时间和来源证明。
2. 过滤过期、搜索/分类/登录/广告页、采集模板、无正文和明显无关内容。
3. 按平台 ID、规范化 URL 和已知重定向精确去重。
4. 只为剩余候选补全正文、线程、README、Release Notes、摘要或字幕。
5. 按标题和正文指纹做跨渠道近似去重，并与历史结果比较信息增量。
6. OpenRouter 批量评审相关性、原创性、实质性、时效性和可理解性。
7. 通常选择 3-8 条；同一域名或平台默认不超过最终结果的 40%。
8. 只为最终选择生成中文摘要、理由和 `hot | quality` 分类。

官方账号、作者、维护者或当事人的原创短帖可以直接进入评审，不受通用正文长度下限限制；转发和无新增内容的引用仍被过滤。质量不足时允许空结果。

## 6. 编排、调度与一致性

- 创建主题立即入队 `initial` 运行；手动刷新使用 `manual`；调度任务使用 `scheduled`。
- PostgreSQL 的 `nextRunAt` 是调度真实状态。Scheduler 每 10 分钟用条件更新原子认领到期主题，并使用 `scheduled:<topicId>:<dueBucket>` BullMQ job ID。
- 首次成功后为 12 小时；连续两个定时运行各有至少两条新结果时改为 6 小时；一次新结果保持 12 小时；连续两个空定时运行改为 24 小时。
- 周期加入稳定的 ±10% 抖动；手动刷新不修改长期统计和正常周期。
- Topic 运行认领保证同一主题最多一个运行中任务，并使用可过期的运行租约恢复 Worker 崩溃或中断后遗留的状态。单次运行默认总时限 10 分钟，连接器使用更短超时和有限并发。
- 成功写入使用总时限的剩余预算作为数据库交互事务时限；事务返回后再次核对截止时间，避免超时运行提交成功结果。
- 至少一个连接器成功且质量管线完成即为成功，包括空结果。所有连接器失败或 AI 阶段失败时不写半成品，并保留旧 Feed。

## 7. 数据模型

- `Topic`：关键词、扩展词、运行状态、`nextRunAt`、6/12/24 小时间隔和自适应 streak。
- `DiscoveryRun`：触发方式、状态、时间、脱敏连接器摘要、候选/录取/新增计数和安全错误。运行诊断与用户发现历史分离。
- `DiscoveryItem`：`hot | quality`、中文内容、原始 URL、`sourceType`、平台、作者、外部 ID 和内部来源证明类型。

`Topic(userId, normalizedKeyword)` 和 `DiscoveryItem(topicId, canonicalPrimaryUrl)` 保持唯一。发现条目永久保留；Feed 的 90 天只是默认查询窗口，不删除旧数据。完整外部正文和平台原始响应不持久化。

## 8. API 与前端

所有业务端点位于 `/api/v1`：

| Method | Path | 行为 |
| --- | --- | --- |
| `POST` | `/topics` | 创建主题并入队首次运行 |
| `GET` | `/topics` | 主题状态、扩展词和下一次更新时间 |
| `POST` | `/topics/:id/refresh` | 手动刷新，保持自动周期 |
| `GET` | `/feed?range=recent|all` | 默认最近 90 天或全部历史 |
| `GET` | `/items/:id` | 摘要、理由和原始链接 |
| `GET` | `/discovery-sources` | 仅返回连接器名称、类别和安全状态 |

卡片显示平台、内容类型和作者信息。主题区域显示下一次自动更新与当前周期。来源状态只显示 `enabled | not_configured`，不显示密钥、配额、评分或内部错误。

## 9. 配置与运行

完整示例见根目录 `.env.example`。关键运行参数：

```env
DISCOVERY_RUN_TIMEOUT_MS=600000
DISCOVERY_CONNECTOR_CONCURRENCY=4
DISCOVERY_SCHEDULER_ENABLED=true
DISCOVERY_RSS_FEED_URLS=
```

自动测试默认不访问外网。OpenRouter 和 TwitterAPI.io live 测试分别要求 `RUN_LIVE_AI_TESTS=1` 与 `RUN_LIVE_TWITTERAPI_IO_TESTS=1`，并同时存在对应 Key。

## 10. 验收证据映射

| # | 验收点 | 主要证据 |
| --- | --- | --- |
| 1 | 单关键词创建 | `apps/api/src/app.test.ts`、`tests/e2e/ai-discovery.spec.ts` |
| 2 | 至少四类来源及无 Key 降级 | `apps/worker/src/runtime.test.ts`、各 `connectors/*.test.ts` |
| 3 | TwitterAPI.io 原创帖与线程 | `connectors/twitterapi-io.test.ts`、`twitterapi-io.live.test.ts`、`DiscoveryCard.test.tsx` |
| 4 | 一手短帖保留、转载过滤 | `quality-pipeline.test.ts`、`connectors/twitterapi-io.test.ts` |
| 5 | 各内容类型有实质正文 | `content-fetcher.test.ts`、`quality-pipeline.test.ts`、各平台连接器测试 |
| 6 | 3-8 条且允许空结果 | `packages/domain/src/quality.test.ts`、`quality-pipeline.test.ts`、`discovery-service.test.ts` |
| 7 | 来源证明和候选 URL 边界 | `packages/domain/src/source.test.ts`、`connectors/registry.test.ts`、`openrouter-gateway.test.ts` |
| 8 | 来源多样性且无可信等级 UI | `packages/domain/src/quality.test.ts`、`App.test.tsx`、`DiscoveryCard.test.tsx` |
| 9 | 即时运行、6/12/24 小时、自身互斥 | `scheduler.test.ts`、`worker.test.ts`、`discovery-service.test.ts` |
| 10 | 默认 90 天与全部历史 | `apps/api/src/app.test.ts`、`apps/web/src/App.test.tsx`、Playwright |
| 11 | 局部降级与失败保留旧结果 | `connectors/registry.test.ts`、`discovery-service.test.ts`、`worker.test.ts` |
| 12 | 敏感信息不外泄 | `runtime.test.ts`、连接器错误测试、`apps/api/src/app.test.ts`、`content-fetcher.test.ts` |
| 13 | 迁移和完整验证 | `prisma/migrations/20260727_multi_source_discovery/migration.sql`；`db:generate`、`db:deploy`、lint、typecheck、test、build、Playwright；live 集成以实际凭据运行结果为准 |

验收结论必须以当次命令输出为准。缺少外部凭据时，live 测试的“跳过”只证明默认测试不会联网，不能视为外部服务集成已验证。
