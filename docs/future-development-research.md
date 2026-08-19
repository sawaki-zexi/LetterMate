# LetterMate 后续产品与工程发展研究

**研究日期：** 2026-08-15  
**适用基线：** `docs/requirements.md`、`docs/design.md`、`docs/next-development-roadmap.md`（更新至 2026-08-12）  
**方法：** 先以仓库内需求、设计和路线图确认产品边界，再查阅标准组织、官方产品文档、开源项目 README/文档及工程实践。外部来源统一列在文末，访问日期均为 2026-08-15。

外部对标分为三组：开源产品（Miniflux、FreshRSS、RSSHub、SearXNG、Readability）、商业产品/服务（Feedly、Readwise Reader、Inoreader、Firecrawl、OpenRouter），以及标准和官方工程文档（W3C/IETF、BullMQ、OpenTelemetry、PostgreSQL、OWASP、Prometheus）。产品能力只作为交互或架构启发，是否落地仍以 LetterMate 的精确关键词、来源证明、用户隔离和真实数据门槛为准。

## 1. 结论摘要

LetterMate 已经不是“关键词 RSS 阅读器”的早期原型。精确 Topic、Trend、Creator、多来源证明、质量门控、显式反馈、兴趣记忆、受约束探索、每日邮件、引用型研究简报、成本预算、生产身份和基础可观测性均已有实现。短期再增加搜索源或直接引入向量召回，收益低于完成真实生产验收和补齐个人阅读闭环。

建议按以下顺序推进：

1. **先完成生产证据闭环。** 完成邮件全链路、24 小时来源漏斗、TLS/秘密存储、告警通知、外部备份和恢复演练。没有这些证据，不应把代码侧“已实现”视为生产就绪。
2. **先消除 Feed 的增长上限。** 当前 `/feed` 没有 `limit/cursor`，PostgreSQL Adapter 会读取 Topic、Trend、Creator 的全部匹配行，再在 API 内存中合并、个性化和排序。应先增加稳定游标与有界候选池，再扩展无限滚动、已读或保存状态。[S33][S35]
3. **补齐阅读工作流。** 增加稍后读、已读/归档、保存视图和批量操作；在现有推荐原因标签与中文推荐理由之上，补充可回放到 Topic、Creator 或兴趣主题的具体依据。它们复用现有 `contentKey`、兴趣标签和反馈，不改变发现质量边界。
4. **提高订阅可迁移性和来源可理解性。** 增加 OPML/JSON 导入导出、Topic/Creator 来源健康和下一次运行状态，减少用户对“为什么今天没有内容”的猜测。FreshRSS、Miniflux 等成熟阅读器都将导入导出、状态和过滤视为基本能力。[S1][S2][S3]
5. **让抓取更省、更实时，而不是一味提高轮询频率。** 对支持方使用 WebSub/Push，对普通 HTTP 使用 ETag/Last-Modified 条件请求，并按 provider 做限流、退避和熔断。[S4][S5][S8][S14][S15][S16]
6. **把跨服务诊断升级为端到端 trace。** 现有低基数 Prometheus 指标保留；补充 API -> BullMQ -> Worker -> Connector/AI 的 OpenTelemetry context propagation，以 trace 关联日志、队列和外部调用。[S17][S18][S31]
7. **语义召回继续服从数据门槛。** 当前真实样本不足。只有路线图规定的曝光/反馈门槛满足且标签召回存在稳定缺口，才启动 pgvector shadow 与混合召回；先离线评估，再小流量实验，不直接上线在线 bandit。[S23][S24][S25][S26]

## 2. 当前开发进度判断

### 2.1 已形成的产品闭环

- 精确关键词和版本边界、技术趋势种子、RSS/X/Bilibili/YouTube/Bluesky Creator 已接入；所有候选仍需通过来源证明、正文、事实支持、增量和去重。
- 统一 Feed 已支持搜索、来源/时间/类别过滤、跨 Topic/Trend/Creator 合并和完整来源回溯。
- `interested | less` 显式反馈、兴趣记忆、稳定个性化排序、约 10% 的受约束探索和订阅保护已完成。
- 每日邮件已覆盖偏好、收件地址验证、冻结快照、引用型 AI 简报、重试、退订、测试邮件、Resend Webhook 和永久退信停发。
- AI Runtime 已有任务路由、保守预算预留、模型/provider/token/成本账本、Checkpoint 和 evidence-gap follow-up。
- 生产身份、CSRF、Session、低基数指标、结构化日志、健康探针、备份/恢复工具和容器基线已完成。

这些判断来自仓库的[产品需求](./requirements.md)、[技术方案](./design.md)和[开发路线图](./next-development-roadmap.md)，不是外部产品类比。

### 2.2 尚未完成或缺少真实证据

- 目标环境的邮件域名、Webhook、正式投递、退订、永久退信链路尚未验收。
- 来源质量阈值尚未用完整 24 小时真实漏斗校准。
- 目标环境 TLS、秘密存储、Alertmanager/通知、日志聚合、加密外部备份和恢复演练尚待完成。
- API 登录限流仍是单进程状态，横向扩展前必须迁移到 Redis 或其他共享状态。
- 语义召回评估器已完成，但当前真实曝光和反馈不足，不能证明 pgvector 有收益。
- 主动构造相邻兴趣候选尚未开始，且明确依赖真实效果基线。

### 2.3 本次代码与验证抽查

- 2026-08-15 在当前 `main` 运行 `npm run typecheck`、`npm test` 和 `npm run evaluate:quality` 均通过：107 个测试文件、927 个测试通过，8 个文件/9 个测试因数据库或真实 provider 开关而跳过；两个离线 golden case 通过。该结果证明离线回归基线健康，不等于真实来源、生产邮件或目标环境已验收。
- [`apps/api/src/topic-store.ts`](../apps/api/src/topic-store.ts) 的 `TopicStore` 同时暴露 Topic、Creator、Feed、反馈、曝光和 Trend 等二十余个方法，并由约 2,400 行的 Prisma/Memory 两套实现承担，已经不是名称所表达的单一模块。
- 同文件的 `listFeed()` 没有分页或单源上限；非搜索路径会分别 `findMany` 全部 Topic、Radar 和 Creator 行，再合并和个性化。搜索路径同样没有 SQL `LIMIT`，Creator 搜索还在 Node 内存计算相似度。数据增长后，响应时间、内存、推荐决策大小和曝光写入都会同步放大。
- [`apps/api/src/app.ts`](../apps/api/src/app.ts) 以一个 Controller 组合认证、Topic、Creator、Feed、兴趣、邮件、Webhook 和运维依赖；[`apps/web/src/App.tsx`](../apps/web/src/App.tsx) 集中所有主要页面；[`packages/contracts/src/index.ts`](../packages/contracts/src/index.ts) 集中所有契约。当前测试覆盖较强，但修改的冲突面和认知负担持续扩大。
- 数据库专用 Feed 搜索测试受 `RUN_DATABASE_TESTS=1` 控制，当前 CI 没有 PostgreSQL job，因此默认跳过了最依赖 `pg_trgm`、Prisma 查询和用户隔离的执行路径。

### 2.4 必须保留的产品边界

- 精确 Topic 不能被语义召回或 AI 扩展为泛化概念。
- Trend/Creator/外部榜单不能绕过主质量管线直接写入 Feed。
- 每条 Feed/邮件内容必须有验证过的 HTTP(S) 原文和足够正文支持。
- `hot | quality` 仍是推荐类别，不是“已核实”或可信等级。
- 用户不可见内部信任分、证据数量、来源排名或原始供应商错误。
- 不抓取私密、登录后或付费墙内容，不使用个人 Cookie，不绕过验证码。

## 3. 可新增的体验需求

下表按“近期、数据达标后、明确暂缓”划分。每项都说明可借鉴之处和 LetterMate 不应照搬的部分。

### 3.1 外部方案对照

| 类型 | 代表方案 | 最值得借鉴 | LetterMate 的取舍 |
| --- | --- | --- | --- |
| 开源阅读器 | Miniflux、FreshRSS | 已读/未读、收藏、分类、全文搜索、OPML、WebSub、开放接口。[S1][S2][S3] | 先补“保存和处理完成”的轻闭环，不扩成完整 RSS 客户端或插件平台。 |
| 商业阅读工作台 | Readwise Reader | 文章、RSS、邮件简报等进入统一稍后读收件箱，并支持组织和回顾。[S33] | 借鉴统一收件箱，不建设 PDF 标注、全文笔记和知识管理套件。 |
| 商业信息监控 | Feedly AI Feeds、Inoreader Rules | 主题收窄、可理解的过滤条件和自动动作。[S6][S34] | 先深化确定性推荐依据；来源黑名单、复杂规则和提醒仍需修改需求后再做。 |
| 开源来源 Adapter | RSSHub、SearXNG、Mozilla Readability | 扩展公开 feed、聚合搜索、确定性正文抽取。[S7][S11][S13] | 只作为 Connector/Extractor Adapter；输出仍需来源证明、事实支持、合规与 SSRF 门控。 |
| 开源变化监控 | changedetection.io | 条件选择、差异快照和通知适合监控 release notes 或文档更新。[S38] | 可作为未来“页面变化 Topic”研究原型；当前自定义 URL、选择器和逐条通知不在范围内。 |
| 工程基础方案 | BullMQ、OpenTelemetry、PostgreSQL | 幂等任务、共享限流、异步 trace、稳定分页和数据库所有权防御。[S14][S16][S17][S18][S21][S35] | 延续现有技术栈，先补 outbox、游标、DB 集成门禁和 trace，不迁移到大型工作流或搜索平台。 |

### 3.2 候选需求

| ID | 建议需求 | 可落地设计与验收 | 可借鉴方案 | 不应照搬 | 优先级 |
| --- | --- | --- | --- | --- | --- |
| UX-1 | 稍后读、已读、归档和保存视图 | 以合并后的 `contentKey` 保存用户状态；卡片可单击保存/归档，列表支持批量标记；状态跨重复来源、登录和设备保持一致。验收：任何去重合并不丢状态，归档不影响兴趣画像，未反馈不被当作负向信号。 | Miniflux/FreshRSS 的阅读状态、收藏、过滤和 API，以及 Readwise Reader 的统一稍后读收件箱，证明这是一条成熟的个人阅读工作流；LetterMate 可复用现有内容身份和所有权边界。[S1][S2][S3][S33] | 不做完整笔记知识库、PDF 标注器或全文同步平台；首版只解决“以后读”和“处理完”。 | 近期 P1 |
| UX-2 | 推荐依据深化 | 项目已有推荐原因标签和中文推荐理由；下一步在卡片展开区补充可验证的具体依据：命中哪个活动 Topic、来自哪个 Creator、哪些显式兴趣主题、是否属于探索。沿用现有“减少推荐”，理由由确定性排序输入生成，不调用 LLM 编造。验收：理由能回放到排序特征版本，订阅保护仍为 100%。 | Feedly AI Feed 的用户可配置主题模型与降噪思路可借鉴；推荐评估工具强调记录排序指标和上下文。[S6][S25] | 不展示内部质量分、证据数或“可信”标签。作者/来源黑名单仍是当前需求明确排除的复杂规则，若要增加必须先修改 canonical requirements。 | 近期 P1 |
| UX-3 | Topic/Creator 运行与来源健康解释 | 在订阅详情显示最近成功时间、下一次计划、`succeeded | degraded | failed` 的用户安全说明、启用来源数量，以及“本轮无合格结果”而非笼统空白。验收：不泄露供应商响应、账号数据、URL、配额或内部错误原文。 | FreshRSS/Miniflux 暴露订阅状态和刷新结果；LetterMate 已有 run summary 和 connector capability，可做安全投影。[S1][S3] | 不把内部 Prometheus 指标、来源排名和 provider 原始错误直接展示给用户。 | 近期 P1 |
| UX-4 | OPML/JSON 导入导出与账户数据导出 | OPML 负责 RSS/Atom，LetterMate JSON 负责 Topic 精确关键词、扩展词、Creator 稳定 ID、邮件偏好（不含邮箱验证令牌）和保存状态；导入先预览冲突，不自动触发无界发现。支持导出和账户删除的异步状态。 | FreshRSS、Miniflux 已把 OPML 作为迁移接口；数据可携与删除也符合成熟个人数据生命周期要求。[S1][S3][S29] | OPML 不能表达精确版本边界、Creator 平台身份和兴趣记忆，不能把它作为唯一备份格式；绝不导出密钥、Session、邮箱令牌或供应商 ID。 | 近期 P1 |
| UX-5 | 原文/中文双层阅读与语言偏好 | Feed 默认仍展示中文标题/摘要；详情可展开原始标题和原文片段，保留 `sourceLanguage`、`summaryLanguage`、翻译版本和生成模型；用户可选择简报语言。验收：原文不被覆盖，翻译失败不影响已验证来源，语言标签使用 BCP 47。[S30] | 多语言 feed reader 的通用做法是保留原文、按需转换；BCP 47 提供稳定语言标识。[S30] | 不自动翻译所有历史全文；不把机器翻译当作事实证据；不改写引用原文。 | 中期 P1 |
| UX-6 | “事件簇/更新了什么”而非仅删除重复项 | 在现有严格去重上增加只读聚类层：同一发布、论文、漏洞或产品事件可显示多来源和时间线；新文章若只有重复事实则合并，若有实质增量则显示“新增信息”。验收：每个子来源仍有独立 proof；合并错误可回退；不改变原有 `contentKey` 去重。 | OpenSearch 的混合检索与 rank fusion 可用于候选聚类，Evidently 的排名指标可评估簇内排序。[S24][S25] | 不用 embedding 直接决定事实同一性；不因“多数来源一致”产生已核实标签；不把来源数量当质量分。 | 中期 P1 |
| UX-7 | Creator 的 Push 优先、轮询兜底 | 对 YouTube 等支持 WebSub/Push 的来源订阅更新事件；事件只触发增量同步，最终内容仍走 Creator 质量与中文化管线。保留定期 reconciliation 防丢事件。[S4][S5] | W3C WebSub 和 YouTube Push 都采用 hub 通知模式，可减少无变化轮询并缩短发现延迟。[S4][S5] | 不把 Push payload 直接写 Feed；不取消周期校对；不为所有平台承诺实时。 | 中期 P1 |
| UX-8 | 低频“重点提醒”和每周回顾 | 在每日邮件稳定后，允许 Topic 级“重大更新提醒”和每周回顾；默认关闭，具有 quiet hours、每日上限和去重窗口。提醒候选必须比普通 Feed 有更高增量门槛。 | Inoreader 的 Rules 是“条件 -> 动作”的商业产品参考，WebSub 提供及时事件入口。[S4][S34] | 当前需求明确排除浏览器 Push、逐条邮件和任意周期摘要，因此必须先更新 canonical requirements；不应默认开启或为每条内容通知。 | 数据达标后 P2 |
| UX-9 | RSS/Creator 路径发现助手 | 用户粘贴主页时，先尝试标准 feed discovery、sitemap 和平台 Resolver，再给出可核对候选；管理员可选部署 RSSHub 作为显式能力，不自动绕过站点限制。[S7][S10] | RSSHub 展示了将公开站点转换为 RSS 的广泛 adapter 模式；sitemap 是标准化 URL 发现入口。[S7][S10] | RSSHub 路由质量、合规性和可用性因站点而异，不能成为“任意平台都可关注”的承诺，也不能使用登录 Cookie 路由。 | 中期 P1 |
| UX-10 | 个人仪表盘中的可操作质量摘要 | 只展示用户可理解的结果：过去 7/30 天每个 Topic/Creator 发现条数、无合格结果次数、保存/反馈分布、来源多样性提示。验收：不展示用户间对比，不用曝光不足的数据做强结论。 | 推荐系统评估框架区分曝光、反馈、排序质量；LetterMate 已有 impression/feedback 数据模型。[S25][S26] | 不做“兴趣分数”、成瘾式连续刷新、跨用户榜单或公开画像。 | 中期 P1 |
| UX-11 | 首次价值引导与恢复入口 | 注册后用三步内完成第一个 Topic 或 Creator；创建后显示精确监控范围、排队状态、预计下一次更新和“无合格结果也是成功”的解释。记录匿名聚合的 `register -> first subscription -> first qualified item -> first save/feedback` 漏斗与 time-to-first-value。 | 商业阅读器普遍先建立收件箱或订阅，再逐步组织内容；LetterMate 已有运行摘要和曝光事件，可复用而不引入行为画像。[S6][S33][S34] | 不用假数据冒充发现结果，不强迫开启邮件，不把单纯点击作为兴趣信号，也不把用户 ID、关键词放入指标标签。 | 近期 P1 |

## 4. 可优化的工程模块

### 4.1 本地代码结构与关键数据路径

这些建议按深模块原则组织：一个小而稳定的接口隐藏较多实现细节；测试和调用方都跨同一个 seam；只有确有生产与测试两种实现时才保留 Adapter。

| ID | 优化方向 | 实施建议 | 优先级与验收 |
| --- | --- | --- | --- |
| ENG-0A | 有界 Feed 模块 | 把当前 `TopicStore.listFeed()` 收敛为独立 Feed 模块，例如 `getPage(scope, query) -> FeedPage`、`react(scope, command)`、`recordExposure(scope, batch)` 三个接口动作。PostgreSQL Adapter 每个候选通道只取有界窗口，按唯一稳定顺序生成 opaque cursor，再合并、去重和个性化；契约返回 `items + nextCursor`。数据量继续增长时再评估持久化 `FeedEntry/FeedOrigin` 读模型，不先做大迁移。[S35][S36] | **P0。** 任意页的候选读取有硬上限；翻页无重复/遗漏；相同 cursor 输入顺序稳定；搜索、筛选、订阅保护、决策/曝光仍正确；为查询加 `EXPLAIN ANALYZE` 容量基线。 |
| ENG-0B | 事务型任务投递 | 当前 Controller 在数据库写入后调用 BullMQ，失败时再补偿。改为在同一 PostgreSQL 事务写业务状态和 outbox 记录；relay 用稳定业务键入队，成功后标记已投递，Worker 继续保持幂等。该模块对调用方只暴露 `register(command)`，隐藏事务、outbox 和 job ID 规则。[S14][S37] | **P0/P1。** 在 DB commit、Redis 断连、relay 崩溃和重复投递故障注入下，任务最终可达且业务结果不重复；补偿分支明显减少。 |
| ENG-0C | 按业务纵向拆分 API/Web | NestJS 按 Auth、Topics、Creators、Feed/Interests、Digest、Operations 形成模块，各 Controller 只处理传输与所有权上下文，调用对应深模块；不要创建一组只转发的薄类。Web 按 route/feature 拆出页面、query key、mutation 与局部样式，`App.tsx` 只保留路由壳、Session 和全局布局。 | **P1，行为不变重构。** 先迁移 Feed 和 Digest 两个变化最快的区域；原端到端行为和 URL 不变；删除已被新接口测试覆盖的内部实现测试，避免双份测试。 |
| ENG-0D | 契约分域但保留单入口 | 将 `packages/contracts/src/index.ts` 按 `auth/topic/creator/feed/interest/digest/operations` 分文件，根 `index.ts` 只做兼容导出。Schema、推导类型和 API/Worker job 契约仍只有一个事实来源。 | **P1。** 公共 export 不破坏；每个域的 schema 测试就近维护；不复制 enum 或 DTO。 |
| ENG-0E | PostgreSQL 集成门禁 | CI 增加 PostgreSQL service，执行迁移并开启 `RUN_DATABASE_TESTS=1`；优先覆盖 Feed 搜索/游标、所有权、并发刷新、outbox 和关键租约。Memory Adapter 继续用于快速行为测试，但不能替代 PostgreSQL 专有 SQL、索引和事务测试。 | **P0。** 数据库路径不再默认 skip；迁移从空库可部署；错误用户读写、游标并发插入和重复 relay 均有回归用例。 |
| ENG-0F | 谨慎整理 AI Adapter | `OpenRouterAiGateway` 虽然文件较大，但已把 provider transport、结构化校验、预算预留和安全错误隐藏在统一 Adapter 后，不能仅按行数拆。可把各任务的 prompt/schema/version 移到就近的内部 task spec，保留一次请求、用量记录和错误映射的单一实现。 | **P2。** 外部 AI 接口和预算语义不变；任务 fixtures 能独立评审；没有新增只包装一次函数调用的浅模块。 |

### 4.2 搜索、抓取与 Connector

| ID | 优化方向 | 实施建议 | 来源与边界 |
| --- | --- | --- | --- |
| ENG-1 | Connector 能力契约 | 为每个 connector 明确 `supportsCursor`、`supportsConditionalFetch`、`supportsPush`、速率窗口、最大分页、内容类型、合规模式和安全错误码；配置能力和运行健康分离。调度器基于契约做 provider 级并发与预算分配。 | BullMQ 提供全局/手动 rate limit 和退避基础。[S15][S16] 不把可配置 connector 自动视为可用，也不泄露账号、URL 或供应商错误。 |
| ENG-2 | 条件请求和响应缓存 | 在 URL + 认证范围内保存 ETag、Last-Modified、内容哈希、MIME 和有限 TTL；发送 `If-None-Match`/`If-Modified-Since`，304 不进入正文/AI 阶段。重定向后的每一跳仍重新执行 SSRF 校验。 | HTTP Semantics 定义条件请求及 304。[S8] 缓存不能跨用户复用私有凭据响应；当前产品只抓公开内容时可按规范化公共 URL 共享正文缓存。 |
| ENG-3 | Push + reconciliation 调度 | 抽象 `SourceEvent -> sync seed`，WebSub/平台事件只入幂等队列；每 24 小时或平台合适周期做 cursor reconciliation。记录事件延迟、重复率、漏补数量。 | WebSub 和 YouTube Push 是一手标准/厂商方案。[S4][S5] Push 是触发器，不是 source proof。 |
| ENG-4 | 正文抽取多策略和可测置信度 | 将 HTTP 获取、正文抽取、平台结构化解析分层。通用 HTML 先用 Readability 类确定性抽取，失败时再进入受限动态渲染/外部 extraction adapter；保存抽取器版本、字符数、正文/导航比例和失败码。 | Mozilla Readability 提供稳定 DOM 正文抽取；Firecrawl 展示渲染、抓取和结构化提取能力。[S11][S12] 外部 extraction 服务仍必须经过 LetterMate 的 URL、安全、MIME、大小和来源验证，不能被视为可信正文。 |
| ENG-5 | robots、sitemap 与礼貌抓取 | 在 connector 合规策略中记录 robots 适用性、最小抓取间隔、User-Agent、站点级并发和退避；sitemap 仅生成候选 URL。 | Robots Exclusion Protocol 与 sitemap 是公开标准。[S9][S10] robots 不是授权机制，也不能替代 SSRF 和 ToS 审查。 |
| ENG-6 | 通用搜索 adapter 的可替换性 | 保留现有 Brave/Tavily/Bing/provider adapter；可在开发或自托管场景评估 SearXNG，但只把它当查询聚合器并逐引擎记录安全失败。 | SearXNG 暴露结构化 Search API。[S13] 不应把 scrape 多个搜索引擎视为稳定生产 SLA；仍需遵守引擎条款、限流和结果 proof。 |
| ENG-7 | 动态浏览器隔离 | 只有静态抽取失败且来源白名单/策略允许时才进入独立低并发队列；容器禁用内网访问，限制 CPU/内存/时间/下载，产物重新经过 MIME/大小/URL 检查。 | Firecrawl 的浏览器抓取能力证明动态渲染的价值；OWASP SSRF 指南要求网络层与应用层双重防护。[S12][S22] 不在主 Worker 内启动无限浏览器，不自动绕过登录、验证码或付费墙。 |

### 4.3 调度、可靠性与队列

| ID | 优化方向 | 实施建议 | 来源与边界 |
| --- | --- | --- | --- |
| ENG-8 | 幂等、去重和重放清单 | 对 Topic/Trend/Creator/邮件/Push 统一记录业务幂等键、策略版本和最终状态；将可重试失败与永久失败分开；提供只接受安全参数的运维重放命令。 | BullMQ 明确建议将 job 设计为简单、原子、幂等，并支持 fixed/exponential backoff。[S14][S15] 不把 BullMQ job ID 当跨迁移的唯一业务身份。 |
| ENG-9 | provider 级公平调度 | 以 provider + credential scope 设置全局速率限制和并发，用户/Topic 采用加权公平队列；手动刷新有小额优先额度但不能饿死计划任务。429 时读取安全的 retry-after 并触发共享冷却。 | BullMQ rate limiting 支持全局和手动限流。[S16] 不按用户 ID 建 Prometheus label，不把单个大用户拖垮共享来源。 |
| ENG-10 | 卡死检测与恢复 | 为每阶段定义 heartbeat、最大运行时间和 cancel 传播；租约过期只能由 checkpoint 恢复，不从头重复所有 AI/搜索调用。增加 stalled/recovered/permanent-failure 指标和审计。 | BullMQ 的重试/幂等模式与现有 RunStage Checkpoint 互补。[S14][S15] 不急于迁移到 Temporal；当前 BullMQ + DB checkpoint 足以承载现阶段复杂度。 |
| ENG-11 | 故障注入测试 | 在 CI/预生产对 Redis/PostgreSQL/SMTP/HTTP 模拟延迟、断连、半开连接和限带宽，验证取消、重试、幂等和优雅退出。 | Toxiproxy 专门模拟网络条件，适合自动化集成测试。[S20] 不在生产用户流量上无审批注入故障。 |

### 4.4 可观测性与 SLO

| ID | 优化方向 | 实施建议 | 来源与边界 |
| --- | --- | --- | --- |
| ENG-12 | 端到端 trace 传播 | 使用 OpenTelemetry W3C trace context，API 入站创建 span，BullMQ producer 注入 context，Worker 提取后为 connector、正文、AI、持久化建 child span；日志保留 trace/run ID。 | OTel context propagation 与 BullMQ telemetry 都支持跨异步边界关联。[S17][S18] span 属性不得含用户 ID、关键词、URL、邮箱和正文。 |
| ENG-13 | 指标到 trace 的受控关联 | 保留低基数 histogram/counter；只在慢请求或失败样本写 exemplar trace ID，并设置采样和保留策略。 | Prometheus exemplar 可把聚合指标关联到特定 trace。[S31] 不能把高基数资源 ID放入普通 label。 |
| ENG-14 | 用户结果导向 SLO | 分别定义：API 可用性、调度及时性、来源成功新鲜度、合格内容端到端延迟、邮件按本地时间送达率、恢复点/恢复时间。告警以 burn rate 为主，来源“零候选”需结合查询量和窗口完整性。 | Google SRE 的 SLO 告警建议基于错误预算消耗，而不是单个瞬时阈值。[S19] 空结果是正常成功，不能把“没有 Feed 项”直接算故障。 |
| ENG-15 | 数据质量 lineage | 为每个最终条目记录 connector、extractor、quality policy、AI route、dedupe 和 ranking 版本；对用户隐藏内部评分，但运维可按版本离线回放。 | OTel 提供执行链，Evidently/Microsoft Recommenders 提供排序评估框架。[S18][S25][S26] lineage 不应包含原始密钥或未脱敏 payload。 |

### 4.5 排序、语义召回与评估

| ID | 优化方向 | 实施建议 | 启动门槛与边界 |
| --- | --- | --- | --- |
| ENG-16 | pgvector shadow 召回 | 仅在现有路线图门槛满足后，为合格公共候选和用户兴趣簇生成版本化 embedding；shadow 查询不影响线上排序，先计算标签召回缺口覆盖、精确版本越界、跨用户违规和成本。 | pgvector 支持 exact、HNSW、IVFFlat 和带过滤查询。[S23] HNSW 的近似过滤可能少返回结果，需要 iterative scan/过采样；向量相似不能绕过 Topic 精确边界。 |
| ENG-17 | 受约束混合召回 | 先分别执行精确 Topic、Creator、标签邻接和向量召回，再在合格集合中用 RRF 或稳定归一化融合；订阅项是保护集合，探索仍有约 10% 上限且不进邮件。 | OpenSearch 的 RRF processor 说明可在不直接比较异构分数时融合多个排名。[S24] 不直接相加 BM25、规则分和 cosine；不以 embedding 生成证据。 |
| ENG-18 | 离线回放与准入报告 | 固化 rolling split；报告 Recall@K、NDCG@K、MRR、覆盖率、重复率、负反馈率、订阅覆盖和来源多样性，并按日期/来源而非敏感用户标签切片。每次 policy/model 变更产出可比较报告。 | Evidently 和 Microsoft Recommenders 提供常用 ranking metrics、数据拆分与评估实现。[S25][S26] 没有曝光/反馈时必须输出 `insufficient_data`，不能用合成指标宣称提升。 |
| ENG-19 | 小流量实验而非在线 bandit | shadow 胜出后，用稳定用户哈希做可撤销小流量实验，记录 decision ID、资格候选和 policy version；设订阅覆盖/跨用户泄漏为 hard guardrail。 | 推荐评估框架可用于线上前的离线比较。[S25][S26] 负反馈和样本不足时不上 bandit；不把未点击视为负反馈。 |

### 4.6 安全、多租户和权限

| ID | 优化方向 | 实施建议 | 来源与边界 |
| --- | --- | --- | --- |
| ENG-20 | SSRF 防御深化 | DNS 解析后验证全部 A/AAAA，连接时固定解析结果或使用受控 egress proxy；每次重定向重新校验；阻断私网、链路本地、metadata、非 HTTP(S)、异常端口和 DNS rebinding；响应流式限大小。 | OWASP SSRF 指南建议应用层 allow/deny 与网络层 egress 控制组合。[S22] allowlist 对通用 Web 发现不现实，需采用严格 deny + egress 隔离 + 重定向复检。 |
| ENG-21 | 分布式限流 | 横向扩展前把登录、邮箱验证、测试邮件和外部 provider 配额迁移到 Redis/数据库共享原子状态；键使用 HMAC/规范化摘要，TTL 和失败策略明确。 | BullMQ 的共享 rate limiter 可用于 worker provider 配额。[S16] 登录/API 限流仍需独立实现，不能误用 job limiter 替代。 |
| ENG-22 | PostgreSQL RLS 防御层 | 在确认 Prisma 连接池和事务上下文可稳定设置 tenant/user session variable 后，为高风险用户表评估 RLS shadow/测试；API ownership 仍保留。 | PostgreSQL Row Security 可按每行策略限制 SELECT/INSERT/UPDATE/DELETE，启用后无策略默认拒绝。[S21] 不应在没有连接上下文隔离验证时贸然启用，也不能用 RLS 替代 API 的 404/所有权逻辑。 |
| ENG-23 | 团队/分享权限暂缓 | 先完成个人账户导出、删除、会话列表和设备撤销；只有出现明确团队共享需求时，再引入 workspace、role、share link、审计日志和对象级授权模型。 | RLS 可支撑租户隔离基础。[S21] 当前产品定位是个人工作台，不应提前引入复杂 RBAC/ReBAC 和多租户计费。 |
| ENG-24 | 数据保留与删除作业 | 明确 Feed、原文缓存、AI usage、曝光、反馈、邮件运行、Webhook 幂等记录和安全日志的不同保留期；删除账户采用可审计异步流程，先撤销 Session/调度，再清理或匿名化。 | GDPR 官方文本提供删除和数据可携的成熟基线。[S29] 法律适用范围需单独评估；这里借鉴的是数据生命周期设计，不宣称 LetterMate 已满足任何法规。 |

### 4.7 成本与容量控制

| ID | 优化方向 | 实施建议 | 来源与边界 |
| --- | --- | --- | --- |
| ENG-25 | 单位结果成本账本 | 在现有 `AiUsage` 上增加只聚合的 `cost per fetched candidate`、`cost per supported candidate`、`cost per final item`、`wasted retry cost`；按 run kind、task、model route、connector 统计，不以用户为指标 label。 | OpenRouter 提供 usage accounting，当前 Runtime 已保存实际模型/provider/token/成本。[S27][S28] 账本用于调度和运维，不显示为用户质量分。 |
| ENG-26 | 任务级模型路由与降级 | 规则可完成的工作不调用模型；分类/本地化使用 fast route，事实评审/简报使用 quality route；provider fallback 只在预算和 policy 允许时执行，并冻结 run policy。 | OpenRouter 支持 provider routing/fallback 与使用量字段。[S27][S28] 不让 fallback 绕过数据驻留、模型能力、结构化输出或预算约束。 |
| ENG-27 | 成本感知调度 | 根据 Topic 活跃度、上次增量、用户手动刷新、provider 冷却和剩余运行预算决定分页/连接器；先执行廉价来源与缓存，证据缺口明确时再做昂贵搜索/AI。 | HTTP 条件请求、BullMQ 限流和现有 evidence-gap follow-up 提供基础。[S8][S16] 不能因成本降级跳过 proof/quality，也不能让付费来源长期挤占来源多样性。 |
| ENG-28 | 容量基线与负载模型 | 建立每 1,000 Topic/Creator 的队列吞吐、DB 增长、Redis 内存、正文缓存、AI tokens、邮件峰值和外部配额模型；用压测验证 backpressure 与优雅降级。 | SLO 和故障注入方法可验证容量边界。[S19][S20] 负载测试不得调用真实外部 provider 或发送真实邮件，除非使用显式隔离的 live 环境和配额。 |

## 5. 推荐实施路线

### 阶段 A：生产验收与低风险体验闭环（0-4 周）

1. 完成路线图已有的邮件、监控、备份、TLS、秘密和来源漏斗验收，保存目标环境证据。
2. 先实现 ENG-0A Feed 游标/有界候选池和 ENG-0E PostgreSQL CI 门禁，建立当前数据量与 10 倍数据量的查询基线。
3. 为 Topic/Creator 创建和刷新引入 ENG-0B outbox 最小切片，验证 Redis 断连与重复 relay；稳定后再覆盖邮件和 Push。
4. 实现 UX-1 稍后读/已读/归档、UX-2 推荐依据深化和 UX-11 首次价值引导。
5. 实现 UX-3 订阅运行状态和安全错误说明；把登录和邮件限流迁移到共享状态，为 provider 增加全局限流和冷却。
6. 在 API -> Queue -> Worker 接入 trace context，先覆盖一个 Topic run 和一个 Digest run。

**退出条件：** Feed 查询和内存使用有硬上限；数据库专有路径进入 CI；任务在 DB/Redis 部分故障下最终可达且不重复；生产故障可从告警定位到 run/stage；用户能处理、保存和理解 Feed；横向扩展不依赖进程内限流。

### 阶段 B：可迁移、低成本的新鲜发现（4-8 周）

1. 实现 OPML + LetterMate JSON 导入导出和账户数据导出/删除基础流程。
2. 为通用 HTTP connector 增加 ETag/Last-Modified、内容缓存和抽取器版本。
3. 对 YouTube/WebSub 做 Push 试点，保留 reconciliation；测量轮询节省和通知延迟。
4. 增加原文/中文层和语言元数据，不批量重翻历史全文。
5. 在预生产加入 Redis/PostgreSQL/HTTP/邮件故障注入测试。

**退出条件：** 无变化请求的正文/AI 调用显著下降；Push 事件重复不产生重复内容；用户可迁移并删除自己的数据。

### 阶段 C：内容组织和评估（8-12 周）

1. 以规则 + 指纹实现事件簇原型，embedding 只做离线辅助，不直接合并。
2. 建立跨 policy 版本的离线回放报告和单位结果成本报告。
3. 校准用户质量摘要、来源多样性和事件簇误合并率。
4. 只有真实语义召回门槛达标，才创建 pgvector shadow；否则继续完善标签召回。

**退出条件：** 事件簇有人工抽样精度门槛和回退路径；语义召回准入结论可复现为 `admit | reject | insufficient_data`。

### 阶段 D：由数据触发，而非按日历启动

- pgvector shadow 在离线稳定提升且 hard guardrail 全通过后，进入 5%-10% 可撤销实验。
- 重点提醒/每周回顾必须先更新 `requirements.md` 和 `design.md`，并有用户需求证据。
- 团队空间、分享权限、在线 bandit、浏览器抓取集群、复杂工作流引擎均需独立 ADR 和容量/风险证明。

## 6. 建议的量化验收指标

| 领域 | 建议指标 | 首个门槛 |
| --- | --- | --- |
| 阅读闭环 | 保存成功率、归档状态跨重复来源一致性、批量操作失败率 | 状态一致性 100%；跨用户违规 0 |
| 推荐解释 | 可解释覆盖率、解释与 policy version 回放一致率、订阅保护率 | 覆盖/一致/保护均 100% |
| 条件抓取 | 304 比例、每个最终条目的下载字节和抽取调用 | 在可缓存来源下降至少 30%，质量门槛不变 |
| Push | 端到端延迟、重复事件率、reconciliation 漏补率 | 重复不产生重复内容；漏补可被 24 小时校对发现 |
| 正文抽取 | 足够正文率、错误正文率、动态渲染占比 | 按来源建立基线；动态渲染必须有硬上限 |
| 队列 | p95 排队时间、stalled rate、永久失败率、provider 429 | 手动刷新不饿死计划任务；429 触发共享冷却 |
| 可观测性 | 失败 run 的 trace 覆盖、告警到根因时间 | 关键 run trace 覆盖 95% 以上；不增加敏感 label |
| 成本 | 每个 supported/final candidate 成本、重试浪费 | 每周可解释；预算超限不发生上游调用 |
| 事件簇 | 人工抽样 precision、漏合并率、错误来源合并 | precision 先于 recall，错误合并可撤销 |
| 语义召回 | Recall@K/NDCG、语义缺口覆盖、订阅覆盖、越界/泄漏 | 沿用路线图数据门槛；订阅覆盖 100%，越界/泄漏 0 |

## 7. 明确不建议当前照搬的方案

1. **不迁移到 Temporal/大型工作流平台。** 现有 BullMQ、数据库运行租约和 checkpoint 已覆盖核心恢复语义；先补齐 provider 公平性、trace 和故障演练。
2. **不部署全量 Bluesky firehose/Jetstream 作为默认 Creator 路径。** Jetstream 能按 collection/DID 过滤并从 cursor 回放，但仍是持续流基础设施；对个人订阅规模，定期同步或有限事件订阅更经济。[S32]
3. **不把 RSSHub、SearXNG 或 Firecrawl 当“万能来源”。** 它们分别解决 feed adapter、搜索聚合和动态提取，不提供 LetterMate 所需的来源证明、平台授权、事实支持或稳定 SLA。[S7][S12][S13]
4. **不让 LLM 负责推荐解释、去重身份或权限决策。** 这些需要确定性输入、可回放版本和 hard guardrail；LLM 只在受约束生成、标签或评审环节工作。
5. **不提前建设团队 RBAC/ReBAC。** 先解决个人数据导出/删除、共享限流和数据库隔离验证；团队功能出现真实需求后再设计。
6. **不因 WebSub/Push 取消轮询校对。** 事件可能重复、延迟或丢失，Push 只能触发幂等同步。[S4][S5]
7. **不因 pgvector 引入向量即宣称“更懂用户”。** HNSW/IVFFlat 是召回工具，不是质量证明；必须与标签基线在无未来泄漏数据上比较。[S23][S25]
8. **不把浏览器渲染作为默认抓取。** 它放大 SSRF、资源消耗、反爬和合规风险，只应作为隔离且有预算的最后手段。[S12][S22]

## 8. 外部来源

> 以下链接均于 **2026-08-15** 访问。厂商/项目能力会变化，落地前应再次核对版本、许可、配额和服务条款。

- **[S1] Miniflux 官方仓库。** Feed reader、过滤、保存/阅读状态、导入导出和 API 的开源实现参考。<https://github.com/miniflux/v2>
- **[S2] Miniflux API 文档。** 订阅、条目、分类、状态和集成接口参考。<https://miniflux.app/docs/api.html>
- **[S3] FreshRSS 官方仓库。** 多用户 feed reader、WebSub、过滤、标签、OPML 和扩展能力参考。<https://github.com/FreshRSS/FreshRSS>
- **[S4] W3C WebSub Recommendation。** Publisher、Hub、Subscriber 的订阅与通知标准。<https://www.w3.org/TR/websub/>
- **[S5] YouTube Data API - Push notifications。** 使用 WebSub 接收频道视频更新的厂商文档。<https://developers.google.com/youtube/v3/guides/push_notifications>
- **[S6] Feedly - What is an AI Feed。** 用户定义主题模型、持续收窄信息流的产品参考。<https://docs.feedly.com/article/375-what-is-an-ai-feed>
- **[S7] RSSHub 官方仓库与文档入口。** 将公开站点内容转换为 RSS 的 adapter 模式。<https://github.com/DIYgod/RSSHub>
- **[S8] RFC 9110: HTTP Semantics, Conditional Requests。** ETag、Last-Modified、条件请求和 304 的标准语义。<https://www.rfc-editor.org/rfc/rfc9110.html#name-conditional-requests>
- **[S9] RFC 9309: Robots Exclusion Protocol。** `robots.txt` 的标准化规则。<https://www.rfc-editor.org/rfc/rfc9309>
- **[S10] Sitemaps Protocol。** Sitemap XML 和 URL 发现格式。<https://www.sitemaps.org/protocol.html>
- **[S11] Mozilla Readability 官方仓库。** 从 DOM 提取主要可读正文的开源实现。<https://github.com/mozilla/readability>
- **[S12] Firecrawl 官方文档。** Crawl、Scrape、Map、动态渲染与结构化提取的工程参考。<https://docs.firecrawl.dev/introduction>
- **[S13] SearXNG Search API。** 自托管 meta-search 的结构化 API 参考。<https://docs.searxng.org/dev/search_api.html>
- **[S14] BullMQ - Idempotent jobs。** 原子、简单、可重试 job 的设计模式。<https://docs.bullmq.io/patterns/idempotent-jobs>
- **[S15] BullMQ - Retrying failing jobs。** 失败、attempts、fixed/exponential backoff 和 jitter。<https://docs.bullmq.io/guide/retrying-failing-jobs>
- **[S16] BullMQ - Rate limiting。** Worker 全局与手动限流机制。<https://docs.bullmq.io/guide/rate-limiting>
- **[S17] BullMQ - Telemetry。** 基于 OpenTelemetry 的 producer/consumer trace 关联。<https://docs.bullmq.io/guide/telemetry>
- **[S18] OpenTelemetry - Context propagation。** 跨服务和异步边界传播 execution context。<https://opentelemetry.io/docs/concepts/context-propagation/>
- **[S19] Google SRE Workbook - Alerting on SLOs。** 基于错误预算和 burn rate 的告警设计。<https://sre.google/workbook/alerting-on-slos/>
- **[S20] Shopify Toxiproxy 官方仓库。** 自动化模拟网络延迟、断开和带宽限制。<https://github.com/Shopify/toxiproxy>
- **[S21] PostgreSQL - Row Security Policies。** 按行限制读写的数据库防御层。<https://www.postgresql.org/docs/current/ddl-rowsecurity.html>
- **[S22] OWASP SSRF Prevention Cheat Sheet。** URL/DNS 校验、网络层 egress 和重定向风险防护。<https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html>
- **[S23] pgvector 官方仓库。** PostgreSQL exact/approximate vector search、HNSW/IVFFlat 和过滤行为。<https://github.com/pgvector/pgvector>
- **[S24] OpenSearch - RRF score ranker processor。** 多个查询结果的 reciprocal rank fusion。<https://docs.opensearch.org/latest/search-plugins/search-pipelines/score-ranker-processor/>
- **[S25] Evidently - Ranking and recommendation metrics。** NDCG、MAP、MRR、Hit Rate 等评估指标。<https://docs.evidentlyai.com/metrics/explainer_recsys>
- **[S26] Microsoft Recommenders 官方仓库。** 推荐系统数据准备、模型和评估的开源最佳实践。<https://github.com/recommenders-team/recommenders>
- **[S27] OpenRouter - Provider routing。** provider 选择、排序和 fallback 约束。<https://openrouter.ai/docs/guides/routing/provider-selection>
- **[S28] OpenRouter - Usage accounting。** 请求 usage、token 与成本字段。<https://openrouter.ai/docs/use-cases/usage-accounting>
- **[S29] EU GDPR 官方文本。** 删除、数据可携和处理生命周期的法规基线；具体适用性需法律评估。<https://eur-lex.europa.eu/eli/reg/2016/679/oj>
- **[S30] RFC 5646: Tags for Identifying Languages。** BCP 47 语言标签标准。<https://www.rfc-editor.org/rfc/rfc5646>
- **[S31] Prometheus - Exemplar storage。** 将 histogram 样本关联到 trace 等 exemplar。<https://prometheus.io/docs/prometheus/latest/feature_flags/#exemplars-storage>
- **[S32] Bluesky Jetstream 官方仓库。** 简化 AT Protocol firehose、按 collection/DID 过滤和 cursor 回放。<https://github.com/bluesky-social/jetstream>
- **[S33] Readwise Reader 官方产品页。** 将文章、邮件简报、RSS、PDF 等汇入统一稍后读收件箱的商业产品参考。<https://readwise.io/read>
- **[S34] Inoreader - Rules 官方知识库。** 使用条件匹配执行标签、星标、通知等动作的商业产品参考。<https://www.inoreader.com/knowledge-base/rules/>
- **[S35] PostgreSQL - LIMIT and OFFSET。** 分页必须使用唯一且可预测顺序；大 OFFSET 仍需计算被跳过的行。<https://www.postgresql.org/docs/current/queries-limit.html>
- **[S36] TanStack Query - Infinite Queries。** 基于 `nextCursor`、`pageParam` 和 `fetchNextPage` 的前端分页模式。<https://tanstack.com/query/latest/docs/framework/react/guides/infinite-queries>
- **[S37] Transactional Outbox pattern。** 在同一数据库事务中保存业务变更和待投递消息，再由 relay 发布，避免 DB 与消息代理之间的双写窗口。<https://microservices.io/patterns/data/transactional-outbox.html>
- **[S38] changedetection.io 官方仓库。** 自托管网页变化检测、选择器、差异与通知的开源实现参考。<https://github.com/dgtlmoon/changedetection.io>

## 9. 决策建议

将本研究作为候选池，而不是直接替换 canonical roadmap。最合理的下一次需求更新应只吸收：

1. 生产验收的明确证据和责任人；
2. 稍后读/已读/归档、确定性推荐解释、订阅健康；
3. OPML/JSON 导入导出和账户数据生命周期；
4. 条件请求、Push 试点、provider 限流、端到端 trace；
5. 语义召回的严格准入门槛和 shadow 路径。

通知、每周简报、团队空间、通用动态浏览器抓取和在线 bandit 继续保持候选状态，直到用户需求、真实数据或容量证据触发。任何进入实施的需求都应同步更新 `docs/requirements.md` 与 `docs/design.md`，不要另建竞争性产品规范。
