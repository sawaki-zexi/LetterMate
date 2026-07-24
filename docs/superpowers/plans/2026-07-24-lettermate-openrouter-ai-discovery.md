# OpenRouter AI Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the trusted-event prototype with a real OpenRouter-powered workflow that expands one keyword, searches the web, classifies hot or high-quality new content, writes Chinese summaries, and displays citation-backed source links.

**Architecture:** The API owns authenticated topic CRUD, Prisma persistence, and BullMQ job production. A separate Worker consumes refresh jobs, orchestrates a provider-neutral `AiGateway`, and persists only citation-validated discoveries; the only production gateway is `OpenRouterAiGateway`. React consumes `/api/v1/topics`, `/feed`, and `/items/:id`; unit/API/E2E tests inject fake repositories, queues, and gateways, while an opt-in live test uses the user's local OpenRouter Key.

**Tech Stack:** TypeScript, Zod, NestJS, Prisma/PostgreSQL, BullMQ/Redis, React, TanStack Query, Vitest, Supertest, Playwright, OpenRouter Chat Completions Web Search plugin.

---

## Target File Structure

```text
packages/contracts/src/index.ts                 Public schemas and DTO types
packages/config/src/index.ts                    Server/OpenRouter configuration
packages/domain/src/discovery.ts                Pure keyword/URL/result validation
packages/domain/src/url.ts                      URL canonicalization retained
prisma/schema.prisma                            User, Topic, DiscoveryItem data model
prisma/migrations/.../migration.sql             Destructive replacement of old prototype tables
apps/api/src/topic-store.ts                     API repository interface, Prisma and memory adapters
apps/api/src/topic-queue.ts                     Queue interface and BullMQ producer
apps/api/src/app.ts                             Topic/feed/item controllers and dependency wiring
apps/api/src/e2e-main.ts                        Deterministic fake discovery server for Playwright only
apps/worker/src/ai-gateway.ts                    Provider-neutral AI capability contract and errors
apps/worker/src/openrouter-gateway.ts            OpenRouter HTTP, JSON, citation and retry adapter
apps/worker/src/discovery-service.ts             Discovery orchestration and Prisma persistence
apps/worker/src/worker.ts                        BullMQ consumer and retry-state coordination
apps/worker/src/main.ts                          Production worker bootstrap
apps/web/src/api.ts                              Validated API client and typed API errors
apps/web/src/components/DiscoveryCard.tsx        Citation-backed feed row
apps/web/src/App.tsx                             Topic creation, polling, feed and item detail
apps/web/src/styles.css                          Responsive discovery workspace styling
tests/e2e/ai-discovery.spec.ts                   Desktop/tablet/mobile acceptance workflow
```

Delete the obsolete `packages/domain/src/trust.ts`, `matching.ts`, `notifications.ts`, `apps/worker/src/pipeline.ts`, `apps/worker/src/collectors.ts`, their tests, `EventCard.tsx`, its test, and the old Playwright phase-one spec. OpenRouter Web Search replaces the old source collectors in this scope.

### Task 1: Replace Public Contracts and Old Domain Rules

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/index.test.ts`
- Create: `packages/domain/src/discovery.ts`
- Create: `packages/domain/src/discovery.test.ts`
- Modify: `packages/domain/src/index.ts`
- Modify: `packages/domain/src/index.test.ts`
- Delete: `packages/domain/src/trust.ts`
- Delete: `packages/domain/src/matching.ts`
- Delete: `packages/domain/src/notifications.ts`

- [ ] **Step 1: Write failing contract tests for one-keyword topics and citation-backed discoveries**

```ts
import { describe, expect, it } from 'vitest';
import { discoveryResultSchema, topicInputSchema } from './index.js';

describe('AI discovery contracts', () => {
  it('accepts exactly one trimmed keyword', () => {
    expect(topicInputSchema.parse({ keyword: '  AI Agent  ' })).toEqual({ keyword: 'AI Agent' });
    expect(() => topicInputSchema.parse({ keyword: '' })).toThrow();
    expect(() => topicInputSchema.parse({ keyword: 'x'.repeat(101) })).toThrow();
  });

  it('requires hot or quality items with Chinese copy and source URLs', () => {
    expect(discoveryResultSchema.parse({
      citations: ['https://example.com/release'],
      items: [{
        kind: 'quality', title: 'Agent release', summary: '这是中文摘要。',
        reason: '内容提供了完整实现细节。', sourceUrls: ['https://example.com/release'],
        publishedAt: '2026-07-24T06:30:00.000Z',
      }],
    }).items[0]?.kind).toBe('quality');
  });
});
```

- [ ] **Step 2: Run the contract test and verify the old exports make it fail**

Run: `npx vitest run packages/contracts/src/index.test.ts`

Expected: FAIL because `topicInputSchema` and `discoveryResultSchema` are not exported.

- [ ] **Step 3: Replace the contract surface with exact topic and discovery schemas**

```ts
export const discoveryKindSchema = z.enum(['hot', 'quality']);
export const runStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed']);
export const topicInputSchema = z.object({ keyword: z.string().trim().min(1).max(100) });
export const safeErrorSchema = z.object({ code: z.string().min(1), message: z.string().min(1) });
export const topicSchema = z.object({
  id: z.string().min(1), userId: z.string().min(1), keyword: z.string().min(1).max(100),
  expandedTerms: z.array(z.string().min(1)), createdAt: z.iso.datetime(),
  lastRunAt: z.iso.datetime().nullable(), runStatus: runStatusSchema,
  lastError: safeErrorSchema.nullable(),
});
export const discoveryCandidateSchema = z.object({
  kind: discoveryKindSchema, title: z.string().trim().min(1).max(300),
  summary: z.string().trim().min(1).max(1000), reason: z.string().trim().min(1).max(500),
  sourceUrls: z.array(z.url()).min(1).max(8), publishedAt: z.iso.datetime().nullable(),
});
export const discoveryResultSchema = z.object({
  items: z.array(discoveryCandidateSchema).max(30), citations: z.array(z.url()).max(100),
});
export const discoveryJobDataSchema = z.object({ topicId: z.string().min(1), userId: z.string().min(1) });
export const discoveryItemSchema = discoveryCandidateSchema.extend({
  id: z.string().min(1), topicId: z.string().min(1), discoveredAt: z.iso.datetime(),
});
export type TopicInput = z.infer<typeof topicInputSchema>;
export type Topic = z.infer<typeof topicSchema>;
export type DiscoveryCandidate = z.infer<typeof discoveryCandidateSchema>;
export type DiscoveryResult = z.infer<typeof discoveryResultSchema>;
export type DiscoveryItem = z.infer<typeof discoveryItemSchema>;
export type DiscoveryKind = z.infer<typeof discoveryKindSchema>;
export type DiscoveryJobData = z.infer<typeof discoveryJobDataSchema>;
export type SafeError = z.infer<typeof safeErrorSchema>;
```

Keep `apiErrorSchema`; remove all monitor rule, trust, evidence, notification, source, and priority schemas and types.

- [ ] **Step 4: Write failing pure-domain tests for normalization and citation enforcement**

```ts
import { describe, expect, it } from 'vitest';
import { normalizeKeyword, validateDiscoveryResult } from './discovery.js';

it('normalizes equivalent keywords for uniqueness', () => {
  expect(normalizeKeyword('  ＡＩ Agent ')).toBe('ai agent');
});

it('keeps only candidates whose every URL is a citation', () => {
  const output = validateDiscoveryResult({
    citations: ['https://example.com/post?utm_source=x'],
    items: [
      { kind: 'hot', title: 'Valid', summary: '中文摘要', reason: '近期讨论集中', sourceUrls: ['https://example.com/post'], publishedAt: null },
      { kind: 'quality', title: 'Invalid', summary: '中文摘要', reason: '内容深入', sourceUrls: ['https://invented.test/post'], publishedAt: null },
    ],
  });
  expect(output).toHaveLength(1);
  expect(output[0]?.title).toBe('Valid');
});

it('rejects a non-empty model result when every item lacks citations', () => {
  expect(() => validateDiscoveryResult({
    citations: [],
    items: [{ kind: 'hot', title: 'No source', summary: '中文', reason: '热门', sourceUrls: ['https://invented.test'], publishedAt: null }],
  })).toThrow('搜索结果缺少可验证的原始链接');
});
```

- [ ] **Step 5: Implement keyword and discovery validation, then remove old domain files**

```ts
export class DiscoveryValidationError extends Error {
  constructor(public readonly code: 'AI_CITATIONS_MISSING', message: string) {
    super(message);
    this.name = 'DiscoveryValidationError';
  }
}

export const normalizeKeyword = (value: string) =>
  value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();

export function validateDiscoveryResult(result: DiscoveryResult): DiscoveryCandidate[] {
  const citations = new Set(result.citations.map(canonicalizeUrl));
  const valid = result.items.filter((item) =>
    item.sourceUrls.every((url) => {
      try { return ['http:', 'https:'].includes(new URL(url).protocol) && citations.has(canonicalizeUrl(url)); }
      catch { return false; }
    }),
  );
  if (result.items.length > 0 && valid.length === 0) {
    throw new DiscoveryValidationError('AI_CITATIONS_MISSING', '搜索结果缺少可验证的原始链接');
  }
  return valid;
}
```

Export only `discovery.js` and `url.js` from `packages/domain/src/index.ts`. Replace `index.test.ts` with URL canonicalization coverage and remove imports of old trust/matching/notification functions.

- [ ] **Step 6: Run focused domain tests and commit**

Run: `npx vitest run packages/contracts/src/index.test.ts packages/domain/src/discovery.test.ts packages/domain/src/index.test.ts`

Expected: PASS with no references to `TrustStatus`, `MonitorRule`, or notification rules.

```powershell
git add packages/contracts packages/domain
git commit -m "refactor: replace trusted events with discovery contracts"
```

### Task 2: Add OpenRouter Server Configuration

**Files:**
- Modify: `packages/config/src/index.ts`
- Modify: `packages/config/src/index.test.ts`
- Modify: `.env.example`

- [ ] **Step 1: Add failing tests for Key-only defaults and model overrides**

```ts
it('defaults to OpenRouter auto routing and web search', () => {
  expect(parseConfig({ NODE_ENV: 'development', AI_API_KEY: 'secret' })).toMatchObject({
    AI_API_KEY: 'secret', AI_MODEL: 'openrouter/auto', AI_WEB_SEARCH: true, AI_TIMEOUT_MS: 60_000,
  });
});

it('allows selecting another OpenRouter model without code changes', () => {
  expect(parseConfig({ AI_API_KEY: 'secret', AI_MODEL: 'openai/gpt-4.1-mini' }).AI_MODEL)
    .toBe('openai/gpt-4.1-mini');
});
```

- [ ] **Step 2: Run the config test and verify it fails**

Run: `npx vitest run packages/config/src/index.test.ts`

Expected: FAIL because AI fields are missing from `AppConfig`.

- [ ] **Step 3: Extend configuration without requiring a Key for read-only startup**

```ts
AI_API_KEY: z.string().trim().min(1).optional(),
AI_MODEL: z.string().trim().min(1).default('openrouter/auto'),
AI_WEB_SEARCH: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
AI_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(180_000).default(60_000),
RUN_LIVE_AI_TESTS: z.enum(['0', '1']).default('0').transform((value) => value === '1'),
```

Append the following to `.env.example` and remove VAPID settings because Push is out of scope:

```env
AI_API_KEY=
AI_MODEL=openrouter/auto
AI_WEB_SEARCH=true
AI_TIMEOUT_MS=60000
RUN_LIVE_AI_TESTS=0
```

- [ ] **Step 4: Run config tests and commit**

Run: `npx vitest run packages/config/src/index.test.ts`

Expected: PASS, including existing production secret validation.

```powershell
git add packages/config .env.example
git commit -m "feat: add OpenRouter server configuration"
```

### Task 3: Replace the Prisma Trusted-Event Schema

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260724_replace_trusted_events_with_ai_discovery/migration.sql`
- Modify: `package.json`

- [ ] **Step 1: Replace the Prisma model with explicit topic ownership and discovery uniqueness**

```prisma
enum DiscoveryKind { hot quality }
enum RunStatus { queued running succeeded failed }

model User {
  id           String   @id @default(uuid())
  email        String   @unique
  passwordHash String
  timezone     String   @default("UTC")
  createdAt    DateTime @default(now())
  sessions     Session[]
  topics       Topic[]
}

model Topic {
  id                String          @id @default(uuid())
  userId            String
  keyword           String
  normalizedKeyword String
  expandedTerms     String[]        @default([])
  createdAt         DateTime        @default(now())
  lastRunAt         DateTime?
  runStatus         RunStatus       @default(queued)
  lastError         Json?
  user              User            @relation(fields: [userId], references: [id], onDelete: Cascade)
  items             DiscoveryItem[]
  @@unique([userId, normalizedKeyword])
  @@index([userId, createdAt])
}

model DiscoveryItem {
  id                  String        @id @default(uuid())
  topicId             String
  kind                DiscoveryKind
  title               String
  summary             String
  reason              String
  sourceUrls          String[]
  canonicalPrimaryUrl String
  publishedAt         DateTime?
  discoveredAt        DateTime      @default(now())
  updatedAt           DateTime      @updatedAt
  topic               Topic         @relation(fields: [topicId], references: [id], onDelete: Cascade)
  @@unique([topicId, canonicalPrimaryUrl])
  @@index([topicId, publishedAt, discoveredAt])
}
```

Retain `Session`; delete all trust/source/content/event/rule/notification/push/outbox enums and models. Because this repository has no prior migration history, make this file the complete baseline generated from an empty database:

```sql
CREATE TYPE "DiscoveryKind" AS ENUM ('hot', 'quality');
CREATE TYPE "RunStatus" AS ENUM ('queued', 'running', 'succeeded', 'failed');
CREATE TABLE "User" (
  "id" TEXT NOT NULL, "email" TEXT NOT NULL, "passwordHash" TEXT NOT NULL,
  "timezone" TEXT NOT NULL DEFAULT 'UTC', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Session" (
  "id" TEXT NOT NULL, "tokenHash" TEXT NOT NULL, "userId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL, "revokedAt" TIMESTAMP(3),
  CONSTRAINT "Session_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "Topic" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "keyword" TEXT NOT NULL,
  "normalizedKeyword" TEXT NOT NULL, "expandedTerms" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "lastRunAt" TIMESTAMP(3),
  "runStatus" "RunStatus" NOT NULL DEFAULT 'queued', "lastError" JSONB,
  CONSTRAINT "Topic_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Topic_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "DiscoveryItem" (
  "id" TEXT NOT NULL, "topicId" TEXT NOT NULL, "kind" "DiscoveryKind" NOT NULL,
  "title" TEXT NOT NULL, "summary" TEXT NOT NULL, "reason" TEXT NOT NULL,
  "sourceUrls" TEXT[], "canonicalPrimaryUrl" TEXT NOT NULL, "publishedAt" TIMESTAMP(3),
  "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DiscoveryItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DiscoveryItem_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");
CREATE INDEX "Session_userId_expiresAt_idx" ON "Session"("userId", "expiresAt");
CREATE UNIQUE INDEX "Topic_userId_normalizedKeyword_key" ON "Topic"("userId", "normalizedKeyword");
CREATE INDEX "Topic_userId_createdAt_idx" ON "Topic"("userId", "createdAt");
CREATE UNIQUE INDEX "DiscoveryItem_topicId_canonicalPrimaryUrl_key" ON "DiscoveryItem"("topicId", "canonicalPrimaryUrl");
CREATE INDEX "DiscoveryItem_topicId_publishedAt_discoveredAt_idx" ON "DiscoveryItem"("topicId", "publishedAt", "discoveredAt");
```

For an existing local database created from the old unversioned prototype schema, first print and verify that `DATABASE_URL` points to the Compose database `localhost:5432/lettermate`, then run `npx prisma migrate reset --force` once. This removes only that disposable local prototype schema and reapplies the new baseline. Never reset a database whose exact host/database name has not been verified.

- [ ] **Step 2: Validate the schema and verify client generation**

Run: `npx prisma format && npx prisma validate && npx prisma generate`

Expected: all three commands exit 0 and generated client exposes `topic` and `discoveryItem` delegates.

- [ ] **Step 3: Add database lifecycle scripts and commit**

```json
"db:generate": "prisma generate",
"db:migrate": "prisma migrate dev",
"db:deploy": "prisma migrate deploy"
```

Run: `npm run typecheck`

Expected: FAIL only where old application code still imports removed contracts; record this expected transition and do not claim the whole build is green until Tasks 6-8.

```powershell
git add prisma package.json package-lock.json
git commit -m "refactor: replace trusted event database model"
```

### Task 4: Implement the OpenRouter Gateway with TDD

**Files:**
- Create: `apps/worker/src/ai-gateway.ts`
- Create: `apps/worker/src/openrouter-gateway.ts`
- Create: `apps/worker/src/openrouter-gateway.test.ts`
- Modify: `apps/worker/package.json`
- Modify: `apps/worker/tsconfig.json`

- [ ] **Step 1: Write mocked HTTP tests for expansion, web plugin, citations, correction retry and errors**

```ts
const openRouterResponse = (content: string, annotations: unknown[] = []) =>
  new Response(JSON.stringify({ choices: [{ message: { content, annotations } }] }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });

const makeGateway = (fetcher: typeof fetch) => new OpenRouterAiGateway(
  { apiKey: 'secret', model: 'openrouter/auto', webSearch: true, timeoutMs: 60_000 },
  fetcher,
);

it('sends OpenRouter web search and normalizes url citations', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: {
    content: JSON.stringify({ items: [{ kind: 'hot', title: 'Release', summary: '中文摘要', reason: '讨论增加', sourceUrls: ['https://example.com/release'], publishedAt: null }] }),
    annotations: [{ type: 'url_citation', url_citation: { url: 'https://example.com/release', title: 'Release' } }],
  } }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
  const gateway = new OpenRouterAiGateway({ apiKey: 'secret', model: 'openrouter/auto', webSearch: true, timeoutMs: 60_000 }, fetcher);
  const result = await gateway.discover({ keyword: 'AI Agent', expandedTerms: ['智能体'], lookbackDays: 7, now: '2026-07-24T08:00:00.000Z' });
  expect(result.citations).toEqual(['https://example.com/release']);
  expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toMatchObject({ model: 'openrouter/auto', plugins: [{ id: 'web' }] });
});

it('retries invalid JSON exactly once with a correction instruction', async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(openRouterResponse('not-json'))
    .mockResolvedValueOnce(openRouterResponse(JSON.stringify({ terms: ['AI agent'], searchQueries: ['AI agent latest'] })));
  await expect(makeGateway(fetcher).expandTopic({ keyword: 'AI Agent' })).resolves.toMatchObject({ terms: ['AI agent'] });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it.each([[429, 'AI_RATE_LIMITED', true], [401, 'AI_AUTH_FAILED', false], [404, 'AI_MODEL_UNAVAILABLE', false], [500, 'AI_UPSTREAM_UNAVAILABLE', true]])(
  'maps HTTP %i to %s', async (status, code, retryable) => {
    const gateway = makeGateway(vi.fn().mockResolvedValue(new Response('{}', { status })));
    await expect(gateway.expandTopic({ keyword: 'AI' })).rejects.toMatchObject({ code, retryable });
  },
);
```

- [ ] **Step 2: Run the gateway test and verify it fails**

Run: `npx vitest run apps/worker/src/openrouter-gateway.test.ts`

Expected: FAIL because the gateway files do not exist.

- [ ] **Step 3: Define the gateway capability and normalized error**

```ts
export interface AiGateway {
  expandTopic(input: { keyword: string }): Promise<{ terms: string[]; searchQueries: string[] }>;
  discover(input: { keyword: string; expandedTerms: string[]; lookbackDays: number; now: string }): Promise<DiscoveryResult>;
}

export class AiGatewayError extends Error {
  constructor(
    public readonly code: 'AI_RATE_LIMITED' | 'AI_AUTH_FAILED' | 'AI_MODEL_UNAVAILABLE' | 'AI_UPSTREAM_UNAVAILABLE' | 'AI_RESPONSE_INVALID',
    message: string,
    public readonly retryable: boolean,
    public readonly retryAfterMs?: number,
  ) { super(message); this.name = 'AiGatewayError'; }
}
```

- [ ] **Step 4: Implement OpenRouter request and structured response parsing**

```ts
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

private async complete(messages: Message[], useWeb: boolean): Promise<OpenRouterMessage> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
  try {
    const response = await this.fetcher(OPENROUTER_URL, {
      method: 'POST', signal: controller.signal,
      headers: { authorization: `Bearer ${this.config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.config.model, messages, temperature: 0.1,
        ...(useWeb && this.config.webSearch ? { plugins: [{ id: 'web' }] } : {}),
      }),
    });
    if (!response.ok) throw mapOpenRouterError(response.status, response.headers.get('retry-after'));
    return openRouterResponseSchema.parse(await response.json()).choices[0]!.message;
  } catch (error) {
    if (error instanceof AiGatewayError) throw error;
    throw new AiGatewayError('AI_UPSTREAM_UNAVAILABLE', 'OpenRouter 暂时不可用', true);
  } finally { clearTimeout(timeout); }
}
```

Implement `parseJsonWithOneCorrection` so the first schema/JSON failure sends one additional user message saying the previous response was invalid and must return only the required JSON. Extract citations only from `message.annotations` where `type === 'url_citation'` and `url_citation.url` is valid. Prompts must request Chinese `summary` and `reason`, prohibit invented dates/URLs, enforce `hot` over `quality` when both apply, and pass the explicit seven-day window.

Add `@lettermate/config`, `@prisma/client`, `bullmq`, and `ioredis` as direct Worker dependencies, and add `packages/config` to the Worker TypeScript project references so production bootstrap never relies on undeclared root dependency hoisting.

- [ ] **Step 5: Run gateway tests and commit**

Run: `npx vitest run apps/worker/src/openrouter-gateway.test.ts`

Expected: PASS with exactly two requests for invalid JSON and no Authorization value in thrown messages or snapshots.

```powershell
git add apps/worker package-lock.json
git commit -m "feat: add OpenRouter AI gateway"
```

### Task 5: Implement Discovery Orchestration and Worker Runtime

**Files:**
- Create: `apps/worker/src/discovery-service.ts`
- Create: `apps/worker/src/discovery-service.test.ts`
- Create: `apps/worker/src/worker.ts`
- Create: `apps/worker/src/worker.test.ts`
- Modify: `apps/worker/src/main.ts`
- Delete: `apps/worker/src/pipeline.ts`
- Delete: `apps/worker/src/pipeline.test.ts`
- Delete: `apps/worker/src/collectors.ts`
- Delete: `apps/worker/src/collectors.test.ts`

- [ ] **Step 1: Write failing orchestration tests with fake gateway and repository**

```ts
const existingItem: DiscoveryCandidate = {
  kind: 'quality', title: 'Existing', summary: '旧摘要', reason: '旧理由',
  sourceUrls: ['https://example.com/existing'], publishedAt: null,
};

class FakeDiscoveryRepository implements DiscoveryRepository {
  currentTopic: Topic = {
    id: 'topic-1', userId: 'user-a', keyword: 'AI Agent', expandedTerms: [],
    createdAt: '2026-07-24T07:00:00.000Z', lastRunAt: null, runStatus: 'queued', lastError: null,
  };
  savedItems: DiscoveryCandidate[] = [];
  async findOwnedTopic() { return this.currentTopic; }
  async markRunning() { this.currentTopic.runStatus = 'running'; }
  async saveSuccess(_id: string, expandedTerms: string[], items: DiscoveryCandidate[], finishedAt: Date) {
    this.savedItems = items;
    this.currentTopic = { ...this.currentTopic, expandedTerms, runStatus: 'succeeded', lastRunAt: finishedAt.toISOString(), lastError: null };
  }
  async saveFailure(_id: string, error: SafeError, finishedAt: Date, status: 'queued' | 'failed') {
    this.currentTopic = { ...this.currentTopic, runStatus: status, lastRunAt: finishedAt.toISOString(), lastError: error };
  }
}

it('expands, validates and upserts citation-backed discoveries', async () => {
  const gateway: AiGateway = {
    expandTopic: vi.fn().mockResolvedValue({ terms: ['智能体'], searchQueries: ['AI agent latest'] }),
    discover: vi.fn().mockResolvedValue({ citations: ['https://example.com/post'], items: [{
      kind: 'quality', title: 'Deep guide', summary: '中文摘要', reason: '内容深入',
      sourceUrls: ['https://example.com/post'], publishedAt: null,
    }] }),
  };
  const repository = new FakeDiscoveryRepository();
  await new TopicDiscoveryService(gateway, repository, () => new Date('2026-07-24T08:00:00Z')).run('topic-1', 'user-a');
  expect(repository.savedItems).toHaveLength(1);
  expect(repository.currentTopic).toMatchObject({ expandedTerms: ['智能体'], runStatus: 'succeeded', lastError: null });
});

it('preserves previous items and records a safe failure', async () => {
  const repository = new FakeDiscoveryRepository();
  repository.savedItems = [existingItem];
  const gateway: AiGateway = {
    expandTopic: vi.fn().mockRejectedValue(new AiGatewayError('AI_AUTH_FAILED', '认证失败', false)),
    discover: vi.fn(),
  };
  await expect(new TopicDiscoveryService(gateway, repository).run('topic-1', 'user-a')).rejects.toMatchObject({ code: 'AI_AUTH_FAILED' });
  expect(repository.savedItems).toEqual([existingItem]);
  expect(repository.currentTopic.runStatus).toBe('failed');
});
```

- [ ] **Step 2: Run the discovery service test and verify it fails**

Run: `npx vitest run apps/worker/src/discovery-service.test.ts`

Expected: FAIL because `TopicDiscoveryService` does not exist.

- [ ] **Step 3: Implement the repository boundary and transactional service**

```ts
export interface DiscoveryRepository {
  findOwnedTopic(topicId: string, userId: string): Promise<Topic | null>;
  markRunning(topicId: string): Promise<void>;
  saveSuccess(topicId: string, expandedTerms: string[], items: DiscoveryCandidate[], finishedAt: Date): Promise<void>;
  saveFailure(topicId: string, error: SafeError, finishedAt: Date, status: 'queued' | 'failed'): Promise<void>;
}

export class TopicDiscoveryService {
  constructor(private readonly gateway: AiGateway, private readonly repository: DiscoveryRepository, private readonly now = () => new Date()) {}
  async run(topicId: string, userId: string): Promise<void> {
    const topic = await this.repository.findOwnedTopic(topicId, userId);
    if (!topic) return;
    await this.repository.markRunning(topicId);
    try {
      const expanded = await this.gateway.expandTopic({ keyword: topic.keyword });
      const result = await this.gateway.discover({ keyword: topic.keyword, expandedTerms: [...expanded.terms, ...expanded.searchQueries], lookbackDays: 7, now: this.now().toISOString() });
      await this.repository.saveSuccess(topicId, [...expanded.terms, ...expanded.searchQueries], validateDiscoveryResult(result), this.now());
    } catch (error) {
      const safe = toSafeAiError(error);
      await this.repository.saveFailure(topicId, safe, this.now(), 'failed');
      throw error;
    }
  }
}
```

The Prisma repository transaction upserts each item by `topicId_canonicalPrimaryUrl`, merges canonical source URLs, and updates the topic only after all item writes succeed.

- [ ] **Step 4: Write and implement BullMQ retry-state tests**

```ts
it('requeues a retryable failure and marks the final attempt failed', async () => {
  const repository = { saveFailure: vi.fn() } as unknown as DiscoveryRepository;
  const service = { run: vi.fn().mockRejectedValue(new AiGatewayError('AI_RATE_LIMITED', '限流', true, 15_000)) };
  const handler = createDiscoveryJobHandler(service, repository);
  const first = { data: { topicId: 'topic-1', userId: 'user-a' }, attemptsMade: 0, opts: { attempts: 3 } } as Job<DiscoveryJobData>;
  await expect(handler(first)).rejects.toMatchObject({ retryable: true });
  expect(repository.saveFailure).toHaveBeenLastCalledWith(expect.any(String), expect.any(Object), expect.any(Date), 'queued');
  const final = { data: first.data, attemptsMade: 2, opts: { attempts: 3 } } as Job<DiscoveryJobData>;
  await expect(handler(final)).rejects.toBeDefined();
  expect(repository.saveFailure).toHaveBeenLastCalledWith(expect.any(String), expect.any(Object), expect.any(Date), 'failed');
});
```

Create a BullMQ `Worker('topic-discovery', handler, { connection, settings: { backoffStrategy } })`; job data is `{ topicId, userId }`, attempts are `3`, and the custom backoff returns `AiGatewayError.retryAfterMs` before exponential fallback. `main.ts` parses config, instantiates Prisma, Redis, `OpenRouterAiGateway`, repository, service, and Worker, and disconnects them on `SIGINT`/`SIGTERM`.

- [ ] **Step 5: Run worker tests and commit**

Run: `npx vitest run apps/worker/src/discovery-service.test.ts apps/worker/src/worker.test.ts apps/worker/src/openrouter-gateway.test.ts`

Expected: PASS; no old collector or trusted-event pipeline files remain.

```powershell
git add apps/worker
git commit -m "feat: process topic discovery jobs"
```

### Task 6: Replace the API with Topic, Feed and Item Endpoints

**Files:**
- Create: `apps/api/src/topic-store.ts`
- Create: `apps/api/src/topic-queue.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/app.test.ts`
- Modify: `apps/api/src/main.ts`
- Delete: `apps/api/src/store.ts`
- Modify: `apps/api/package.json`
- Modify: `apps/api/tsconfig.json`

- [ ] **Step 1: Replace API tests with the approved endpoint contract**

```ts
class RecordingQueue implements TopicQueue {
  jobs: DiscoveryJobData[] = [];
  async enqueue(data: DiscoveryJobData) { this.jobs.push(data); }
  async close() {}
}

let app: INestApplication;
let server: ReturnType<INestApplication['getHttpServer']>;
let store: MemoryTopicStore;
let queue: RecordingQueue;

beforeEach(async () => {
  store = new MemoryTopicStore(); queue = new RecordingQueue();
  app = await createApiApp({ store, queue, aiConfigured: true });
  server = app.getHttpServer();
});
afterEach(async () => app.close());

it('creates one keyword topic and enqueues its first refresh', async () => {
  const response = await request(server).post('/api/v1/topics').set('x-user-id', 'user-a').send({ keyword: '  AI Agent  ' }).expect(201);
  expect(response.body).toMatchObject({ userId: 'user-a', keyword: 'AI Agent', runStatus: 'queued', expandedTerms: [] });
  expect(queue.jobs).toEqual([{ topicId: response.body.id, userId: 'user-a' }]);
});

it('rejects create and refresh without an OpenRouter Key', async () => {
  const noKeyApp = await createApiApp({ store, queue, aiConfigured: false });
  await request(noKeyApp.getHttpServer()).post('/api/v1/topics').set('x-user-id', 'user-a').send({ keyword: 'AI' })
    .expect(503).expect(({ body }) => expect(body.code).toBe('AI_NOT_CONFIGURED'));
  await noKeyApp.close();
});

it('isolates topics, feed and item details by user', async () => {
  const topic = store.seedTopic('user-b', 'private');
  const item = store.seedItem(topic.id);
  await request(server).get(`/api/v1/feed?topicId=${topic.id}`).set('x-user-id', 'user-a').expect(404);
  await request(server).get(`/api/v1/items/${item.id}`).set('x-user-id', 'user-a').expect(404);
});

it('filters feed by hot or quality', async () => {
  store.seedDiscovery('user-a', 'hot'); store.seedDiscovery('user-a', 'quality');
  const response = await request(server).get('/api/v1/feed?kind=hot').set('x-user-id', 'user-a').expect(200);
  expect(response.body).toHaveLength(1); expect(response.body[0].kind).toBe('hot');
});
```

- [ ] **Step 2: Run API tests and verify old routes fail the new contract**

Run: `npx vitest run apps/api/src/app.test.ts`

Expected: FAIL because `/topics`, `/feed`, and `/items/:id` do not exist.

- [ ] **Step 3: Implement repository and queue interfaces with production adapters**

```ts
export interface TopicStore {
  createTopic(userId: string, keyword: string, normalizedKeyword: string): Promise<Topic>;
  listTopics(userId: string): Promise<Topic[]>;
  findTopic(userId: string, id: string): Promise<Topic | null>;
  queueRefresh(userId: string, id: string): Promise<Topic | null>;
  listFeed(userId: string, filter: { topicId?: string; kind?: DiscoveryKind }): Promise<DiscoveryItem[]>;
  findItem(userId: string, id: string): Promise<DiscoveryItem | null>;
}

export interface TopicQueue { enqueue(data: { topicId: string; userId: string }): Promise<void>; close(): Promise<void>; }

export class BullTopicQueue implements TopicQueue {
  constructor(private readonly queue: Queue<DiscoveryJobData>) {}
  async enqueue(data: DiscoveryJobData) {
    await this.queue.add('refresh', data, { jobId: `topic:${data.topicId}`, attempts: 3, backoff: { type: 'custom' }, removeOnComplete: true, removeOnFail: true });
  }
  async close() { await this.queue.close(); }
}
```

`PrismaTopicStore` maps Prisma enums/dates/JSON errors through the public schemas. It catches Prisma `P2002` for `[userId, normalizedKeyword]` and throws `TopicAlreadyExistsError`. For the existing local `x-user-id` prototype authentication, `createTopic` uses `user.connectOrCreate` with `${userId}@example.local` and a non-login placeholder password hash so a clean database can create its first topic; no production login claim is added. `MemoryTopicStore` implements the same interface for API/E2E tests only and exposes `seedTopic`, `seedItem`, `seedDiscovery`, and `completeFakeDiscovery` exclusively for tests.

Add `@lettermate/config`, `@prisma/client`, `bullmq`, and `ioredis` as direct API dependencies and add `packages/config` to its TypeScript project references.

- [ ] **Step 4: Implement the controller and explicit error behavior**

```ts
@Post('topics')
async createTopic(@Headers('x-user-id') header: string | undefined, @Body() body: unknown) {
  this.assertAiConfigured();
  const userId = authenticatedUser(header);
  const input = parseOrThrow(topicInputSchema, body, '主题关键词无效');
  const topic = await this.store.createTopic(userId, input.keyword, normalizeKeyword(input.keyword));
  await this.queue.enqueue({ topicId: topic.id, userId });
  return topic;
}

@Post('topics/:id/refresh') @HttpCode(202)
async refresh(@Headers('x-user-id') header: string | undefined, @Param('id') id: string) {
  this.assertAiConfigured();
  const userId = authenticatedUser(header);
  const topic = await this.store.queueRefresh(userId, id);
  if (!topic) throw new NotFoundException();
  await this.queue.enqueue({ topicId: id, userId });
  return topic;
}
```

Add `GET /topics`, `GET /feed`, and `GET /items/:id`; reject invalid `kind` with `400 VALIDATION_ERROR`; preserve the health and session endpoints; remove monitor rules, events, evidence, sources, notifications, Push and their routes. `createApiApp(options)` accepts injected store/queue/aiConfigured for tests and creates Prisma/BullMQ defaults for production.

- [ ] **Step 5: Run API tests and commit**

Run: `npx vitest run apps/api/src/app.test.ts`

Expected: PASS for validation, duplicates, no-Key 503, initial queueing, refresh dedupe, filtering and ownership.

```powershell
git add apps/api package-lock.json
git commit -m "feat: expose topic discovery API"
```

### Task 7: Build the Validated Web API and Discovery Card

**Files:**
- Modify: `apps/web/src/api.ts`
- Create: `apps/web/src/components/DiscoveryCard.tsx`
- Create: `apps/web/src/components/DiscoveryCard.test.tsx`
- Delete: `apps/web/src/components/EventCard.tsx`
- Delete: `apps/web/src/components/EventCard.test.tsx`

- [ ] **Step 1: Write a failing card test for classification, Chinese copy and original links**

```tsx
it('renders classification, summary, reason and safe source links', () => {
  render(<DiscoveryCard item={{
    id: 'item-1', topicId: 'topic-1', kind: 'quality', title: 'Agent guide',
    summary: '完整介绍了实现方式。', reason: '包含可复现代码与性能数据。',
    sourceUrls: ['https://example.com/guide'], publishedAt: null,
    discoveredAt: '2026-07-24T08:00:00.000Z',
  }} />);
  expect(screen.getByText('优质')).toBeVisible();
  expect(screen.getByText('完整介绍了实现方式。')).toBeVisible();
  expect(screen.getByText(/可复现代码/)).toBeVisible();
  expect(screen.getByRole('link', { name: /查看原文/ })).toHaveAttribute('href', 'https://example.com/guide');
  expect(screen.getByRole('link', { name: /查看原文/ })).toHaveAttribute('rel', expect.stringContaining('noopener'));
});
```

- [ ] **Step 2: Run the card test and verify it fails**

Run: `npx vitest run apps/web/src/components/DiscoveryCard.test.tsx`

Expected: FAIL because `DiscoveryCard` does not exist.

- [ ] **Step 3: Replace the API client with topic discovery methods and typed errors**

```ts
export class ApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) { super(message); }
}

export const api = {
  topics: () => apiRequest('/topics', z.array(topicSchema)),
  createTopic: (input: TopicInput) => apiRequest('/topics', topicSchema, { method: 'POST', body: JSON.stringify(topicInputSchema.parse(input)) }),
  refreshTopic: (id: string) => apiRequest(`/topics/${id}/refresh`, topicSchema, { method: 'POST' }),
  feed: (filter: { topicId?: string; kind?: DiscoveryKind }) => apiRequest(`/feed?${new URLSearchParams(compact(filter))}`, z.array(discoveryItemSchema)),
  item: (id: string) => apiRequest(`/items/${id}`, discoveryItemSchema),
};
```

`apiRequest` parses `apiErrorSchema` on failures and throws `ApiError`; remove every event/rule/source/notification/Push method.

- [ ] **Step 4: Implement `DiscoveryCard` and run its test**

Use `Flame` for `hot`, `Sparkles` for `quality`, `Clock3` for the timestamp and `ExternalLink` for source commands. Render each source URL as a separate external link with `target="_blank" rel="noreferrer noopener"`; do not render trust, confirmation, evidence, or source-count wording.

Run: `npx vitest run apps/web/src/components/DiscoveryCard.test.tsx`

Expected: PASS and the DOM contains no `已确认`, `待核实`, `已驳回`, `证据链`, or `可信` text.

- [ ] **Step 5: Commit the client and card**

```powershell
git add apps/web/src/api.ts apps/web/src/components
git commit -m "feat: add citation-backed discovery cards"
```

### Task 8: Replace the React Workspace and Styling

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/styles.css`
- Delete: `apps/web/src/push.ts`
- Delete: `apps/web/src/push.test.ts`
- Delete: `apps/web/public/sw.js`

- [ ] **Step 1: Add focused component integration tests for single-keyword creation and real errors**

Create `apps/web/src/App.test.tsx` with MSW-free mocked `global.fetch` responses:

```tsx
const discoveryItem: DiscoveryItem = {
  id: 'item-1', topicId: 'topic-1', kind: 'quality', title: 'Agent guide',
  summary: '中文摘要', reason: '内容深入', sourceUrls: ['https://example.com/guide'],
  publishedAt: null, discoveredAt: '2026-07-24T08:00:00.000Z',
};
const requests: Array<{ url: string; body?: unknown }> = [];

function installFetchMock(topics: Topic[], feed: DiscoveryItem[], created?: Topic) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, body });
    if (url.endsWith('/topics') && init?.method === 'POST') return Response.json(created!, { status: 201 });
    if (url.endsWith('/topics')) return Response.json(topics);
    if (url.includes('/feed')) return Response.json(feed);
    return Response.json({ code: 'NOT_FOUND', message: 'not found', traceId: 'test' }, { status: 404 });
  }));
}

function renderApp(route: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[route]}><App /></MemoryRouter></QueryClientProvider>);
}

it('submits only one keyword and polls queued topics', async () => {
  const created: Topic = {
    id: 'topic-1', userId: 'user-a', keyword: 'AI Agent', expandedTerms: [],
    createdAt: '2026-07-24T08:00:00.000Z', lastRunAt: null, runStatus: 'queued', lastError: null,
  };
  installFetchMock([], [], created);
  renderApp('/topics');
  await userEvent.type(screen.getByLabelText('主题关键词'), 'AI Agent');
  await userEvent.click(screen.getByRole('button', { name: '创建主题' }));
  expect(requests.find((request) => request.url.endsWith('/topics') && request.body)?.body).toEqual({ keyword: 'AI Agent' });
  expect(await screen.findByText('AI Agent')).toBeVisible();
});

it('shows AI_NOT_CONFIGURED without losing existing content', async () => {
  installFetchMock([{
    id: 'topic-1', userId: 'user-a', keyword: 'AI Agent', expandedTerms: [],
    createdAt: '2026-07-24T07:00:00.000Z', lastRunAt: '2026-07-24T08:00:00.000Z',
    runStatus: 'failed', lastError: { code: 'AI_NOT_CONFIGURED', message: '尚未配置 OpenRouter Key' },
  }], [discoveryItem]);
  renderApp('/');
  expect(await screen.findByText('尚未配置 OpenRouter Key')).toBeVisible();
  expect(screen.getByText(discoveryItem.title)).toBeVisible();
});
```

- [ ] **Step 2: Run the App test and verify the old workspace fails**

Run: `npx vitest run apps/web/src/App.test.tsx`

Expected: FAIL because there is no topic form, polling, discovery feed, or OpenRouter error mapping.

- [ ] **Step 3: Implement the two-view workspace**

```tsx
const navigation = [
  { to: '/', label: '发现', icon: Newspaper },
  { to: '/topics', label: '主题', icon: Search },
];

const topics = useQuery({
  queryKey: ['topics'], queryFn: api.topics,
  refetchInterval: (query) => query.state.data?.some((topic) => ['queued', 'running'].includes(topic.runStatus)) ? 1_500 : false,
});
```

`FeedPage` has `全部 / 热点 / 优质` tabs, optional topic selection, refresh action, and `DiscoveryCard` rows. `TopicsPage` has exactly one `主题关键词` input, creates a topic, lists expanded terms only after AI produces them, shows queued/running/succeeded/failed state, and exposes an icon refresh button with tooltip. `ItemPage` shows the same summary/reason and all source URLs. Remove notifications, sources, settings, trust status, evidence details and all Push behavior.

- [ ] **Step 4: Rewrite styles around the retained quiet workspace shell**

Keep the current neutral white/gray + green accent palette and 6px maximum card radius. Add stable dimensions for the topic input row, two-tab mobile navigation, three-option segmented control and icon buttons. Use `overflow-wrap: anywhere` for titles and URLs, `minmax(0, 1fr)` grid tracks, and mobile breakpoints at 780px and 420px. Remove `.status--confirmed`, `.status--pending`, `.status--rejected`, `.priority`, `.compliance`, `.source-level`, `.decision`, `.evidence`, `.settings-band`, and `.toggle` selectors.

- [ ] **Step 5: Run web tests, typecheck, build and commit**

Run: `npx vitest run apps/web/src/App.test.tsx apps/web/src/components/DiscoveryCard.test.tsx`

Expected: PASS.

Run: `npm run typecheck && npm run build`

Expected: both exit 0; no old contract imports remain.

```powershell
git add apps/web
git commit -m "feat: build AI discovery workspace"
```

### Task 9: Add Deterministic Cross-Viewport E2E Coverage

**Files:**
- Create: `apps/api/src/e2e-main.ts`
- Modify: `apps/api/package.json`
- Modify: `playwright.config.ts`
- Create: `tests/e2e/ai-discovery.spec.ts`
- Delete: `tests/e2e/phase-one.spec.ts`

- [ ] **Step 1: Create a deterministic fake discovery server for browser tests**

```ts
const store = new MemoryTopicStore();
const queue: TopicQueue = {
  async enqueue({ topicId, userId }) {
    await store.completeFakeDiscovery(userId, topicId, {
      expandedTerms: ['智能体', 'agentic AI'],
      items: [{ kind: 'quality', title: 'Agent 工程实践指南', summary: '文章总结了可复现的工程方法。', reason: '包含实现细节与原始数据。', sourceUrls: ['https://example.com/agent-guide'], publishedAt: '2026-07-24T06:30:00.000Z' }],
    });
  },
  async close() {},
};
const app = await createApiApp({ store, queue, aiConfigured: true });
await app.listen(3000, '0.0.0.0');
```

Add `"dev:e2e": "tsx watch src/e2e-main.ts"` to the API package and point Playwright's API web server command to it. This fake is never imported by production `main.ts`.

- [ ] **Step 2: Write the new acceptance workflow**

```ts
test('creates one-keyword topic and shows AI discovery with original link', async ({ page }) => {
  await page.goto('/topics');
  await page.getByLabel('主题关键词').fill('AI Agent');
  await page.getByRole('button', { name: '创建主题' }).click();
  await expect(page.getByText('智能体')).toBeVisible();
  await page.getByRole('link', { name: '发现' }).click();
  await expect(page.getByText('Agent 工程实践指南')).toBeVisible();
  await expect(page.getByText('优质')).toBeVisible();
  await expect(page.getByRole('link', { name: /查看原文/ })).toHaveAttribute('href', 'https://example.com/agent-guide');
  await expect(page.getByText(/已确认|待核实|已驳回|证据链/)).toHaveCount(0);
});
```

- [ ] **Step 3: Run Playwright across all configured viewports**

Run: `npm run test:e2e`

Expected: PASS in `desktop`, `tablet`, and `mobile` projects with no horizontal scrolling and no overlapping controls.

- [ ] **Step 4: Capture and inspect browser screenshots**

Run: `npx playwright test tests/e2e/ai-discovery.spec.ts --project=desktop --screenshot=on`

Expected: the screenshot shows the actual discovery workspace, the topic keyword remains readable, the card source command is visible, and the next feed row/section is not obscured. Repeat with `--project=mobile` and inspect both images using the local image viewer.

- [ ] **Step 5: Commit E2E coverage**

```powershell
git add apps/api/src/e2e-main.ts apps/api/package.json playwright.config.ts tests/e2e
git commit -m "test: cover AI discovery across viewports"
```

### Task 10: Add Live OpenRouter Smoke Test, Docs and Full Verification

**Files:**
- Create: `apps/worker/src/openrouter.live.test.ts`
- Modify: `README.md`
- Modify: `package.json`

- [ ] **Step 1: Add the opt-in live test without fixed result assertions**

```ts
const enabled = process.env.RUN_LIVE_AI_TESTS === '1' && Boolean(process.env.AI_API_KEY);
describe.skipIf(!enabled)('OpenRouter live discovery', () => {
  it('returns citation-backed Chinese discoveries', async () => {
    const gateway = new OpenRouterAiGateway({
      apiKey: process.env.AI_API_KEY!, model: process.env.AI_MODEL ?? 'openrouter/auto',
      webSearch: true, timeoutMs: 120_000,
    });
    const expanded = await gateway.expandTopic({ keyword: 'TypeScript' });
    const result = await gateway.discover({ keyword: 'TypeScript', expandedTerms: [...expanded.terms, ...expanded.searchQueries], lookbackDays: 7, now: new Date().toISOString() });
    const valid = validateDiscoveryResult(result);
    expect(valid.length).toBeGreaterThan(0);
    expect(valid.every((item) => ['hot', 'quality'].includes(item.kind))).toBe(true);
    expect(valid.every((item) => item.summary.length > 0 && item.reason.length > 0 && item.sourceUrls.every((url) => URL.canParse(url)))).toBe(true);
  }, 180_000);
});
```

- [ ] **Step 2: Rewrite README around the real OpenRouter workflow**

Document exactly:

```powershell
Copy-Item .env.example .env
# Edit only AI_API_KEY for the default openrouter/auto model.
docker compose -f infra/compose.yaml up -d
npm run db:deploy
npm run dev
```

State that `npm run dev` starts Web, API and Worker; changing `AI_MODEL` selects another OpenRouter model; Key stays server-side; normal tests use fakes; live verification requires `RUN_LIVE_AI_TESTS=1`. Remove every claim about trusted events, source grades, monitor rules, evidence status and Push.

- [ ] **Step 3: Make root development start the Worker and add a live-test command**

```json
"dev": "npm-run-all --parallel dev:web dev:api dev:worker",
"dev:worker": "npm run dev -w @lettermate/worker",
"test:live-ai": "vitest run apps/worker/src/openrouter.live.test.ts"
```

- [ ] **Step 4: Run the complete deterministic verification suite**

Run in order:

```powershell
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
npx prisma validate
```

Expected: every command exits 0; default tests do not contact OpenRouter; search output contains no old domain/UI terms outside historical docs and migration SQL:

```powershell
Get-ChildItem apps,packages,prisma -Recurse -File -Include *.ts,*.tsx,*.prisma | Select-String -Pattern 'TrustStatus|trustStatus|已确认|待核实|已驳回|MonitorRule|monitor-rules|evidence chain'
```

Expected: no matches in active source or Prisma schema.

- [ ] **Step 5: Run real OpenRouter verification when the user has configured the local Key**

Run: `$env:RUN_LIVE_AI_TESTS='1'; npm run test:live-ai`

Expected: PASS with at least one citation-backed `hot | quality` result, Chinese summary and Chinese reason. Never print `.env`, request headers or the Key.

- [ ] **Step 6: Start the complete local application and verify the real workflow**

Run: `npm run dev`

Expected: Web at `http://localhost:5173`, API health at `http://localhost:3000/api/v1/health`, Worker connected to Redis, and creating a keyword transitions `queued -> running -> succeeded` before real discovery cards appear.

- [ ] **Step 7: Commit documentation and verification work**

```powershell
git add README.md package.json package-lock.json apps/worker/src/openrouter.live.test.ts
git commit -m "docs: document real OpenRouter discovery workflow"
```

## Completion Audit

Before declaring the goal complete, inspect current source and runtime evidence against every requirement:

1. No trust classification: active UI, contracts, domain exports, API routes and Prisma schema contain no trusted-event state or source-grade concepts.
2. One-keyword flow: API and Playwright prove the request body is only `{ keyword }`; expanded terms are produced by Fake/real `AiGateway`, not user inputs.
3. Real service: the live test and manual local run prove OpenRouter Web Search returns citations, Worker persists validated results and React displays their original URLs.
4. Model configuration: config tests prove Key-only defaults and `AI_MODEL` override behavior.
5. Failure integrity: tests prove missing Key, rate limits, invalid JSON, missing citations and upstream errors are visible, retried correctly and do not erase prior discoveries.
6. Quality gates: lint, typecheck, unit/API/component tests, build, Prisma validation and all Playwright viewports pass from the final worktree.
