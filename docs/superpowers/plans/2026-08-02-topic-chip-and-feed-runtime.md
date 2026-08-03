# Topic Chip Editing and Feed Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make expanded terms editable and removable inside compact chips, and restore the homepage with aligned feature-worktree services.

**Architecture:** `TopicRow` retains its local draft and renders each term as an inline input plus trailing remove button. Save remains the persistence boundary. The strict Feed contract remains unchanged; runtime verification launches the feature-worktree API on an isolated port and points Vite at it.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, NestJS, Zod, Vite, Playwright

---

### Task 1: Compact Editable Chips

**Files:**
- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/App.tsx:388-435`
- Modify: `apps/web/src/styles.css:122-128`

- [ ] **Step 1: Write failing tests**

Add a test that opens Topic editing, changes the first expanded term, removes the second through `鍒犻櫎 <term>`, adds a focused empty chip, and saves. Assert the PATCH body equals:

```ts
{ keyword: 'AI Agent', expandedTerms: ['agent framework'] }
```

Add a test that edits/removes terms, cancels, reopens, and sees the persisted terms restored.

- [ ] **Step 2: Verify RED**

```powershell
npx vitest run apps/web/src/App.test.tsx -t "edits expanded terms as removable chips|discards expanded term chip drafts"
```

Expected: FAIL because the current editor uses full-width rows and does not focus a new chip.

- [ ] **Step 3: Implement minimal behavior**

Render a wrapping `.variant-editor__chips` row. Each `.variant-chip` contains the existing controlled input and a trailing `X` button whose accessible name is `鍒犻櫎 <term>`. Focus a newly appended empty input. Keep the existing save normalization and reset drafts from `topic` when opening edit mode.

Style chips as inline grids with a content-sized input, fixed remove area, 4px radius, neutral border/background, stable remove target, and visible `:focus-within`.

- [ ] **Step 4: Verify GREEN and the full file**

```powershell
npx vitest run apps/web/src/App.test.tsx -t "edits expanded terms as removable chips|discards expanded term chip drafts"
npx vitest run apps/web/src/App.test.tsx
```

Expected: all selected and full-file tests PASS without warnings.

- [ ] **Step 5: Commit**

```powershell
git add apps/web/src/App.test.tsx apps/web/src/App.tsx apps/web/src/styles.css
git commit -m "fix(web): edit expanded terms as removable chips"
```

### Task 2: Feed Contract Regression Coverage

**Files:**
- Modify: `apps/api/src/topic-store.test.ts`
- Modify: `apps/api/src/app.test.ts`

- [ ] **Step 1: Strengthen assertions**

Extend the Prisma list test with:

```ts
expect(items[0]).toMatchObject({
  origin: 'topic',
  topicKeyword: 'Project',
  topicKeywordActive: true,
});
```

Extend HTTP tests so active, renamed, and deleted Topic snapshots retain `topicKeyword` and expose the correct boolean `topicKeywordActive`. Trend items remain unchanged.

- [ ] **Step 2: Run tests**

```powershell
npx vitest run apps/api/src/topic-store.test.ts apps/api/src/app.test.ts
```

Expected: PASS, proving this source revision already satisfies the strict contract.

- [ ] **Step 3: Commit**

```powershell
git add apps/api/src/topic-store.test.ts apps/api/src/app.test.ts
git commit -m "test(api): lock topic keyword feed fields"
```

### Task 3: Align Runtime and Verify Homepage

**Files:**
- No repository files modified

- [ ] **Step 1: Record mismatch**

Query `http://localhost:3000/api/v1/feed?range=30d`. Expected before alignment: main-worktree Topic items omit the two keyword fields.

- [ ] **Step 2: Launch aligned services**

From `D:\LetterMate\.worktrees\topic-keyword-management`, start API with `PORT=3001`. Start Vite on a free loopback port with `VITE_API_PROXY=http://localhost:3001`. Set `WEB_ORIGIN` consistently.

- [ ] **Step 3: Verify the raw boundary**

Query port `3001`. Assert every Topic item has non-empty `topicKeyword` and boolean `topicKeywordActive`; Trend items have neither.

- [ ] **Step 4: Verify in Playwright**

Open the aligned Vite URL. Assert `鏃犳硶鍔犺浇鏁版嵁` is absent and a discovery card or legitimate empty state appears. Capture desktop and mobile screenshots; inspect chip wrapping, controls, and overlap.

### Task 4: Full Verification

**Files:**
- No repository files modified unless a check identifies an issue in changed files

- [ ] **Step 1: Run checks**

```powershell
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
```

Expected: every command exits 0 without lint warnings, type errors, test failures, or build failures.

- [ ] **Step 2: Inspect final state**

```powershell
git diff --check
git status --short
git log -4 --oneline
```

Expected: no whitespace errors, clean worktree, and separate UI/test commits.
