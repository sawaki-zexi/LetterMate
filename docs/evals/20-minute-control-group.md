# 20-Minute Coding-Agent Control Group

## Status

The coding-agent run was **not executed**. This document is a reproducible protocol plus a
measured offline latest-first baseline. It does not report generated coding-agent output,
elapsed coding-agent time, or production reliability that was not observed.

## Exact prompt

```text
You have 20 minutes. Given evals/datasets/items.sample.jsonl and a static preference profile
of {"interests": ["agent engineering", "LLM evaluation", "career growth"]}, produce a
single JSON recommendation result that ranks at most five existing item IDs. Use only the item
titles and excerpts. Do not call external services, browse, use tools, persist state, schedule
work, or modify source data. Return schema_version, candidate_ids, ranked_items with item_id,
score, and source, followed by a short explanation of the ranking.
```

## Reproducible protocol

1. Start a new coding-agent session with no prior project memory and provide the exact prompt.
2. Start a wall-clock timer immediately before the prompt is submitted; stop it at the first
   complete response or at 20 minutes, whichever happens first.
3. Save the unedited generated output, elapsed time, and any errors in a dated experiment
   directory outside the committed sample dataset.
4. Validate returned IDs against the ten candidate IDs, normalize the output through the
   `BaselineResult` schema, and compute the five metrics with `evaluate_result`.
5. Compare the output with the same candidate IDs and labels used by latest-first. Record the
   exact model, agent version, local environment, and prompt verbatim before interpreting it.

## Current measured offline baseline

Measured on 2026-07-22 in this worktree with:

```powershell
.\.venv\Scripts\python.exe -m lettermate.evals.runner --dataset evals\datasets\items.sample.jsonl --labels evals\datasets\labels.sample.jsonl --baseline latest-first
```

The command completed in approximately 348.3805 ms. Its metric output was:

```json
{
  "precision_at_5": 0.2,
  "useful_rate": 0.4,
  "ndcg_at_5": 0.2382355835589124,
  "duplicate_rate": 0.0,
  "source_diversity": 1.0
}
```

## Missing workflow and conclusion

This protocol intentionally has no persistent state, source-ingestion workflow, scheduling,
authorization, retry behavior, feedback loop, or production observability. The latest-first
measurement is a deterministic offline reference, not evidence of production reliability. The
coding-agent comparison remains not executed; no conclusion about model quality or deployment
readiness can be drawn until the protocol is actually run and its raw output is retained.
