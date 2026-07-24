# LetterMate

LetterMate is an AI discovery workspace. Enter one topic keyword; the worker asks OpenRouter to expand Chinese and English search terms, searches the web, classifies findings as `hot` or `quality`, and writes Chinese summaries and reasons with the original cited URLs.

## OpenRouter configuration

OpenRouter is the only AI gateway in this version. Put the key in a local `.env` file and change only `AI_MODEL` when selecting another OpenRouter model:

```env
AI_API_KEY=your-openrouter-key
AI_MODEL=openrouter/auto
AI_WEB_SEARCH=true
AI_TIMEOUT_MS=60000
RUN_LIVE_AI_TESTS=0
```

`openrouter/auto` is the default. `AI_MODEL=openai/gpt-4.1-mini` (or another OpenRouter model ID) changes routing without application code changes. The worker enables OpenRouter Web Search and accepts only URLs returned as `url_citation` annotations.

## Local development

Requirements: Node.js 24+, npm 11+, PostgreSQL and Redis (Docker Desktop is convenient).

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
