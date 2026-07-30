# LetterMate Agent Guide

## Project

LetterMate is a personal discovery workspace. It combines exact-keyword Topic
tracking with automatic technology-trend discovery. Both paths search multiple
sources, validate supporting content, deduplicate candidates, and produce
Chinese `hot` or `quality` Feed items with original links.

This is an npm workspaces monorepo: React/Vite web client, NestJS API, BullMQ
worker, PostgreSQL/Prisma, and Redis.

## Read First

- [README.md](README.md): local setup and environment requirements.
- [Product requirements](docs/requirements.md): current scope, behavior, and acceptance criteria.
- [Technical design](docs/design.md): architecture, boundaries, data flow, and verification strategy.

## Code Map

| Path | Purpose |
| --- | --- |
| `apps/web` | React/Vite client |
| `apps/api` | NestJS API, request identity, ownership boundaries, validation, and job enqueueing |
| `apps/worker` | Connectors, trend inputs, discovery pipelines, BullMQ consumers, and schedulers |
| `packages/config` | Shared environment configuration |
| `packages/contracts` | Shared API and cross-application contracts |
| `packages/domain` | Domain rules and AI gateway abstractions |
| `prisma/schema.prisma` | Database schema |
| `infra/compose.yaml` | Local PostgreSQL and Redis |
| `tests/e2e` | Playwright end-to-end flows; unit and integration tests are colocated with source files |

## Constraints

- The web client consumes the API only. Keep OpenRouter calls, AI keys, and
  authorization headers on the server side.
- Put shared API shapes in `packages/contracts` and business rules in
  `packages/domain`; keep provider-specific code behind the AI gateway.
- Preserve complete keyword and version boundaries; do not broaden precise
  Topics into generic related concepts.
- Trend lists create search seeds only. They never create Feed items without
  supporting content from the main discovery pipeline.
- Keep user ownership checks and verified HTTP(S) source proof for all final
  Feed items.
- Treat the fixed `x-user-id` identity as development-only; it is not
  production authentication.
- Never commit `.env`, real keys, tokens, or authorization headers.
- When changing `prisma/schema.prisma`, generate Prisma and add a migration.
- Do not reintroduce retired trust states, evidence counts, or source rankings
  without an approved specification.

## Commands

```powershell
# Setup
npm install
Copy-Item .env.example .env
docker compose -f infra/compose.yaml up -d
npm run db:generate
npm run db:deploy

# Development (worker runs separately)
npm run dev
npm run dev -w @lettermate/worker

# Verification
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
```

The web app is `http://localhost:5173`; the API defaults to port `3000`.
Live AI smoke tests require both `RUN_LIVE_AI_TESTS=1` and `AI_API_KEY`.
