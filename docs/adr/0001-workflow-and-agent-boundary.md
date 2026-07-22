# ADR 0001: Workflow And Agent Boundary

## Decision

Use deterministic services for source sync, collection, ranking, issue building, and delivery.
Use a bounded read-only Curation Agent only for semantic assessment and optional evidence tools.

## Consequences

The Agent cannot send mail, mutate preferences, access arbitrary URLs, or determine final issue
membership. Tool calls are bounded and traced. If final trajectory evaluation does not justify
adaptive tools, replace the Agent with a structured deterministic workflow.
