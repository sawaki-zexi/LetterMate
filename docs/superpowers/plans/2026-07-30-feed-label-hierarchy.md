# Feed Label Hierarchy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Simplify the Feed so content value is the only prominent label, discovery context is secondary text, and one source selector replaces the origin segments plus Topic selector.

**Architecture:** Keep the API and shared `hot | quality` and `topic | trend` contracts unchanged. Add one Web-only display-label module and one pure source-selection mapper, then let `FeedPage` translate a single selector value into the existing `origin + topicId` query and refresh inputs. `DiscoveryCard` receives the Topic keyword from the already-loaded Topic snapshot and owns the final discovery-context rendering.

**Tech Stack:** React 19, TypeScript, TanStack Query, React Testing Library, Vitest, Playwright, CSS

---

## File Map

- Create `apps/web/src/discovery-display.ts`: one public mapping for `hot -> 热点` and `quality -> 精选`.
- Create `apps/web/src/feed-source-selection.ts`: typed source-selector values and pure conversion to the existing Feed filter.
- Create `apps/web/src/feed-source-selection.test.ts`: isolated tests for source conversion and Topic value construction.
- Modify `apps/web/src/components/DiscoveryCard.tsx`: render the primary value label and secondary discovery context.
- Modify `apps/web/src/components/DiscoveryCard.test.tsx`: verify Topic, trend, fallback, accessibility, and renamed value labels.
- Modify `apps/web/src/App.tsx`: replace two origin controls with one source selector, pass Topic keywords to cards, and reuse the display mapping on the detail page.
- Modify `apps/web/src/App.test.tsx`: verify source options, query mapping, stale Topic recovery, detail labels, and CSS constraints.
- Modify `apps/web/src/styles.css`: weaken and safely truncate discovery context; remove obsolete origin-segment rules.
- Modify `tests/e2e/ai-discovery.spec.ts`: exercise unified source filtering and assert the new labels at four viewport sizes.

### Task 1: Centralize Display Labels and Simplify Card Metadata

**Files:**
- Create: `apps/web/src/discovery-display.ts`
- Modify: `apps/web/src/components/DiscoveryCard.tsx`
- Test: `apps/web/src/components/DiscoveryCard.test.tsx`

- [ ] **Step 1: Replace card expectations with the approved labels and context**

Update the first two tests and add the fallback assertion:

```tsx
it('renders Topic context, selected value, details, and safe links', () => {
  render(<DiscoveryCard item={topicItem} topicKeyword="gpt-5.7" />);

  const context = screen.getByText('来自「gpt-5.7」');
  expect(context).toBeVisible();
  expect(context).toHaveAttribute('title', 'gpt-5.7');
  expect(context).toHaveAttribute('aria-label', '来自「gpt-5.7」');
  expect(screen.getByText('精选')).toBeVisible();
  expect(screen.queryByText(/关键词追踪|优质/)).not.toBeInTheDocument();
  expect(screen.getByText('完整介绍了实现方式。')).toBeVisible();
  expect(screen.getByText(/可复现代码/)).toBeVisible();
  expect(screen.getByText('X')).toBeVisible();
  expect(screen.getByText('社交')).toBeVisible();
  expect(screen.getByText(/@project/)).toBeVisible();
  expect(screen.getByText(/Project Team With A Very Long Display Name/)).toHaveClass('source-author');
  expect(screen.getByRole('link', { name: /查看原文/ })).toHaveAttribute('href', 'https://x.com/project/status/100');
  expect(screen.getByRole('link', { name: /查看原文/ })).toHaveAttribute('rel', expect.stringContaining('noopener'));
  expect(screen.queryByText(/可信|已核实|评分|证据|排名/)).not.toBeInTheDocument();
});

it('labels trend items as coming from broad trends', () => {
  const trendItem: FeedItem = { ...topicItem, id: 'radar-1', origin: 'trend', topicId: null };
  render(<DiscoveryCard item={trendItem} />);

  expect(screen.getByText('来自全网趋势')).toBeVisible();
  expect(screen.queryByText(/关键词追踪|趋势发现/)).not.toBeInTheDocument();
});

it('uses a neutral Topic fallback while the Topic snapshot is unavailable', () => {
  render(<DiscoveryCard item={topicItem} />);

  expect(screen.getByText('来自关注主题')).toBeVisible();
});
```

- [ ] **Step 2: Run the card test and confirm the old UI fails the new assertions**

Run:

```powershell
npm test -- apps/web/src/components/DiscoveryCard.test.tsx
```

Expected: FAIL because the card still renders “关键词追踪 / 趋势发现 / 优质” and has no `topicKeyword` behavior.

- [ ] **Step 3: Add the shared value-label mapping**

Create `apps/web/src/discovery-display.ts`:

```ts
import type { DiscoveryKind } from '@lettermate/contracts';

export const discoveryKindLabels: Record<DiscoveryKind, string> = {
  hot: '热点',
  quality: '精选',
};
```

- [ ] **Step 4: Render the approved card hierarchy**

In `DiscoveryCard.tsx`, import `discoveryKindLabels`, add the prop, and replace the classification/context setup with:

```tsx
import { discoveryKindLabels } from '../discovery-display.js';

export function DiscoveryCard({
  item,
  topicKeyword,
  detailHref,
  headingLevel = 2,
}: {
  item: FeedItem;
  topicKeyword?: string;
  detailHref?: string;
  headingLevel?: 2 | 3;
}) {
  const Heading = `h${headingLevel}` as const;
  const ClassificationIcon = item.kind === 'hot' ? Flame : Sparkles;
  const classification = discoveryKindLabels[item.kind];
  const discoveryContext = item.origin === 'trend'
    ? '来自全网趋势'
    : topicKeyword
      ? `来自「${topicKeyword}」`
      : '来自关注主题';
  const source = sourceTypeMeta[item.sourceType];
  const SourceIcon = source.icon;
  const author = [item.authorName, item.authorHandle ? `@${item.authorHandle}` : null]
    .filter(Boolean)
    .join(' · ');
```

Replace the existing origin span with:

```tsx
<span
  className="origin-label"
  title={item.origin === 'topic' ? topicKeyword : undefined}
  aria-label={discoveryContext}
>
  {discoveryContext}
</span>
```

- [ ] **Step 5: Run the card tests and confirm they pass**

Run:

```powershell
npm test -- apps/web/src/components/DiscoveryCard.test.tsx
```

Expected: 4 tests PASS.

- [ ] **Step 6: Commit the card hierarchy change**

```powershell
git add apps/web/src/discovery-display.ts apps/web/src/components/DiscoveryCard.tsx apps/web/src/components/DiscoveryCard.test.tsx
git commit -m "feat(web): simplify discovery card labels"
```

### Task 2: Model the Unified Source Selector as a Pure Mapping

**Files:**
- Create: `apps/web/src/feed-source-selection.ts`
- Test: `apps/web/src/feed-source-selection.test.ts`

- [ ] **Step 1: Write failing tests for all selector values**

Create `apps/web/src/feed-source-selection.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  feedFilterForSource,
  topicSourceSelection,
} from './feed-source-selection.js';

describe('Feed source selection', () => {
  it('maps all and trend without a stale topicId', () => {
    expect(feedFilterForSource('all')).toEqual({ origin: 'all' });
    expect(feedFilterForSource('trend')).toEqual({ origin: 'trend' });
  });

  it('maps a Topic option to the existing topic filter contract', () => {
    const selection = topicSourceSelection('topic-1');

    expect(selection).toBe('topic:topic-1');
    expect(feedFilterForSource(selection)).toEqual({
      origin: 'topic',
      topicId: 'topic-1',
    });
  });
});
```

- [ ] **Step 2: Run the mapper test and confirm the missing module failure**

Run:

```powershell
npm test -- apps/web/src/feed-source-selection.test.ts
```

Expected: FAIL because `feed-source-selection.ts` does not exist.

- [ ] **Step 3: Implement the typed mapper**

Create `apps/web/src/feed-source-selection.ts`:

```ts
import type { FeedOrigin } from '@lettermate/contracts';

export type FeedSourceSelection = 'all' | 'trend' | `topic:${string}`;

export interface FeedSourceFilter {
  origin: FeedOrigin;
  topicId?: string;
}

export function topicSourceSelection(topicId: string): `topic:${string}` {
  return `topic:${topicId}`;
}

export function feedFilterForSource(selection: FeedSourceSelection): FeedSourceFilter {
  if (selection === 'all') return { origin: 'all' };
  if (selection === 'trend') return { origin: 'trend' };
  return { origin: 'topic', topicId: selection.slice('topic:'.length) };
}
```

- [ ] **Step 4: Run the mapper tests and typecheck the Web workspace**

Run:

```powershell
npm test -- apps/web/src/feed-source-selection.test.ts
npm run typecheck -w @lettermate/web
```

Expected: 2 tests PASS and TypeScript exits 0.

- [ ] **Step 5: Commit the source-selection model**

```powershell
git add apps/web/src/feed-source-selection.ts apps/web/src/feed-source-selection.test.ts
git commit -m "feat(web): model unified feed source selection"
```

### Task 3: Replace Feed Controls and Preserve Query and Refresh Semantics

**Files:**
- Modify: `apps/web/src/App.tsx`
- Test: `apps/web/src/App.test.tsx`

- [ ] **Step 1: Rewrite the origin-filter integration test around one source selector**

Replace the existing origin/topic-filter test with:

```tsx
it('maps one source selector to valid Feed filters without stale topic IDs', async () => {
  installFetchMock({ topics: [topic('topic-1', 'AI Agent')], feed: [feedItem('today', 'topic')] });
  renderApp('/');

  const source = await screen.findByRole('combobox', { name: '来源' });
  expect(within(source).getAllByRole('option').map((option) => option.textContent)).toEqual([
    '全部来源', '全网趋势', 'AI Agent',
  ]);

  fireEvent.change(source, { target: { value: 'topic:topic-1' } });
  await waitFor(() => expect(requests.some(({ url }) => (
    url.includes('/feed?') && url.includes('topicId=topic-1') && url.includes('origin=topic')
  ))).toBe(true));

  fireEvent.change(source, { target: { value: 'trend' } });
  await waitFor(() => expect(requests.some(({ url }) => (
    url.includes('/feed?') && url.includes('origin=trend') && !url.includes('topicId=')
  ))).toBe(true));

  fireEvent.change(source, { target: { value: 'all' } });
  await waitFor(() => expect(requests.some(({ url }) => (
    url.includes('/feed?') && url.includes('origin=all') && !url.includes('topicId=')
  ))).toBe(true));
  expect(requests.every(({ url }) => !(url.includes('origin=trend') && url.includes('topicId=')))).toBe(true);
});
```

- [ ] **Step 2: Update stale-Topic and empty-Topic tests**

Change the stale-Topic test to select `topic:topic-1`, invalidate Topics, and assert the source selector returns to `all`:

```tsx
const source = await screen.findByRole('combobox', { name: '来源' });
fireEvent.change(source, { target: { value: 'topic:topic-1' } });
await waitFor(() => expect(requests.some(({ url }) => url.includes('topicId=topic-1'))).toBe(true));

mock.setTopics([]);
await act(async () => { await client.invalidateQueries({ queryKey: ['topics'] }); });

await waitFor(() => expect(source).toHaveValue('all'));
await waitFor(() => {
  const latestFeedRequest = requests.filter(({ url }) => url.includes('/feed?')).at(-1)?.url;
  expect(latestFeedRequest).not.toContain('topicId=topic-1');
});
```

Replace the obsolete “topic-only refresh with no Topics” test with:

```tsx
it('does not offer Topic source options when there are no Topics', async () => {
  installFetchMock({ topics: [], feed: [] });
  renderApp('/');

  await screen.findByText('暂无发现内容');
  const source = screen.getByRole('combobox', { name: '来源' });
  expect(within(source).getAllByRole('option').map((option) => option.textContent)).toEqual([
    '全部来源', '全网趋势',
  ]);
});
```

- [ ] **Step 3: Add integration coverage for Topic context and detail-page labels**

Extend `FetchMockOptions` with `item?: FeedItem`, destructure it in `installFetchMock`, and add this handler before the `/feed` handler:

```ts
const itemMatch = url.match(/\/items\/([^/?]+)$/);
if (itemMatch) return Response.json(item!);
```

Add these tests:

```tsx
it('passes the exact Topic keyword into Topic cards', async () => {
  installFetchMock({
    topics: [topic('topic-1', 'gpt-5.7')],
    feed: [feedItem('today', 'topic')],
  });
  renderApp('/');

  expect(await screen.findByText('来自「gpt-5.7」')).toBeVisible();
});

it('renders quality items as selected on the detail page', async () => {
  installFetchMock({ item: feedItem('detail', 'topic') });
  renderApp('/items/detail');

  expect(await screen.findByText('精选')).toBeVisible();
  expect(screen.queryByText('优质')).not.toBeInTheDocument();
});
```

- [ ] **Step 4: Run the App tests and confirm the existing controls fail**

Run:

```powershell
npm test -- apps/web/src/App.test.tsx
```

Expected: FAIL because there is no combobox named “来源”, Topic card context is generic, and the detail page still renders “优质”.

- [ ] **Step 5: Store one source selection and derive the existing API filter**

In `App.tsx`, remove the `FeedOrigin` import and add:

```ts
import { discoveryKindLabels } from './discovery-display.js';
import {
  feedFilterForSource,
  topicSourceSelection,
  type FeedSourceSelection,
} from './feed-source-selection.js';
```

Replace the separate origin and Topic state with:

```tsx
const [kind, setKind] = useState<DiscoveryKind | 'all'>('all');
const [range, setRange] = useState<FeedRange>('30d');
const [sourceSelection, setSourceSelection] = useState<FeedSourceSelection>('all');
const { origin, topicId } = feedFilterForSource(sourceSelection);
const filter = {
  range,
  origin,
  ...(topicId ? { topicId } : {}),
  ...(kind === 'all' ? {} : { kind }),
};
```

Delete `changeOrigin`. Replace the stale Topic effect with:

```tsx
useEffect(() => {
  if (topicId && topics.data && !hasSelectedTopic) setSourceSelection('all');
}, [hasSelectedTopic, topicId, topics.data]);
```

- [ ] **Step 6: Replace the Feed controls with one value segment and two selects**

Replace the contents of `.feed-tools` with:

```tsx
<div className="feed-tools">
  <div className="feed-segments">
    <div className="segmented" role="group" aria-label="内容类型">
      {(['all', 'hot', 'quality'] as const).map((value) => (
        <button key={value} aria-pressed={kind === value} onClick={() => setKind(value)}>
          {value === 'all' ? '全部' : discoveryKindLabels[value]}
        </button>
      ))}
    </div>
  </div>
  <div className="feed-selects">
    <label className="filter-control source-filter">
      <span>来源</span>
      <select
        value={sourceSelection}
        onChange={(event) => setSourceSelection(event.target.value as FeedSourceSelection)}
      >
        <option value="all">全部来源</option>
        <option value="trend">全网趋势</option>
        {(topics.data ?? []).map((topic) => (
          <option key={topic.id} value={topicSourceSelection(topic.id)}>{topic.keyword}</option>
        ))}
      </select>
    </label>
    <label className="filter-control time-filter">
      <span>时间范围</span>
      <select value={range} onChange={(event) => setRange(event.target.value as FeedRange)}>
        {timeRangeOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
    </label>
  </div>
</div>
```

- [ ] **Step 7: Pass Topic context to cards and reuse the selected label on details**

Before rendering groups, build the lookup:

```tsx
const topicKeywordById = new Map(
  (topics.data ?? []).map((topic) => [topic.id, topic.keyword]),
);
```

Replace the card map with:

```tsx
{group.items.map((item) => (
  <DiscoveryCard
    key={item.id}
    item={item}
    topicKeyword={item.origin === 'topic' ? topicKeywordById.get(item.topicId) : undefined}
    detailHref={`/items/${item.id}`}
    headingLevel={3}
  />
))}
```

In `ItemPage`, replace the inline ternary with:

```tsx
<span className={`classification classification--${item.data.kind}`}>
  {discoveryKindLabels[item.data.kind]}
</span>
```

- [ ] **Step 8: Run the focused Web tests**

Run:

```powershell
npm test -- apps/web/src/App.test.tsx apps/web/src/components/DiscoveryCard.test.tsx apps/web/src/feed-source-selection.test.ts
```

Expected: all selected test files PASS.

- [ ] **Step 9: Commit the unified Feed controls**

```powershell
git add apps/web/src/App.tsx apps/web/src/App.test.tsx
git commit -m "feat(web): unify feed source filtering"
```

### Task 4: Tighten Responsive Styling and Update the Browser Flow

**Files:**
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/src/App.test.tsx`
- Modify: `tests/e2e/ai-discovery.spec.ts`

- [ ] **Step 1: Add a failing CSS contract assertion for truncated context**

Extend the existing CSS test in `App.test.tsx`:

```ts
expect(css).toMatch(/\.origin-label\s*\{[^}]*max-width:\s*220px;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s);
expect(css).not.toContain('.segmented--origin');
expect(css).not.toContain('.origin-label--trend');
```

- [ ] **Step 2: Run the CSS contract test and confirm it fails**

Run:

```powershell
npm test -- apps/web/src/App.test.tsx -t "defines stable refresh dimensions"
```

Expected: FAIL because the origin-specific selectors still exist and the context has no truncation rules.

- [ ] **Step 3: Update CSS for the reduced hierarchy**

Make these exact selector changes in `styles.css`:

```css
.feed-segments { display: flex; }
.segmented { display: inline-grid; grid-template-columns: repeat(3, 76px); border: 1px solid #cfd6da; border-radius: 6px; overflow: hidden; background: white; }
.feed-selects { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 10px 14px; }
.filter-control { display: grid; grid-template-columns: auto minmax(130px, 190px); gap: 8px; align-items: center; color: var(--muted); font-size: 12px; }
.source-filter { grid-template-columns: auto minmax(150px, 210px); }
.origin-label { min-width: 0; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-weight: 400; }
```

Delete `.segmented--origin`, `.topic-filter`, and `.origin-label--trend`. In the tablet media query, use:

```css
.filter-control, .source-filter { min-width: 0; grid-template-columns: 1fr; gap: 5px; }
```

In the `max-width: 420px` media query, add:

```css
.origin-label { max-width: 100%; }
```

- [ ] **Step 4: Rewrite the E2E source and label assertions**

In `tests/e2e/ai-discovery.spec.ts`, replace old origin-label assertions with:

```ts
await expect(page.locator('.origin-label', { hasText: `来自「${keyword}」` }).first()).toBeVisible();
await expect(page.locator('.origin-label', { hasText: '来自全网趋势' }).first()).toBeVisible();
await expect(page.getByText('精选').first()).toBeVisible();
await expect(page.getByText(/关键词追踪|趋势发现|优质/)).toHaveCount(0);
```

Use the single selector for each filter transition:

```ts
const sourceSelect = page.getByLabel('来源');

await sourceSelect.selectOption(`topic:${topicId}`);
await selectedTopicResponse;
await expect(page.locator('.origin-label', { hasText: `来自「${keyword}」` }).first()).toBeVisible();
await expect(page.locator('.origin-label', { hasText: '来自全网趋势' })).toHaveCount(0);

await sourceSelect.selectOption('trend');
await trendOnlyResponse;
await expect(page.locator('.origin-label', { hasText: '来自全网趋势' }).first()).toBeVisible();
await expect(page.locator('.origin-label', { hasText: `来自「${keyword}」` })).toHaveCount(0);

await sourceSelect.selectOption('all');
await expect(page.locator('.origin-label', { hasText: `来自「${keyword}」` }).first()).toBeVisible();
await expect(page.locator('.origin-label', { hasText: '来自全网趋势' }).first()).toBeVisible();
```

Keep the existing response predicates for `origin=topic + topicId`, `origin=trend` without `topicId`, and `origin=all` without `topicId`. Keep the final horizontal-overflow assertion and the desktop/compact-mobile screenshots.

- [ ] **Step 5: Run unit tests and all four Playwright projects**

Run:

```powershell
npm test -- apps/web/src/App.test.tsx apps/web/src/components/DiscoveryCard.test.tsx apps/web/src/feed-source-selection.test.ts
npm run test:e2e
```

Expected: focused tests PASS and Playwright reports 4 passed.

- [ ] **Step 6: Inspect the generated desktop and compact-mobile Feed screenshots**

Run:

```powershell
Get-ChildItem -LiteralPath test-results -Recurse -File -Filter '*-feed.png' | Select-Object FullName,Length
```

Open both images with the workspace image viewer. Confirm that the value segment remains one row, source/time controls do not overlap, the secondary context is visibly weaker than “热点 / 精选”, long context truncates cleanly, and the 320px page has no horizontal overflow.

- [ ] **Step 7: Commit responsive and E2E coverage**

```powershell
git add apps/web/src/styles.css apps/web/src/App.test.tsx tests/e2e/ai-discovery.spec.ts
git commit -m "test(web): cover simplified feed hierarchy"
```

### Task 5: Full Verification and Documentation Consistency

**Files:**
- Verify: `docs/superpowers/specs/2026-07-30-feed-label-hierarchy-design.md`
- Verify: `docs/superpowers/plans/2026-07-30-feed-label-hierarchy.md`

- [ ] **Step 1: Confirm retired visible labels are absent from implementation**

Run:

```powershell
Get-ChildItem -LiteralPath apps\web\src,tests\e2e -Recurse -File -Include *.ts,*.tsx | Select-String -Pattern '关键词追踪|趋势发现|优质'
```

Expected: no matches outside negative test assertions that explicitly verify the retired words are absent.

- [ ] **Step 2: Run the complete repository verification suite**

Run each command and stop on the first failure:

```powershell
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
```

Expected: lint, typecheck, tests, build, and 4 Playwright projects all exit 0. Credential-gated live tests may remain skipped unless their explicit run flags are enabled.

- [ ] **Step 3: Check the final diff and worktree state**

Run:

```powershell
git diff --check
git status --short
git log --oneline -5
```

Expected: `git diff --check` emits no errors, `git status --short` is empty, and the implementation commits are visible in the log.
