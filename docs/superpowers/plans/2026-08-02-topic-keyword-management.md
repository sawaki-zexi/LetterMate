# Topic Keyword Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add owned Topic keyword editing, user-managed deterministic variants, soft deletion, and historically accurate inactive-keyword labels without deleting Feed content.

**Architecture:** Topic remains the stable aggregate and gains `deletedAt`; each DiscoveryRun freezes its keyword inputs and each DiscoveryItem stores the primary-keyword snapshot that produced it. Contracts expose full-state Topic updates and server-computed Feed keyword activity, while API, scheduler, worker, and web consistently exclude deleted Topics from active operations.

**Tech Stack:** TypeScript 5.8, Zod, NestJS, Prisma/PostgreSQL, BullMQ, React 19, TanStack Query, Vitest/Testing Library, Playwright.

---

## File Map

- Modify `packages/contracts/src/index.ts` and `index.test.ts`: update request and Feed response contracts.
- Modify `prisma/schema.prisma`; create `prisma/migrations/20260802_topic_keyword_management/migration.sql`: soft deletion, run/item snapshots, and active-only uniqueness.
- Modify `apps/api/src/topic-store.ts` and `topic-store.test.ts`: ownership-safe update/delete, active queries, snapshot-aware Feed mapping, and memory parity.
- Modify `apps/api/src/app.ts` and `app.test.ts`: `PATCH` and `DELETE` endpoints, validation, conflict mapping, and enqueueing.
- Modify `apps/worker/src/discovery-service.ts` and `discovery-service.test.ts`: freeze run inputs, generate variants only initially, and persist item snapshots.
- Modify `apps/worker/src/scheduler.ts` and `scheduler.test.ts`: exclude deleted Topics.
- Modify `apps/web/src/api.ts` and `api.test.ts`: update/delete requests.
- Modify `apps/web/src/App.tsx`, `App.test.tsx`, and `styles.css`: Topic editor, variant controls, delete dialog, cache/filter behavior.
- Modify `apps/web/src/components/DiscoveryCard.tsx` and `DiscoveryCard.test.tsx`: snapshot keyword and inactive label.
- Modify `apps/api/src/e2e-main.ts` and `tests/e2e/ai-discovery.spec.ts`: deterministic test backend and full lifecycle coverage.
- Modify `README.md`, `docs/requirements.md`, and `docs/design.md`: document the completed public behavior and endpoints.

### Task 1: Define Contracts

**Files:**
- Modify: `packages/contracts/src/index.test.ts`
- Modify: `packages/contracts/src/index.ts`

- [ ] **Step 1: Write failing contract tests**

Add tests that require a full update payload and snapshot fields:

```ts
it('validates a full Topic keyword update', () => {
  expect(topicUpdateInputSchema.parse({
    keyword: 'gpt-5.7',
    expandedTerms: ['gpt 5.7', 'gpt5.7'],
  })).toEqual({ keyword: 'gpt-5.7', expandedTerms: ['gpt 5.7', 'gpt5.7'] });
  expect(() => topicUpdateInputSchema.parse({
    keyword: 'gpt-5.7',
    expandedTerms: ['gpt 5.7', ' gpt 5.7 '],
  })).toThrow();
});

it('requires Topic Feed keyword snapshot state', () => {
  expect(topicFeedItemSchema.parse({
    ...feedItemFixture,
    origin: 'topic',
    topicId: 'topic-1',
    topicKeyword: 'gpt-5.7',
    topicKeywordActive: false,
  })).toMatchObject({ topicKeyword: 'gpt-5.7', topicKeywordActive: false });
});
```

- [ ] **Step 2: Run the contract tests and verify RED**

Run: `npm test -- packages/contracts/src/index.test.ts`

Expected: FAIL because `topicUpdateInputSchema`, `topicKeyword`, and `topicKeywordActive` do not exist.

- [ ] **Step 3: Add minimal schemas and exported types**

In `packages/contracts/src/index.ts`, define normalized uniqueness inside the schema without importing domain code:

```ts
const variantSchema = z.string().trim().min(1).max(100);

export const topicUpdateInputSchema = z.object({
  keyword: z.string().trim().min(1).max(100),
  expandedTerms: z.array(variantSchema).max(20),
}).superRefine(({ expandedTerms }, context) => {
  const seen = new Set<string>();
  expandedTerms.forEach((term, index) => {
    const key = term.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
    if (seen.has(key)) context.addIssue({
      code: 'custom', path: ['expandedTerms', index], message: '扩展词不能重复',
    });
    seen.add(key);
  });
});

export const topicFeedItemSchema = discoveryItemSchema.extend({
  origin: z.literal('topic'),
  topicId: z.string().min(1),
  topicKeyword: z.string().min(1).max(100),
  topicKeywordActive: z.boolean(),
}).strict();

export type TopicUpdateInput = z.infer<typeof topicUpdateInputSchema>;
```

- [ ] **Step 4: Run contract tests and verify GREEN**

Run: `npm test -- packages/contracts/src/index.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit contracts**

```powershell
git add packages/contracts/src/index.ts packages/contracts/src/index.test.ts
git commit -m "feat(contracts): define topic keyword management"
```

### Task 2: Add Persistent Snapshots And Soft Deletion

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260802_topic_keyword_management/migration.sql`
- Modify: `apps/worker/src/prisma-schema.test.ts`

- [ ] **Step 1: Write the failing schema test**

Extend `prisma-schema.test.ts` to assert that `Topic` has `deletedAt` and `variantsInitialized`, `DiscoveryRun` has `keywordSnapshot` and `expandedTermsSnapshot`, `DiscoveryItem` has `topicKeyword`, and the old Prisma `@@unique([userId, normalizedKeyword])` declaration is absent.

```ts
expect(schema).toContain('deletedAt             DateTime?');
expect(schema).toContain('variantsInitialized   Boolean');
expect(schema).toContain('keywordSnapshot       String');
expect(schema).toContain('expandedTermsSnapshot String[]');
expect(schema).toContain('topicKeyword          String');
expect(schema).not.toContain('@@unique([userId, normalizedKeyword])');
```

- [ ] **Step 2: Run the schema test and verify RED**

Run: `npm test -- apps/worker/src/prisma-schema.test.ts`

Expected: FAIL on the missing fields.

- [ ] **Step 3: Modify the Prisma schema**

Add the fields, remove the unconditional unique declaration, and add query indexes:

```prisma
model Topic {
  // existing fields
  deletedAt           DateTime?
  variantsInitialized Boolean @default(false)
  @@index([userId, deletedAt, createdAt])
}

model DiscoveryRun {
  // existing fields
  keywordSnapshot       String
  expandedTermsSnapshot String[] @default([])
}

model DiscoveryItem {
  // existing fields
  topicKeyword String
}
```

- [ ] **Step 4: Create the migration with backfills and a partial unique index**

Create `migration.sql` with this order so existing non-null rows remain valid:

```sql
ALTER TABLE "Topic" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "Topic" ADD COLUMN "variantsInitialized" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "DiscoveryRun" ADD COLUMN "keywordSnapshot" TEXT;
ALTER TABLE "DiscoveryRun" ADD COLUMN "expandedTermsSnapshot" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "DiscoveryItem" ADD COLUMN "topicKeyword" TEXT;

UPDATE "DiscoveryRun" AS r
SET "keywordSnapshot" = t."keyword",
    "expandedTermsSnapshot" = t."expandedTerms"
FROM "Topic" AS t WHERE t."id" = r."topicId";

UPDATE "DiscoveryItem" AS i
SET "topicKeyword" = t."keyword"
FROM "Topic" AS t WHERE t."id" = i."topicId";

ALTER TABLE "DiscoveryRun" ALTER COLUMN "keywordSnapshot" SET NOT NULL;
ALTER TABLE "DiscoveryItem" ALTER COLUMN "topicKeyword" SET NOT NULL;
DROP INDEX "Topic_userId_normalizedKeyword_key";
CREATE UNIQUE INDEX "Topic_active_user_keyword_key"
ON "Topic"("userId", "normalizedKeyword") WHERE "deletedAt" IS NULL;
CREATE INDEX "Topic_userId_deletedAt_createdAt_idx"
ON "Topic"("userId", "deletedAt", "createdAt");
```

- [ ] **Step 5: Generate Prisma and verify schema GREEN**

Run: `npm run db:generate`

Expected: Prisma Client generated successfully.

Run: `npm test -- apps/worker/src/prisma-schema.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the data model**

```powershell
git add prisma/schema.prisma prisma/migrations/20260802_topic_keyword_management/migration.sql apps/worker/src/prisma-schema.test.ts
git commit -m "feat(db): preserve topic keyword history"
```

### Task 3: Implement Store Update, Delete, And Feed Mapping

**Files:**
- Modify: `apps/api/src/topic-store.test.ts`
- Modify: `apps/api/src/topic-store.ts`

- [ ] **Step 1: Write failing memory-store behavior tests**

Cover ownership, full replacement of variants, old item state after rename, soft deletion, list exclusion, history retention, and same-name recreation:

```ts
const topic = await store.createTopic('user-1', 'gpt-5.7', 'gpt-5.7');
const item = store.seedItem(topic.id, 'quality');
await expect(store.updateTopic('user-2', topic.id, {
  keyword: 'gpt-5.8', normalizedKeyword: 'gpt-5.8', expandedTerms: [],
})).resolves.toBeNull();
await store.updateTopic('user-1', topic.id, {
  keyword: 'gpt-5.8', normalizedKeyword: 'gpt-5.8', expandedTerms: ['gpt 5.8'],
});
expect(await store.findItem('user-1', item.id)).toMatchObject({
  topicKeyword: 'gpt-5.7', topicKeywordActive: false,
});
await expect(store.deleteTopic('user-1', topic.id)).resolves.toBe(true);
expect(await store.listTopics('user-1')).toEqual([]);
expect(await store.findItem('user-1', item.id)).toMatchObject({ topicKeywordActive: false });
await expect(store.createTopic('user-1', 'gpt-5.8', 'gpt-5.8')).resolves.toBeTruthy();
```

- [ ] **Step 2: Run store tests and verify RED**

Run: `npm test -- apps/api/src/topic-store.test.ts`

Expected: FAIL because update/delete methods and Feed snapshot state are absent.

- [ ] **Step 3: Extend the store interface and errors**

Add:

```ts
export interface TopicUpdateRecord {
  keyword: string;
  normalizedKeyword: string;
  expandedTerms: string[];
}

export interface TopicUpdateResult {
  topic: Topic;
  shouldEnqueue: boolean;
}

interface TopicStore {
  updateTopic(userId: string, id: string, input: TopicUpdateRecord): Promise<TopicUpdateResult | null>;
  deleteTopic(userId: string, id: string): Promise<boolean>;
}
```

- [ ] **Step 4: Implement Prisma active filtering and transactional mutations**

Every active Topic lookup used by list, refresh, update, and delete must include `deletedAt: null`. `updateTopic` updates keyword, normalized keyword, the complete variants array, and `variantsInitialized: true`, then uses the existing refresh registration logic to return `shouldEnqueue`. `deleteTopic` performs owned `updateMany({ where: { id, userId, deletedAt: null }, data: { deletedAt: now, nextRunAt: null, manualRefreshPending: false } })`.

Load the Topic relation when mapping DiscoveryItems:

```ts
type ItemWithTopicState = PrismaDiscoveryItem & {
  topic: { keyword: string; deletedAt: Date | null };
};

function mapTopicFeedItem(item: ItemWithTopicState): FeedItem {
  return topicFeedItemSchema.parse({
    ...mapItem(item),
    origin: 'topic',
    topicKeyword: item.topicKeyword,
    topicKeywordActive: item.topic.deletedAt === null && item.topic.keyword === item.topicKeyword,
  });
}
```

Use `include: { topic: { select: { keyword: true, deletedAt: true } } }` in Feed and item queries. Keep deleted Topics in the relation query so historical content remains visible.

- [ ] **Step 5: Implement memory-store parity**

Store an internal `deletedAt` alongside each memory Topic and set each seeded/completed item's `topicKeyword` from the Topic at creation time. Apply the same owned active lookup, conflict, list filtering, and `topicKeywordActive` computation as Prisma.

- [ ] **Step 6: Run store tests and verify GREEN**

Run: `npm test -- apps/api/src/topic-store.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit store behavior**

```powershell
git add apps/api/src/topic-store.ts apps/api/src/topic-store.test.ts
git commit -m "feat(api): persist topic edits and soft deletion"
```

### Task 4: Expose Owned Update And Delete Endpoints

**Files:**
- Modify: `apps/api/src/app.test.ts`
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: Write failing HTTP tests**

Add Supertest cases for successful update with variants, enqueue-on-update, successful `204` deletion, Topic list removal with Feed retention, duplicate conflict, validation errors, and cross-user `404` for both methods.

```ts
const response = await request(app.getHttpServer())
  .patch(`/api/v1/topics/${topic.id}`)
  .set('x-user-id', 'user-a')
  .send({ keyword: 'gpt-5.8', expandedTerms: ['gpt 5.8'] })
  .expect(200);
expect(response.body).toMatchObject({ keyword: 'gpt-5.8', expandedTerms: ['gpt 5.8'] });
expect(queue.jobs.at(-1)).toMatchObject({ topicId: topic.id, userId: 'user-a', trigger: 'manual' });

await request(app.getHttpServer())
  .delete(`/api/v1/topics/${topic.id}`)
  .set('x-user-id', 'user-a')
  .expect(204);
```

- [ ] **Step 2: Run API tests and verify RED**

Run: `npm test -- apps/api/src/app.test.ts`

Expected: FAIL with 404 for the new routes.

- [ ] **Step 3: Add controller routes**

Import `Patch`, `Delete`, and `topicUpdateInputSchema`. Implement:

```ts
@Patch('topics/:id')
async updateTopic(@Param('id') id: string, @Body() body: unknown,
  @Headers('x-user-id') header?: string) {
  const userId = authenticatedUser(header);
  const input = parseOrThrow(topicUpdateInputSchema, body, '关键词设置无效');
  try {
    const result = await this.store.updateTopic(userId, id, {
      ...input, normalizedKeyword: normalizeKeyword(input.keyword),
    });
    if (!result) throw new NotFoundException(errorBody('TOPIC_NOT_FOUND', '关键词不存在'));
    if (result.shouldEnqueue) await this.queue.enqueue({ topicId: id, userId, trigger: 'manual' });
    return result.topic;
  } catch (error) {
    if (error instanceof TopicAlreadyExistsError) throw new ConflictException(
      errorBody('TOPIC_ALREADY_EXISTS', '关键词已存在'),
    );
    throw error;
  }
}

@Delete('topics/:id')
@HttpCode(204)
async deleteTopic(@Param('id') id: string, @Headers('x-user-id') header?: string) {
  if (!await this.store.deleteTopic(authenticatedUser(header), id)) {
    throw new NotFoundException(errorBody('TOPIC_NOT_FOUND', '关键词不存在'));
  }
}
```

- [ ] **Step 4: Run API tests and verify GREEN**

Run: `npm test -- apps/api/src/app.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit endpoints**

```powershell
git add apps/api/src/app.ts apps/api/src/app.test.ts
git commit -m "feat(api): expose topic update and deletion"
```

### Task 5: Freeze Worker Inputs And Stop Automatic Variant Changes

**Files:**
- Modify: `apps/worker/src/discovery-service.test.ts`
- Modify: `apps/worker/src/discovery-service.ts`
- Modify: `apps/worker/src/scheduler.test.ts`
- Modify: `apps/worker/src/scheduler.ts`

- [ ] **Step 1: Write failing worker tests**

Add separate tests proving: deleted Topics are not found/claimed; a run creates `keywordSnapshot` and `expandedTermsSnapshot`; an initial run calls `expandTopic`; a later run uses saved `expandedTerms` without calling `expandTopic`; completion writes each item with the run keyword; a concurrent rename does not change the accepted item's snapshot.

```ts
expect(prisma.discoveryRun.create).toHaveBeenCalledWith(expect.objectContaining({
  data: expect.objectContaining({
    keywordSnapshot: 'gpt-5.7',
    expandedTermsSnapshot: ['gpt 5.7'],
  }),
}));
expect(prisma.discoveryItem.upsert).toHaveBeenCalledWith(expect.objectContaining({
  create: expect.objectContaining({ topicKeyword: 'gpt-5.7' }),
}));
expect(gateway.expandTopic).not.toHaveBeenCalled();
```

- [ ] **Step 2: Run worker tests and verify RED**

Run: `npm test -- apps/worker/src/discovery-service.test.ts apps/worker/src/scheduler.test.ts`

Expected: FAIL because runs/items have no snapshots and expansion happens on every run.

- [ ] **Step 3: Return a frozen run claim from `beginRun`**

Replace the run-id-only result with:

```ts
export interface BegunDiscoveryRun {
  runId: string;
  keyword: string;
  expandedTerms: string[];
  initialExpansion: boolean;
}
```

Inside the transaction, select the active Topic with `deletedAt: null`, freeze `previous.keyword` and `previous.expandedTerms`, set `initialExpansion` when `trigger === 'initial' && !previous.variantsInitialized`, and create DiscoveryRun with both snapshots. This flag, rather than array emptiness, prevents regeneration after a user intentionally saves no variants.

- [ ] **Step 4: Use saved variants after initial generation**

In `TopicDiscoveryService.run`, use the begun run values rather than the pre-claim Topic object. Only call `gateway.expandTopic` when `initialExpansion` is true. Otherwise construct the router expansion input from the saved list:

```ts
const expanded = begun.initialExpansion
  ? await this.gateway.expandTopic({ keyword: begun.keyword, signal: controller.signal })
  : { terms: begun.expandedTerms, searchQueries: begun.expandedTerms };
const expandedTerms = begun.initialExpansion
  ? unique([...expanded.terms, ...expanded.searchQueries])
  : begun.expandedTerms;
```

Pass `keywordSnapshot: begun.keyword` into completion and write `topicKeyword` on both create and update branches. Only persist `Topic.expandedTerms` and set `variantsInitialized: true` for an initial expansion; subsequent runs never alter user-managed variants.

- [ ] **Step 5: Exclude deleted Topics from scheduling**

Add `deletedAt: null` to both the scheduler's initial `findMany` and conditional `updateMany` ownership clauses, preventing a deletion between scan and claim from enqueueing work.

- [ ] **Step 6: Run worker tests and verify GREEN**

Run: `npm test -- apps/worker/src/discovery-service.test.ts apps/worker/src/scheduler.test.ts apps/worker/src/worker.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit worker behavior**

```powershell
git add apps/worker/src/discovery-service.ts apps/worker/src/discovery-service.test.ts apps/worker/src/scheduler.ts apps/worker/src/scheduler.test.ts
git commit -m "feat(worker): freeze managed topic keywords per run"
```

### Task 6: Add Web API And Topic Management UI

**Files:**
- Modify: `apps/web/src/api.test.ts`
- Modify: `apps/web/src/api.ts`
- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1: Write failing API client tests**

Assert exact methods, paths, and bodies:

```ts
await api.updateTopic('topic-1', { keyword: 'gpt-5.8', expandedTerms: ['gpt 5.8'] });
expect(fetch).toHaveBeenCalledWith('/api/v1/topics/topic-1', expect.objectContaining({
  method: 'PATCH', body: JSON.stringify({ keyword: 'gpt-5.8', expandedTerms: ['gpt 5.8'] }),
}));
await api.deleteTopic('topic-1');
expect(fetch).toHaveBeenLastCalledWith('/api/v1/topics/topic-1', expect.objectContaining({ method: 'DELETE' }));
```

- [ ] **Step 2: Run client tests and verify RED**

Run: `npm test -- apps/web/src/api.test.ts`

Expected: FAIL because the client methods do not exist.

- [ ] **Step 3: Implement API client methods**

Use the existing request helper and parse update responses with `topicSchema`. Make the request helper accept a `204` response without attempting JSON parsing for deletion.

- [ ] **Step 4: Run client tests and verify GREEN**

Run: `npm test -- apps/web/src/api.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing Topic UI tests**

Using Testing Library, cover entering edit mode, prefilled keyword/variants, add/edit/remove variant, cancel, successful cache replacement, validation/server error retention, delete confirmation text, successful removal, and cancel deletion. Use accessible queries such as:

```ts
await user.click(screen.getByRole('button', { name: '编辑 gpt-5.7' }));
expect(screen.getByLabelText('主关键词')).toHaveValue('gpt-5.7');
await user.click(screen.getByRole('button', { name: '添加扩展词' }));
await user.click(screen.getByRole('button', { name: '删除 gpt 5.7' }));
await user.click(screen.getByRole('button', { name: '删除关键词 gpt-5.7' }));
expect(screen.getByRole('dialog')).toHaveTextContent('历史内容仍会保留并标记为失效');
```

- [ ] **Step 6: Run App tests and verify RED**

Run: `npm test -- apps/web/src/App.test.tsx`

Expected: FAIL because edit/delete controls are absent.

- [ ] **Step 7: Implement the Topic editor and delete confirmation**

Add `Pencil`, `Trash2`, `Plus`, `X`, `Save` icons from Lucide. Keep draft state local to `TopicRow`, submit the complete keyword and variant list, and show field/server errors inline. Add update/delete mutations in `TopicsPage`; on success replace/remove the Topic in `['topics']`, invalidate `['feed']`, and leave failed rows intact. Use a semantic `role="dialog"`, focus the destructive confirmation button, and provide explicit cancel.

- [ ] **Step 8: Style stable responsive controls**

In `styles.css`, add fixed-size icon buttons, a compact unframed editor layout, variant rows with constrained inputs, error text, and a modal backdrop/dialog. Verify at 320px that inputs wrap below labels and action buttons never overlap content.

- [ ] **Step 9: Run App tests and verify GREEN**

Run: `npm test -- apps/web/src/App.test.tsx`

Expected: PASS with no React act warnings.

- [ ] **Step 10: Commit Topic management UI**

```powershell
git add apps/web/src/api.ts apps/web/src/api.test.ts apps/web/src/App.tsx apps/web/src/App.test.tsx apps/web/src/styles.css
git commit -m "feat(web): manage topic keywords and variants"
```

### Task 7: Render Historical Keyword State

**Files:**
- Modify: `apps/web/src/components/DiscoveryCard.test.tsx`
- Modify: `apps/web/src/components/DiscoveryCard.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1: Write failing card tests**

```ts
render(<DiscoveryCard item={{
  ...topicItem,
  topicKeyword: 'gpt-5.7',
  topicKeywordActive: false,
}} />);
expect(screen.getByText('来自「gpt-5.7」')).toBeVisible();
expect(screen.getByText('关键词已失效')).toBeVisible();
```

Add the active counterpart and assert the inactive label is absent.

- [ ] **Step 2: Run card/App tests and verify RED**

Run: `npm test -- apps/web/src/components/DiscoveryCard.test.tsx apps/web/src/App.test.tsx`

Expected: FAIL because the card still depends on the active Topic list lookup.

- [ ] **Step 3: Render server-provided snapshot state**

Remove `topicKeywordById` and the `topicKeyword` prop. For Topic items use `item.topicKeyword` directly and render:

```tsx
{item.origin === 'topic' && !item.topicKeywordActive && (
  <span className="keyword-state keyword-state--inactive">关键词已失效</span>
)}
```

Keep the status adjacent to origin metadata, not over the title or source link.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `npm test -- apps/web/src/components/DiscoveryCard.test.tsx apps/web/src/App.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit historical labels**

```powershell
git add apps/web/src/components/DiscoveryCard.tsx apps/web/src/components/DiscoveryCard.test.tsx apps/web/src/App.tsx apps/web/src/App.test.tsx apps/web/src/styles.css
git commit -m "feat(web): label inactive topic history"
```

### Task 8: Complete E2E, Documentation, And Verification

**Files:**
- Modify: `apps/api/src/e2e-main.ts`
- Modify: `tests/e2e/ai-discovery.spec.ts`
- Modify: `README.md`
- Modify: `docs/requirements.md`
- Modify: `docs/design.md`

- [ ] **Step 1: Write the failing Playwright lifecycle assertions**

Extend the existing test after initial Feed creation: edit the Topic to `gpt-5.8`, replace variants, verify the old card says `关键词已失效`, verify new results use `gpt-5.8`, select that Topic filter, delete with confirmation, verify source selection resets to `all`, verify the Topic heading disappears, and verify old content and original link remain.

- [ ] **Step 2: Run desktop E2E and verify RED**

Run: `npm run test:e2e -- --project=desktop --grep "precise topic"`

Expected: FAIL at the first edit-control assertion.

- [ ] **Step 3: Update the fake E2E discovery lifecycle**

Make `completeFakeDiscovery` persist the Topic keyword snapshot used when the fake run started, and ensure deleted queued Topics no-op. Keep fake results deterministic for both the original and edited keywords so Playwright can distinguish old and new cards.

- [ ] **Step 4: Update public documentation**

Add `PATCH /topics/:id` and `DELETE /topics/:id` to the API table. Document soft deletion/history retention, immutable discovery-time keyword labels, and one-time AI variant generation followed by user-managed exact variants. Do not describe broad synonyms.

- [ ] **Step 5: Run focused E2E and verify GREEN**

Run: `npm run test:e2e -- --project=desktop --grep "precise topic"`

Expected: PASS.

- [ ] **Step 6: Run database and static verification**

Run: `npm run db:generate`

Expected: Prisma Client generation succeeds.

Run: `npm run lint`

Expected: PASS with zero warnings.

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Run full automated verification**

Run: `npm test`

Expected: all Vitest suites PASS.

Run: `npm run build`

Expected: web, API, and worker builds PASS.

Run: `npm run test:e2e`

Expected: all configured desktop, tablet, mobile, and compact-mobile Playwright projects PASS.

- [ ] **Step 8: Inspect responsive screenshots**

Open the Playwright desktop and compact-mobile screenshots. Confirm the editor, dialog, keyword state, buttons, labels, and 320px layout do not overlap or overflow. If visual defects exist, first add a failing component/E2E assertion where practical, then adjust `styles.css` and rerun Step 7.

- [ ] **Step 9: Commit E2E and docs**

```powershell
git add apps/api/src/e2e-main.ts tests/e2e/ai-discovery.spec.ts README.md docs/requirements.md docs/design.md apps/web/src/styles.css
git commit -m "test: verify topic keyword management lifecycle"
```
