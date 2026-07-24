# LetterMate Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the phase-one trusted-event discovery loop from keyword monitoring through evidence-backed event status and in-app notification in a responsive web workspace.

**Architecture:** Use npm workspaces for a React/Vite web app, NestJS API and worker, plus framework-free contracts and domain packages. PostgreSQL and Redis remain the production persistence and queue targets; the first executable increment keeps domain logic pure and exposes repository ports so tests can run deterministically without external credentials.

**Tech Stack:** TypeScript, npm workspaces, React, Vite, NestJS, Prisma, PostgreSQL, Redis, BullMQ, Zod, Vitest, Testing Library, Supertest, Playwright, Docker Compose.

**Execution result (2026-07-24):** The runnable local vertical slice is implemented: shared contracts and domain rules, an isolated NestJS API adapter, Prisma schema, RSS/HTML parsing and worker safety rules, responsive Web workspace, Service Worker and Push subscription flow, plus desktop/tablet/mobile acceptance tests.

**Production integrations remaining:** Replace the deterministic in-memory API repository with Prisma migrations and repositories; run BullMQ scheduling and the transactional Outbox dispatcher; add production password/session, Origin/CSRF and OpenAPI wiring; configure encrypted Push storage and live VAPID delivery; add DNS-resolution checks and approved-source schedules for external collectors.

---

## File Map

- `package.json`, `tsconfig.base.json`, `vitest.workspace.ts`: workspace scripts and shared compiler/test configuration.
- `packages/contracts/src/index.ts`: runtime-validated API schemas and shared public types.
- `packages/domain/src/*`: pure matching, trust, notification, URL, event, and source-policy rules.
- `packages/config/src/index.ts`: environment validation shared by API and worker.
- `apps/api/src/*`: NestJS HTTP modules, authentication context, repositories, and health/API resources.
- `apps/worker/src/*`: collector ports and deterministic processing pipeline.
- `apps/web/src/*`: responsive authenticated workspace and API client boundary.
- `prisma/schema.prisma`: authoritative relational model and user-isolation constraints.
- `infra/compose.yaml`: local PostgreSQL and Redis services.
- `tests/e2e/*`: browser acceptance tests for the phase-one workflow.

### Task 1: Workspace and shared contracts

**Files:** Create root workspace files, `packages/contracts`, `packages/config`, and their tests.

- [ ] **Step 1: Write failing schema tests**

```ts
it('rejects a monitor rule without a keyword', () => {
  expect(() => monitorRuleInputSchema.parse({ name: 'AI', keywords: [] })).toThrow();
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- --run packages/contracts`
Expected: FAIL because the workspace and schemas do not exist.

- [ ] **Step 3: Add workspace configuration and Zod schemas**

Define `monitorRuleInputSchema`, `eventSchema`, `eventEvidenceSchema`, `notificationSchema`, `sourceSchema`, and the shared API error shape. Validate environment values with `configSchema` and prohibit silent production defaults for secrets.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- --run packages/contracts packages/config`
Expected: all contract and configuration tests pass.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.base.json vitest.workspace.ts packages
git commit -m "chore: establish LetterMate workspace contracts"
```

### Task 2: Domain rules and evidence state machine

**Files:** Create `packages/domain/src` modules and tests.

- [ ] **Step 1: Write failing behavior tests**

```ts
it('confirms two independent secondary sources', () => {
  expect(calculateTrustStatus([
    evidence('secondary', 'group-a'),
    evidence('secondary', 'group-b'),
  ])).toBe('confirmed');
});

it('keeps syndicated evidence pending', () => {
  expect(calculateTrustStatus([
    evidence('secondary', 'wire-a'),
    evidence('secondary', 'wire-a'),
  ])).toBe('pending');
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- --run packages/domain`
Expected: FAIL because domain functions are missing.

- [ ] **Step 3: Implement minimal pure rules**

Add URL canonicalization, keyword/synonym/exclusion matching, source-scope matching, independent evidence counting, three-state trust calculation, transition validation, notification eligibility and stable deduplication keys. Keep AI suggestions outside status calculation.

- [ ] **Step 4: Verify GREEN and refactor**

Run: `npm test -- --run packages/domain`
Expected: all domain tests pass with no warnings.

- [ ] **Step 5: Commit**

```bash
git add packages/domain
git commit -m "feat: implement trusted event domain rules"
```

### Task 3: Persistence model and API vertical slice

**Files:** Create `prisma/schema.prisma`, `apps/api`, API tests, and `infra/compose.yaml`.

- [ ] **Step 1: Write failing API tests**

```ts
it('does not expose another user rule', async () => {
  await request(app).get(`/api/v1/monitor-rules/${otherRule.id}`)
    .set(authHeader(userA)).expect(404);
});

it('creates a high priority rule with notification enabled', async () => {
  const response = await request(app).post('/api/v1/monitor-rules')
    .set(authHeader(userA)).send(validRule).expect(201);
  expect(response.body.priority).toBe('high');
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- --run apps/api`
Expected: FAIL because the API application is absent.

- [ ] **Step 3: Implement the API**

Create versioned endpoints for session, monitor rules, events/evidence, notifications, sources, profile, and Push subscriptions. Use an authenticated user context in repository calls; never accept a client-selected `userId`. Add uniform errors with `traceId`, Origin/CSRF checks for mutations, and OpenAPI generation.

- [ ] **Step 4: Add Prisma constraints**

Model users, sessions, rules, sources, collector runs, candidate content, events, evidence, status history, rule matches, notifications, Push subscriptions, and Outbox messages. Add user-scoped indexes and unique deduplication constraints.

- [ ] **Step 5: Verify GREEN**

Run: `npm test -- --run apps/api`
Expected: API unit and Supertest tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api prisma infra
git commit -m "feat: add isolated phase one API"
```

### Task 4: Collector worker and processing pipeline

**Files:** Create `apps/worker`, fixture sources, and worker tests.

- [ ] **Step 1: Write failing pipeline tests**

```ts
it('continues trust evaluation when AI is unavailable', async () => {
  const event = await pipeline.process(primarySourceItem, failingAiProvider);
  expect(event.status).toBe('confirmed');
  expect(event.summaryStatus).toBe('unavailable');
});

it('rejects redirects to private network addresses', async () => {
  await expect(fetcher.fetch(publicUrlRedirectingToPrivateIp)).rejects.toMatchObject({
    code: 'SOURCE_ADDRESS_BLOCKED',
  });
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- --run apps/worker`
Expected: FAIL because collector ports and pipeline are absent.

- [ ] **Step 3: Implement collectors and pipeline**

Add RSS and allowed-HTML collector ports, compliance gates, URL/address validation, response limits, timeout, redirect revalidation, error categories, retry decisions, content normalization, fingerprinting, rule matching, event upsert, status history, and notification Outbox creation.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- --run apps/worker`
Expected: worker tests pass, including independent-source failure isolation and AI fallback.

- [ ] **Step 5: Commit**

```bash
git add apps/worker
git commit -m "feat: process compliant sources into trusted events"
```

### Task 5: Responsive web workspace

**Files:** Create `apps/web`, component tests, service worker, and styles.

- [ ] **Step 1: Write failing UI tests**

```tsx
it('shows evidence text as well as trust color', async () => {
  render(<EventCard event={confirmedEvent} />);
  expect(screen.getByText('已确认')).toBeVisible();
  expect(screen.getByRole('link', { name: /查看证据/ })).toBeVisible();
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- --run apps/web`
Expected: FAIL because the web application is absent.

- [ ] **Step 3: Implement application routes and states**

Build login, event feed, monitor rules, event detail, notifications, source status, and settings routes. Add loading, empty, failure and retry states; accessible forms; desktop sidebar; mobile top/bottom navigation; Push capability fallback; and evidence-safe external links.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- --run apps/web`
Expected: component and route tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat: build responsive trusted event workspace"
```

### Task 6: End-to-end acceptance and operational documentation

**Files:** Create `playwright.config.ts`, `tests/e2e`, `.env.example`, and `README.md`.

- [ ] **Step 1: Add failing acceptance scenario**

```ts
test('user creates a rule and reads confirmed evidence', async ({ page }) => {
  await page.goto('/monitor-rules');
  await page.getByRole('button', { name: '新建监控' }).click();
  await page.getByLabel('关键词').fill('AI Agent');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('AI Agent')).toBeVisible();
});
```

- [ ] **Step 2: Verify RED**

Run: `npm run test:e2e`
Expected: FAIL until the seeded acceptance environment and routes are wired.

- [ ] **Step 3: Add deterministic acceptance environment**

Seed two users, allowed/blocked sources, pending/confirmed/rejected events, evidence and notifications. Document local setup, secrets, migrations, test commands, compliance limits, and which external features use adapters rather than real credentials.

- [ ] **Step 4: Run complete verification**

Run: `npm run lint && npm run typecheck && npm test -- --run && npm run build && npm run test:e2e`
Expected: every command exits 0, with acceptance runs at desktop, tablet and mobile viewports.

- [ ] **Step 5: Review requirements and commit**

Check each phase-one acceptance scenario against a test or documented adapter boundary, then run:

```bash
git add .
git commit -m "test: verify LetterMate phase one workflow"
```
