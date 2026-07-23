# Offline Demo Walkthrough

**Date:** 2026-07-23 (Asia/Shanghai)
**Scope:** Local SQLite workflow acceptance using the deterministic fake curation provider and
dry-run email delivery.

This record is reproducible evidence for the offline daily workflow. It does not demonstrate an
OpenAI model call, SMTP delivery, production deployment, owner dogfood, or an external-user
pilot.

## Command

Run this from the repository root in PowerShell. The explicit environment values keep the run
local, deterministic, and free of external model and SMTP calls.

```powershell
$env:DATABASE_URL = "sqlite:///./data/offline-acceptance-20260723-openai-wiring.db"
$env:APP_ENV = "local"
$env:LLM_PROVIDER = "fake"
$env:EMAIL_DRY_RUN = "true"
.\.venv\Scripts\lettermate.exe run-daily `
  --feed-fixture configs\demo-feed.xml `
  --issue-date 2026-07-23
```

The first run produced:

```text
stage=sync job=1 status=succeeded sources=5
stage=collect job=2 status=succeeded sources=5 items=5
stage=analyze job=3 status=succeeded analyses=1
stage=build job=4 status=succeeded items=1
stage=send job=5 status=succeeded sent=0 dry_run=1
```

The same command was executed a second time against the same database:

```text
stage=sync job=6 status=succeeded sources=5
stage=collect job=7 status=succeeded sources=5 items=5
stage=analyze job=8 status=succeeded analyses=0
stage=build job=9 status=succeeded items=1
stage=send job=10 status=succeeded sent=0 dry_run=1
```

## Persisted State

After the two runs, the database contained:

| Record | Count |
| --- | ---: |
| Sources | 5 |
| Content items | 1 |
| Analysis results | 1 |
| Newsletters | 1 |
| Newsletter items | 1 |
| Job runs | 10 |

The second run's zero analyses and unchanged entity counts show that the workflow reused its
persisted analysis rather than creating a duplicate. The database is an ignored local acceptance
artifact and is not committed.

## Next Evidence

A production acceptance run must set `LLM_PROVIDER=openai`, a real `OPENAI_API_KEY`, production
secrets, and a controlled SMTP target. Its results should be recorded separately without exposing
credentials or raw private content.
