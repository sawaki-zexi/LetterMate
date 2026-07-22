# ADR 0002: Structured Preference Memory

## Decision

Persist feedback and immutable SQL preference snapshots rather than conversation memory or a
vector database.

## Consequences

Each ranking can name the snapshot that influenced it; feedback replay is deterministic and reset
does not delete source feedback. Vector retrieval remains out of scope until evaluation proves
structured tags and source weights insufficient.
