# LetterMate

LetterMate is an early-stage personal intelligence agent for newsletter curation.

## Current status

LetterMate provides source collection, bounded curation with traceable decisions, preference
snapshots, newsletter generation and delivery, protected operational views, and a separate
scheduler worker. The deployed topology uses Postgres shared by the web and worker processes.
Real owner dogfood and an external pilot remain required before the portfolio release can claim
the business metrics in the requirements.

The container topology has been exercised against a fresh Postgres volume; see the
[container deployment verification record](docs/deployment-verification.md) for the exact
scope, evidence, and host-specific limitations.

The repeatable local workflow record is available in the
[offline demo walkthrough](docs/demo-walkthrough.md). It verifies the full daily path with the
deterministic fake provider and dry-run email; it is not a substitute for a real model or SMTP
acceptance run.

The authoritative product requirements are the
[LetterMate Agentic Product Requirements V2](docs/lettermate-agentic-product-requirements-v2.md),
and active implementation work follows the
[LetterMate Agentic MVP V3 implementation plan](docs/superpowers/plans/2026-07-21-lettermate-agentic-mvp-v3-implementation-plan.md).
The earlier V2 vertical-slice plan is retained only as historical planning context.

## Development setup

LetterMate requires Python 3.12. From PowerShell:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"
.\.venv\Scripts\python.exe -m pytest -q
```

## Curation provider

`LLM_PROVIDER=fake` is the default and is suitable for local tests and the offline demo. For a
live bounded curation agent, configure the following in the deployment environment:

```text
LLM_PROVIDER=openai
LLM_MODEL=gpt-5-mini
OPENAI_API_KEY=<real-secret>
```

The application rejects unknown provider names and rejects `LLM_PROVIDER=openai` without an API
key. `analyze`, `run-daily`, and the scheduler all construct the same configured provider. The
Agent is still bounded by `CURATION_MAX_TURNS`, `CURATION_TIMEOUT_SECONDS`, and
`CURATION_MINIMUM_CONFIDENCE` (each has a safe default in application settings).

## Docker deployment

Create `.env` from `.env.example` and replace every placeholder with a distinct secret of at
least 32 characters. `APP_ENV=production` is intentional: the application rejects development
defaults in this mode.

```powershell
Copy-Item .env.example .env
docker compose config
docker compose up --build -d
docker compose ps
curl.exe --fail http://127.0.0.1:8000/health
```

The `migrate` service runs `alembic upgrade head` before the web and worker start. `web` serves
the protected dashboard at port 8000; `worker` runs `lettermate scheduler`; Postgres data is kept
in the `postgres_data` volume. To apply a later migration explicitly, run:

```powershell
docker compose run --rm migrate alembic upgrade head
```

Before calling a deployment production-ready, repeat the container check with a real OpenAI API
key and SMTP configuration, then collect the real-use evidence listed in the current-status
section.
