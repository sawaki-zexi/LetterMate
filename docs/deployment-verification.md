# Container Deployment Verification

**Date:** 2026-07-23 (Asia/Shanghai)
**Revision:** `80b9b05` (`feature/agentic-mvp`)

This record describes a real local container acceptance run. It is not evidence of the
owner dogfood period, external pilot, production email delivery, or business-quality
metrics required for the portfolio release.

## Verified

An isolated Compose project with a fresh Postgres volume was built and started. The
`migrate` service applied each migration in order:

```text
0001 -> 0002 -> 0003 -> 0004
```

The dedicated scheduler worker passed its database health check. A web container passed
its HTTP health check. The worker then ran `lettermate sync-sources`, which persisted five
configured sources. The protected `GET /api/sources` endpoint returned those same five
records using the owner bearer token.

The web container and scheduler worker were restarted independently. The protected API
continued to return the five records after both restarts, demonstrating that the web and
worker share durable Postgres state rather than process-local state.

The isolated containers, network, and Postgres volume were removed after the run.

## Environment Constraint

Docker Desktop on this host could not establish an HTTPS connection to
`registry-1.docker.io`, so it could not pull the official `python:3.12-slim` image. For
this local acceptance run only, a local image with that tag was built from the verified
Python 3.12.12 source release on the cached official `postgres:17` Debian image. The
application Dockerfile, Compose file, and image tag were not changed.

The host also rejected a bind to `0.0.0.0:8000` despite no process owning that port. The
same Compose `web` service was therefore run on `18080:8000` for the HTTP checks. A normal
deployment still uses the documented `8000:8000` mapping and must be rechecked on the
actual target host.

## Remaining Release Evidence

The following requirements remain intentionally unclaimed: a production deployment with
real secrets and SMTP, a seven-day pre-product baseline, fourteen-day owner dogfood, an
isolated external-user pilot, and the final real-item Eval report.
