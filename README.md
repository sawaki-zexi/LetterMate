# LetterMate
LetterMate is an AI discovery workspace. Enter one topic keyword; the worker asks OpenRouter to expand Chinese and English search terms, searches the web, classifies findings as `hot` or `quality`, and writes Chinese summaries and reasons with the original cited URLs.LetterMate 是一个基于人工智能的发现工作空间。输入一个主题关键词后，系统会请求 OpenRouter 扩展中文和英文的搜索词，进行网络检索，将结果分类为“热门”或“优质”，并生成中文摘要及原因，同时附上原始引用的网址。LetterMate 是一个基于人工智能的发现工作空间。输入一个主题关键词后，系统会请求 OpenRouter 扩展中文和英文的搜索词，进行网络检索，将结果分类为“热门”或“优质”，并生成中文摘要及原因，同时附上原始引用的网址。


## OpenRouter configuration## OpenRouter 配置## OpenRouter 配置## OpenRouter 配置## OpenRouter 配置reload-alertreload-alertreload-alertreload-alertreload-alertreload-alertreload-alertreload-alert

OpenRouter is the only AI gateway in this version. Put the key in a local `.env` file and change only `AI_MODEL` when selecting another OpenRouter model:OpenRouter 是此版本中唯一的 AI 门禁。将密钥放入本地 `.env` 文件中，仅在选择其他 OpenRouter 模型时更改 `AI_MODEL`：OpenRouter 是此版本中唯一的 AI 门禁。将密钥放入本地 `.env` 文件中，仅在选择其他 OpenRouter 模型时更改 `AI_MODEL`：OpenRouter 是此版本中唯一的 AI 门禁。将密钥放入本地 `.env` 文件中，仅在选择其他 OpenRouter 模型时更改 `AI_MODEL`：OpenRouter 是此版本中唯一的 AI 门禁。将密钥放入本地 `.env` 文件中，仅在选择其他 OpenRouter 模型时更改 `AI_MODEL`：

```env
AI_API_KEY=your-openrouter-keyAI_API_KEY=你的OpenRouter密钥AI_API_KEY=你的OpenRouter密钥AI_API_KEY=你的OpenRouter密钥AI_API_KEY=你的OpenRouter密钥AI_API_KEY=ton-clé-OpenRouterAI_API_KEY=ton-clé-OpenRouterAI_API_KEY=ton-clé-OpenRouterAI_API_KEY=ton-clé-OpenRouterAI_API_KEY=ton-clé-OpenRouterAI_API_KEY=ton-clé-OpenRouterAI_API_KEY=ton-clé-OpenRouterAI_API_KEY=ton-clé-OpenRouterAI_API_KEY=ton-clé-OpenRouterAI_API_KEY=ton-cl -OpenRouterAI_API_KEY=ton-clé -OpenRouterAI_API_KEY=ton-clé -OpenRouterAI_API_KEY=ton-clé-OpenRouterAI_API_KEY=ton-clé-OpenRouterAI_API_KEY=ton-clé-OpenRouterAI_API_KEY=ton-clé-OpenRouterAI_API_KEY=ton-clé-OpenRouterAI_API_KEY=ton-cl -OpenRouterAI_API_KEY=ton-clé -OpenRouterAI_API_KEY=ton-clé -OpenRouterAI_API_KEY=ton-clé -OpenRouterAI_API_KEY=ton-clé -OpenRouterAI_API_KEY=ton-cl -OpenRouterAI_API_KEY=ton-clé -OpenRouterAI_API_KEY=ton-clé -OpenRouterreload-alertreload-alertreload-alertreload-alertreload-alertreload-alertreload-alertreload-alertreload-alert
AI_MODEL=openrouter/auto
AI_WEB_SEARCH=true
AI_TIMEOUT_MS=60000
RUN_LIVE_AI_TESTS=0
```

`openrouter/auto` is the default. `AI_MODEL=openai/gpt-4.1-mini` (or another OpenRouter model ID) changes routing without application code changes. The worker enables OpenRouter Web Search and accepts only URLs returned as `url_citation` annotations.`openrouter/auto` 是默认设置。将 `AI_MODEL=openai/gpt-4.1-mini`（或其他 OpenRouter 模型 ID）即可在不修改应用代码的情况下更改路由。该工作节点启用 OpenRouter 网络搜索功能，并仅接受以 `url_citation` 注解形式返回的 URL。`openrouter/auto` 是默认设置。将 `AI_MODEL=openai/gpt-4.1-mini`（或其他 OpenRouter 模型 ID）即可在不修改应用代码的情况下更改路由。该工作节点启用 OpenRouter 网络搜索功能，并仅接受以 `url_citation` 注解形式返回的 URL。`openrouter/auto` 是默认设置。将 `AI_MODEL=openai/gpt-4.1-mini`（或其他 OpenRouter 模型 ID）即可在不修改应用代码的情况下更改路由。该工作节点启用 OpenRouter 网络搜索功能，并仅接受以 `url_citation` 注解形式返回的 URL。`openrouter/auto` 是默认设置。将 `AI_MODEL=openai/gpt-4.1-mini`（或其他 OpenRouter 模型 ID）即可在不修改应用代码的情况下更改路由。该工作节点启用 OpenRouter 网络搜索功能，并仅接受以 `url_citation` 注解形式返回的 URL。`openrouter/auto` 是默认设置。将 `AI_MODEL=openai/gpt-4.1-mini`（或其他 OpenRouter 模型 ID）即可在不修改应用代码的情况下更改路由。该工作节点启用 OpenRouter 网络搜索功能，并仅接受以 `url_citation` 注解形式返回的 URL。`openrouter/auto` 是默认设置。将 `AI_MODEL=openai/gpt-4.1-mini`（或其他 OpenRouter 模型 ID）即可在不修改应用代码的情况下更改路由。该工作节点启用 OpenRouter 网络搜索功能，并仅接受以 `url_citation` 注解形式返回的 URL。

## Local development   ## 本地开发   ## 本地开发

Requirements: Node.js 24+, npm 11+, PostgreSQL and Redis (Docker Desktop is convenient).要求：Node.js 24+，npm 11+，PostgreSQL 和 Redis（使用 Docker Desktop 更方便）。

```powershell
npm install
Copy-Item .env.example .env
docker compose -f infra/compose.yaml up -d
npm run db:generate
npm run db:deploy
npm run dev
```

Open `http://localhost:5173`. The API listens on `http://localhost:3000`; the Vite development server proxies `/api` to it. The worker must also be started when running real discovery jobs:

```powershell
npm run dev -w @lettermate/worker
```

Without `AI_API_KEY`, read-only API startup remains available, while creating or refreshing a topic returns `AI_NOT_CONFIGURED` and existing discoveries remain visible.

## Verification

```powershell
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
```

Playwright runs the deterministic fake discovery workflow at desktop, tablet and mobile viewports. Install Chromium once with `npx playwright install chromium` if needed.

The live OpenRouter test is opt-in and never prints the key:

```powershell
$env:RUN_LIVE_AI_TESTS='1'
npm run test -- apps/worker/src/openrouter.live.test.ts
```

## API workflow

- `POST /api/v1/topics` accepts exactly `{ "keyword": "..." }` and queues one discovery job.
- `GET /api/v1/topics` returns AI-expanded terms and run state.
- `GET /api/v1/feed?kind=hot|quality&topicId=...` returns citation-backed discoveries.
- `POST /api/v1/topics/:id/refresh` queues a new search without deleting prior items.
- `GET /api/v1/items/:id` returns the summary, reason and every original source URL.

OpenRouter errors are normalized into safe API errors. Rate limits and upstream failures are retried by the worker; invalid structured output is corrected once; missing citations never become persisted discovery items.
