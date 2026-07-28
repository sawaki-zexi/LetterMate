# LetterMate

[中文](./README.md)

LetterMate is a personal discovery workspace. A user enters one topic keyword; the system expands Chinese and English queries, retrieves recent material from search, feeds, social platforms, video platforms, and technical communities, then applies one high-precision quality pipeline to produce Chinese summaries with original source links.

## Features

- Connectors for OpenRouter Web Search, TwitterAPI.io (X), RSS/Atom, Hacker News, arXiv, GitHub, Brave-compatible Search, YouTube, Reddit, Bluesky, and Bilibili.
- Provenance validation, time filtering, content enrichment, exact and near deduplication, AI review, and source diversity controls.
- Direct support for first-party social posts and author threads; reposts without new information are filtered.
- Immediate first run followed by adaptive 6, 12, or 24-hour refreshes. Manual refresh does not alter the automatic schedule.
- Discovery history is retained; Feed defaults to the latest 90 days and supports all history.
- Precision over volume: 3-8 items is typical, but fewer or empty successful results are valid.

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

Start the worker in another terminal:

```powershell
npm run dev -w @lettermate/worker
```

Open [http://localhost:5173](http://localhost:5173). The API defaults to `http://localhost:3000`.

## Configuration

`AI_API_KEY` is the base requirement for topic expansion, candidate assessment, and final composition. Every other credential is optional; an unavailable connector is skipped without disabling the remaining sources. Store real credentials only in the untracked local `.env` file.

| Variable | Purpose |
| --- | --- |
| `AI_API_KEY`, `AI_MODEL`, `AI_WEB_SEARCH` | OpenRouter AI and optional Web Search |
| `TWITTERAPI_IO_API_KEY` | [TwitterAPI.io](https://twitterapi.io/) X search, original posts, and threads |
| `GITHUB_TOKEN` | Optional higher GitHub API quota |
| `YOUTUBE_API_KEY` | YouTube Data API |
| `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` | Reddit OAuth API |
| `SEARCH_PROVIDER` | Additional search provider; currently `brave` |
| `SEARCH_API_KEY`, `SEARCH_API_BASE_URL` | Brave-compatible Search credential and optional endpoint |
| `DISCOVERY_RSS_FEED_URLS` | Comma-separated RSS/Atom feed URLs |
| `DISCOVERY_RUN_TIMEOUT_MS` | Overall discovery timeout; 10 minutes by default |
| `DISCOVERY_CONNECTOR_CONCURRENCY` | Connector concurrency; 4 by default |
| `DISCOVERY_SCHEDULER_ENABLED` | Enables automatic refresh scanning |

Hacker News, arXiv, Bluesky, Bilibili, and public GitHub access need no platform key. RSS/Atom needs feed URLs but no key. The scheduler scans due topics every 10 minutes, while PostgreSQL remains the scheduling source of truth.

## Verification

```powershell
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
```

Tests do not access external services by default. Live smoke tests require both the explicit flag and corresponding key:

```powershell
$env:RUN_LIVE_AI_TESTS='1'
npm test -- apps/worker/src/openrouter.live.test.ts

$env:RUN_LIVE_TWITTERAPI_IO_TESTS='1'
npm test -- apps/worker/src/twitterapi-io.live.test.ts
```

Project documentation:

- [Product requirements](./docs/requirements.md)
- [Technical design](./docs/design.md)
- [Detailed multi-source design](./docs/superpowers/specs/2026-07-27-lettermate-multi-source-discovery-design.md)
