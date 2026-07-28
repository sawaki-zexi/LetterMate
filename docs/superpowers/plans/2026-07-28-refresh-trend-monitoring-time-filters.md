# Refresh, Trend Monitoring, and Time Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add reliable refresh progress and completion counts, exact keyword monitoring, external trend-list discovery with fact-support filtering, and server-backed time filtering with grouped Feed presentation.

**Architecture:** Keep topic discovery and trend discovery as separate persisted pipelines that share source connectors and the quality pipeline. Extend shared contracts first, add Prisma-owned trend state and run summaries, then implement precise query policy, trend adapters/orchestration, API composition, and finally the React refresh coordinator and time-grouped UI.

**Tech Stack:** TypeScript, React 19, TanStack Query, NestJS, BullMQ, Prisma/PostgreSQL, Zod, Vitest, Testing Library, Playwright.

---

### Task 1: Extend shared contracts and configuration

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/index.test.ts`
- Modify: `packages/config/src/index.ts`
- Modify: `packages/config/src/index.test.ts`
- Modify: `.env.example`

- [ ] **Step 1: Write failing contract tests**

Add tests that require the explicit Feed ranges, origins, run summaries, trend job data, trend status, and discriminated Feed items:

```ts
expect(feedRangeSchema.options).toEqual(['1d', '3d', '7d', '30d', '90d', 'all']);
expect(feedOriginSchema.options).toEqual(['all', 'topic', 'trend']);
expect(runSummarySchema.parse({
  id: 'run-1', trigger: 'manual', status: 'succeeded',
  startedAt: '2026-07-28T00:00:00.000Z', finishedAt: '2026-07-28T00:01:00.000Z',
  newItemCount: 3,
})).toMatchObject({ newItemCount: 3 });
expect(trendJobDataSchema.parse({ userId: 'user-a', trigger: 'manual' })).toEqual({
  userId: 'user-a', trigger: 'manual',
});
expect(feedItemSchema.parse({ ...topicItem, origin: 'topic', topicId: 'topic-1' }).origin).toBe('topic');
expect(feedItemSchema.parse({ ...trendItem, origin: 'trend', topicId: null }).origin).toBe('trend');
```

- [ ] **Step 2: Run contract tests and verify RED**

Run: `npm test -- packages/contracts/src/index.test.ts`

Expected: FAIL because the new schemas and discriminated item contract do not exist.

- [ ] **Step 3: Implement the contract schemas**

Define:

```ts
export const feedRangeSchema = z.enum(['1d', '3d', '7d', '30d', '90d', 'all']);
export const feedOriginSchema = z.enum(['all', 'topic', 'trend']);
export const runSummarySchema = z.object({
  id: z.string().min(1),
  trigger: discoveryTriggerSchema,
  status: runStatusSchema,
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  newItemCount: z.number().int().nonnegative().nullable(),
});
export const trendJobDataSchema = z.object({
  userId: z.string().min(1),
  trigger: discoveryTriggerSchema,
});
export const topicFeedItemSchema = discoveryItemSchema.extend({
  origin: z.literal('topic'),
  topicId: z.string().min(1),
});
export const trendFeedItemSchema = discoveryItemSchema.omit({ topicId: true }).extend({
  origin: z.literal('trend'),
  topicId: z.null(),
});
export const feedItemSchema = z.discriminatedUnion('origin', [
  topicFeedItemSchema,
  trendFeedItemSchema,
]);
```

Add `lastRun: runSummarySchema.nullable()` to `topicSchema`, add safe `trendStatusSchema`, and export inferred types plus `trendQueueName = 'trend-discovery'`.

- [ ] **Step 4: Write failing configuration tests**

Require defaults and parsing for:

```ts
expect(parseConfig({})).toMatchObject({
  TREND_MONITOR_ENABLED: true,
  TREND_INTERVAL_HOURS: 4,
  TREND_X_WOEIDS: [1],
  TREND_YOUTUBE_REGION: 'US',
  TREND_REDDIT_COMMUNITIES: ['MachineLearning', 'LocalLLaMA', 'programming', 'technology'],
  TREND_GOOGLE_RSS_URLS: [],
});
```

Also assert that `TREND_INTERVAL_HOURS=1`, invalid WOEIDs, invalid region codes, and Reddit values containing `/` are rejected.

- [ ] **Step 5: Run configuration tests and verify RED**

Run: `npm test -- packages/config/src/index.test.ts`

Expected: FAIL because trend configuration is absent.

- [ ] **Step 6: Implement trend configuration**

Add server-only parsers for comma-separated positive WOEIDs, community names, and HTTPS RSS URLs. Add these defaults to `.env.example` without real keys:

```env
TREND_MONITOR_ENABLED=true
TREND_INTERVAL_HOURS=4
TREND_X_WOEIDS=1
TREND_YOUTUBE_REGION=US
TREND_REDDIT_COMMUNITIES=MachineLearning,LocalLLaMA,programming,technology
TREND_GOOGLE_RSS_URLS=
```

- [ ] **Step 7: Run focused tests and commit**

Run: `npm test -- packages/contracts/src/index.test.ts packages/config/src/index.test.ts`

Expected: PASS.

Commit:

```powershell
git add packages/contracts/src/index.ts packages/contracts/src/index.test.ts packages/config/src/index.ts packages/config/src/index.test.ts .env.example
git commit -m "feat: add trend and feed filter contracts"
```

### Task 2: Add durable trend persistence and migration

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260728_trend_monitoring/migration.sql`
- Modify: `apps/worker/src/prisma-schema.test.ts`

- [ ] **Step 1: Write failing Prisma schema tests**

Require `TrendMonitor`, `TrendRun`, `TrendSeed`, and `RadarItem`, plus user relations and indexes:

```ts
expect(Prisma.dmmf.datamodel.models.map((model) => model.name)).toEqual(
  expect.arrayContaining(['TrendMonitor', 'TrendRun', 'TrendSeed', 'RadarItem']),
);
expect(fieldNames('TrendMonitor')).toEqual(expect.arrayContaining([
  'userId', 'runStatus', 'nextRunAt', 'intervalHours', 'activeRunId',
  'runLeaseUntil', 'manualRefreshPending',
]));
expect(fieldNames('RadarItem')).toEqual(expect.arrayContaining([
  'userId', 'canonicalPrimaryUrl', 'publishedAt', 'discoveredAt',
  'sourceType', 'platform', 'provenanceKind',
]));
```

- [ ] **Step 2: Run schema test and verify RED**

Run: `npm test -- apps/worker/src/prisma-schema.test.ts`

Expected: FAIL because trend models are missing.

- [ ] **Step 3: Add Prisma models**

Add user-owned models with cascade relations. `TrendMonitor.userId` is unique, `TrendRun` records trigger/status/counts, `TrendSeed` stores only normalized seed metadata, and `RadarItem` mirrors public discovery fields with `@@unique([userId, canonicalPrimaryUrl])`. Do not add trust scores, evidence counts, source ranks, or full upstream payloads.

- [ ] **Step 4: Add SQL migration**

Create enums/foreign keys/tables/indexes matching the Prisma schema. Backfill one `TrendMonitor` for each existing user with `intervalHours=4`, `runStatus='queued'`, and `nextRunAt=NOW()` so existing installations begin monitoring after deployment.

- [ ] **Step 5: Generate Prisma and verify schema**

Run:

```powershell
npm run db:generate
npm test -- apps/worker/src/prisma-schema.test.ts
```

Expected: Prisma generation succeeds and the schema tests pass.

- [ ] **Step 6: Commit**

```powershell
git add prisma/schema.prisma prisma/migrations/20260728_trend_monitoring/migration.sql apps/worker/src/prisma-schema.test.ts
git commit -m "feat: persist trend monitoring runs and items"
```

### Task 3: Implement precise keyword policy and fact-support assessment

**Files:**
- Create: `apps/worker/src/keyword-policy.ts`
- Create: `apps/worker/src/keyword-policy.test.ts`
- Modify: `apps/worker/src/connectors/types.ts`
- Modify: `apps/worker/src/source-router.ts`
- Modify: `apps/worker/src/source-router.test.ts`
- Modify: `apps/worker/src/ai-gateway.ts`
- Modify: `apps/worker/src/openrouter-gateway.ts`
- Modify: `apps/worker/src/openrouter-gateway.test.ts`
- Modify: `apps/worker/src/quality-pipeline.ts`
- Modify: `apps/worker/src/quality-pipeline.test.ts`

- [ ] **Step 1: Write failing keyword-policy tests**

Test the wished-for API:

```ts
const policy = buildKeywordPolicy('gpt-5.7');
expect(policy.exactPhrase).toBe('gpt-5.7');
expect(policy.aliases).toEqual(expect.arrayContaining(['gpt-5.7', 'gpt 5.7', 'gpt5.7']));
expect(filterQueriesForPolicy([
  'gpt-5.7 release notes',
  'latest GPT model',
], policy)).toEqual(['gpt-5.7 release notes']);
expect(candidateMatchesKeyword(makeCandidate({
  title: 'GPT-5.7 release notes', content: 'Official migration details.',
}), policy)).toBe(true);
expect(candidateMatchesKeyword(makeCandidate({
  title: 'Latest GPT model', content: 'A general model roundup.',
}), policy)).toBe(false);
```

- [ ] **Step 2: Run keyword tests and verify RED**

Run: `npm test -- apps/worker/src/keyword-policy.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement deterministic keyword policy**

Implement `buildKeywordPolicy`, `filterQueriesForPolicy`, and `candidateMatchesKeyword`. Normalize Unicode width/case/whitespace, preserve numeric version segments, and only create punctuation/spacing aliases. Do not invent semantic aliases in deterministic code.

- [ ] **Step 4: Route only precise queries**

Add `matchPolicy` to `SourceQueryPlan`. `SourceRouter.route` builds the policy, filters AI search queries, appends deterministic intent queries such as `"gpt-5.7" release`, and always returns at least one query containing the exact phrase.

Run: `npm test -- apps/worker/src/source-router.test.ts apps/worker/src/keyword-policy.test.ts`

Expected: PASS after first observing the new router test fail on the old behavior.

- [ ] **Step 5: Write failing fact-support tests**

Extend `QualityAssessment` with:

```ts
claimSupport: 'supported' | 'unsupported' | 'conflicting';
```

Add tests that reject an otherwise `accepted: true` candidate when support is not `supported`, and reject a Topic candidate that does not match its policy before AI evaluation.

- [ ] **Step 6: Run quality tests and verify RED**

Run: `npm test -- apps/worker/src/quality-pipeline.test.ts apps/worker/src/openrouter-gateway.test.ts`

Expected: FAIL because claim support and policy filtering are absent.

- [ ] **Step 7: Implement fact-support gating**

Update OpenRouter structured output and prompt so every decision includes `claimSupport`. The prompt must judge only supplied title/body/platform data and mark rumor, satire, unsupported release claims, and title/body conflicts as unsupported or conflicting. `QualityPipeline` accepts only `accepted && claimSupport === 'supported'` and applies `candidateMatchesKeyword` when a policy is present.

- [ ] **Step 8: Run focused tests and commit**

Run: `npm test -- apps/worker/src/keyword-policy.test.ts apps/worker/src/source-router.test.ts apps/worker/src/quality-pipeline.test.ts apps/worker/src/openrouter-gateway.test.ts`

Expected: PASS.

Commit:

```powershell
git add apps/worker/src/keyword-policy.ts apps/worker/src/keyword-policy.test.ts apps/worker/src/connectors/types.ts apps/worker/src/source-router.ts apps/worker/src/source-router.test.ts apps/worker/src/ai-gateway.ts apps/worker/src/openrouter-gateway.ts apps/worker/src/openrouter-gateway.test.ts apps/worker/src/quality-pipeline.ts apps/worker/src/quality-pipeline.test.ts
git commit -m "feat: enforce precise topic monitoring"
```

### Task 4: Add external trend-source adapters

**Files:**
- Create: `apps/worker/src/trends/types.ts`
- Create: `apps/worker/src/trends/registry.ts`
- Create: `apps/worker/src/trends/registry.test.ts`
- Create: `apps/worker/src/trends/twitterapi-io.ts`
- Create: `apps/worker/src/trends/twitterapi-io.test.ts`
- Create: `apps/worker/src/trends/hacker-news.ts`
- Create: `apps/worker/src/trends/hacker-news.test.ts`
- Create: `apps/worker/src/trends/youtube.ts`
- Create: `apps/worker/src/trends/youtube.test.ts`
- Create: `apps/worker/src/trends/reddit.ts`
- Create: `apps/worker/src/trends/reddit.test.ts`
- Create: `apps/worker/src/trends/bilibili.ts`
- Create: `apps/worker/src/trends/bilibili.test.ts`
- Create: `apps/worker/src/trends/google-rss.ts`
- Create: `apps/worker/src/trends/google-rss.test.ts`
- Modify: `apps/worker/src/runtime.ts`
- Modify: `apps/worker/src/runtime.test.ts`

- [ ] **Step 1: Define trend interfaces through failing registry tests**

Use:

```ts
interface TrendSeedCandidate {
  sourceId: string;
  platform: string;
  externalId: string;
  title: string;
  url: string;
  publishedAt: string | null;
}

interface TrendSource {
  readonly id: string;
  readonly label: string;
  isEnabled(): boolean;
  collect(window: TrendWindow, signal: AbortSignal): Promise<TrendSourceResult>;
}
```

Registry tests require per-source timeout, bounded concurrency, safe failures, candidate validation, URL canonicalization, and round-robin aggregation. There is no rank or score field.

- [ ] **Step 2: Run registry test and verify RED**

Run: `npm test -- apps/worker/src/trends/registry.test.ts`

Expected: FAIL because trend types and registry do not exist.

- [ ] **Step 3: Implement trend registry**

Follow the existing connector registry failure-isolation pattern but keep trend-specific types separate. Return successful source IDs, skipped source IDs, safe failures, candidates, and request counts.

- [ ] **Step 4: Add adapter tests one source at a time**

Each test supplies a deterministic fake response and requires only normalized fields:

```ts
expect(result.candidates[0]).toEqual({
  sourceId: 'twitter-trends',
  platform: 'X Trends',
  externalId: 'gpt-5.7',
  title: 'gpt-5.7',
  url: expect.stringMatching(/^https:\/\/x\.com\/search/),
  publishedAt: null,
});
```

Use these upstream endpoints:

- TwitterAPI.io: `GET https://api.twitterapi.io/twitter/trends?woeid=<id>&count=30` with `x-api-key`.
- Hacker News: `https://hacker-news.firebaseio.com/v0/topstories.json` plus bounded item lookups.
- YouTube: `videos.list?chart=mostPopular&part=snippet,statistics&regionCode=<region>`.
- Reddit: OAuth token plus `/r/<community>/hot`.
- Bilibili: `/x/web-interface/popular?pn=1&ps=<limit>`.
- Google Trends: configured HTTPS RSS parsed with `fast-xml-parser`.

For each adapter, run its test before implementation to observe RED, then implement strict Zod/XML parsing, safe errors, request budgets, HTTP(S) URL validation, and no upstream payload persistence.

- [ ] **Step 5: Register enabled trend adapters**

Add `createTrendSources(config, fetcher)` in `runtime.ts`. Public HN/Bilibili adapters are enabled without keys; Twitter/YouTube/Reddit/Google require their existing or new configuration.

- [ ] **Step 6: Run trend adapter suite and commit**

Run: `npm test -- apps/worker/src/trends apps/worker/src/runtime.test.ts`

Expected: PASS.

Commit:

```powershell
git add apps/worker/src/trends apps/worker/src/runtime.ts apps/worker/src/runtime.test.ts
git commit -m "feat: collect external technology trends"
```

### Task 5: Implement trend classification, persistence, scheduling, and worker

**Files:**
- Modify: `apps/worker/src/ai-gateway.ts`
- Modify: `apps/worker/src/openrouter-gateway.ts`
- Modify: `apps/worker/src/openrouter-gateway.test.ts`
- Create: `apps/worker/src/trend-service.ts`
- Create: `apps/worker/src/trend-service.test.ts`
- Create: `apps/worker/src/trend-scheduler.ts`
- Create: `apps/worker/src/trend-scheduler.test.ts`
- Create: `apps/worker/src/trend-worker.ts`
- Create: `apps/worker/src/trend-worker.test.ts`
- Modify: `apps/worker/src/main.ts`

- [ ] **Step 1: Write failing trend classification tests**

Add `classifyTrendSeeds` to `AiGateway` with structured results:

```ts
interface TrendSeedDecision {
  id: string;
  accepted: boolean;
  query: string | null;
  requiredTerms: string[];
}
```

Tests require one decision per seed, reject non-technology topics, and preserve version identifiers such as `gpt-5.7` in `query` and `requiredTerms`.

- [ ] **Step 2: Run gateway tests and verify RED**

Run: `npm test -- apps/worker/src/openrouter-gateway.test.ts`

Expected: FAIL because trend classification is missing.

- [ ] **Step 3: Implement structured trend classification**

Add a strict JSON schema and a prompt limited to AI, technology, software products, engineering, and research. Require null query and empty required terms for rejected seeds. Validate that accepted output retains identifiers detected in the seed title.

- [ ] **Step 4: Write failing repository and orchestration tests**

Tests cover:

- claiming one monitor run with a lease;
- persisting sanitized TrendSeeds without rank or payload fields;
- skipping recent duplicate fingerprints;
- routing accepted seed queries through `ConnectorRegistry` and `QualityPipeline`;
- saving RadarItems with user ownership and canonical URL uniqueness;
- reporting `newItemCount` from actual inserts;
- succeeding with zero items when at least one trend source succeeds;
- failing atomically when all trend sources or AI stages fail;
- queuing one pending manual refresh during an active run.

- [ ] **Step 5: Run trend service tests and verify RED**

Run: `npm test -- apps/worker/src/trend-service.test.ts`

Expected: FAIL because the service and repository do not exist.

- [ ] **Step 6: Implement trend repository and service**

Create `PrismaTrendRepository` and `TrendDiscoveryService`. The service collects trend candidates, persists sanitized seed fingerprints, classifies accepted seeds in batches, creates precise `SourceQueryPlan` values, searches connectors, runs the quality pipeline, and atomically upserts RadarItems plus TrendRun completion data.

- [ ] **Step 7: Write and implement scheduler/worker tests**

Scheduler tests require due-monitor claiming, deterministic scheduled job IDs, 4-hour next runs, failure retry at the configured interval, and a 10-minute scan. Worker tests mirror topic retry/backoff behavior using `TrendJobData` and `trendQueueName`.

Run each new test before implementation, then implement `TrendScheduleService`, `startTrendScheduler`, `createTrendWorker`, and handler functions.

- [ ] **Step 8: Wire the Worker runtime**

In `main.ts`, instantiate one trend BullMQ queue, trend registry, service, worker, and optional scheduler. Shutdown closes both workers and queues. `TREND_MONITOR_ENABLED=false` disables scheduling but not manual API processing or existing data reads.

- [ ] **Step 9: Run focused tests and commit**

Run: `npm test -- apps/worker/src/openrouter-gateway.test.ts apps/worker/src/trend-service.test.ts apps/worker/src/trend-scheduler.test.ts apps/worker/src/trend-worker.test.ts`

Expected: PASS.

Commit:

```powershell
git add apps/worker/src/ai-gateway.ts apps/worker/src/openrouter-gateway.ts apps/worker/src/openrouter-gateway.test.ts apps/worker/src/trend-service.ts apps/worker/src/trend-service.test.ts apps/worker/src/trend-scheduler.ts apps/worker/src/trend-scheduler.test.ts apps/worker/src/trend-worker.ts apps/worker/src/trend-worker.test.ts apps/worker/src/main.ts
git commit -m "feat: orchestrate scheduled trend discovery"
```

### Task 6: Expose run summaries, unified Feed, and trend refresh API

**Files:**
- Modify: `apps/api/src/topic-store.ts`
- Modify: `apps/api/src/topic-store.test.ts`
- Create: `apps/api/src/trend-queue.ts`
- Create: `apps/api/src/trend-queue.test.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/app.test.ts`
- Modify: `apps/api/src/e2e-main.ts`

- [ ] **Step 1: Write failing store tests**

Require:

- Prisma Topic mapping includes the latest `DiscoveryRun` as `lastRun`;
- memory topics expose `lastRun` and update it during fake discovery;
- Feed ranges use a supplied `since` date;
- origin filters return topic-only, trend-only, or merged data;
- merged items are sorted by `publishedAt ?? discoveredAt`;
- Radar detail lookup enforces `userId`.

- [ ] **Step 2: Run store tests and verify RED**

Run: `npm test -- apps/api/src/topic-store.test.ts`

Expected: FAIL on the new DTO and Radar store behavior.

- [ ] **Step 3: Implement store mappings**

Extend `TopicStore` into a discovery store that can query Topic and Radar items. Use Prisma relation queries for latest runs and map unfinished run counts to null. Keep full source bodies and internal trend decisions out of API mappings.

- [ ] **Step 4: Write failing API tests**

Add tests for:

```text
GET  /feed                      -> defaults to range=30d, origin=all
GET  /feed?range=3d            -> uses a 72-hour since time
GET  /feed?origin=trend        -> returns only Radar items
GET  /trends/status            -> returns current user's safe status
POST /trends/refresh           -> queues one manual trend run and returns 202
GET  /items/:id                -> reads Topic or Radar item, never another user's item
```

Also assert invalid range/origin combinations return `VALIDATION_ERROR`.

- [ ] **Step 5: Run API tests and verify RED**

Run: `npm test -- apps/api/src/app.test.ts apps/api/src/trend-queue.test.ts`

Expected: FAIL because the endpoints and queue are absent.

- [ ] **Step 6: Implement trend queue and API**

Add `BullTrendQueue` using `trendQueueName`, job IDs analogous to Topic jobs, and dependency injection into `createApiApp`. Add a `range -> milliseconds` map for `1d`, `3d`, `7d`, `30d`, `90d`; `all` omits `since`. Add trend status/refresh endpoints and safe source status entries for enabled trend adapters.

- [ ] **Step 7: Update deterministic E2E API**

The fake trend queue completes one trend run and inserts one `RadarItem` with a distinct URL. It must expose run summaries so Playwright can observe refresh completion and count aggregation.

- [ ] **Step 8: Run focused tests and commit**

Run: `npm test -- apps/api/src/topic-store.test.ts apps/api/src/topic-queue.test.ts apps/api/src/trend-queue.test.ts apps/api/src/app.test.ts`

Expected: PASS.

Commit:

```powershell
git add apps/api/src/topic-store.ts apps/api/src/topic-store.test.ts apps/api/src/trend-queue.ts apps/api/src/trend-queue.test.ts apps/api/src/app.ts apps/api/src/app.test.ts apps/api/src/e2e-main.ts
git commit -m "feat: expose trend discovery and run summaries"
```

### Task 7: Build reusable Web time and refresh utilities

**Files:**
- Create: `apps/web/src/feed-time.ts`
- Create: `apps/web/src/feed-time.test.ts`
- Create: `apps/web/src/use-pull-refresh.ts`
- Create: `apps/web/src/use-pull-refresh.test.tsx`
- Create: `apps/web/src/use-refresh-coordinator.ts`
- Create: `apps/web/src/use-refresh-coordinator.test.tsx`
- Modify: `apps/web/src/api.ts`

- [ ] **Step 1: Write failing time-group tests**

Use an injected `now` and require mutually exclusive groups:

```ts
expect(groupFeedItems(items, new Date('2026-07-28T12:00:00+08:00'))
  .map((group) => [group.label, group.items.map((item) => item.id)]))
  .toEqual([
    ['今天', ['today']],
    ['昨天', ['yesterday']],
    ['近 3 天', ['three-days']],
    ['近 7 天', ['seven-days']],
    ['本月更早', ['month']],
    ['更早', ['older']],
  ]);
```

- [ ] **Step 2: Run time tests and verify RED**

Run: `npm test -- apps/web/src/feed-time.test.ts`

Expected: FAIL because the helper is absent.

- [ ] **Step 3: Implement time grouping**

Use `date-fns` calendar boundaries, `publishedAt ?? discoveredAt`, stable ordering, and omit empty groups.

- [ ] **Step 4: Write failing pull-refresh tests**

Render a small harness and simulate touch start/move/end. Require refresh only when `scrollY === 0`, vertical delta exceeds 72 px, target is not a form control, and no refresh is already active. Require progress to reset after completion.

- [ ] **Step 5: Run pull-refresh tests and verify RED**

Run: `npm test -- apps/web/src/use-pull-refresh.test.tsx`

Expected: FAIL because the hook is absent.

- [ ] **Step 6: Implement pull-refresh hook**

Return `{ containerProps, pullDistance, armed }`. Use passive-safe touch handlers on the page container, ignore horizontal gestures, cap visual distance, and never call `preventDefault` outside an active top-of-page pull.

- [ ] **Step 7: Write failing refresh-coordinator tests**

The coordinator receives topics, trend status, API actions, and query invalidation. Tests require:

- selected Topic refresh only;
- all/topic/trend origin scopes target the correct jobs;
- per-topic pending IDs;
- completion only from a later manual `lastRun`;
- exact sum of `newItemCount`;
- messages for success, zero, partial failure, and total failure.

- [ ] **Step 8: Run coordinator tests and verify RED**

Run: `npm test -- apps/web/src/use-refresh-coordinator.test.tsx`

Expected: FAIL because the coordinator is absent.

- [ ] **Step 9: Implement API and coordinator**

Update `api.feed` for range/origin, parse `feedItemSchema`, and add `trendStatus`/`refreshTrends`. Implement coordinator state with a request timestamp, targeted run tracking, 1.5-second query polling via existing Topic and trend queries, Feed invalidation on terminal completion, and an `aria-live` notification payload.

- [ ] **Step 10: Run utility tests and commit**

Run: `npm test -- apps/web/src/feed-time.test.ts apps/web/src/use-pull-refresh.test.tsx apps/web/src/use-refresh-coordinator.test.tsx`

Expected: PASS.

Commit:

```powershell
git add apps/web/src/feed-time.ts apps/web/src/feed-time.test.ts apps/web/src/use-pull-refresh.ts apps/web/src/use-pull-refresh.test.tsx apps/web/src/use-refresh-coordinator.ts apps/web/src/use-refresh-coordinator.test.tsx apps/web/src/api.ts
git commit -m "feat: add feed refresh and time utilities"
```

### Task 8: Integrate refreshed Feed and Topic UI

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/components/DiscoveryCard.tsx`
- Modify: `apps/web/src/components/DiscoveryCard.test.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1: Write failing Feed interaction tests**

Add tests that require:

- a top time `<select>` with six options and default `30d` request;
- origin control for all/topic/trend;
- time group headings around cards;
- refresh icon gets `spin` while jobs are active;
- status text reports target count;
- final `aria-live` message contains the authoritative new count;
- trend cards show `趋势发现`, Topic cards show `关键词追踪`;
- reduced-motion class does not rely on layout-changing animation.

- [ ] **Step 2: Run App tests and verify RED**

Run: `npm test -- apps/web/src/App.test.tsx apps/web/src/components/DiscoveryCard.test.tsx`

Expected: FAIL on the missing controls and lifecycle.

- [ ] **Step 3: Implement Feed UI**

Replace the 90-day segmented history control with a compact labeled time `<select>`. Add origin filtering without nesting cards. Render each non-empty time group as an unframed section with a small heading and the existing card list. Connect click and pull refresh to the coordinator and render a fixed-dimension pull indicator/status row.

- [ ] **Step 4: Implement Topic-row refresh state**

Use the coordinator's pending Topic IDs so only the clicked row is disabled/spinning. Preserve current schedule text, expanded terms, errors, and source status UI.

- [ ] **Step 5: Add polished responsive styles**

Add stable dimensions for controls/icons, `@keyframes refresh-spin`, `@media (prefers-reduced-motion: reduce)`, time-group spacing, touch pull indicator transitions, and toast/status placement. Verify no card nesting, no text overlap, and 320px controls wrap instead of overflowing.

- [ ] **Step 6: Run Web tests and commit**

Run: `npm test -- apps/web/src/App.test.tsx apps/web/src/components/DiscoveryCard.test.tsx apps/web/src/feed-time.test.ts apps/web/src/use-pull-refresh.test.tsx apps/web/src/use-refresh-coordinator.test.tsx`

Expected: PASS.

Commit:

```powershell
git add apps/web/src/App.tsx apps/web/src/App.test.tsx apps/web/src/components/DiscoveryCard.tsx apps/web/src/components/DiscoveryCard.test.tsx apps/web/src/styles.css
git commit -m "feat: show refresh progress and grouped feed"
```

### Task 9: Update documentation and end-to-end coverage

**Files:**
- Modify: `docs/requirements.md`
- Modify: `docs/design.md`
- Modify: `README.md`
- Modify: `README_EN.md`
- Modify: `tests/e2e/ai-discovery.spec.ts`

- [ ] **Step 1: Write failing Playwright expectations**

Extend the deterministic scenario to:

```ts
await page.getByLabel('时间范围').selectOption('3d');
await expect(page.getByText('趋势发现').first()).toBeVisible();
await page.getByRole('button', { name: '刷新发现' }).click();
await expect(page.getByRole('button', { name: '刷新发现' })).toHaveAttribute('aria-busy', 'true');
await expect(page.getByText(/刷新完成，新增 \d+ 条内容/)).toBeVisible();
await expect(page.getByText(/今天|昨天|近 3 天/).first()).toBeVisible();
```

Keep the no-trust-language and horizontal-overflow assertions.

- [ ] **Step 2: Run E2E and verify RED**

Run: `npm run test:e2e`

Expected: FAIL because the deterministic API/UI lifecycle is not fully wired yet.

- [ ] **Step 3: Update product and operator documentation**

Document precise keyword monitoring, external trend sources, trend configuration, 4-hour schedule, fact-support filtering, refresh completion counts, and six Feed ranges. State that trend-list presence is not proof and that no trust score/ranking is exposed.

- [ ] **Step 4: Make deterministic E2E pass**

Adjust only fake timing/data needed for deterministic completion; do not weaken production polling or assertions.

- [ ] **Step 5: Run full verification**

Run in order:

```powershell
npm run db:generate
npm run db:deploy
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
```

Expected: all commands exit 0; unit/integration tests report no failures; credential-gated live tests may skip; Playwright passes all four viewports.

- [ ] **Step 6: Commit**

```powershell
git add docs/requirements.md docs/design.md README.md README_EN.md tests/e2e/ai-discovery.spec.ts
git commit -m "docs: document precise and trend discovery"
```

### Task 10: Final audit and branch completion

**Files:**
- Review: all changed files
- Review: `docs/superpowers/specs/2026-07-28-refresh-trend-monitoring-time-filters-design.md`

- [ ] **Step 1: Audit every requirement against evidence**

Confirm:

- click and pull refresh visibly load and report authoritative new counts;
- keyword topics preserve exact identifiers and reject unrelated candidates;
- automatic hotspots originate from external trend lists and require supporting content;
- no trust state, source ranking, evidence count, or key leaks into public contracts;
- Feed ranges include 3 days and 30 days and every Feed view uses them;
- content is grouped by effective time;
- all new persisted rows enforce user ownership;
- migrations, API, Worker, Web, and E2E evidence cover the design.

- [ ] **Step 2: Inspect Git state**

Run:

```powershell
git status --short --branch
git log --oneline --decorate -12
git diff main...HEAD --check
```

Expected: clean worktree and no whitespace errors.

- [ ] **Step 3: Invoke branch finishing workflow**

Use `superpowers:finishing-a-development-branch`, re-run its required verification, and integrate only after the user-selected completion path.
