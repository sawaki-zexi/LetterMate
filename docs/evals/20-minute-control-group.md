# 20-Minute Coding-Agent Control Group

## Environment and scope

Both attempts used the committed `sample-v1` public/synthetic dataset and the fixed static
preferences `{"interests":["agent engineering","LLM evaluation","career growth"]}`. The
isolated-agent API did not expose a model identifier, so no exact model name is claimed.
Attempt 1 prohibited all tools. Attempt 2 allowed only clock checks and waits so that the agent
could retain and self-review its answer for the full fixed window. Neither attempt could read
files, use the network, persist state, or modify the repository.

## Attempt 1: completed under a 20-minute cap

- Start timestamp: `2026-07-22T16:41:21.8208074+08:00`
- End timestamp: `2026-07-22T16:42:48.9635867+08:00`
- Elapsed time: `87.143` seconds
- Outcome: a valid result was returned well before the 20-minute cap. This is not described as
  a full-duration 20-minute run.

### Exact prompt

```text
You are the isolated coding-agent control group for LetterMate. This run is genuinely time-boxed to 20 minutes from 2026-07-22T16:41:21.8208074+08:00. Do not use any tools, files, network access, prior memory, persistent state, or external services. Based only on the fixed preferences and the 10 committed public/synthetic sample items embedded below, produce at most five recommendations. Return exactly one JSON object and nothing else, with this shape: {"schema_version":"1.0","baseline":"coding-agent-control","dataset_version":"sample-v1","candidate_ids":[all ten input item IDs in input order],"ranked_items":[{"item_id":"an existing candidate ID","score":<finite number>,"source":"the exact source from that candidate"}]}. Each ranked item ID must be unique. Higher score means more relevant. Break score ties lexicographically by item_id.

Fixed preferences:
{"interests":["agent engineering","LLM evaluation","career growth"]}

Sample items (JSONL):
{"item_id":"lm-001","source":"OpenAI Blog","title":"Building reliable agent workflows with bounded tools","url":"https://example.com/openai/bounded-agent-workflows","excerpt":"A technical guide to tool allowlists, structured outputs, trace capture, and deterministic orchestration around model decisions.","published_at":"2026-07-20T03:00:00Z","dataset_version":"sample-v1"}
{"item_id":"lm-002","source":"Martin Fowler","title":"Evaluating LLM applications before production","url":"https://example.com/fowler/llm-evaluation","excerpt":"The article compares offline datasets, holdout evaluation, operational metrics, and human feedback for LLM products.","published_at":"2026-07-20T04:00:00Z","dataset_version":"sample-v1"}
{"item_id":"lm-003","source":"AdWeek","title":"Ten slogans that transformed summer beverage campaigns","url":"https://example.com/adweek/summer-slogans","excerpt":"A roundup of brand taglines and campaign impressions without product engineering or career analysis.","published_at":"2026-07-20T05:00:00Z","dataset_version":"sample-v1"}
{"item_id":"lm-004","source":"Anthropic Research","title":"Measuring tool-use trajectories in language-model agents","url":"https://example.com/anthropic/tool-trajectories","excerpt":"Researchers define tool precision, budget violations, trace completeness, and adversarial cases for bounded agents.","published_at":"2026-07-20T06:00:00Z","dataset_version":"sample-v1"}
{"item_id":"lm-005","source":"GitHub Blog","title":"A practical guide to preparing an engineering portfolio","url":"https://example.com/github/engineering-portfolio","excerpt":"Hiring managers explain how candidates can present tradeoffs, tests, incident learning, and measurable project outcomes.","published_at":"2026-07-20T07:00:00Z","dataset_version":"sample-v1"}
{"item_id":"lm-006","source":"Retail Weekly","title":"Limited-edition sneakers arrive in five new colors","url":"https://example.com/retail/sneaker-colors","excerpt":"A short product announcement listing color variants, store availability, and promotional pricing.","published_at":"2026-07-20T08:00:00Z","dataset_version":"sample-v1"}
{"item_id":"lm-007","source":"Microsoft Research","title":"When deterministic systems should surround an AI agent","url":"https://example.com/microsoft/deterministic-agent-boundaries","excerpt":"A system design study separates model judgment from persistence, scheduling, authorization, and side effects.","published_at":"2026-07-20T09:00:00Z","dataset_version":"sample-v1"}
{"item_id":"lm-008","source":"Cloud News","title":"Managed database vendor updates its enterprise pricing","url":"https://example.com/cloud/database-pricing","excerpt":"The vendor announces revised annual plans, sales contacts, and migration discounts with few implementation details.","published_at":"2026-07-20T10:00:00Z","dataset_version":"sample-v1"}
{"item_id":"lm-009","source":"LeadDev","title":"Designing a useful technical career growth loop","url":"https://example.com/leaddev/career-growth-loop","excerpt":"An engineering manager describes quarterly evidence reviews; the excerpt omits the concrete worksheet and examples.","published_at":"2026-07-20T11:00:00Z","dataset_version":"sample-v1"}
{"item_id":"lm-010","source":"Marketing Today","title":"Why every startup needs a viral mascot this year","url":"https://example.com/marketing/viral-mascot","excerpt":"A promotional opinion piece promises rapid growth but provides no experiments, technical method, or supporting evidence.","published_at":"2026-07-20T12:00:00Z","dataset_version":"sample-v1"}
```

### Raw output

```json
{"schema_version":"1.0","baseline":"coding-agent-control","dataset_version":"sample-v1","candidate_ids":["lm-001","lm-002","lm-003","lm-004","lm-005","lm-006","lm-007","lm-008","lm-009","lm-010"],"ranked_items":[{"item_id":"lm-004","score":0.99,"source":"Anthropic Research"},{"item_id":"lm-001","score":0.96,"source":"OpenAI Blog"},{"item_id":"lm-002","score":0.93,"source":"Martin Fowler"},{"item_id":"lm-007","score":0.9,"source":"Microsoft Research"},{"item_id":"lm-005","score":0.82,"source":"GitHub Blog"}]}
```

### Normalized output

The raw output passed `BaselineResult.model_validate_json` without repair. Pretty-printing the
validated model produced the same candidate IDs, ranking, scores, and sources.

```json
{
  "schema_version": "1.0",
  "baseline": "coding-agent-control",
  "dataset_version": "sample-v1",
  "candidate_ids": ["lm-001", "lm-002", "lm-003", "lm-004", "lm-005", "lm-006", "lm-007", "lm-008", "lm-009", "lm-010"],
  "ranked_items": [
    {"item_id": "lm-004", "score": 0.99, "source": "Anthropic Research"},
    {"item_id": "lm-001", "score": 0.96, "source": "OpenAI Blog"},
    {"item_id": "lm-002", "score": 0.93, "source": "Martin Fowler"},
    {"item_id": "lm-007", "score": 0.9, "source": "Microsoft Research"},
    {"item_id": "lm-005", "score": 0.82, "source": "GitHub Blog"}
  ]
}
```

### Metric output

```json
{
  "precision_at_5": 0.8,
  "useful_rate": 1.0,
  "ndcg_at_5": 1.0,
  "duplicate_rate": 0.0,
  "source_diversity": 1.0
}
```

## Attempt 2: fixed full 20-minute window

- Start timestamp: `2026-07-22T16:45:50.4289030+08:00`
- End timestamp (fixed deadline): `2026-07-22T17:05:50.4289030+08:00`
- Elapsed time in the fixed window: `1200.000` seconds
- Last agent clock check: `2026-07-22T17:05:44.5305128+08:00`
- Output receipt sampled at: `2026-07-22T17:06:18.7425511+08:00`
- Start-to-receipt upper bound: `1228.314` seconds. The collaboration API does not expose an
  exact message-arrival timestamp, so the 28.314 seconds after the deadline are reported as
  delivery/observation uncertainty, not as extra agent work.
- Tool record reported after the run: `Get-Date`, `Start-Sleep`, and wait-session continuations
  only. No files or network were accessed.

### Exact prompt

Attempt 2 used the same fixed preferences and the same ten JSONL records shown in Attempt 1.
Its exact control preamble and output instruction were:

```text
You are the second isolated coding-agent control group for LetterMate. Your fixed experiment window starts at 2026-07-22T16:45:50.4289030+08:00 and ends at 2026-07-22T17:05:50.4289030+08:00. You receive the full 20-minute wall-clock window. Do not send a final answer before the stated end timestamp. If you reach an answer early, use all remaining time to repeatedly self-review and refine it: verify all ten candidate IDs and their order, every selected ID and exact source, finite scores, relevance to all three preferences, unique IDs, descending scores, and lexicographic tie-breaking. You may use tools only to check the current clock and to wait in intervals no longer than 30 seconds. Do not read files, access the network, use prior memory or persistent state, modify anything, or call any other tool. At or after the deadline, return exactly one JSON object and nothing else, with this shape: {"schema_version":"1.0","baseline":"coding-agent-control","dataset_version":"sample-v1","candidate_ids":[all ten input item IDs in input order],"ranked_items":[{"item_id":"an existing candidate ID","score":<finite number>,"source":"the exact source from that candidate"}]}. Include at most five unique ranked items. Higher score means more relevant. Break score ties lexicographically by item_id.

Fixed preferences:
{"interests":["agent engineering","LLM evaluation","career growth"]}

Committed public/synthetic sample items (JSONL):
{"item_id":"lm-001","source":"OpenAI Blog","title":"Building reliable agent workflows with bounded tools","url":"https://example.com/openai/bounded-agent-workflows","excerpt":"A technical guide to tool allowlists, structured outputs, trace capture, and deterministic orchestration around model decisions.","published_at":"2026-07-20T03:00:00Z","dataset_version":"sample-v1"}
{"item_id":"lm-002","source":"Martin Fowler","title":"Evaluating LLM applications before production","url":"https://example.com/fowler/llm-evaluation","excerpt":"The article compares offline datasets, holdout evaluation, operational metrics, and human feedback for LLM products.","published_at":"2026-07-20T04:00:00Z","dataset_version":"sample-v1"}
{"item_id":"lm-003","source":"AdWeek","title":"Ten slogans that transformed summer beverage campaigns","url":"https://example.com/adweek/summer-slogans","excerpt":"A roundup of brand taglines and campaign impressions without product engineering or career analysis.","published_at":"2026-07-20T05:00:00Z","dataset_version":"sample-v1"}
{"item_id":"lm-004","source":"Anthropic Research","title":"Measuring tool-use trajectories in language-model agents","url":"https://example.com/anthropic/tool-trajectories","excerpt":"Researchers define tool precision, budget violations, trace completeness, and adversarial cases for bounded agents.","published_at":"2026-07-20T06:00:00Z","dataset_version":"sample-v1"}
{"item_id":"lm-005","source":"GitHub Blog","title":"A practical guide to preparing an engineering portfolio","url":"https://example.com/github/engineering-portfolio","excerpt":"Hiring managers explain how candidates can present tradeoffs, tests, incident learning, and measurable project outcomes.","published_at":"2026-07-20T07:00:00Z","dataset_version":"sample-v1"}
{"item_id":"lm-006","source":"Retail Weekly","title":"Limited-edition sneakers arrive in five new colors","url":"https://example.com/retail/sneaker-colors","excerpt":"A short product announcement listing color variants, store availability, and promotional pricing.","published_at":"2026-07-20T08:00:00Z","dataset_version":"sample-v1"}
{"item_id":"lm-007","source":"Microsoft Research","title":"When deterministic systems should surround an AI agent","url":"https://example.com/microsoft/deterministic-agent-boundaries","excerpt":"A system design study separates model judgment from persistence, scheduling, authorization, and side effects.","published_at":"2026-07-20T09:00:00Z","dataset_version":"sample-v1"}
{"item_id":"lm-008","source":"Cloud News","title":"Managed database vendor updates its enterprise pricing","url":"https://example.com/cloud/database-pricing","excerpt":"The vendor announces revised annual plans, sales contacts, and migration discounts with few implementation details.","published_at":"2026-07-20T10:00:00Z","dataset_version":"sample-v1"}
{"item_id":"lm-009","source":"LeadDev","title":"Designing a useful technical career growth loop","url":"https://example.com/leaddev/career-growth-loop","excerpt":"An engineering manager describes quarterly evidence reviews; the excerpt omits the concrete worksheet and examples.","published_at":"2026-07-20T11:00:00Z","dataset_version":"sample-v1"}
{"item_id":"lm-010","source":"Marketing Today","title":"Why every startup needs a viral mascot this year","url":"https://example.com/marketing/viral-mascot","excerpt":"A promotional opinion piece promises rapid growth but provides no experiments, technical method, or supporting evidence.","published_at":"2026-07-20T12:00:00Z","dataset_version":"sample-v1"}
```

### Raw output

```json
{"schema_version":"1.0","baseline":"coding-agent-control","dataset_version":"sample-v1","candidate_ids":["lm-001","lm-002","lm-003","lm-004","lm-005","lm-006","lm-007","lm-008","lm-009","lm-010"],"ranked_items":[{"item_id":"lm-004","score":0.99,"source":"Anthropic Research"},{"item_id":"lm-001","score":0.96,"source":"OpenAI Blog"},{"item_id":"lm-002","score":0.94,"source":"Martin Fowler"},{"item_id":"lm-007","score":0.9,"source":"Microsoft Research"},{"item_id":"lm-005","score":0.82,"source":"GitHub Blog"}]}
```

### Normalized output

The raw output passed the strict `BaselineResult` schema without repair. It differs from
Attempt 1 only in the `lm-002` score (`0.94` instead of `0.93`); ranking and IDs are unchanged.

```json
{
  "schema_version": "1.0",
  "baseline": "coding-agent-control",
  "dataset_version": "sample-v1",
  "candidate_ids": ["lm-001", "lm-002", "lm-003", "lm-004", "lm-005", "lm-006", "lm-007", "lm-008", "lm-009", "lm-010"],
  "ranked_items": [
    {"item_id": "lm-004", "score": 0.99, "source": "Anthropic Research"},
    {"item_id": "lm-001", "score": 0.96, "source": "OpenAI Blog"},
    {"item_id": "lm-002", "score": 0.94, "source": "Martin Fowler"},
    {"item_id": "lm-007", "score": 0.9, "source": "Microsoft Research"},
    {"item_id": "lm-005", "score": 0.82, "source": "GitHub Blog"}
  ]
}
```

### Metric output

```json
{
  "precision_at_5": 0.8,
  "useful_rate": 1.0,
  "ndcg_at_5": 1.0,
  "duplicate_rate": 0.0,
  "source_diversity": 1.0
}
```

## Offline latest-first comparison

The deterministic latest-first command on the same ten candidates produced
`precision_at_5=0.2`, `useful_rate=0.4`, `ndcg_at_5=0.2382355835589124`,
`duplicate_rate=0.0`, and `source_diversity=1.0`.

## Missing workflow and conclusions

The coding-agent control selected all four Grade 2 items and one Grade 1 item in both attempts,
so it outscored latest-first on this small labeled sample. The full-window self-review changed
one score but not the order or metrics. This is a measured result, not evidence of production reliability:
the dataset has only ten synthetic/public examples, the static interests closely
match the labeling rubric, and no blind holdout or repeated-model study was performed.

The control still has no persistent state, ingestion workflow, full-text retrieval, scheduling,
authorization, retry policy, feedback loop, idempotent side effects, or production observability.
Those missing workflow capabilities are exactly why the result cannot establish deployment
readiness, unattended reliability, or behavior on private user data.
