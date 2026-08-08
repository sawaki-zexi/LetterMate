# LetterMate 兴趣记忆与个性化发现研究

**日期：** 2026-08-08
**范围：** 用户兴趣记忆、内容召回、排序、探索、多样性、评估与隐私
**结论：** LetterMate 不需要先引入“大模型代理记忆”。更适合当前产品的核心，是一套可审计、可撤销的推荐记忆：保留原始信号，分别维护短期和长期兴趣，以多路候选召回、质量门控、个性化排序和受控探索组成完整闭环。

## 1. 当前基础与问题定义

LetterMate 已经具备推荐系统中最难替代的资产：

- `Topic` 表示用户主动建立的精确关键词监控；具体型号和版本边界不能被语义扩展破坏。
- `CreatorSubscription` 表示用户主动关注的公开账号；X、Bilibili 和 RSS/Atom 已有持续采集链路。
- `DiscoveryItem`、`RadarItem`、`CreatorItem` 已经过正文、事实支持、质量和去重门控。
- Feed 通过稳定的规范化 URL `contentKey` 合并 Topic、Trend 和 Creator 来源，并保留 `origins[]`。
- `ContentFeedback(userId, contentKey)` 已持久化 `interested | less`，支持幂等切换、取消和所有权保护。

当前缺口不是更多“记忆文本”，而是四个明确模块：

1. 将关键词、关注和显式反馈转换成可解释的兴趣信号。
2. 区分短期正在关注的变化与长期稳定偏好。
3. 从已有合格内容中召回、排序并做少量探索，而不改变质量门槛。
4. 记录曝光和反馈结果，形成可离线重放、可比较的评估闭环。

## 2. 开源系统能借鉴什么

### 2.1 RecBole：实验台，不是线上记忆服务

RecBole 将通用、序列、上下文和知识型推荐统一到一套数据格式与评估协议中，并提供按时间或比例切分、全排序或负采样评估，以及 Recall、MRR、NDCG、Hit、Precision 等排名指标。它最适合 LetterMate 用来离线比较“无个性化、规则模型、序列模型”等方案，而不应直接承担在线 Feed 服务。[RecBole README](https://github.com/RUCAIBox/RecBole)；[RecBole evaluation settings](https://recbole.io/docs/user_guide/config/evaluation_settings.html)

可复用机制：事件数据采用统一 schema；按时间切分避免未来信息泄漏；同一固定数据快照比较多个排序器。

### 2.2 TorchRec 与 NVIDIA Merlin：规模化训练基础设施

TorchRec 提供大规模推荐模型所需的稀疏特征、jagged tensor、embedding bag 和多种 embedding table 分片策略，目标是把巨大稀疏表分布到多个 GPU 上训练和推理。[TorchRec README](https://github.com/meta-pytorch/torchrec/blob/main/README.MD)

NVIDIA Merlin 覆盖推荐数据 ETL、特征工程、模型训练和部署，并包含面向序列/会话推荐的 Transformers4Rec；其价值同样集中在 GPU 数据与模型规模化。[NVIDIA Merlin README](https://github.com/NVIDIA-Merlin/Merlin)

LetterMate 当前数据规模不需要这类基础设施。值得保留的是接口思想：将“特征生成、模型/规则评分、线上编排”隔离，使未来替换排序器时不用改采集和 Feed 契约。

### 2.3 Feast：时间正确的特征供给

Feast 明确区分用于历史训练/批量评分的 offline store、用于低延迟预测的 online store，并提供 point-in-time correct join，防止训练样本读取到事件发生后的未来特征。[Feast architecture](https://docs.feast.dev/)；[Feast point-in-time joins](https://docs.feast.dev/getting-started/concepts/point-in-time-joins)

LetterMate 不必立即部署 Feast，但应复制两个关键约束：

- 每个兴趣信号必须带 `occurredAt`，离线重放只能读取当时已经存在的信号。
- 在线排序读取一个确定版本的兴趣快照；更新失败时仍可退回基础时间排序。

### 2.4 pgvector 与 Qdrant：召回索引，不是用户画像真相

pgvector 将向量与业务数据保存在 PostgreSQL 中，继承事务、JOIN 和 point-in-time recovery，并支持精确及近似近邻查询。[pgvector README](https://github.com/pgvector/pgvector)

Qdrant 支持 dense、sparse 和 multivector 检索，并可对 payload 使用 `must`、`should`、`must_not` 等结构化过滤。[Qdrant README](https://github.com/qdrant/qdrant)；[Qdrant filtering](https://qdrant.tech/documentation/concepts/filtering/)

对 LetterMate，向量只适合补充“相邻技术主题”的候选召回，所有权、时间窗口、质量状态、明确负反馈和来源条件仍必须用结构化字段过滤。当前应优先 pgvector，避免为了少量数据引入第二套数据库；在规模、延迟或多向量需求出现之前不需要 Qdrant。

### 2.5 Letta/Mem0：代理记忆与推荐记忆不是一回事

Letta 的目标是让有状态代理维护可编辑的 memory blocks，并把当前核心记忆置于模型上下文；Mem0 将 memory 面向 user/session/agent 等范围保存和检索。它们解决的是代理跨对话记住事实和偏好，而不是具有曝光日志、负反馈、候选召回、排序与探索约束的推荐闭环。[Letta memory](https://docs.letta.com/guides/agents/memory)；[Mem0 memory types](https://docs.mem0.ai/core-concepts/memory-types)

因此可以借鉴“记忆有来源、范围和生命周期”，但不能用一段 LLM 自动改写的用户简介替代可追溯兴趣信号。否则难以解释一次 `less` 为什么生效，也无法按历史时点重放排名。

## 3. 企业公开方案中的共同结构

### 3.1 YouTube：召回与排序分离

YouTube 的公开论文把系统拆成两级：candidate generation 从极大语料中缩小候选，ranking 再用更丰富的用户和视频特征逐项评分；论文还将样本按时间划分，并显式引入视频年龄来处理新鲜度。[Covington, Adams, Sargin, *Deep Neural Networks for YouTube Recommendations*](https://static.googleusercontent.com/media/research.google.com/en//pubs/archive/45530.pdf)

可复用结论：LetterMate 不应让一个 AI 调用同时决定“搜什么、是否合格、排第几”。采集与质量门控先形成合格池，兴趣系统只做候选选择和顺序调整。

### 3.2 LinkedIn：多阶段、多目标且可运营

LinkedIn 公开的 LiRank 架构将推荐排序作为大规模多任务学习问题，并强调特征交互、多个业务目标和线上部署效率；LinkedIn 的 Venice 则提供近实时派生数据，使新的用户行为能快速进入线上应用。[LiRank paper](https://arxiv.org/abs/2402.06859)；[LinkedIn Venice](https://github.com/linkedin/venice)

可复用结论：不要把 `interested` 和 `less` 压成一个不可解释的单一计数；分别保留正向、负向、新鲜度、明确订阅和质量等分量，再由可版本化的排序公式组合。

### 3.3 Netflix：计算、存储和在线服务解耦

Netflix 公开的个性化架构将离线、近线和在线计算与事件、模型和结果存储分开，并通过在线服务把多个推荐结果组合给用户。[Netflix, *System Architectures for Personalization and Recommendation*](https://netflixtechblog.com/system-architectures-for-personalization-and-recommendation-e081aa94b5d8)

可复用结论：兴趣画像是可重建的派生结果，原始反馈事件才是事实；当画像更新或 AI 标签生成失败时，Feed 仍应基于现有持久化内容工作。

### 3.4 Spotify：探索必须纳入评估

Spotify 公开的 Contextual and Personalized Multi-Armed Bandit 框架把探索/利用视为可在线训练和离线评估的策略，并提供 reward、policy 与环境接口，而不是在排序结果中随机塞入内容。[Spotify MABWiser](https://github.com/spotify/mabwiser)

可复用结论：LetterMate 的探索应来自符合质量门槛的相邻兴趣候选，记录使用了哪个策略和是否收到反馈；早期使用确定性配额和稳定散列即可，不必马上在线训练 bandit。

### 3.5 Pinterest：一个用户需要多个兴趣向量

Pinterest 的 PinnerSage 不是用单一平均向量描述用户，而是对用户历史内容聚类，生成多个兴趣表示，并通过重要性和新鲜度选择代表；这样可保留用户同时存在的不同兴趣。[Pal et al., *PinnerSage*](https://arxiv.org/abs/2007.03634)

可复用结论：LetterMate 不应把 `TypeScript`、`大模型发布`、`摄影` 平均成一个模糊向量。用一组规范化兴趣主题及各自短期/长期权重，更符合产品可解释性，也更便于负反馈局部生效。

### 3.6 Twitter/X：多路候选与过滤在排名之前

Twitter 公开的推荐算法仓库展示了 Home Mixer 从多种候选源获取内容、经过过滤和特征处理后排序，再由产品混合器编排时间线的分层结构。[Twitter Recommendation Algorithm](https://github.com/twitter/the-algorithm)

可复用结论：Topic、Trend、Creator 和探索应作为有标签的候选通道进入同一编排器；通道来源是排名特征和产品约束，但不能绕过统一质量门槛。

## 4. 推荐的 LetterMate 兴趣记忆模型

### 4.1 三层记忆，而不是一段用户简介

| 层 | 内容 | 生命周期 | 是否可直接改写 |
| --- | --- | --- | --- |
| 事实层 | Topic、Creator、`ContentFeedback`、曝光事件 | 长期持久化 | 只能由对应用户操作或真实投递产生 |
| 兴趣层 | 每个规范化兴趣主题的短期/长期正负权重 | 可由事实层重建 | 只由确定性聚合器更新 |
| 服务层 | 某次请求的候选、分数分量、探索位置、排序版本 | 短期日志 | 不作为用户事实 |

AI 的职责应限制为：从已经通过质量门控的内容中生成 1 到 5 个规范化技术兴趣标签，并给出标签置信度；AI 不直接增删 Topic、不替用户关注账号、不直接修改画像权重。

### 4.2 建议的数据结构

保留现有 `ContentFeedback` 作为当前 UI 状态，并增量增加：

```text
InterestTag
  id, slug, displayName, parentId?, status

ContentInterestTag
  contentKey, tagId, confidence, modelVersion, createdAt

UserInterestSignal
  id, userId, tagId, sourceType, sourceRef, direction,
  strength, occurredAt, expiresAt?, supersededAt?

UserInterestProfile
  userId, tagId, shortScore, longScore, negativeScore,
  computedAt, version

FeedImpression
  id, userId, contentKey, position, surface,
  rankingVersion, isExploration, shownAt
```

关键约束：

- `sourceRef` 对 Topic、Creator、ContentFeedback 保持唯一，使重算和撤销幂等。
- `ContentInterestTag` 绑定合并后的 `contentKey`，跨来源的同一内容只有一套语义标签。
- `FeedImpression` 只证明“展示过”，不自动产生负兴趣；需求已明确未反馈不能视为负反馈。
- 画像是物化视图或派生表，不是唯一真相；应提供按用户重建能力。
- 标签词表要小而稳定，允许父子关系；版本号、具体产品名可作实体标签，但不得向父级扩展后反过来改变精确 Topic 的命中边界。

### 4.3 信号权重与时间衰减

建议同时维护两条指数衰减轨道：

```text
shortScore(t) = sum(signalStrength * exp(-age / shortTau))
longScore(t)  = sum(signalStrength * exp(-age / longTau))
```

第一版可把 7 天和 90 天作为短/长期半衰期的实验起点，而不是产品承诺：

- 活动 Topic：强正向结构信号；活动期间不衰减，但只保护精确订阅通道。
- 活动 Creator：来源偏好信号；其合格内容标签提供较弱主题信号。
- `interested`：最强的内容级正向信号，传播到该内容的高置信标签。
- `less`：独立负向信号，降低相似推荐；不得隐藏明确 Topic 或 Creator 订阅内容。
- 取消反馈：终止对应信号并重算，不用反向追加一个抵消事件。
- 未点击、未反馈：不产生兴趣信号。

负反馈应局部化：对“某篇 GPT 教程减少推荐”主要降低其标签组合和相似内容，不应直接判定用户不喜欢整个 AI 领域。重复多个独立 `less` 后才逐步形成更宽的负向主题偏好。

## 5. 候选生成、排序与探索

### 5.1 四路候选

1. **订阅通道：** 精确 Topic 和活动 Creator 命中的全部合格内容；不可被兴趣画像静默移除。
2. **兴趣通道：** 与高权重兴趣标签相符的 Radar/领域 Topic/普通推荐内容。
3. **新鲜热点通道：** 自动 Trend 产生并经过完整发现管线验证的近期重要内容。
4. **探索通道：** 与正向兴趣相邻但用户尚未明确选择、且没有明确负反馈的合格内容。

小规模阶段直接用 PostgreSQL 标签倒排召回即可。只有标签无法覆盖同义表达或内容规模显著增加时，再增加 pgvector 语义召回；向量结果仍需按 `userId` 可见性、时间、质量和负反馈过滤。

### 5.2 第一版可解释排序

建议先实现确定性线性排序，不急于训练深度模型：

```text
score = subscriptionPriority
      + shortInterestMatch
      + longInterestMatch
      - negativeInterestMatch
      + freshness
      + importance
      + multiOriginSignal
```

每个分量归一化并记录 `rankingVersion`。最终顺序继续用发布时间和 ID 作为稳定 tie-breaker。产品只展示自然语言推荐理由，不展示内部数字。

必须保留三条硬边界：

- 质量门控在排序之前，个性化不能救回不合格内容。
- 明确 Feed 搜索以文本相关性为主，兴趣只处理同相关度结果。
- `less` 可以降序，但不能隐藏用户明确创建的 Topic 或 Creator 订阅。

### 5.3 多样性与探索

单纯按相关性排序会连续出现同一产品、同一来源或同一标签。第一版可用 MMR 风格的重排思想：选择下一条时，同时考虑基础分和与已选条目的重复度；重复度由主标签、平台、作者和规范化内容键共同决定。

探索沿用当前需求上限：最多约 10%，候选不足时为零；使用稳定散列决定插入位置，避免刷新页面时跳动。探索项必须标记 `isExploration=true`，永不进入每日邮件。待曝光量足够后，才评估是否用 contextual bandit 替换固定策略。

## 6. 评估设计

### 6.1 离线评估

- 按事件时间做 rolling split，绝不能随机把未来反馈放进训练集。
- 比较基线：时间倒序、仅明确订阅、规则兴趣排序、规则排序加多样性/探索。
- 排名指标：Recall@K、NDCG@K、MRR；显式 `interested` 作为正例，`less` 作为负例，未反馈保持未标注。
- 产品指标：Topic/Creator 明确订阅内容覆盖率、标签和来源覆盖率、重复率、新颖度、探索接受率。
- 守门指标：不合格内容入选数必须为零；跨用户内容必须为零；精确 Topic 的版本边界回归必须保持通过。

RecBole 可用于指标和基线复现，但训练样本应由 LetterMate 的时间正确事件导出，不直接读取当前画像表。

### 6.2 在线评估

早期用户量不足以做可信 A/B 时，先做 shadow scoring：线上仍展示旧顺序，同时记录新排序器会如何排序。积累足够曝光后，再按用户稳定分桶比较：

- `interested / impression` 与 `less / impression`；
- 每次会话或每日邮件的有效反馈率；
- 来源/主题覆盖率和连续重复率；
- 探索内容的正负反馈率；
- 明确订阅内容的展示覆盖率。

邮件与浏览器 Feed 应分开评估：邮件只选高置信、非探索内容，不能用 Feed 的浏览深度直接推断邮件价值。

## 7. 隐私、控制与可解释性

- 数据最小化：不保存原始浏览器历史、Cookie 或其他平台私密行为；只记录 LetterMate 内必要的曝光和显式反馈。
- 用户控制：提供清除单条反馈、清除兴趣历史、暂停个性化和导出兴趣主题的能力；Topic/Creator 生命周期继续独立管理。
- 目的限制：兴趣事件只用于当前用户的发现和邮件排序，不跨用户训练可识别画像。
- 可解释：推荐理由引用具体信号，例如“因为你关注了 React Compiler”和“与你感兴趣的 TypeScript 工具相关”；不能把 AI 推断写成用户事实。
- 可删除：删除用户时级联删除信号、画像、曝光和反馈；内容公共索引可以保留，但不能保留用户关联。
- 权限：所有画像和事件查询必须以 `userId` 为边界；固定 `x-user-id` 仍只能用于开发环境。

## 8. 对 LetterMate 的实施建议

### 阶段 A：可解释规则记忆（当前最值得做）

1. 定义有限标签契约和 AI 标签生成，先回填少量近期合格内容。
2. 新增 `UserInterestSignal`、`UserInterestProfile` 和 `FeedImpression`，从 Topic、Creator 与现有 `ContentFeedback` 幂等生成信号。
3. 在 `packages/domain` 实现纯函数：衰减、兴趣聚合、可解释评分、多样性重排和 10% 探索编排。
4. `TopicStore` 仍负责所有权与持久化，Feed 合并完成后再附加标签和画像评分。
5. 先 shadow scoring，再启用个性化；出现异常时可通过 `rankingVersion` 立即退回时间排序。

这是最可能成为产品亮点的版本：用户能看到系统为何理解自己，短期热点不会永久污染长期偏好，`less` 能局部生效，而且所有结果仍有原帖和质量证明。

### 阶段 B：语义召回与离线实验

当标签召回出现明显遗漏后，在 PostgreSQL 增加 pgvector 内容 embedding；使用兴趣簇而非单一用户向量召回。导出时间正确事件到 RecBole，比较规则基线与序列/双塔模型。没有稳定增益前不引入 TorchRec、Merlin 或独立向量数据库。

### 阶段 C：自适应探索

只有在探索曝光和反馈足够后，才将固定 10% 编排替换为受约束 contextual bandit。策略仍受质量门槛、订阅保护、负反馈过滤、探索上限和邮件禁入约束。

## 9. 不建议的捷径

- 不用 Letta/Mem0 的自由文本记忆直接决定 Feed 排名。
- 不把用户所有行为平均成一个 embedding。
- 不把未点击当作负反馈；没有可靠曝光数据时尤其如此。
- 不让 AI 自由发明兴趣标签或修改权重；标签词表和聚合规则必须版本化。
- 不在数据量很小时先搭 TorchRec、Merlin、Feast 或 Qdrant 集群。
- 不把探索理解为随机内容；探索仍是相邻兴趣中的高质量候选。

## 10. 最终建议

LetterMate 的“记忆系统”应命名为**兴趣图谱/兴趣记忆**，其差异化不是存得多，而是：

- **双时间尺度：** 能跟上近期关注，又不会忘掉长期爱好。
- **多兴趣表示：** 保留多个独立兴趣簇，不压成模糊的单一画像。
- **显式可撤销：** 每个兴趣都能追溯到 Topic、Creator 或反馈，并能取消和重建。
- **质量优先：** 推荐只改变合格内容的相对顺序，不改变事实和来源门槛。
- **受控探索：** 用少量、可评估的新领域内容扩展信息面，且不污染每日邮件。
- **渐进式架构：** 当前用 PostgreSQL 和纯领域函数完成闭环，数据证明需要时再增加向量召回和学习排序。

这比通用“AI 记住你”更符合 LetterMate：它不是聊天记忆，而是一套用户可以信任、理解并纠正的个人信息雷达。
