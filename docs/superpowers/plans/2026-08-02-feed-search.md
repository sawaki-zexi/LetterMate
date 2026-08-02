# Persisted Feed Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add relevance-ranked search over stored Feed articles while preserving ownership and every existing Feed filter.

**Architecture:** A shared Zod contract adds the optional submitted query to `GET /feed`. PostgreSQL uses `pg_trgm` indexes, substring matching, and weighted similarity to rank persisted Topic and trend items; the memory store mirrors the ordering for API and E2E tests. React keeps draft and submitted search state separate so only Enter or the Search button issues a request.

**Tech Stack:** TypeScript, Zod, NestJS, Prisma, PostgreSQL `pg_trgm`, React, TanStack Query, Vitest, Playwright

---

### Task 1: Define The Shared Feed Query Contract

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/index.test.ts`

- [ ] **Step 1: Write failing contract tests**

Import `feedQuerySchema` and add tests proving that it trims `q`, converts an
empty submitted value to no query, accepts existing filters, rejects queries
over 100 characters, and still rejects `topicId` combined with trend origin.

```ts
it('normalizes persisted Feed search queries with existing filters', () => {
  expect(feedQuerySchema.parse({
    q: '  智能体工程  ', range: '30d', origin: 'topic', kind: 'quality',
  })).toEqual({
    q: '智能体工程', range: '30d', origin: 'topic', kind: 'quality',
  });
  expect(feedQuerySchema.parse({ q: '   ' })).toEqual({
    q: undefined, range: '30d', origin: 'all',
  });
  expect(() => feedQuerySchema.parse({ q: 'x'.repeat(101) })).toThrow();
  expect(() => feedQuerySchema.parse({ topicId: 'topic-1', origin: 'trend' })).toThrow();
});
```

- [ ] **Step 2: Run the focused contract test and verify RED**

Run: `npm test -- packages/contracts/src/index.test.ts`

Expected: FAIL because `feedQuerySchema` is not exported.

- [ ] **Step 3: Implement the shared contract and types**

Add a strict object schema next to the existing Feed enums. Normalize a blank
query to `undefined` while retaining current defaults and the incompatible
filter check.

```ts
const feedSearchTextSchema = z.string().trim().max(100)
  .transform((value) => value || undefined)
  .optional();

export const feedQuerySchema = z.strictObject({
  topicId: z.string().trim().min(1).optional(),
  kind: discoveryKindSchema.optional(),
  range: feedRangeSchema.default('30d'),
  origin: feedOriginSchema.default('all'),
  q: feedSearchTextSchema,
}).superRefine((filter, context) => {
  if (filter.topicId && filter.origin === 'trend') {
    context.addIssue({
      code: 'custom', path: ['origin'],
      message: 'topicId cannot be combined with trend origin',
    });
  }
});

export type FeedQuery = z.infer<typeof feedQuerySchema>;
export type FeedQueryInput = z.input<typeof feedQuerySchema>;
```

- [ ] **Step 4: Run the contract test and verify GREEN**

Run: `npm test -- packages/contracts/src/index.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the contract**

```powershell
git add packages/contracts/src/index.ts packages/contracts/src/index.test.ts
git commit -m "feat(contracts): define persisted feed search query"
```

### Task 2: Add PostgreSQL Search Indexes And Ranked Store Queries

**Files:**
- Create: `prisma/migrations/20260802_feed_search_trigrams/migration.sql`
- Create: `apps/api/src/feed-search.ts`
- Create: `apps/api/src/feed-search.test.ts`
- Modify: `apps/api/src/topic-store.ts`
- Modify: `apps/api/src/topic-store.test.ts`

- [ ] **Step 1: Add a failing migration structure test**

Create `feed-search.test.ts` with a test that reads the migration and requires
`pg_trgm` plus title, summary, and reason GIN indexes on both stored item tables.

```ts
const sql = readFileSync(
  'prisma/migrations/20260802_feed_search_trigrams/migration.sql',
  'utf8',
);

expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS pg_trgm');
for (const table of ['DiscoveryItem', 'RadarItem']) {
  for (const field of ['title', 'summary', 'reason']) {
    expect(sql).toContain(`ON "${table}" USING GIN ("${field}" gin_trgm_ops)`);
  }
}
```

- [ ] **Step 2: Run the migration test and verify RED**

Run: `npm test -- apps/api/src/feed-search.test.ts`

Expected: FAIL because the migration does not exist.

- [ ] **Step 3: Add the extension and indexes**

Create the migration with explicit stable index names:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "DiscoveryItem_title_trgm_idx"
  ON "DiscoveryItem" USING GIN ("title" gin_trgm_ops);
CREATE INDEX "DiscoveryItem_summary_trgm_idx"
  ON "DiscoveryItem" USING GIN ("summary" gin_trgm_ops);
CREATE INDEX "DiscoveryItem_reason_trgm_idx"
  ON "DiscoveryItem" USING GIN ("reason" gin_trgm_ops);

CREATE INDEX "RadarItem_title_trgm_idx"
  ON "RadarItem" USING GIN ("title" gin_trgm_ops);
CREATE INDEX "RadarItem_summary_trgm_idx"
  ON "RadarItem" USING GIN ("summary" gin_trgm_ops);
CREATE INDEX "RadarItem_reason_trgm_idx"
  ON "RadarItem" USING GIN ("reason" gin_trgm_ops);
```

- [ ] **Step 4: Add failing ranking and ownership tests**

In `feed-search.test.ts`, test a pure merge helper with deliberately shuffled
Topic and trend ranks. Require relevance descending, effective time descending,
then ID descending. Also inspect generated Prisma SQL to prove that Topic search
joins `Topic` and constrains `Topic.userId`, while trend search constrains
`RadarItem.userId`.

```ts
expect(sortRankedFeed([
  { item: oldTitleMatch, relevance: 3.4 },
  { item: newSummaryMatch, relevance: 2.7 },
  { item: newerEqualMatch, relevance: 3.4 },
])).toEqual([newerEqualMatch, oldTitleMatch, newSummaryMatch]);

const topicSql = buildTopicRankQuery('user-a', filter);
expect(topicSql.strings.join('?')).toContain('JOIN "Topic"');
expect(topicSql.strings.join('?')).toContain('topic."userId" =');
expect(topicSql.values).toContain('user-a');
```

In `topic-store.test.ts`, add memory-store fixtures whose query appears only in
title, only in summary, and only in reason. Assert title first, then summary,
then reason; include another user's matching item and assert it is absent. Add a
second test combining `query`, `topicId`, `kind`, and `since`.

- [ ] **Step 5: Run focused store tests and verify RED**

Run:

```powershell
npm test -- apps/api/src/feed-search.test.ts apps/api/src/topic-store.test.ts
```

Expected: FAIL because ranked query helpers and `FeedStoreFilter.query` do not
exist and the memory store ignores search.

- [ ] **Step 6: Implement parameterized PostgreSQL rank queries**

In `feed-search.ts`, define `RankedId`, `RankedFeedItem`, stable merge sorting,
and two query builders. Escape `%`, `_`, and backslash before creating the
`%query%` pattern. Use `Prisma.sql` interpolation for every user value and
filter; never concatenate user input into SQL.

The score must make title containment stronger than summary containment, and
summary stronger than reason, while using trigram similarity inside each field:

```sql
(
  CASE WHEN item."title" ILIKE $pattern THEN 3 ELSE 0 END
  + similarity(lower(item."title"), lower($query)) * 0.60
  + CASE WHEN item."summary" ILIKE $pattern THEN 2 ELSE 0 END
  + similarity(lower(item."summary"), lower($query)) * 0.30
  + CASE WHEN item."reason" ILIKE $pattern THEN 1 ELSE 0 END
  + similarity(lower(item."reason"), lower($query)) * 0.10
)::double precision AS relevance
```

Require at least one substring match in the `WHERE` clause. Apply ownership,
kind, effective-time, and selected-Topic conditions in the rank query. Skip the
Topic or trend query entirely when `origin` excludes it.

Expose only these internal helpers:

```ts
export interface RankedId { id: string; relevance: number }
export interface RankedFeedItem { item: FeedItem; relevance: number }
export function buildTopicRankQuery(userId: string, filter: FeedStoreFilter): Prisma.Sql;
export function buildTrendRankQuery(userId: string, filter: FeedStoreFilter): Prisma.Sql;
export function sortRankedFeed(items: RankedFeedItem[]): FeedItem[];
```

- [ ] **Step 7: Route queried IDs through Prisma model reads**

Add `query?: string` to `FeedStoreFilter`. In `PrismaTopicStore.listFeed`, keep
the current implementation unchanged when `query` is absent. When present:

1. execute the applicable rank query or queries with `$queryRaw<RankedId[]>`;
2. fetch the returned IDs through `discoveryItem.findMany` and
   `radarItem.findMany`, repeating the current ownership constraints;
3. map rows with the existing public mappers;
4. pair each item with its database relevance and call `sortRankedFeed`.

Do not return the score in `FeedItem`.

- [ ] **Step 8: Implement deterministic memory-store search**

Add a private `memorySearchRelevance(item, query): number | null` helper using
case-insensitive substring matching and the same 3/2/1 field priority. Filter
out null scores, retain every existing ownership/filter check, and use
`sortRankedFeed` for query mode. Keep `sortFeed` for normal mode.

- [ ] **Step 9: Run focused tests and verify GREEN**

Run:

```powershell
npm test -- apps/api/src/feed-search.test.ts apps/api/src/topic-store.test.ts
```

Expected: PASS.

- [ ] **Step 10: Apply the migration locally and verify the extension**

Run:

```powershell
npm run db:deploy
docker exec infra-postgres-1 psql -U lettermate -d lettermate -c "SELECT extname FROM pg_extension WHERE extname = 'pg_trgm';"
```

Expected: migration applies and the query returns one `pg_trgm` row. Use the
database user and database from `infra/compose.yaml` if those defaults differ.

- [ ] **Step 11: Commit store search**

```powershell
git add prisma/migrations/20260802_feed_search_trigrams apps/api/src/feed-search.ts apps/api/src/feed-search.test.ts apps/api/src/topic-store.ts apps/api/src/topic-store.test.ts
git commit -m "feat(api): rank persisted feed search results"
```

### Task 3: Expose Search Through The Feed API And Web Client

**Files:**
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/app.test.ts`
- Modify: `apps/web/src/api.ts`
- Modify: `apps/web/src/api.test.ts`

- [ ] **Step 1: Write failing API endpoint tests**

Seed the `MemoryTopicStore` through its existing fake completion helpers, then
assert `/api/v1/feed?q=工程` returns only matching persisted items and preserves
`kind`, `range`, `origin`, and `topicId`. Add a validation assertion for a
101-character query returning HTTP 400 with `VALIDATION_ERROR`.

```ts
const response = await request(app.getHttpServer())
  .get('/api/v1/feed?q=工程&origin=topic&kind=quality&range=all')
  .set('x-user-id', 'user-a')
  .expect(200);

expect(response.body.map((item: FeedItem) => item.title))
  .toEqual(['智能体工程实践']);
```

- [ ] **Step 2: Write a failing web API serialization test**

Call `api.feed` with `q` and every existing filter. Assert the URL contains the
trimmed encoded query and valid filter parameters. Also assert no `q` parameter
is emitted for normal Feed mode.

- [ ] **Step 3: Run the API/client tests and verify RED**

Run:

```powershell
npm test -- apps/api/src/app.test.ts apps/web/src/api.test.ts
```

Expected: FAIL because the endpoint rejects `q` and the web client schema drops
it.

- [ ] **Step 4: Replace duplicate schemas with the shared contract**

Import `feedQuerySchema` in both API and web. Remove the private duplicate Feed
filter schemas. In the API controller, pass the normalized query to the store:

```ts
return this.store.listFeed(userId, {
  origin: filter.origin,
  since,
  ...(filter.topicId ? { topicId: filter.topicId } : {}),
  ...(filter.kind ? { kind: filter.kind } : {}),
  ...(filter.q ? { query: filter.q } : {}),
});
```

In `apps/web/src/api.ts`, type `FeedFilter` as `FeedQueryInput`, parse it with
`feedQuerySchema`, and include `q` in `URLSearchParams` only when defined.

- [ ] **Step 5: Run API/client tests and verify GREEN**

Run:

```powershell
npm test -- apps/api/src/app.test.ts apps/web/src/api.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the API boundary**

```powershell
git add apps/api/src/app.ts apps/api/src/app.test.ts apps/web/src/api.ts apps/web/src/api.test.ts
git commit -m "feat(api): expose stored article search"
```

### Task 4: Add Submit-Only Search To The Discovery Page

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1: Add failing interaction tests**

Extend the fetch recorder so Feed responses can vary by the `q` parameter. Add
tests for these observable behaviors:

1. typing does not add a Feed request;
2. Enter submits a trimmed query;
3. clicking the Search icon submits the query;
4. changing source/kind/range retains the active `q`;
5. Clear removes `q` and restores normal Feed;
6. a zero-result search shows the search-specific empty state;
7. a failed search retains the input and retry uses the same query.

```ts
fireEvent.change(screen.getByLabelText('搜索已获取文章'), {
  target: { value: '  智能体工程  ' },
});
expect(feedRequests()).toHaveLength(requestsBeforeTyping);

fireEvent.submit(screen.getByRole('search'));
await waitFor(() => expect(requests.some(({ url }) => (
  new URL(url, 'http://test').searchParams.get('q') === '智能体工程'
))).toBe(true));
```

- [ ] **Step 2: Run the focused web test and verify RED**

Run: `npm test -- apps/web/src/App.test.tsx`

Expected: FAIL because the search form does not exist.

- [ ] **Step 3: Implement draft and submitted query state**

In `FeedPage`, add `searchDraft` and `searchQuery`. Include only `searchQuery`
in the memoized filter/query key. The submit handler trims the draft and sets
the submitted value; it does not start discovery or mutate any Topic.

```tsx
const [searchDraft, setSearchDraft] = useState('');
const [searchQuery, setSearchQuery] = useState('');
const submitSearch = (event: React.FormEvent) => {
  event.preventDefault();
  setSearchQuery(searchDraft.trim());
};
const clearSearch = () => {
  setSearchDraft('');
  setSearchQuery('');
};
```

Render a `<form role="search">` below the page header and before `.feed-tools`.
Use the existing Lucide `Search`, `X`, and `RefreshCw` icons. The Search icon
button has `aria-label="搜索文章"`, `title="搜索文章"`, a stable 38px square,
and `aria-busy={feed.isFetching}`. Show the Clear icon only while a submitted
query is active. Keep the input editable during requests.

- [ ] **Step 4: Add search-aware empty and retry states**

When `feed.data?.length === 0`, render `未找到匹配文章` if `searchQuery` is
active, otherwise preserve `暂无发现内容`. Reuse `QueryState` for failures so
its retry calls the current query's `feed.refetch()` without clearing state.

- [ ] **Step 5: Add stable responsive styles**

Add `.feed-search` as a grid with `minmax(0, 1fr)` plus fixed 38px icon tracks.
Style the input consistently with existing selects, keep border radius at 5px,
and collapse without horizontal overflow at 320px. Do not add a decorative
card or explanatory copy.

```css
.feed-search { display: grid; grid-template-columns: minmax(0, 1fr) 38px; gap: 8px; margin-bottom: 14px; }
.feed-search--active { grid-template-columns: minmax(0, 1fr) 38px 38px; }
.feed-search input { min-width: 0; height: 38px; border: 1px solid #cfd6da; border-radius: 5px; padding: 0 11px; }
```

- [ ] **Step 6: Run the focused web tests and verify GREEN**

Run: `npm test -- apps/web/src/App.test.tsx apps/web/src/api.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the discovery-page search UI**

```powershell
git add apps/web/src/App.tsx apps/web/src/App.test.tsx apps/web/src/styles.css
git commit -m "feat(web): search persisted discovery articles"
```

### Task 5: Verify The Complete Search Flow

**Files:**
- Modify: `tests/e2e/ai-discovery.spec.ts`
- Modify: `README.md`
- Modify: `docs/requirements.md`
- Modify: `docs/design.md`

- [ ] **Step 1: Add a Playwright search regression flow**

After the fake worker has created Topic and trend articles, search for a phrase
unique to one stored article. Assert typing alone does not issue a `q` request,
Enter produces a request with `q`, current filters remain present, only the
matching card remains, and Clear restores all cards. Keep the existing desktop
and compact-mobile screenshots and horizontal overflow assertion.

- [ ] **Step 2: Run the desktop E2E search flow**

Run: `npm run test:e2e -- --project=desktop`

Expected: PASS. The feature already completed its test-first cycle in Tasks 1-4;
this step verifies the integrated browser workflow against the fake API worker.

- [ ] **Step 3: Verify the compact mobile E2E layout**

Use accessible selectors (`getByLabel('搜索已获取文章')`,
`getByRole('button', { name: '搜索文章' })`, and
`getByRole('button', { name: '清除搜索' })`). Verify the submitted URL through
`page.waitForResponse`. Then run:

```powershell
npm run test:e2e -- --project=compact-mobile
```

Expected: PASS with no horizontal overflow at 320px.

- [ ] **Step 4: Update product and technical documentation**

Document `q` in the README Feed API table/parameter list. Add persisted search,
relevance ordering, filter composition, and the no-external-discovery boundary
to `docs/requirements.md`. Add the `pg_trgm` ranking path and ownership query
boundary to `docs/design.md`.

- [ ] **Step 5: Run all automated verification**

Run each command and require exit code 0:

```powershell
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
```

Expected: lint has zero warnings, TypeScript and build succeed, all Vitest tests
pass except explicitly gated live tests, and all four Playwright viewport
projects pass.

- [ ] **Step 6: Run a real PostgreSQL API smoke test**

Ensure the local API and database are running. Query a known persisted phrase
with the development user and inspect the ordered response:

```powershell
$headers = @{ 'x-user-id' = 'user-a' }
Invoke-RestMethod -Headers $headers -Uri 'http://localhost:3000/api/v1/feed?q=AI%20Agent&range=all&origin=all'
```

Expected: HTTP 200; every returned item belongs to `user-a`, contains the phrase
in title/summary/reason, and title matches precede weaker-field matches.

- [ ] **Step 7: Commit E2E and documentation**

```powershell
git add tests/e2e/ai-discovery.spec.ts README.md docs/requirements.md docs/design.md
git commit -m "docs: specify persisted feed search"
```
