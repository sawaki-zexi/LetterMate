# ADR 0004: Dedicated Scheduler And Postgres

## Decision

Run the scheduler in one worker process with durable Postgres claims, fenced leases, and recovery
inside the configured window. Deploy web, worker, migration, and database as separate Compose
services.

## Consequences

Web workers do not start schedulers. Migrations are the production schema authority. SMTP remains
at-least-once at the external provider boundary; sent-state claims reduce but cannot eliminate an
ambiguous provider acknowledgement.
