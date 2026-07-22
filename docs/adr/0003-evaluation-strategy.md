# ADR 0003: Evaluation Strategy

## Decision

Compare latest-first, one-shot static preference, fixed workflow, and bounded Agent variants on
the same labelled data. Keep offline prompt-injection checks in CI.

## Consequences

Passing unit tests does not prove product value. The final report must include failed slices,
cost/latency, tool trajectory, and a decision on whether the Agent remains justified.
