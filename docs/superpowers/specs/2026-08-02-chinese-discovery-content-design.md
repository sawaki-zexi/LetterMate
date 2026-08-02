# Feed 中文内容生成与校验设计

**状态：** 已确认，待实施
**日期：** 2026-08-02

## 1. 背景与目标

部分信息源的英文标题、摘要会被 AI 原样带入 Feed，导致标题、内容概要和推荐理由的语言不一致。本次改动只处理最终面向用户的三段文本：`title`、`summary` 和 `reason`。

目标：

- 新生成的 Feed 标题、内容概要和推荐理由使用简体中文；
- 在生成提示词中提前约束语言，减少首次输出不合格的概率；
- 用 Worker 本地校验兜底，避免英文文本写入新 Feed；
- 只修正语言，不改变事实、来源 URL 或来源元数据；
- 不迁移或批量重写历史 Feed 数据。

允许保留产品名、模型名、版本号、代码、协议名和其他必要专有名词，例如 `GPT-5.7`、`React 19`。这类保留不应使整段标题、概要或理由成为英文。

## 2. 方案

采用“提示词前置约束 + 本地中文校验 + 异常条目修正”的两层方案：

1. `composeItems` 的系统提示词明确要求标题、概要和推荐理由使用简体中文，并逐字段说明翻译范围和事实边界。
2. 首次结构化结果返回后，本地检查三段文本是否包含中文表达，且不是整段英文。
3. 只把不合格条目发送给一次中文修正请求。修正请求只允许改变 `title`、`summary`、`reason`。
4. 修正后再次校验。不合格或修正请求失败的条目丢弃，其他合格条目继续进入质量流水线。
5. `QualityPipeline` 在最终返回前再执行一次中文门槛，防止测试替身或其他 AI 网关绕过网关层校验。

正常批次只产生一次生成请求；只有检测到语言问题的条目才增加一次修正请求。

## 3. 数据流与边界

```text
accepted candidates
  -> Chinese-constrained composition prompt
  -> structured JSON parse
  -> per-item Chinese language check
  -> repair invalid text fields once
  -> language check again
  -> QualityPipeline final guard
  -> persist Feed item
```

校验范围仅包括：

- `title`
- `summary`
- `reason`

以下字段必须保持输入值，不翻译、不改写：

- `sourceUrls`
- `publishedAt`
- `sourceType`
- `platform`
- `authorName`
- `authorHandle`
- `externalId`
- `provenanceKind`

修正条目通过来源 URL 与原始候选关联，不能接受模型新生成的 URL、作者、日期或来源字段。

## 4. 组件改动

### 4.1 OpenRouter AI Gateway

- 增强 `composeItems` 的系统提示词，要求三段文本使用简体中文，并明确专有名词例外和来源字段保护规则。
- 增加中文修正请求，输入仅包含不合格条目及其原始候选上下文。
- 复用现有结构化 JSON schema 和响应解析逻辑。
- 修正结果仍需通过 schema、来源字段白名单和中文语言校验。

### 4.2 Worker 质量流水线

- 增加可复用的中文文本检查函数，避免依赖前端展示层判断语言。
- 将不合格条目从最终结果中移除，不让英文文本落库。
- 保持现有候选过滤、事实支持、去重和来源证明规则不变。

### 4.3 Web、Contracts、Prisma

- Web 展示逻辑不变，继续读取服务端生成的三段文本。
- 不新增 API 字段，不修改共享 schema 的数据结构。
- 不修改 Prisma schema，不产生迁移。

## 5. 异常处理

- 首次生成 JSON 无效：沿用现有结构化响应重试逻辑。
- 首次 JSON 有效但文本不符合中文门槛：仅修正异常条目。
- 修正请求超时、认证失败或返回无效：丢弃对应条目并继续处理其他条目。
- 全部条目被丢弃：任务可正常完成，新增数为 0；不得写入英文半成品。
- 来源字段发生变化或出现未授权 URL：沿用现有 `QualityPipelineError` 安全失败规则。

## 6. 测试与验收

新增或调整 Worker 测试：

1. 首次生成返回英文标题、概要或理由时，触发一次中文修正请求。
2. 修正后文本合格时，三段中文写入结果，来源字段与输入完全一致。
3. 修正结果仍不合格时，仅丢弃该条，其他合格条目保留。
4. 修正请求失败时，不产生英文 Feed 条目。
5. `QualityPipeline` 能阻止绕过 AI Gateway 的英文结果。
6. 专有名词和版本号可以保留，不被误判为整段英文。

验证命令：

```powershell
npm run lint
npm run typecheck
npm test
npm run build
```

## 7. 非目标

- 不翻译原始文章页面或外部链接内容。
- 不修改作者、平台、URL、外部 ID 等来源元数据。
- 不批量翻译历史数据库记录。
- 不调整搜索源、质量评估、事实支持、去重或调度策略。
