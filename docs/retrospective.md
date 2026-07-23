# LetterMate Retrospective

Status: draft; complete after real deployment and pilot.

## Verified Decisions

- Deterministic workflows own irreversible delivery and ranking membership.
- The Agent is bounded to three read-only tools with redacted traces.
- Preference snapshots are immutable and explainable.
- Scheduler claims use durable keys, leases, and recovery semantics.
- The web and scheduler worker share Postgres state after migrations; local container acceptance
  verified source persistence across independent web and worker restarts.

## Failed Experiments And Corrections

- The host could not pull `python:3.12-slim` from Docker Hub because its HTTPS connection timed
  out. A local acceptance-only image was assembled from verified Python 3.12.12 source on the
  cached Postgres 17 image so the Compose workflow could be tested. The repository Dockerfile and
  production image tag were not changed. See [deployment verification](deployment-verification.md).
- Early CLI composition used `FakeCurationProvider` directly, so setting `LLM_PROVIDER=openai`
  would not activate the bounded Agent. A tested provider factory now validates the configured
  provider and API key, then is used by `analyze`, `run-daily`, and the scheduler.
- An ambiguous SMTP acknowledgement cannot be made exactly-once with a local transaction. The
  send job records a reconciliation requirement instead of reporting the issue as sent.

## Known Limits

- SMTP provider acknowledgement can remain ambiguous after network failure.
- The recorded container acceptance is local only; a production deployment with real secrets,
  OpenAI, and SMTP is still pending.
- Product-value and framework-exit claims require the pending real-world evidence.

## AI-Assisted Code Review

Implementation changes were reviewed with test-first regression coverage where behavior changed,
automated tests, Ruff, mypy, builds, migration checks, security evaluation, container acceptance,
and independent specification/code-quality passes. Record future production incidents and
corrections here without removing prior entries.
