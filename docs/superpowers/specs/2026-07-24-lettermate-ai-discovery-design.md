# LetterMate AI 主题发现与统一模型网关设计

**版本：** V2.0
**日期：** 2026-07-24
**状态：** 待书面复核
**取代：** `2026-07-24-lettermate-requirements.md` 与 `2026-07-24-lettermate-phase-1-design.md` 中关于监控规则、来源可信等级、事件可信状态、证据计数和 AI 决策边界的设计

## 1. 目标

LetterMate 第一版聚焦一个完整且可真实运行的流程：用户输入一个关键词，系统自动扩展中英文语义表达，通过联网搜索发现近期内容，使用 AI 判断热点或新出的高质量内容，生成中文摘要与推荐理由，并在前端展示可访问的原始链接。

本设计的成功标准是：

- 用户创建主题时只填写一个关键词，不维护同义词、排除词、来源范围或优先级；
- 搜索和分析使用真实的 OpenRouter 请求，而不是静态种子数据；
- 每个展示条目至少有一个来自本次搜索 citation 的 HTTP(S) 原始链接；
- 每个条目都有 `hot` 或 `quality` 分类、中文摘要和中文推荐理由；
- 主题发现业务不直接依赖 OpenRouter HTTP 格式或具体模型；
- 默认只配置 OpenRouter Key 即可运行，指定模型时只修改 `AI_MODEL`；
- 首版只实现和验收 OpenRouter，不设计其他模型网关或供应商切换方案。

## 2. 范围与明确删除项

### 2.1 本期范围

- 单关键词主题的创建与列表；
- AI 自动生成中英文近义词、相关概念和搜索表达；
- OpenRouter Web Search 联网发现；
- AI 去重、时效判断、`hot | quality` 分类、中文摘要和推荐理由；
- 手动刷新主题及首次创建后的自动刷新；
- 主题运行状态、真实错误和发现结果展示；
- 内部 `AiGateway` 抽象与 OpenRouter 实现；
- Fake Gateway 自动化测试与可选的真实 OpenRouter 冒烟测试。

现有账号与用户数据隔离能力继续作为基础设施保留。主题和发现结果属于当前用户，跨用户不可读取或触发刷新。

### 2.2 删除的产品概念

以下能力从产品、API、领域模型、数据库和界面中删除，不保留兼容状态或隐藏入口：

- “已确认 / 待核实 / 已驳回”状态；
- 一级来源、二级来源、兴趣来源及来源可信等级；
- 基于证据数量、独立来源或反证的状态机；
- 证据计数、可信状态迁移历史和更正通知；
- 需要用户填写同义词、排除词、来源范围、优先级和即时通知开关的复杂监控规则；
- “AI 只能辅助、不能参与最终判断”的旧限制。

本期不做浏览器 Push、每日邮件、创作者订阅、个性化反馈学习、社交平台专用采集器和运维来源后台。它们可以在后续独立规格中重新设计，但不得继续依赖旧可信状态体系。

## 3. 方案选择

### 3.1 OpenRouter 直连 + 内部统一抽象

首版由服务端直接调用 OpenRouter。OpenRouter 提供单一 OpenAI-compatible endpoint、`openrouter/auto` 模型路由和统一 Web Search，因而只需要一个 Key 就能完成模型调用与联网搜索。

应用内部只依赖 `AiGateway` 接口。具体 HTTP 格式、OpenRouter 的 `plugins: [{ "id": "web" }]` 扩展、响应 annotations 和错误格式全部封装在 `OpenRouterAiGateway` 内。主题发现服务只接收规范化的结构化结果与 citations，不识别 OpenRouter 请求细节。

### 3.2 范围边界

本期只实现 OpenRouter，不增加其他模型网关、供应商适配器或独立搜索服务的配置、测试和验收要求。`AiGateway` 的目的仅是隔离主题发现业务、集中处理 OpenRouter 行为并支持 Fake 测试，不代表本期承诺跨供应商兼容。

## 4. 系统架构

```text
React Web
  |  REST
  v
NestJS API ---- TopicRepository / DiscoveryRepository ---- PostgreSQL
  |
  | enqueue refresh
  v
Worker ---- TopicDiscoveryService ---- AiGateway
                                      |
                                      v
                           OpenRouterAiGateway
                                      |
                                      v
                                  OpenRouter
```

各单元职责如下：

- `Topics`：主题创建、所有权校验、列表和运行状态；
- `DiscoveryRuns`：首次发现与手动刷新任务、并发保护和失败记录；
- `TopicDiscoveryService`：编排语义扩展、联网发现、验证、去重和持久化；
- `AiGateway`：向业务提供语义扩展与带 citations 的发现能力；
- `OpenRouterAiGateway`：构造请求、启用 Web Search、解析结构化输出与 citations、规范化 OpenRouter 错误；
- `Repositories`：持久化主题、运行状态和发现结果，不包含 AI 或 OpenRouter 逻辑；
- `Web`：只消费 API，不读取 Key，也不直接请求 OpenRouter。

API 接到创建或刷新请求后只负责校验并入队，返回 `202` 或带初始任务状态的 `201`，不在长连接内等待模型。Worker 对同一主题最多运行一个发现任务；重复刷新合并为一个待执行任务。

## 5. 统一 `AiGateway`

业务接口表达能力而不是厂商 API：

```ts
interface AiGateway {
  expandTopic(input: ExpandTopicInput): Promise<ExpandedTopic>;
  discover(input: DiscoverTopicInput): Promise<DiscoveryResult>;
}
```

`ExpandedTopic` 包含规范化关键词、去重后的中英文相关词和搜索表达。`DiscoveryResult` 同时包含候选条目和本次请求的规范化 citation URL 集合；其中 `DiscoveryCandidate` 包含标题、分类、中文摘要、中文推荐理由、发布时间以及一个或多个来源 URL。分开返回 citation 集合使服务层可以复核候选 URL，而不必信任模型输出或厂商适配器的隐式过滤。

`OpenRouterAiGateway` 使用 OpenRouter 的 OpenAI-compatible `POST https://openrouter.ai/api/v1/chat/completions`。结构化输出由共享 Zod schema 校验；实现可使用 OpenRouter 支持的 JSON Schema response format，但业务正确性不能依赖 TypeScript 类型断言。Web Search 开启时，请求附加 `plugins: [{ "id": "web" }]`，并将返回的 `url_citation` annotations 规范化为 URL 集合。

只有以下内容属于配置，不进入业务调用参数：

```env
AI_API_KEY=sk-or-xxx
AI_MODEL=openrouter/auto
AI_WEB_SEARCH=true
AI_TIMEOUT_MS=60000
```

配置规则：

- OpenRouter API 地址由 `OpenRouterAiGateway` 固定管理；`AI_MODEL` 和 `AI_WEB_SEARCH` 有以上默认值，因此本机只填写 `AI_API_KEY` 即可运行；
- 更换 OpenRouter 模型只改 `AI_MODEL`，例如改成明确的模型标识；
- Key 只由 API/Worker 服务端环境读取，禁止以 `VITE_` 前缀暴露；
- 日志、错误响应、追踪属性和测试快照必须脱敏 Key 与 Authorization header；
- `.env.example` 只包含占位值，真实 `.env` 不提交版本库。

“只改 Key”表示采用默认 `openrouter/auto` 时无需选择具体模型，由 OpenRouter 自动路由；如果需要锁定或切换具体模型，必须修改 `AI_MODEL`，不能通过 Key 隐式表达模型。

## 6. 发现流程与判断规则

1. 用户提交一个去除首尾空白后的关键词；相同用户不能创建大小写与 Unicode 规范化后相同的主题。
2. 系统保存主题并自动创建首次发现任务。
3. `expandTopic` 生成有限且去重的中英文近义词、相关概念和搜索表达，并保存到 `expandedTerms`。
4. `discover` 使用原关键词、扩展词、当前日期和默认 7 天回看窗口调用 Web Search。
5. AI 对搜索结果进行语义去重并选择值得展示的近期内容，为每项指定唯一主分类：
   - `hot`：近期出现明显关注增长、密集讨论或多个相关更新；
   - `quality`：近期发布、内容实质性强且对理解或实践该主题有价值，但未达到热点标准。
6. 同一内容同时符合两类时优先标记为 `hot`，推荐理由可以说明其内容质量。
7. 服务端验证结构、URL、citation 归属和字段长度；只有 `sourceUrls` 全部来自本次规范化 citation 集合且至少包含一个有效 HTTP(S) URL 的条目才能入库。
8. 结果按“用户 + 主题 + 规范化主 URL”幂等 upsert；后续刷新可更新分类、摘要、理由和来源集合，不创建重复卡片。
9. Feed 按发布时间优先、发现时间兜底倒序展示。旧条目保留为历史发现，本期不实现自动删除。

AI 的分类是产品推荐判断，不是真实性认证。界面不得使用“可信”“已确认”“核实”“证据等级”等措辞暗示事实核验结论。

若模型明确返回空 `items`，该次运行成功并展示空状态。若模型声称有条目但条目因缺少 citations 全部被丢弃，该次运行失败并报告 `AI_CITATIONS_MISSING`，避免把上游格式故障伪装成“没有内容”。

## 7. 数据模型

### 7.1 `Topic`

| 字段 | 约束 |
| --- | --- |
| `id` | 服务端生成的稳定 ID |
| `userId` | 当前用户所有权，所有查询必须带此边界 |
| `keyword` | 1-100 个字符，保存用户输入的规范化形式 |
| `expandedTerms` | 字符串数组，由最近一次成功扩展产生 |
| `createdAt` | 服务端时间 |
| `lastRunAt` | 最近一次任务结束时间，可为空 |
| `runStatus` | `queued | running | succeeded | failed` |
| `lastError` | 可安全展示的错误码与消息，可为空 |

同一用户的规范化 `keyword` 唯一。创建时状态为 `queued`；任务开始、成功或失败必须可靠写入对应状态。上一次成功结果在刷新失败时继续可见。

### 7.2 `DiscoveryItem`

| 字段 | 约束 |
| --- | --- |
| `id` | 服务端生成的稳定 ID |
| `topicId` | 所属主题 |
| `kind` | `hot | quality` |
| `title` | 原内容标题或准确概括，不得为空 |
| `summary` | 简洁中文摘要，不得为空 |
| `reason` | 中文推荐理由，解释热点或质量判断 |
| `sourceUrls` | 至少一个经 citation 验证的 HTTP(S) URL |
| `publishedAt` | 来源无法确定时为空，不允许由模型猜测 |
| `discoveredAt` | 首次成功保存的服务端时间 |

数据库以 `topicId + canonicalPrimaryUrl` 建唯一约束；`canonicalPrimaryUrl` 是服务端内部字段，不暴露为用户填写项。删除旧 `Event`、`EventEvidence`、`EventStatusHistory`、来源可信枚举及其领域规则，由迁移明确完成，不保留双写。

## 8. API 契约

所有接口位于 `/api/v1`，并从认证上下文获取 `userId`：

- `POST /topics`：请求 `{ keyword }`；创建主题并自动入队，返回 `201` 和主题；重复关键词返回 `409 TOPIC_ALREADY_EXISTS`；未配置 Key 时返回 `503 AI_NOT_CONFIGURED` 且不创建主题；
- `GET /topics`：返回当前用户主题及运行状态；
- `POST /topics/:id/refresh`：入队或合并刷新，返回 `202` 和最新运行状态；未配置 Key 时返回 `503 AI_NOT_CONFIGURED` 且不改变现有结果或运行状态；
- `GET /feed?topicId=...&kind=hot|quality`：返回当前用户可见的发现条目；`topicId` 和 `kind` 均可选；
- `GET /items/:id`：返回单条详情和全部原始链接，不属于当前用户时返回 `404`。

统一错误响应继续包含稳定错误码、安全消息和 `traceId`。前端轮询主题状态直到 `succeeded | failed`，刷新 feed 后停止轮询；轮询不会触发新的模型请求。

## 9. 前端体验

第一屏是实际工作台，不增加营销落地页：

- 顶部提供单个关键词输入框和明确的创建命令；
- 主题列表展示关键词、最近刷新时间、运行中或失败状态，并提供图标刷新按钮和 tooltip；
- Feed 提供“全部 / 热点 / 优质”标签页；
- 条目展示分类标签、标题、中文摘要、推荐理由、发布时间和来源链接；
- 多个来源使用独立可点击链接，外链使用安全的新标签页属性；
- 加载、首次空状态、无结果、缺少 Key、限流和上游失败分别显示真实状态；
- 刷新失败时保留已有内容，同时在主题区域显示本次错误；
- 页面完全移除可信状态筛选、证据计数、来源等级和复杂规则表单。

移动端和桌面端均需完成创建主题、观察运行状态、切换分类、刷新以及打开原文的完整流程。固定工具栏、标签页和按钮应有稳定尺寸，长标题与长 URL 不得造成横向溢出或遮挡。

## 10. 错误与恢复

- 未配置 Key：创建与刷新接口在入队前返回 `503 AI_NOT_CONFIGURED`，不创建任务，也不发出网络请求；读取接口仍可用于查看已有主题和结果；
- OpenRouter `429`：规范化为可重试的 `AI_RATE_LIMITED`，遵守 `Retry-After`，Worker 采用有上限退避；
- 超时、网络错误和上游 `5xx`：规范化为可重试错误，达到上限后主题标记 `failed`；
- 鉴权失败或非法模型：不盲目重试，返回脱敏后的 `AI_AUTH_FAILED` 或 `AI_MODEL_UNAVAILABLE`；
- AI 返回非法 JSON 或 schema 不符：追加纠正指令重试一次，仍失败则 `AI_RESPONSE_INVALID`；
- 单个条目缺 citation 或 URL 非法：丢弃该条目；有其他有效条目时任务仍成功；
- 任务失败：不覆盖最近一次成功的 `expandedTerms` 和发现结果；用户可以手动重试；
- 日志可记录供应商状态码、请求 ID、耗时和模型标识，但不记录 Key、Authorization header 或完整提示词/响应正文。

## 11. 测试策略

### 11.1 默认自动化测试

所有常规测试使用可编程的 Fake `AiGateway`，不访问外网：

- 配置默认值、缺 Key、脱敏和 OpenRouter 模型选择；
- 单关键词校验、用户隔离、重复主题和首次自动入队；
- 扩展词保存、`hot | quality` 分类、中文字段和幂等去重；
- citation 白名单验证、非法 URL 丢弃、全丢弃失败和显式空结果成功；
- 非法 JSON 单次重试、限流重试、非重试错误和旧结果保留；
- API 创建、列表、刷新、feed 筛选和详情所有权；
- 前端无旧可信状态 UI，并覆盖加载、成功、空、缺 Key和刷新失败状态；
- Playwright 在桌面、平板和手机视口走通创建主题到打开原始链接的流程。

### 11.2 真实 OpenRouter 冒烟测试

真实测试默认跳过，只有本机同时设置 `RUN_LIVE_AI_TESTS=1` 和 `AI_API_KEY` 时运行。测试创建一个稳定、非敏感的技术主题，并验证：

- 请求确实到达 OpenRouter，并返回可识别的 OpenRouter 响应；
- 至少一个有效结果含原始 HTTP(S) URL；
- 每个结果都有 `hot | quality` 分类、非空中文摘要和推荐理由；
- 响应 citation 能与保存的 `sourceUrls` 对应；
- 测试输出和失败信息不泄露 Key。

实时搜索结果不可断言固定标题、数量或 `openrouter/auto` 最终选择的上游模型，以免把外部内容变化误判为代码回归。

## 12. 验收标准

1. 新用户只输入一个关键词即可创建主题，无需理解搜索语法或维护同义词。
2. 在配置有效 OpenRouter Key 的本机环境中，系统完成真实联网搜索、AI 筛选、中文摘要和原始链接展示。
3. 默认 `openrouter/auto` 下只配置 `AI_API_KEY` 可以运行；修改 `AI_MODEL` 后无需改代码即可使用另一个模型。
4. 所有展示条目至少有一个本次请求返回的 citation URL；没有来源的 AI 内容绝不展示。
5. UI、API、领域代码和数据库中不再存在三种可信状态、来源等级、证据计数或复杂监控规则。
6. 上游失败、限流、缺 Key 和非法响应均显示可操作的真实错误，且不会删除上一次成功结果。
7. Fake Gateway 测试全量通过；启用实时测试时真实结果满足 URL、分类和中文内容要求。

## 13. 实施边界

实施将在现有 React、NestJS、Worker、共享 contracts/config/domain 和 Prisma 工作区内完成，优先复用现有认证边界、API 错误结构和响应式工作台骨架。旧可信事件纵向切片将被替换，而不是与新发现模型并存。

本规格批准后再编写逐文件实施计划，并按测试驱动顺序执行：先固定新 contracts 和 `AiGateway` 行为，再替换存储/API/Worker，最后替换前端并执行真实 OpenRouter 与跨视口验收。真实 Key 由用户仅在本机 `.env` 中填写。
