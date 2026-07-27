# LetterMate 多源高质量发现与自动更新设计

**版本：** V1.0

**日期：** 2026-07-27

**状态：** 已完成方案确认，待书面规格审阅

**关系：** 扩展当前 `docs/design.md` 与 `docs/requirements.md` 中的 AI 发现能力，并替换其中的单一来源限制

## 1. 背景与目标

当前发现流程由一次 OpenRouter Web Search 同时承担候选召回、内容选择、分类和摘要。服务端能够验证 URL 是否来自本次 citation，但不能确认页面是否有足够正文、是否为转载或聚合页，也不能控制来源是否集中在少数网站。因此，citation 有效并不等于内容值得展示。

本设计将发现流程改为“多连接器召回 + 统一质量管线”：

- 同时覆盖中英文信息环境；
- 从搜索引擎、RSS/Atom、社交媒体、视频平台、技术社区、论文与代码平台获取候选内容；
- 默认只依赖现有 OpenRouter Key 和无需额外密钥的公开渠道，有额外密钥时启用增强连接器；
- 以高精度为目标，通常只保留 3-8 条真正有价值的新内容，不为凑数降低标准；
- 允许单次异步发现运行 5-10 分钟；
- 创建主题后立即运行，并在 6-24 小时范围内自适应自动更新；
- 永久保留历史结果，Feed 默认展示最近 90 天，并提供历史查看入口；
- 保留 `hot | quality` 产品分类，但不引入来源可信等级、证据等级、事实确认状态或用户可见评分。

## 2. 与现有规格的关系

本设计保留现有规格中的以下边界：

- Web 只访问 LetterMate API，所有外部服务密钥留在服务端；
- 主题、运行和发现结果继续按用户隔离；
- 每个展示条目必须有可验证的 HTTP(S) 原始链接；
- AI 输出必须经过运行时 schema 校验；
- 刷新失败保留最近一次成功结果；
- 相同主题和相同规范化主 URL 幂等更新；
- AI 推荐分类不代表事实核验结论。

本设计明确替换旧规格中的以下限制：

- OpenRouter Web Search 不再是唯一发现入口；
- 允许额外搜索服务、社交平台、视频平台和技术社区连接器；
- “URL 必须属于 OpenRouter annotation citation”扩展为“URL 必须属于服务端验证过的来源证明”；
- 手动刷新扩展为首次运行、手动刷新和自适应定时运行；
- 默认 7 天窗口由连接器和主题节奏共同决定，仍禁止模型猜测发布时间。

本设计不恢复已退役的来源等级、证据计数、可信状态机或事实确认状态。来源证明只回答“该 URL 是否确实由本次连接器返回”，不回答“该来源是否可信”。

## 3. 方案选择

采用“多连接器召回 + 统一质量管线”。不采用仅增强 OpenRouter 提示词的方案，因为它仍受单一召回入口限制；也不在本期把每个渠道拆成独立队列和采集系统，因为当前个人工作区规模不需要完整的数据采集平台。

连接器保持可独立演进。未来某个高流量渠道可以迁移为独立任务，而不改变上层候选契约和质量管线。

## 4. 总体架构

```text
React Web
  | REST
  v
NestJS API ---- PostgreSQL / Prisma
  |
  | enqueue initial/manual/scheduled run
  v
BullMQ Worker
  |
  v
TopicDiscoveryService
  |-- TopicExpander
  |-- SourceRouter
  |-- ConnectorRegistry
  |     |-- OpenRouter Search
  |     |-- Web Search Providers
  |     |-- RSS / Atom
  |     |-- TwitterAPI.io
  |     |-- GitHub / Hacker News / arXiv
  |     |-- YouTube / Bilibili
  |     `-- Reddit / Bluesky / other enabled sources
  |-- ContentEnricher
  |-- CandidateQualityPipeline
  |-- DiversitySelector
  `-- DiscoveryRepository

TopicScheduleService
  |-- scans due topics in PostgreSQL
  `-- enqueues idempotent scheduled jobs in BullMQ
```

### 4.1 组件职责

`TopicExpander` 生成有限且去重的中英文概念、实体、别名和渠道适用的搜索表达。它不生成来源等级，也不要求用户维护复杂搜索规则。

`SourceRouter` 根据主题语义选择连接器和查询组合。技术主题提高 GitHub、Hacker News、arXiv 和技术 RSS 的覆盖；社会、商业和产品主题提高搜索、社交和视频覆盖。路由结果受已启用连接器、总预算和运行时限约束，不会机械调用所有渠道。

`SourceConnector` 只负责获取并规范化候选，不负责最终录取、中文摘要或 `hot | quality` 分类。

`ConnectorRegistry` 以有限并发执行连接器，对每个连接器施加超时、分页和候选数量上限。单个连接器失败不会取消其他连接器。

`ContentEnricher` 在必要时获取网页正文、RSS 正文、帖子线程、代码仓库说明、论文摘要、视频说明或字幕。正文仅用于本次判断和摘要，不把外部完整正文长期保存到数据库。

`CandidateQualityPipeline` 依次完成来源证明验证、规则过滤、内容补全、跨渠道去重、AI 高精度评审和摘要分类。

`DiversitySelector` 在合格候选中控制同域名和同平台集中度。它不对来源做可信排名。

`TopicScheduleService` 以 PostgreSQL 的 `nextRunAt` 为事实来源，周期性扫描到期主题并使用确定性 job ID 入队，避免重复调度依赖 Redis 的长期完整性。

### 4.2 AI 边界

现有 `AiGateway.discover()` 同时承担联网召回和最终内容生成，实施时将拆成三个与供应商无关的能力：

```ts
interface AiGateway {
  expandTopic(input: ExpandTopicInput): Promise<ExpandedTopic>;
  evaluateCandidates(input: EvaluateCandidatesInput): Promise<CandidateAssessment[]>;
  composeItems(input: ComposeItemsInput): Promise<DiscoveryCandidate[]>;
}
```

`SourceRouter` 根据 `ExpandedTopic` 和已启用连接器生成查询计划；它不依赖 OpenRouter HTTP 格式。`OpenRouterSearchConnector` 单独封装 Web Search 和 annotation citations。AI 评审与最终摘要使用经过截断、分批和 schema 校验的候选内容；最终服务层仍复核条目 URL 是否属于输入候选池。

OpenRouter 的请求格式、模型选择、结构化输出和错误映射继续留在 Worker 的供应商适配层，不进入 `packages/contracts` 或前端 API。

## 5. 统一连接器契约

连接器能力以业务含义表达，不暴露供应商响应格式：

```ts
interface SourceConnector {
  readonly id: string;
  isEnabled(): boolean;
  supports(plan: SourceQueryPlan): boolean;
  search(plan: SourceQueryPlan, signal: AbortSignal): Promise<ConnectorResult>;
}

interface SourceCandidate {
  connectorId: string;
  sourceType: 'web' | 'feed' | 'social' | 'video' | 'community' | 'code' | 'paper';
  platform: string;
  externalId: string | null;
  url: string;
  title: string | null;
  content: string | null;
  excerpt: string | null;
  authorName: string | null;
  authorHandle: string | null;
  publishedAt: string | null;
  language: string | null;
  engagement: Record<string, number>;
  proof: SourceProof;
}
```

`engagement` 只用于判断关注增长和排序候选，不作为可信度或内容质量的直接依据，也不进入公开 API。

连接器专有 schema、鉴权、分页和错误映射放在 `apps/worker`。可独立测试的 URL 规范化、来源证明、质量门槛和去重规则放在 `packages/domain`。只有跨 API、Worker 和 Web 的最终数据结构放在 `packages/contracts`。

## 6. 来源证明

`SourceProof` 统一表达候选从何而来：

- `ai_citation`：URL 来自 OpenRouter 本次响应的 `url_citation` annotation；
- `api_record`：URL、平台内容 ID 和正文元数据来自经过 schema 校验的结构化 API 响应；
- `feed_entry`：URL 来自成功解析的 RSS/Atom entry，并保留 feed URL 与 entry ID；
- `fetched_page`：URL 是由已验证候选跳转后获得的最终页面，所有跳转均经服务端安全校验。

AI 只能从已验证候选池中选择 URL，不得生成或补写 URL。最终结果的主 URL 和附加 URL 都必须能回溯到本次候选池中的 `SourceProof`。来源证明是内部采集完整性机制，不向用户展示“可信”“已核实”或等级措辞。

## 7. 连接器范围

### 7.1 基础连接器

以下连接器构成首批高信号基础能力：

| 连接器 | 鉴权 | 用途 |
| --- | --- | --- |
| OpenRouter Search | 现有 `AI_API_KEY` | 通用中英文 Web 搜索和长尾来源发现 |
| RSS/Atom | 无 | 官方博客、媒体、项目和频道的稳定更新 |
| Hacker News | 无 | 技术新闻、项目发布和高价值讨论 |
| arXiv | 无 | 论文摘要与近期研究 |
| GitHub | 可无；Token 增强 | Release、仓库、Issue/Discussion 和项目一手信息 |
| TwitterAPI.io | `TWITTERAPI_IO_API_KEY` | X/Twitter 搜索、原创推文、线程和热点信号 |

### 7.2 扩展连接器

| 类别 | 连接器方向 | 说明 |
| --- | --- | --- |
| 搜索引擎 | Google/Brave/Bing-compatible adapter | 使用明确配置的服务端搜索供应商；站点限定搜索补足不开放检索 API 的平台 |
| 视频 | YouTube Data API、频道 RSS、Bilibili 合规读取接口 | 只有取得说明或字幕等实质内容时才进入优质评审 |
| 社区 | Reddit OAuth API、Bluesky public API | 保留原创帖和有实质信息的讨论，过滤低信息评论 |
| 中文平台 | 微博、微信公众号、Bilibili | 优先官方/授权接口；缺少稳定开放搜索 API 时使用搜索引擎站点限定结果 |

不使用需要模拟登录、绕过验证码或依赖个人 Cookie 的抓取方式。平台接口和条款变化时可以禁用单个连接器，不影响其他渠道。

### 7.3 TwitterAPI.io 设计

X/Twitter 明确使用 `twitterapi.io`：

- 通过 `GET /twitter/tweet/advanced_search` 执行 `Latest` 和 `Top` 查询；
- 查询使用 `since_time`、`until_time` 限制时间窗口，并设置查询数、页数和候选数预算；
- 对初筛后可能有价值的线程调用 `GET /twitter/tweet/thread_context` 补全上下文，而不是为所有推文请求线程；
- 通过 `x-api-key` 请求头鉴权，密钥来自服务端 `TWITTERAPI_IO_API_KEY`；
- 使用 Zod 校验推文、作者、引用、转推、游标和错误响应；
- 转推规范化到原始推文，引用推文保留引用关系，回复必须补齐必要上下文；
- 使用 `tweetId` 和规范化 `x.com` URL 幂等去重；
- 蓝标、粉丝数、浏览量和互动量不直接决定质量；
- 官方账号、项目作者、研究者或事件当事人的原创推文与线程可以作为一手来源直接入库。

## 8. 高精度质量管线

每次运行按以下顺序处理：

1. **规范化与来源验证**：验证 schema、HTTP(S) URL、平台内容 ID、时间字段和 `SourceProof`。
2. **时间过滤**：优先使用来源明确给出的发布时间；无法确定时不猜测。超过当前查询窗口的候选不进入后续评审。
3. **低成本排除**：过滤搜索页、标签页、分类页、登录页、广告页、采集站模板、无正文页面、纯转载和明显无关内容。
4. **精确去重**：按平台内容 ID、规范化 URL 和已知重定向关系合并。
5. **内容补全**：只为剩余候选获取正文、线程、摘要、README、Release Notes 或字幕，并应用内容大小和超时限制。
6. **近似去重**：按规范化标题、正文指纹和语义相似度合并跨渠道重复内容，优先保留最接近原始发布者的 URL。
7. **AI 批量评审**：对相关性、信息增量、原创性、实质性、时效性和可理解性作结构化判断；严格阈值以下直接拒绝。
8. **与历史比较**：拒绝只是重复已有摘要、没有新增事实或新观点的内容；同一原始内容的新版本使用幂等更新。
9. **多样性选择**：通常选择 3-8 条；不合格时允许少于 3 条或空结果。同一域名或平台默认不超过最终结果的 40%，不足 3 条时可放宽但不降低质量阈值。
10. **生成最终内容**：只对最终条目生成中文摘要、推荐理由和 `hot | quality` 分类。

AI 评审结果是内部录取决策，不作为用户可见分数，不持久化来源排名。

### 8.1 一手社交信息规则

社交内容不能因为篇幅短而自动降级。满足以下条件时可以直接成为发现条目：

- 内容为原创帖、作者线程、官方公告或当事人陈述，而不是无新增内容的转发；
- 作者与内容存在可解释关系，例如组织官方账号、项目维护者、论文作者、产品负责人或事件当事人；
- 内容提供新的发布、决定、数据、时间表、技术说明、立场或可验证链接；
- 回复或引用推文已补齐理解所需上下文；
- 原始帖子 URL 和平台内容 ID 已由连接器验证。

短但明确的官方发布不受通用正文长度下限约束。蓝标、粉丝量或高互动不能替代以上条件。

### 8.2 不同内容类型的最低要求

- 网页文章：必须提取到正文主内容，不能只根据标题和搜索摘要入库；
- 视频：必须取得足够的说明、章节、字幕或可验证文字稿，不能只根据标题和缩略图摘要；
- 论文：至少取得标题、作者、摘要和原始论文页；
- 代码项目：至少取得 Release、README、变更说明或实质 Issue/Discussion 内容；
- 社区讨论：必须包含实质问题、方案、数据或经验，纯情绪和重复评论不入库；
- RSS/Atom：entry 链接和发布时间必须可解析，正文不足时继续抓取原始页面。

## 9. `hot | quality` 分类

`quality` 表示内容本身有明显信息增量，并能帮助用户理解或实践主题。

`hot` 表示近期出现明显关注增长、密集更新、重要发布或平台原生热度变化。互动量和多渠道出现只能作为热度信号，不能证明内容真实性。内容同时满足两类时继续优先标记为 `hot`。

最终 `reason` 必须解释条目为何值得阅读，禁止使用“来源可信”“已经证实”或“证据充分”等事实认证措辞。

## 10. 自适应自动更新

### 10.1 调度规则

- 创建主题后立即入队首次运行；
- 首次成功后默认 `nextRunAt = finishedAt + 12h`；
- 连续两个定时运行均发现至少两条新合格内容时，间隔缩短为 6 小时；
- 定时运行发现一条新内容时维持 12 小时；
- 连续两个定时运行没有新合格内容时，间隔延长为 24 小时；
- 间隔只取 6、12、24 小时三档，并加入不超过 10% 的确定性抖动，避免大量主题同时入队；
- 手动刷新不改变长期自适应统计和下一次正常周期；
- 定时运行失败时采用 BullMQ 有上限重试；最终失败后保留旧结果，并安排 24 小时内再次尝试。

### 10.2 并发与幂等

调度器每 10 分钟扫描到期主题。数据库通过条件更新原子认领到期主题，BullMQ job ID 使用 `scheduled:<topicId>:<dueBucket>`。现有首次和手动任务继续按主题互斥；任意触发来源下，同一主题最多有一个运行中任务和一个待执行任务。

单次运行默认总时限 10 分钟。连接器拥有更短的独立超时，运行在有限并发池中。到达总时限后取消未完成请求，并用已成功返回的渠道继续质量管线。

## 11. 数据模型

### 11.1 `Topic` 扩展

新增：

| 字段 | 用途 |
| --- | --- |
| `nextRunAt` | 下一次自动运行时间 |
| `scheduleIntervalHours` | 当前 6、12 或 24 小时间隔 |
| `productiveRunStreak` | 连续有较多新内容的定时运行次数 |
| `emptyRunStreak` | 连续无新内容的定时运行次数 |

这些字段是调度运行状态，不是来源证据计数。

### 11.2 `DiscoveryRun`

新增运行记录用于故障恢复和调度决策：

| 字段 | 用途 |
| --- | --- |
| `id`, `topicId` | 运行标识和所属主题 |
| `trigger` | `initial | manual | scheduled` |
| `status` | `queued | running | succeeded | failed` |
| `startedAt`, `finishedAt` | 运行时序 |
| `connectorSummary` | 脱敏后的启用、成功、跳过和失败状态 |
| `candidateCount`, `acceptedCount`, `newItemCount` | 运行质量和调度统计 |
| `error` | 安全错误代码和消息 |

运行计数仅用于运维、测试和调度，不作为发现条目的可信证据，也不在 Feed 展示。

`DiscoveryRun` 详细记录默认保留 90 天，过期记录可清理；永久保留要求只适用于用户发现内容，不适用于运行诊断日志。

### 11.3 `DiscoveryItem` 扩展

保留现有字段并新增：

| 字段 | 用途 |
| --- | --- |
| `sourceType` | `web | feed | social | video | community | code | paper` |
| `platform` | 用户可理解的平台名称，如 `X`、`GitHub`、`arXiv` |
| `authorName` | 可为空的来源作者或组织名 |
| `authorHandle` | 可为空的平台账号标识 |
| `externalId` | 可为空的平台稳定内容 ID |
| `provenanceKind` | 内部来源证明类型，不作为可信等级展示 |

继续使用 `topicId + canonicalPrimaryUrl` 唯一约束。平台连接器提供专用 URL 规范化，例如统一 `twitter.com` 与 `x.com` 推文 URL、去除追踪参数并保留内容 ID。涉及 Prisma schema 的实现必须同时生成 Prisma Client 和迁移。

完整外部正文、字幕和帖子线程不长期写入 `DiscoveryItem`。

## 12. API 与前端

### 12.1 API

现有端点保持兼容，并作以下扩展：

- Topic 响应增加 `nextRunAt` 和 `scheduleIntervalHours`；
- DiscoveryItem 响应增加 `sourceType`、`platform`、`authorName` 和 `authorHandle`；
- `GET /feed` 增加 `range=recent|all`，默认 `recent` 表示最近 90 天；
- `POST /topics/:id/refresh` 继续只触发手动运行，不修改自适应间隔；
- 增加只读 `GET /discovery-sources`，返回连接器名称、类别和 `enabled | not_configured` 状态，不返回密钥、配额或敏感错误。

所有端点继续执行用户所有权检查。`GET /discovery-sources` 只返回全局安全配置状态，不接受或写入密钥。

### 12.2 前端

- Feed 卡片显示平台、内容类型和可用的作者/账号信息；
- 原始链接继续安全地在新标签页打开；
- 增加“最近 90 天 / 全部历史”筛选，不删除旧结果；
- 主题行显示“下次自动更新”时间和当前自动更新间隔；
- 运行状态文案从单一“搜索中”调整为“多源发现中”；
- 来源状态界面只显示哪些渠道已启用或待配置，不显示来源评分；
- 侧栏不再固定显示 `OpenRouter Web Search`，改为能准确反映多源发现状态的文案。

本期不增加复杂的用户来源规则表单，也不允许用户在浏览器中输入第三方密钥。

## 13. 错误、降级与恢复

- 未配置可选连接器密钥：连接器标记为 `not_configured` 并跳过，不视为运行失败；
- 单个连接器限流、超时或上游失败：记录脱敏状态，其他连接器继续；
- 至少一个连接器成功且质量管线完成：运行成功，即使最终为空；
- 所有计划连接器失败：运行失败并保留旧结果；
- AI 评审或最终结构化输出失败：运行失败，不保存半成品；
- 候选 URL 无有效来源证明：丢弃候选；如果所有非空候选都因此被丢弃，使用明确的来源证明错误；
- 内容抓取失败：该候选降级使用结构化 API 正文；若仍不足以评审则丢弃，不根据标题臆测；
- 定时运行失败：保留旧 Feed，不把失败伪装为空结果；
- 日志只记录 connector ID、状态码、请求 ID、耗时和数量，不记录 API Key、Authorization、`x-api-key`、完整提示词或完整外部正文。

## 14. 网络与内容安全

正文抓取必须：

- 只允许 HTTP(S)；
- 拒绝 localhost、环回、链路本地、私网和云元数据地址；
- DNS 解析后校验目标地址，每次重定向重新校验；
- 限制重定向次数、响应大小、MIME 类型和超时；
- 不执行页面脚本，不携带用户 Cookie，不模拟登录；
- 尊重平台使用条款和站点抓取约束；
- 清理 HTML，只把纯文本交给 AI；
- 不在日志、数据库或错误响应中保存完整抓取正文。

## 15. 配置

继续保留现有配置，并增加可选项：

```env
AI_API_KEY=
AI_MODEL=openrouter/auto
AI_WEB_SEARCH=true

TWITTERAPI_IO_API_KEY=
GITHUB_TOKEN=
YOUTUBE_API_KEY=
REDDIT_CLIENT_ID=
REDDIT_CLIENT_SECRET=
SEARCH_PROVIDER=
SEARCH_API_KEY=

DISCOVERY_RUN_TIMEOUT_MS=600000
DISCOVERY_CONNECTOR_CONCURRENCY=4
DISCOVERY_SCHEDULER_ENABLED=true
```

只有 `AI_API_KEY` 仍是创建和运行主题的基础要求。其他配置为空时对应连接器自动禁用。`.env.example` 只提供空占位符，真实密钥不得提交。

## 16. 测试策略

### 16.1 默认自动化测试

- 每个连接器使用固定响应 fixture，验证鉴权头脱敏、分页、时间窗口、schema、URL 和错误映射；
- TwitterAPI.io 覆盖 `Latest`/`Top` 查询、游标、转推归一、引用关系、线程补全和 API Key 不泄漏；
- 来源证明覆盖 annotation、API record、feed entry 和安全重定向；
- SSRF 测试覆盖 localhost、私网、DNS/重定向绕过、超大响应和非法 MIME；
- 质量管线覆盖 SEO 页、聚合页、转载、薄内容、视频无字幕、社交一手短讯、跨渠道重复和历史重复；
- 多样性选择覆盖单域名集中、平台集中、结果不足和空结果；
- 调度测试使用假时钟，覆盖 6/12/24 小时切换、抖动、手动刷新不改周期、重复扫描和失败恢复；
- Repository/API 覆盖新字段、90 天默认窗口、全部历史和用户隔离；
- Web 测试覆盖平台标签、作者信息、历史筛选、下次更新时间和多源运行状态；
- 默认测试不访问外网。

### 16.2 可选实时测试

实时测试按连接器独立开关，只有对应 Key 存在时运行。测试不断言固定标题、数量、互动量或外部排序，只验证：

- 请求确实到达目标服务；
- 返回候选具有可验证原始 URL 和来源证明；
- 最终条目通过高精度质量管线；
- 日志与错误不泄露密钥；
- 单渠道失败不破坏其他渠道结果。

## 17. 分阶段交付

### 阶段一：多源基础与高精度闭环

- 统一连接器、候选和来源证明接口；
- 重构 OpenRouter 为连接器之一；
- RSS/Atom、Hacker News、arXiv、GitHub 和 TwitterAPI.io；
- 正文安全提取、质量管线、跨渠道去重和多样性选择；
- 数据迁移、运行记录和自适应调度；
- API 与前端显示平台、历史范围和下次更新时间。

### 阶段二：搜索、视频与社区扩展

- 可配置搜索引擎适配器；
- YouTube、Bilibili、Reddit 和 Bluesky；
- 微博、微信公众号等通过合规 API 或站点限定搜索接入；
- 视频字幕和社区上下文补全；
- 跨平台质量阈值调优。

### 阶段三：稳定性与成本调优

- 基于运行记录调整连接器预算和路由策略；
- 完善限流、熔断、缓存和运行诊断；
- 扩大实时冒烟测试和长时间调度验证。

每个阶段都必须保持现有手动发现流程可用。阶段一完成后即可形成可使用的多源闭环，后续阶段在同一接口边界内增量交付。

## 18. 验收标准

1. 用户只输入一个关键词即可创建主题，不需要配置同义词、来源等级或搜索规则。
2. 在对应连接器已配置且主题适用时，系统能够从至少四类来源完成真实发现，而不是只依赖 OpenRouter Web Search；缺少可选密钥时仍可使用基础渠道运行。
3. 配置 `TWITTERAPI_IO_API_KEY` 后，原创推文和线程能够通过 TwitterAPI.io 被发现、验证和展示。
4. 官方账号、作者或当事人的高信息量短帖不会因为篇幅短被错误过滤；转载和无新增信息内容被过滤。
5. 网页、视频、代码、论文和社区内容必须取得足够正文或结构化内容后才能摘要，禁止只根据标题生成结果。
6. 最终通常展示 3-8 条高质量结果；没有合格内容时允许空结果，不为凑数降低阈值。
7. 每条结果都有可回溯的来源证明和有效原始 URL，AI 不能引入候选池外 URL。
8. Feed 不被单一域名或平台长期占满，同时不展示来源可信等级、证据等级或事实确认状态。
9. 创建后立即运行，之后按 6、12 或 24 小时自适应自动更新；同一主题不会并发运行多个任务。
10. Feed 默认展示最近 90 天，用户可以查看永久保留的全部历史。
11. 单个可选连接器失败或缺少密钥不会导致整个运行失败；所有连接器失败或 AI 评审失败会保留旧结果并显示真实错误。
12. 密钥、鉴权头、完整外部正文和敏感上游响应不会进入浏览器、数据库、日志、错误响应或测试快照。
13. Prisma migration、lint、typecheck、单元测试、构建和端到端测试全部通过；启用实时测试时已配置连接器通过基本集成验证。

## 19. 实施边界

实施按测试驱动顺序进行：先固定领域契约、来源证明和质量规则，再实现连接器和编排；随后增加 Prisma 迁移、自适应调度和 API；最后更新前端、实时冒烟测试和跨视口验收。

不在本设计中实现用户自定义来源规则、浏览器内密钥管理、来源评分后台、事实核验状态机、邮件/Push 通知或完整社交数据仓库。
