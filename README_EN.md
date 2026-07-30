# LetterMate

[中文](./README.md)

LetterMate is a personal discovery workspace. Users can monitor one complete keyword precisely, while the system also collects search seeds from external technology trend lists. Both paths use multi-source search, content enrichment, fact-support gating, deduplication, and AI review before Chinese summaries with original links appear in one Feed.

> The core discovery pipelines, scheduling, unified Feed, and refresh feedback are implemented. Identity is still development-only: the Web client sends a fixed `x-user-id: user-a`, and the API uses that header for data isolation. Production login, sessions, and CSRF are not implemented. Each real external source still requires credentialed local integration testing.

## Features

- Precise keywords preserve product names, project names, and version segments. `gpt-5.7` is not broadened to generic GPT/AI material and does not match `gpt-5.7.1`.
- Main discovery connectors: OpenRouter Web Search, TwitterAPI.io (X), RSS/Atom, Hacker News, arXiv, GitHub, Brave-compatible Search, YouTube, Reddit, Bluesky, and Bilibili.
- Trend inputs: X/TwitterAPI.io, Hacker News, YouTube, Reddit, Bilibili, and Google Trends RSS. They produce seeds only, never direct Feed items.
- One high-precision pipeline performs technology vertical classification, multi-source search, content enrichment, core fact-support gating, exact and near deduplication, historical novelty checks, source diversity, and Chinese composition.
- Two schedules: a missing TrendMonitor is provisioned with a 4-hour interval by default and then follows its persisted interval; Topics run immediately after creation and then adapt to 6, 12, or 24 hours.
- Unified Feed with `all | topic | trend` origins and `1d | 3d | 7d | 30d | 90d | all` ranges. The default is `30d`, and results are grouped by calendar time.
- Authoritative refresh feedback: click or mobile pull refresh shows nonblocking progress, and completion counts come from persisted run summaries.

A trend-list appearance is not proof. Content can be saved only after substantive pages, first-party platform records, official announcements, code releases, papers, or other material support its core facts. The product exposes no trust score, source ranking, evidence count, internal score, or verified label.

## Quick Start

Requirements: Node.js 24+, npm 11+, PostgreSQL, and Redis.

```powershell
npm install
Copy-Item .env.example .env
docker compose -f infra/compose.yaml up -d
npm run db:generate
npm run db:deploy
npm run dev
```

Start the Worker in another terminal. Queued Topic and trend jobs are not consumed without it:

```powershell
npm run dev -w @lettermate/worker
```

Open [http://localhost:5173](http://localhost:5173). The API defaults to `http://localhost:3000`.

## Configuration

`.env.example` is authoritative. Every key, session/CSRF secret, private feed URL, and authorization header is server-only. Put real values only in the untracked local `.env`; never commit it.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL`, `REDIS_URL` | PostgreSQL and Redis |
| `SESSION_SECRET`, `CSRF_SECRET`, `WEB_ORIGIN` | Server session, CSRF, and Web origin |
| `AI_API_KEY`, `AI_MODEL`, `AI_WEB_SEARCH`, `AI_TIMEOUT_MS` | OpenRouter expansion, classification, assessment, composition, and optional Web Search |
| `TWITTERAPI_IO_API_KEY` | TwitterAPI.io X search, threads, and Trends |
| `GITHUB_TOKEN` | Optional higher GitHub API quota |
| `YOUTUBE_API_KEY` | YouTube search and Most Popular |
| `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` | Reddit OAuth search and community Hot lists |
| `SEARCH_PROVIDER`, `SEARCH_API_KEY`, `SEARCH_API_BASE_URL` | Brave-compatible Search and optional compatible endpoint |
| `DISCOVERY_RSS_FEED_URLS` | Comma-separated main-discovery RSS/Atom URLs |
| `DISCOVERY_RUN_TIMEOUT_MS`, `DISCOVERY_CONNECTOR_CONCURRENCY`, `DISCOVERY_SCHEDULER_ENABLED` | Discovery timeout, connector concurrency, and Topic scheduling |
| `TREND_MONITOR_ENABLED`, `TREND_INTERVAL_HOURS` | Trend scheduling switch; the interval defaults to 4 hours only when provisioning a missing TrendMonitor. An existing monitor's persisted `intervalHours` remains authoritative and environment changes do not mutate it |
| `TREND_X_WOEIDS` | Comma-separated X Trends location IDs |
| `TREND_YOUTUBE_REGION` | Two-letter YouTube region |
| `TREND_REDDIT_COMMUNITIES` | Comma-separated Reddit community names |
| `TREND_GOOGLE_RSS_URLS` | Comma-separated Google Trends HTTPS RSS URLs |

Hacker News, arXiv, Bluesky, and Bilibili need no platform key; public GitHub access works without a token. RSS/Atom and Google Trends RSS need configured URLs but no key. Missing optional credentials disable only their corresponding channels.

## API

- `POST /api/v1/topics`: create a complete-keyword Topic and trigger initial discovery.
- `GET /api/v1/topics`: read Topic scheduling, status, and the latest run summary.
- `POST /api/v1/topics/:id/refresh`: register a manual Topic refresh.
- `GET /api/v1/trends/status`: read the current user's safe trend status and latest run summary.
- `POST /api/v1/trends/refresh`: register a manual trend refresh.
- `GET /api/v1/feed?range=1d|3d|7d|30d|90d|all&origin=all|topic|trend&kind=hot|quality&topicId=...`: read the unified Feed; defaults are `range=30d&origin=all`.
- `GET /api/v1/items/:id`: read a Topic or trend item's summary, reason, and original links.
- `GET /api/v1/discovery-sources`: read redacted connector availability.

`topicId` cannot be combined with `origin=trend`. Feed history is retained permanently; the range controls only the server query window.

## Verification

```powershell
npm run db:generate
npm run db:deploy
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
```

Tests do not access external services by default. Live smoke tests require both the flag and matching key:

```powershell
$env:RUN_LIVE_AI_TESTS='1'
# Also set AI_API_KEY
npm test -- apps/worker/src/openrouter.live.test.ts

$env:RUN_LIVE_TWITTERAPI_IO_TESTS='1'
# Also set TWITTERAPI_IO_API_KEY
npm test -- apps/worker/src/twitterapi-io.live.test.ts
```

Credential-gated tests skip when their live configuration is absent. Playwright uses a deterministic fake flow across 1440px desktop, tablet, mobile, and 320px compact viewports.

Project documentation:

- [Product requirements](./docs/requirements.md)
- [Technical design](./docs/design.md)
