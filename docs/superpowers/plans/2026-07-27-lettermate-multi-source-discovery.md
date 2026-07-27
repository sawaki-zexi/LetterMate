# LetterMate Multi-Source Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single OpenRouter Web Search discovery path with a high-precision multi-source pipeline, verified provenance, adaptive scheduled refreshes, durable history, and source-aware UI.

**Architecture:** Worker-local connectors normalize external sources into provider-neutral candidates. Domain services validate provenance, fetch safe content, filter and deduplicate candidates, then use the AI gateway only for expansion, assessment, and final composition. PostgreSQL remains the source of truth for results and schedules; BullMQ executes initial, manual, and scheduled runs.

**Tech Stack:** TypeScript, NestJS, React, Vite, BullMQ, PostgreSQL, Prisma, Redis, Zod, Vitest, Testing Library, Playwright, Cheerio, fast-xml-parser.

---

## File Map

New focused files:

- `packages/domain/src/source.ts`: provider-neutral source types, proof validation, candidate normalization.
- `packages/domain/src/quality.ts`: deterministic rejection, exact/semantic deduplication, diversity selection.
- `apps/worker/src/connectors/types.ts`: connector runtime interface and query/result contracts.
- `apps/worker/src/connectors/registry.ts`: enablement, routing, bounded concurrency, partial failure handling.
- `apps/worker/src/connectors/openrouter-search.ts`: existing OpenRouter Web Search as one source connector.
- `apps/worker/src/connectors/twitterapi-io.ts`: TwitterAPI.io advanced search and thread expansion.
- `apps/worker/src/connectors/rss.ts`: RSS/Atom feed parsing.
- `apps/worker/src/connectors/hacker-news.ts`: Hacker News Algolia search.
- `apps/worker/src/connectors/arxiv.ts`: arXiv Atom search.
- `apps/worker/src/connectors/github.ts`: GitHub search and release normalization.
- `apps/worker/src/connectors/search-provider.ts`: configurable mainstream search API adapter.
- `apps/worker/src/connectors/youtube.ts`: YouTube Data API search and metadata.
- `apps/worker/src/connectors/reddit.ts`: Reddit OAuth search.
- `apps/worker/src/connectors/bluesky.ts`: Bluesky public AppView search.
- `apps/worker/src/connectors/bilibili.ts`: Bilibili public search normalization with strict timeout and disablement.
- `apps/worker/src/content-fetcher.ts`: SSRF-safe HTTP fetch and HTML-to-text extraction.
- `apps/worker/src/quality-pipeline.ts`: enrichment, batching, AI assessment, history comparison, final selection.
- `apps/worker/src/scheduler.ts`: due-topic claiming and repeatable scheduler job.
- `prisma/migrations/20260727_multi_source_discovery/migration.sql`: multi-source fields, run records, and schedule indexes.

Existing files modified:

- `packages/contracts/src/index.ts`: public topic/item/source shapes and feed range.
- `packages/config/src/index.ts`: optional connector and scheduler configuration.
- `packages/domain/src/index.ts`: export new domain modules.
- `packages/domain/src/url.ts`: platform-aware canonicalization.
- `apps/worker/src/ai-gateway.ts`: expansion, candidate assessment, final composition interfaces.
- `apps/worker/src/openrouter-gateway.ts`: remove monolithic discovery and implement AI-only structured calls.
- `apps/worker/src/discovery-service.ts`: multi-source orchestration and run persistence.
- `apps/worker/src/worker.ts`: trigger-aware jobs and retry behavior.
- `apps/worker/src/main.ts`: compose connectors, pipeline, scheduler, and workers.
- `apps/api/src/topic-store.ts`: new fields and 90-day/default-history filtering.
- `apps/api/src/app.ts`: source status endpoint and feed range query.
- `apps/web/src/api.ts`: parse new API shapes and range parameter.
- `apps/web/src/App.tsx`: source metadata, history filter, schedule state, multi-source labels.
- `apps/web/src/components/DiscoveryCard.tsx`: platform/type/author display.
- `prisma/schema.prisma`: schedule, run, provenance, and source metadata.
- `.env.example`, `README.md`, `README_EN.md`, `docs/design.md`, `docs/requirements.md`: configuration and product documentation.

## Task 1: Public Contracts and Configuration

**Files:**
- Modify: `packages/contracts/src/index.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/config/src/index.test.ts`
- Modify: `packages/config/src/index.ts`

- [ ] **Step 1: Write failing contract tests**

Add tests that parse source-aware items, scheduled topics, trigger-aware jobs, feed ranges, and connector status:

```ts
expect(topicSchema.parse({
  ...topicFixture,
  nextRunAt: '2026-07-28T00:00:00.000Z',
  scheduleIntervalHours: 12,
})).toMatchObject({ scheduleIntervalHours: 12 });

expect(discoveryItemSchema.parse({
  ...itemFixture,
  sourceType: 'social',
  platform: 'X',
  authorName: 'Project Team',
  authorHandle: 'project',
})).toMatchObject({ sourceType: 'social', platform: 'X' });

expect(discoveryJobDataSchema.parse({
  topicId: 'topic-1',
  userId: 'user-1',
  trigger: 'scheduled',
})).toMatchObject({ trigger: 'scheduled' });

expect(feedRangeSchema.parse('all')).toBe('all');
expect(discoverySourceStatusSchema.parse({
  id: 'twitterapi-io',
  label: 'X',
  category: 'social',
  status: 'not_configured',
})).toMatchObject({ status: 'not_configured' });
```

- [ ] **Step 2: Verify contracts fail for missing schemas and fields**

Run: `npm test -- packages/contracts/src/index.test.ts`

Expected: FAIL because `feedRangeSchema`, `discoverySourceStatusSchema`, schedule fields, and job trigger do not exist.

- [ ] **Step 3: Implement the public schemas**

Add these constrained schemas and types:

```ts
export const sourceTypeSchema = z.enum([
  'web', 'feed', 'social', 'video', 'community', 'code', 'paper',
]);
export const discoveryTriggerSchema = z.enum(['initial', 'manual', 'scheduled']);
export const feedRangeSchema = z.enum(['recent', 'all']);
export const discoverySourceStatusSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  category: sourceTypeSchema,
  status: z.enum(['enabled', 'not_configured']),
});
```

Extend `topicSchema`, `discoveryCandidateSchema`, `discoveryItemSchema`, and `discoveryJobDataSchema` with the exact fields described in the design. Keep `authorName` and `authorHandle` nullable and restrict `scheduleIntervalHours` to `6 | 12 | 24`.

- [ ] **Step 4: Write failing config tests**

```ts
expect(parseConfig({})).toMatchObject({
  DISCOVERY_RUN_TIMEOUT_MS: 600_000,
  DISCOVERY_CONNECTOR_CONCURRENCY: 4,
  DISCOVERY_SCHEDULER_ENABLED: true,
});

expect(parseConfig({ TWITTERAPI_IO_API_KEY: 'x-key' }).TWITTERAPI_IO_API_KEY)
  .toBe('x-key');
expect(parseConfig({ DISCOVERY_SCHEDULER_ENABLED: 'false' }).DISCOVERY_SCHEDULER_ENABLED)
  .toBe(false);
```

- [ ] **Step 5: Run config tests and verify RED**

Run: `npm test -- packages/config/src/index.test.ts`

Expected: FAIL because connector and scheduler settings are absent.

- [ ] **Step 6: Add optional connector and scheduler configuration**

Add optional non-empty keys for TwitterAPI.io, GitHub, YouTube, Reddit, and generic search. Add bounded numeric settings for total timeout and concurrency plus a boolean scheduler flag. Do not require optional keys in production validation.

- [ ] **Step 7: Verify and commit**

Run: `npm test -- packages/contracts/src/index.test.ts packages/config/src/index.test.ts`

Expected: both files PASS.

Commit: `feat: add multi-source contracts and configuration`

## Task 2: Source Proof, URL Normalization, and Domain Rules

**Files:**
- Create: `packages/domain/src/source.test.ts`
- Create: `packages/domain/src/source.ts`
- Create: `packages/domain/src/quality.test.ts`
- Create: `packages/domain/src/quality.ts`
- Modify: `packages/domain/src/url.ts`
- Modify: `packages/domain/src/index.ts`

- [ ] **Step 1: Write failing source-proof tests**

Cover valid proofs, invalid URLs, platform IDs, and Twitter canonicalization:

```ts
expect(validateSourceCandidate({
  connectorId: 'twitterapi-io',
  sourceType: 'social',
  platform: 'X',
  externalId: '123',
  url: 'https://twitter.com/project/status/123?ref_src=twsrc',
  title: null,
  content: 'We released version 2 today.',
  excerpt: null,
  authorName: 'Project',
  authorHandle: 'project',
  publishedAt: '2026-07-27T08:00:00.000Z',
  language: 'en',
  engagement: { likes: 10 },
  proof: { kind: 'api_record', connectorId: 'twitterapi-io', externalId: '123' },
})).toMatchObject({
  canonicalUrl: 'https://x.com/project/status/123',
});
```

Reject an `api_record` whose proof external ID differs from the candidate, a non-HTTP URL, and a fetched page without a parent proof.

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- packages/domain/src/source.test.ts`

Expected: FAIL because source validation does not exist.

- [ ] **Step 3: Implement provider-neutral source validation**

Use a discriminated `SourceProof` union:

```ts
export type SourceProof =
  | { kind: 'ai_citation'; connectorId: string; citationUrl: string }
  | { kind: 'api_record'; connectorId: string; externalId: string }
  | { kind: 'feed_entry'; connectorId: string; feedUrl: string; entryId: string }
  | { kind: 'fetched_page'; connectorId: string; parentUrl: string };
```

Return a normalized candidate containing `canonicalUrl`. Require matching API IDs and canonical citation URLs. Normalize Twitter/Twitter mobile URLs to `https://x.com/<handle>/status/<id>`.

- [ ] **Step 4: Write failing deterministic quality tests**

```ts
expect(rejectCandidate(thinSearchPage)).toEqual({
  rejected: true,
  reason: 'NON_CONTENT_PAGE',
});
expect(rejectCandidate(firstPartyShortPost).rejected).toBe(false);
expect(selectDiverseCandidates(manySameDomain, 5)
  .filter((item) => item.platform === 'Example').length).toBeLessThanOrEqual(2);
expect(deduplicateCandidates([twitterUrl, xUrl])).toHaveLength(1);
```

- [ ] **Step 5: Run and verify RED**

Run: `npm test -- packages/domain/src/quality.test.ts`

Expected: FAIL because quality functions do not exist.

- [ ] **Step 6: Implement deterministic rejection, deduplication, and diversity**

Reject known non-content path patterns, missing substantive content, out-of-window items, and exact duplicates. Exempt original social announcements from generic text-length rules when they contain a verified platform ID, author, and concrete release/decision/date/link signal. Select at most 40% from one platform or domain when at least three distinct sources are available.

- [ ] **Step 7: Verify and commit**

Run: `npm test -- packages/domain`

Expected: all domain tests PASS.

Commit: `feat: add source proof and quality domain rules`

## Task 3: Connector Runtime and Partial Failure Isolation

**Files:**
- Create: `apps/worker/src/connectors/types.ts`
- Create: `apps/worker/src/connectors/registry.test.ts`
- Create: `apps/worker/src/connectors/registry.ts`

- [ ] **Step 1: Write failing registry tests**

```ts
it('runs only enabled supporting connectors with bounded concurrency', async () => {
  const registry = new ConnectorRegistry(connectors, { concurrency: 2, timeoutMs: 5_000 });
  const result = await registry.search(plan);
  expect(result.successfulConnectorIds).toEqual(['rss', 'github']);
  expect(result.failures).toEqual([]);
  expect(maxObservedConcurrency).toBe(2);
});

it('keeps successful candidates when one connector fails', async () => {
  const result = await registry.search(plan);
  expect(result.candidates).toEqual([candidate]);
  expect(result.failures).toMatchObject([{ connectorId: 'twitterapi-io' }]);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- apps/worker/src/connectors/registry.test.ts`

Expected: FAIL because registry and interfaces do not exist.

- [ ] **Step 3: Implement interfaces and registry**

Define `SourceConnector`, `SourceQueryPlan`, `ConnectorResult`, and safe `ConnectorFailure`. Implement a small promise worker pool, per-connector `AbortController`, and all-settled behavior. Disabled/unsupported connectors are skipped and do not appear as failures.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- apps/worker/src/connectors/registry.test.ts`

Expected: PASS with no unhandled rejection.

Commit: `feat: add isolated connector runtime`

## Task 4: TwitterAPI.io Connector

**Files:**
- Create: `apps/worker/src/connectors/twitterapi-io.test.ts`
- Create: `apps/worker/src/connectors/twitterapi-io.ts`

- [ ] **Step 1: Write failing advanced-search tests**

Use response fixtures that include original, retweeted, quoted, and threaded tweets. Assert:

```ts
expect(requests[0]).toMatchObject({
  url: expect.stringContaining('/twitter/tweet/advanced_search'),
  headers: { 'x-api-key': 'test-twitter-key' },
});
expect(new URL(requests[0]!.url).searchParams.get('queryType')).toBe('Latest');
expect(new URL(requests[1]!.url).searchParams.get('queryType')).toBe('Top');
expect(result.candidates[0]).toMatchObject({
  connectorId: 'twitterapi-io',
  sourceType: 'social',
  platform: 'X',
  externalId: '100',
  proof: { kind: 'api_record', externalId: '100' },
});
```

Assert that `since_time`/`until_time` are Unix seconds, cursors stop at the configured page budget, retweets normalize to the original tweet, and errors never include the API key.

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- apps/worker/src/connectors/twitterapi-io.test.ts`

Expected: FAIL because connector is missing.

- [ ] **Step 3: Implement search and normalization**

Call `https://api.twitterapi.io/twitter/tweet/advanced_search` for `Latest` and `Top`. Parse responses with Zod. Convert Twitter timestamps to ISO, entity URLs to expanded URLs, counts to transient engagement fields, and API errors to safe connector errors.

- [ ] **Step 4: Add failing thread-context test**

Assert that only promising original tweets marked as a thread fetch `/twitter/tweet/thread_context`, combine same-author chronological posts into content, and stop on empty pages even if `has_next_page` remains true.

- [ ] **Step 5: Implement bounded thread enrichment**

Use at most one thread request page per shortlisted tweet in the connector. Preserve the root tweet URL and ID as provenance.

- [ ] **Step 6: Verify and commit**

Run: `npm test -- apps/worker/src/connectors/twitterapi-io.test.ts`

Expected: all TwitterAPI.io tests PASS.

Commit: `feat: add TwitterAPI.io discovery connector`

## Task 5: Public High-Signal Connectors

**Files:**
- Create: `apps/worker/src/connectors/rss.test.ts`
- Create: `apps/worker/src/connectors/rss.ts`
- Create: `apps/worker/src/connectors/hacker-news.test.ts`
- Create: `apps/worker/src/connectors/hacker-news.ts`
- Create: `apps/worker/src/connectors/arxiv.test.ts`
- Create: `apps/worker/src/connectors/arxiv.ts`
- Create: `apps/worker/src/connectors/github.test.ts`
- Create: `apps/worker/src/connectors/github.ts`

- [ ] **Step 1: Write failing RSS/Atom fixture tests**

Verify RSS 2.0 and Atom entries normalize links, GUIDs, authors, publication dates, HTML descriptions, and `feed_entry` proofs. Reject malformed feeds and non-HTTP links.

- [ ] **Step 2: Verify RED, implement RSS, and verify GREEN**

Run RED: `npm test -- apps/worker/src/connectors/rss.test.ts`

Implement using `fast-xml-parser` with explicit schemas and maximum entry count.

Run GREEN: `npm test -- apps/worker/src/connectors/rss.test.ts`

- [ ] **Step 3: Write failing Hacker News tests**

Verify Algolia search query/time parameters, `story_id` stable IDs, discussion URLs, story text, author, and `community` source type.

- [ ] **Step 4: Verify RED, implement Hacker News, and verify GREEN**

Run RED/GREEN: `npm test -- apps/worker/src/connectors/hacker-news.test.ts`

- [ ] **Step 5: Write failing arXiv tests**

Verify Atom query construction, paper IDs, authors, abstract text, published timestamps, PDF/abstract canonical URLs, and `paper` source type.

- [ ] **Step 6: Verify RED, implement arXiv, and verify GREEN**

Run RED/GREEN: `npm test -- apps/worker/src/connectors/arxiv.test.ts`

- [ ] **Step 7: Write failing GitHub tests**

Verify optional bearer token, unauthenticated enablement, release/repository search normalization, rate-limit errors, stable node IDs, and `code` source type.

- [ ] **Step 8: Verify RED, implement GitHub, and verify GREEN**

Run RED/GREEN: `npm test -- apps/worker/src/connectors/github.test.ts`

- [ ] **Step 9: Run connector suite and commit**

Run: `npm test -- apps/worker/src/connectors`

Expected: registry, TwitterAPI.io, RSS, Hacker News, arXiv, and GitHub tests PASS.

Commit: `feat: add public high-signal connectors`

## Task 6: Search, Video, and Community Connectors

**Files:**
- Create: `apps/worker/src/connectors/search-provider.test.ts`
- Create: `apps/worker/src/connectors/search-provider.ts`
- Create: `apps/worker/src/connectors/youtube.test.ts`
- Create: `apps/worker/src/connectors/youtube.ts`
- Create: `apps/worker/src/connectors/reddit.test.ts`
- Create: `apps/worker/src/connectors/reddit.ts`
- Create: `apps/worker/src/connectors/bluesky.test.ts`
- Create: `apps/worker/src/connectors/bluesky.ts`
- Create: `apps/worker/src/connectors/bilibili.test.ts`
- Create: `apps/worker/src/connectors/bilibili.ts`

- [ ] **Step 1: Add failing generic search-provider tests**

Assert that a configured base URL/API key receives Chinese and English queries, optional `site:` constraints, safe auth headers, bounded pages, and normalizes results to `ai_citation`-equivalent API records without accepting model-created URLs.

- [ ] **Step 2: Implement and verify search provider**

Run: `npm test -- apps/worker/src/connectors/search-provider.test.ts`

Expected RED before implementation and GREEN after a provider-neutral JSON adapter with configured field mapping.

- [ ] **Step 3: Add failing YouTube tests, implement, and verify**

Test `search.list` plus `videos.list`, stable video IDs, descriptions, channel authors, published dates, canonical watch URLs, and disablement without `YOUTUBE_API_KEY`.

Run: `npm test -- apps/worker/src/connectors/youtube.test.ts`

- [ ] **Step 4: Add failing Reddit tests, implement, and verify**

Test client-credentials token acquisition, bearer search, post/selftext normalization, permalink validation, and key redaction.

Run: `npm test -- apps/worker/src/connectors/reddit.test.ts`

- [ ] **Step 5: Add failing Bluesky tests, implement, and verify**

Test public AppView post search, AT URI stable IDs, author handles, record timestamps, post URLs, and quote/repost normalization.

Run: `npm test -- apps/worker/src/connectors/bluesky.test.ts`

- [ ] **Step 6: Add failing Bilibili tests, implement, and verify**

Test strict timeout, public search response validation, `bvid` stable IDs, canonical video URLs, author/title/description, and graceful connector disablement on access-control responses. Do not use cookies, login automation, or CAPTCHA bypass.

Run: `npm test -- apps/worker/src/connectors/bilibili.test.ts`

- [ ] **Step 7: Verify and commit**

Run: `npm test -- apps/worker/src/connectors`

Expected: all connector fixture tests PASS.

Commit: `feat: add search video and community connectors`

## Task 7: Safe Content Fetching and High-Precision Pipeline

**Files:**
- Create: `apps/worker/src/content-fetcher.test.ts`
- Create: `apps/worker/src/content-fetcher.ts`
- Create: `apps/worker/src/quality-pipeline.test.ts`
- Create: `apps/worker/src/quality-pipeline.ts`

- [ ] **Step 1: Write failing SSRF and extraction tests**

Test public HTML extraction and reject loopback, RFC1918, link-local, cloud metadata, private DNS answers, redirect-to-private, excessive redirects, oversized content, and non-text MIME types.

```ts
await expect(fetcher.fetchText('http://127.0.0.1/admin')).rejects.toMatchObject({
  code: 'UNSAFE_SOURCE_URL',
});
await expect(fetcher.fetchText('https://example.com/article')).resolves.toMatchObject({
  title: 'Article',
  text: expect.stringContaining('substantive body'),
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- apps/worker/src/content-fetcher.test.ts`

Expected: FAIL because fetcher does not exist.

- [ ] **Step 3: Implement safe fetch and Cheerio extraction**

Inject DNS lookup and fetch for tests. Validate resolved addresses before each request and redirect, cap bytes while streaming, accept HTML/text only, remove script/style/nav/form, and return normalized text without persisting it.

- [ ] **Step 4: Write failing quality-pipeline tests**

Cover enrichment only for candidates needing body text, deterministic rejection, first-party short social exception, historical duplicate removal, AI assessment batching, no URL outside the input pool, 3-8 target size, and empty success.

- [ ] **Step 5: Run and verify RED**

Run: `npm test -- apps/worker/src/quality-pipeline.test.ts`

Expected: FAIL because pipeline does not exist.

- [ ] **Step 6: Implement the pipeline**

Compose domain functions, content fetcher, history lookup, `AiGateway.evaluateCandidates`, diversity selection, and `AiGateway.composeItems`. Batch candidate text with explicit per-item and total character caps. Revalidate composed URLs against accepted candidate canonical URLs.

- [ ] **Step 7: Verify and commit**

Run: `npm test -- apps/worker/src/content-fetcher.test.ts apps/worker/src/quality-pipeline.test.ts packages/domain/src/quality.test.ts`

Expected: all PASS.

Commit: `feat: add safe high-precision quality pipeline`

## Task 8: Split the OpenRouter AI Gateway

**Files:**
- Modify: `apps/worker/src/ai-gateway.ts`
- Modify: `apps/worker/src/openrouter-gateway.test.ts`
- Modify: `apps/worker/src/openrouter-gateway.ts`
- Create: `apps/worker/src/connectors/openrouter-search.test.ts`
- Create: `apps/worker/src/connectors/openrouter-search.ts`

- [ ] **Step 1: Replace monolithic discovery tests with failing capability tests**

Test expansion, candidate assessment, final composition, and strict JSON schemas. Assessment returns an ID-keyed decision with `accepted`, `kind`, and rejection reason; composition receives only accepted candidates and returns source-aware items.

- [ ] **Step 2: Verify RED**

Run: `npm test -- apps/worker/src/openrouter-gateway.test.ts`

Expected: FAIL because new gateway methods do not exist.

- [ ] **Step 3: Implement AI-only gateway methods**

Keep structured response correction, provider parameter requirements, timeout, retry mapping, and redaction. Remove source discovery from `AiGateway`.

- [ ] **Step 4: Write failing OpenRouter search connector test**

Assert Web Search plugin use, annotation normalization into `ai_citation` proofs, and rejection of response URLs absent from annotations.

- [ ] **Step 5: Implement OpenRouter search connector and verify**

Run: `npm test -- apps/worker/src/openrouter-gateway.test.ts apps/worker/src/connectors/openrouter-search.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

Commit: `refactor: split OpenRouter search from AI analysis`

## Task 9: Prisma Models and Repository Persistence

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260727_multi_source_discovery/migration.sql`
- Modify: `apps/worker/src/discovery-service.test.ts`
- Modify: `apps/worker/src/discovery-service.ts`
- Modify: `apps/api/src/topic-store.ts`

- [ ] **Step 1: Write failing repository behavior tests**

Test run creation/completion, source metadata persistence, `nextRunAt`, 6/12/24-hour adaptive state, manual-run schedule preservation, connector summary redaction, and canonical item upsert.

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- apps/worker/src/discovery-service.test.ts`

Expected: FAIL because repository methods and fields are absent.

- [ ] **Step 3: Add Prisma schema and migration**

Add enums for trigger, source type, and provenance kind; add `DiscoveryRun`; extend `Topic` and `DiscoveryItem`; add due-topic and run-history indexes. Migration must backfill existing items as `sourceType=web`, `platform=Web`, `provenanceKind=ai_citation`, and existing topics with a 12-hour interval and nullable next run.

- [ ] **Step 4: Generate Prisma and implement repository methods**

Run: `npm run db:generate`

Implement transactional run lifecycle and schedule updates. Keep old items on failure. Store only safe connector summaries, counts, and final metadata.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- apps/worker/src/discovery-service.test.ts apps/api/src/app.test.ts`

Expected: repository-dependent tests PASS.

Commit: `feat: persist multi-source runs and schedules`

## Task 10: Discovery Orchestration and Adaptive Scheduler

**Files:**
- Modify: `apps/worker/src/discovery-service.test.ts`
- Modify: `apps/worker/src/discovery-service.ts`
- Create: `apps/worker/src/scheduler.test.ts`
- Create: `apps/worker/src/scheduler.ts`
- Modify: `apps/worker/src/worker.test.ts`
- Modify: `apps/worker/src/worker.ts`
- Modify: `apps/worker/src/main.ts`

- [ ] **Step 1: Write failing orchestration tests**

Assert expansion, source routing, connector aggregation, quality pipeline, successful empty results, partial connector success, all-connectors failure, trigger preservation, and old-result retention.

- [ ] **Step 2: Verify RED and implement orchestration**

Run: `npm test -- apps/worker/src/discovery-service.test.ts`

Replace the single `gateway.discover` call with expansion, route building, registry search, provenance validation, quality pipeline, and transactional persistence under the ten-minute overall abort signal.

- [ ] **Step 3: Write failing scheduler tests with fake time**

Test due-topic claiming, deterministic job IDs, duplicate scans, 6/12/24-hour transitions, 10% deterministic jitter, manual refresh schedule preservation, and 24-hour retry after final scheduled failure.

- [ ] **Step 4: Verify RED and implement scheduler**

Run: `npm test -- apps/worker/src/scheduler.test.ts`

Implement PostgreSQL conditional claiming and a BullMQ scheduler queue job every ten minutes. Do not use per-topic repeatable jobs as the source of truth.

- [ ] **Step 5: Update worker composition and verify**

Run: `npm test -- apps/worker/src/worker.test.ts apps/worker/src/scheduler.test.ts apps/worker/src/discovery-service.test.ts`

Expected: all PASS, including retry state.

- [ ] **Step 6: Commit**

Commit: `feat: orchestrate multi-source scheduled discovery`

## Task 11: API Surface and Source Status

**Files:**
- Modify: `apps/api/src/app.test.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/topic-store.ts`
- Modify: `apps/api/src/e2e-main.ts`

- [ ] **Step 1: Write failing API tests**

Test:

```ts
expect((await request(app).get('/api/v1/feed')).body).toHaveLength(1);
expect((await request(app).get('/api/v1/feed?range=all')).body).toHaveLength(2);
expect((await request(app).get('/api/v1/discovery-sources')).body).toEqual([
  expect.objectContaining({ id: 'openrouter-search', status: 'enabled' }),
  expect.objectContaining({ id: 'twitterapi-io', status: 'not_configured' }),
]);
```

Also assert new topic/item fields and ownership behavior remain intact.

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- apps/api/src/app.test.ts`

Expected: FAIL because range and source endpoint are absent.

- [ ] **Step 3: Implement API behavior**

Default feed queries to a server-calculated 90-day cutoff; `range=all` removes it. Inject safe source statuses into the app factory. Never return keys, quotas, upstream URLs, or internal errors.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- apps/api/src/app.test.ts`

Expected: PASS.

Commit: `feat: expose multi-source discovery API state`

## Task 12: Source-Aware Web Experience

**Files:**
- Modify: `apps/web/src/api.ts`
- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/components/DiscoveryCard.test.tsx`
- Modify: `apps/web/src/components/DiscoveryCard.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `tests/e2e/ai-discovery.spec.ts`

- [ ] **Step 1: Write failing card tests**

Assert X platform, social type, author handle, original-link accessibility, and long author wrapping. Assert no trust score or verified wording appears.

- [ ] **Step 2: Verify RED and implement card metadata**

Run: `npm test -- apps/web/src/components/DiscoveryCard.test.tsx`

Use existing Lucide icons and compact metadata. Keep cards at the existing radius and do not add nested cards.

- [ ] **Step 3: Write failing page tests**

Assert recent/all history segmented control, next automatic update text, 6/12/24-hour interval text, multi-source activity label, and enabled/not-configured source status without credentials.

- [ ] **Step 4: Verify RED and implement pages/API client**

Run: `npm test -- apps/web/src/App.test.tsx`

Keep existing React Query polling and failure preservation. Replace fixed OpenRouter sidebar copy with multi-source state.

- [ ] **Step 5: Extend Playwright flow**

Test desktop and mobile history switching, source metadata, refresh, and no overlap at 320px/412px/1440px.

- [ ] **Step 6: Verify and commit**

Run: `npm test -- apps/web/src/App.test.tsx apps/web/src/components/DiscoveryCard.test.tsx`

Expected: PASS.

Commit: `feat: show multi-source discovery and history`

## Task 13: Documentation, Live Tests, and Full Verification

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `README_EN.md`
- Modify: `docs/design.md`
- Modify: `docs/requirements.md`
- Modify: `apps/worker/src/openrouter.live.test.ts`
- Create: `apps/worker/src/twitterapi-io.live.test.ts`

- [ ] **Step 1: Update safe configuration documentation**

Document all optional keys, default no-key/public connectors, TwitterAPI.io specifically, scheduler behavior, 90-day default feed, and live-test opt-ins. Keep every example value empty or clearly fake.

- [ ] **Step 2: Add opt-in live connector tests**

TwitterAPI.io live test runs only when both its explicit live flag and API key exist. Verify one safe public query returns schema-valid source candidates and no output contains the key. Keep OpenRouter live tests aligned with split gateway/search behavior.

- [ ] **Step 3: Run focused live-test files in skipped mode**

Run: `npm test -- apps/worker/src/openrouter.live.test.ts apps/worker/src/twitterapi-io.live.test.ts`

Expected: both suites SKIP without environment flags and make no network requests.

- [ ] **Step 4: Apply and verify database migration locally**

Run:

```powershell
npm run db:generate
npm run db:deploy
```

Expected: Prisma generation succeeds and migration applies to the configured local PostgreSQL database. If infrastructure is unavailable, record that exact environmental limitation and still validate SQL/schema through Prisma generation.

- [ ] **Step 5: Run the complete verification matrix**

Run in order:

```powershell
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
```

Expected: zero lint errors, zero TypeScript errors, all non-live tests pass, all workspaces build, and Playwright passes.

- [ ] **Step 6: Audit the design acceptance criteria**

For every item in `docs/superpowers/specs/2026-07-27-lettermate-multi-source-discovery-design.md` section 18, record the proving file/test/command. Treat missing live credentials as unverified external integration, not as proof of success.

- [ ] **Step 7: Commit final documentation and verification fixtures**

Commit: `docs: document multi-source discovery operation`

## Execution Checkpoints

After Tasks 1-3: shared contracts and connector runtime are stable.

After Tasks 4-8: all connectors and the high-precision pipeline are fixture-tested.

After Tasks 9-10: database, orchestration, and automatic scheduling form a complete backend flow.

After Tasks 11-12: API and user workflows expose the new behavior.

After Task 13: full verification and acceptance audit determine whether the feature is complete.
