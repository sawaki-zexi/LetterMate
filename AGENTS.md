# LetterMate Agent Guide

Use this file as the short project briefing when entering a new context. Keep
it current, concise, and aligned with the repository rather than duplicating
the full product or architecture documents.

## Project

LetterMate is a personal discovery workspace. It combines exact-keyword Topic
tracking, technology-trend discovery, and monitored Creator sources into one
Chinese Feed. Discovery searches multiple providers, validates HTTP(S) source
proof, deduplicates candidates, applies quality and personalization rules, and
generates `hot` or `quality` items with original links.

The repository is an npm-workspaces monorepo:

- React/Vite web client
- NestJS API
- BullMQ worker
- PostgreSQL with Prisma
- Redis

## Read First

These are the canonical project documents:

- [README.md](README.md): setup, configuration, API overview, and operations entry points.
- [docs/requirements.md](docs/requirements.md): product scope, behavior, and acceptance criteria.
- [docs/design.md](docs/design.md): architecture, boundaries, data flow, and verification strategy.

Reference documents:

- [docs/operations-runbook.md](docs/operations-runbook.md): production checks, monitoring, backup, restore, and incident procedures.
- [docs/next-development-roadmap.md](docs/next-development-roadmap.md): current implementation status and next priorities.
- [docs/personalization-memory-design.md](docs/personalization-memory-design.md): interest memory and ranking details.
- [docs/agent-quality-evaluation.md](docs/agent-quality-evaluation.md): offline quality fixtures and gates.

When requirements and implementation differ, update the canonical documents
with the change and keep this index accurate. Do not create another competing
requirements or design document.

## Code Map

| Path | Responsibility |
| --- | --- |
| `apps/web` | React/Vite UI, Feed, Topic management, filters, refresh, and responsive layouts |
| `apps/api` | NestJS HTTP API, sessions, CSRF, ownership checks, validation, persistence, queues, health, and metrics |
| `apps/worker` | Connectors, trend inputs, Creator monitoring, discovery pipelines, BullMQ consumers, schedulers, evaluation, and metrics |
| `packages/contracts` | Shared Zod schemas, DTOs, and API/worker contracts |
| `packages/domain` | Source proof, URL safety, quality, deduplication, ranking, and AI gateway abstractions |
| `packages/config` | Shared environment parsing and defaults |
| `prisma/schema.prisma` | Database schema |
| `prisma/migrations` | Committed Prisma migrations |
| `infra/compose.yaml` | Local PostgreSQL and Redis |
| `infra/compose.production.example.yaml` | Production Compose baseline and optional monitoring/operations profiles |
| `tests/e2e` | Playwright desktop, tablet, mobile, and compact-mobile flows |

## Non-negotiable Constraints

- The web client talks to the API only. Keep AI keys, provider credentials,
  authorization headers, and source fetching on the server/worker.
- Put shared request/response shapes in `packages/contracts`; put reusable
  business rules in `packages/domain`; hide provider details behind adapters or
  the AI gateway.
- Preserve exact Topic keyword and version boundaries. Do not broaden a precise
  Topic into generic related concepts.
- Trend and Creator inputs produce search seeds or candidates only. They cannot
  create Feed items without the main discovery pipeline's source proof and
  quality checks.
- Enforce user ownership at every API read/write boundary. The fixed
  `x-user-id` identity is development-only and must not be treated as production
  authentication.
- Final Feed items require a verified HTTP(S) source URL and supporting content.
  `hot` and `quality` are recommendation categories, not evidence or trust
  states.
- Never commit `.env`, real keys, tokens, cookies, or authorization headers.
- If `prisma/schema.prisma` changes, run Prisma Client generation and create a
  migration. Apply committed migrations with `npm run db:deploy`.
- Do not reintroduce retired trust states, evidence counts, source rankings, or
  other removed concepts without updating `docs/requirements.md` and
  `docs/design.md` first.

## Common Commands

```powershell
# Setup
npm install
Copy-Item .env.example .env
docker compose -f infra/compose.yaml up -d
npm run db:generate
npm run db:deploy

# Development
npm run dev                              # Web + API
npm run dev -w @lettermate/worker       # Worker and schedulers

# Verification
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run evaluate:quality
npm run ops:doctor

# Database safety
npm run db:migrate                       # Local schema change
npm run db:backup
npm run db:backup:verify -- <backup-path>
npm run db:restore:verify -- <backup-path>
```

The local web app is `http://localhost:5173`. The API listens on port `3000`;
its liveness and readiness endpoints are `/api/v1/health` and
`/api/v1/health/ready`. API metrics are exposed at `/metrics`; the worker
metrics port defaults to `9464`.

Default tests are offline. Live provider tests require the matching explicit
`RUN_LIVE_*_TESTS=1` flag and credentials from `.env`; do not enable them in
normal CI or commit those credentials.

## Change Workflow

1. Read the canonical requirements and design sections relevant to the change.
2. Preserve ownership, source-proof, exact-keyword, and provider-boundary rules.
3. Update tests and the affected canonical/reference documentation with the
   implementation.
4. Run the smallest relevant checks, then the full verification set for shared
   contracts, schema, queues, or user-facing flows.
5. Inspect `git diff` and `git status`; stage only intentional files. Keep
   `main` and the remote branch synchronized when the user asks to submit work.

Use GPL-3.0-or-later for new source files unless the repository's license
policy is explicitly changed.
