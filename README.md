# LetterMate

[English](./README_EN.md)

LetterMate 是个人信息发现工作台。用户只需输入一个主题关键词，系统会扩展中英文查询，从搜索引擎、RSS、社交平台、视频平台和技术社区召回近期内容，再通过统一的高精度质量管线生成带原始链接的中文摘要。

## 当前能力

- 多源连接器：OpenRouter Web Search、TwitterAPI.io（X）、RSS/Atom、Hacker News、arXiv、GitHub、Brave-compatible Search、YouTube、Reddit、Bluesky 和 Bilibili。
- 统一质量管线：来源证明、时间过滤、正文补全、精确与近似去重、AI 批量评审和来源多样性约束。
- 一手社交信息：原创帖、官方公告和作者线程可直接作为发现条目；转发和无新增信息内容会被过滤。
- 自适应更新：创建主题后立即运行，之后按 6、12 或 24 小时自动更新；手动刷新不改变自动周期。
- 永久保留发现历史：Feed 默认显示最近 90 天，可切换到全部历史。
- 精度优先：通常返回 3-8 条，不合格时允许少于 3 条或空结果。

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

另开终端启动 Worker：

```powershell
npm run dev -w @lettermate/worker
```

Web 地址为 [http://localhost:5173](http://localhost:5173)，API 默认为 `http://localhost:3000`。

## 配置

`AI_API_KEY` 是创建和运行主题的基础要求，用于主题扩展、候选评审和最终摘要。其他密钥均为可选项，缺少时只禁用对应连接器，不影响其余渠道。真实密钥只能写入本地 `.env`，不得提交。

| 配置 | 用途 |
| --- | --- |
| `AI_API_KEY` | OpenRouter 服务端 Key |
| `AI_MODEL` | OpenRouter 模型，默认 `openrouter/auto` |
| `AI_WEB_SEARCH` | 是否启用 OpenRouter Web Search |
| `TWITTERAPI_IO_API_KEY` | [TwitterAPI.io](https://twitterapi.io/) 的 X 搜索、原创帖和线程 |
| `GITHUB_TOKEN` | 提高 GitHub API 配额；不配置仍可使用公共接口 |
| `YOUTUBE_API_KEY` | YouTube Data API |
| `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` | Reddit OAuth API |
| `SEARCH_PROVIDER` | 额外搜索服务；当前支持 `brave` |
| `SEARCH_API_KEY`, `SEARCH_API_BASE_URL` | Brave-compatible Search 凭据和可选兼容端点 |
| `DISCOVERY_RSS_FEED_URLS` | 逗号分隔的 RSS/Atom Feed URL |
| `DISCOVERY_RUN_TIMEOUT_MS` | 单次发现总时限，默认 10 分钟 |
| `DISCOVERY_CONNECTOR_CONCURRENCY` | 连接器并发数，默认 4 |
| `DISCOVERY_SCHEDULER_ENABLED` | 是否启用自动更新扫描 |

无需平台密钥即可使用 Hacker News、arXiv、Bluesky、Bilibili 和 GitHub 公共接口。RSS/Atom 不需要密钥，但需要配置 `DISCOVERY_RSS_FEED_URLS`。自动调度器每 10 分钟扫描到期主题，PostgreSQL 保存真实调度状态；连接器部分失败时仍使用成功渠道继续处理。

## API 流程

- `POST /api/v1/topics`：使用一个关键词创建主题并触发首次发现。
- `GET /api/v1/topics`：返回扩展词、运行状态和下一次自动更新时间。
- `POST /api/v1/topics/:id/refresh`：手动刷新，不改变自动更新周期。
- `GET /api/v1/feed?range=recent|all&kind=hot|quality&topicId=...`：读取最近 90 天或全部历史。
- `GET /api/v1/items/:id`：读取摘要、理由和原始链接。
- `GET /api/v1/discovery-sources`：读取脱敏的连接器启用状态。

## 验证

```powershell
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
```

默认测试不访问外网。实时测试必须同时提供显式开关和对应 Key，且不会打印 Key：

```powershell
$env:RUN_LIVE_AI_TESTS='1'
npm test -- apps/worker/src/openrouter.live.test.ts

$env:RUN_LIVE_TWITTERAPI_IO_TESTS='1'
npm test -- apps/worker/src/twitterapi-io.live.test.ts
```

缺少实时凭据时，这两个测试会跳过。Playwright 使用确定性 Fake 流程覆盖桌面、平板、手机和 320px 紧凑视口。

详细文档：

- [产品需求](./docs/requirements.md)
- [技术方案](./docs/design.md)
- [多源发现详细设计](./docs/superpowers/specs/2026-07-27-lettermate-multi-source-discovery-design.md)
