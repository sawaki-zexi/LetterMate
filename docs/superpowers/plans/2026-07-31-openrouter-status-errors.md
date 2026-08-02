# OpenRouter Status Errors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Report distinct OpenRouter authentication, payment, and permission failures instead of one generic credentials error.

**Architecture:** Keep status translation inside `OpenRouterSearchConnector`, where HTTP responses are already mapped to connector errors. Preserve existing error codes and retry behavior while making each user-visible message accurately describe its HTTP status.

**Tech Stack:** TypeScript, Vitest

---

### Task 1: Split OpenRouter HTTP status messages

**Files:**
- Modify: `apps/worker/src/connectors/openrouter-search.ts`
- Test: `apps/worker/src/connectors/openrouter-search.test.ts`

- [ ] Add a table-driven test asserting separate messages for HTTP 401, 402, and 403 responses.
- [ ] Run `npm test -- apps/worker/src/connectors/openrouter-search.test.ts` and verify the new test fails because all three statuses currently return the generic credentials message.
- [ ] Replace the combined status branch with explicit mappings: 401 invalid key, 402 insufficient balance or credit, and 403 insufficient permission.
- [ ] Run the focused test and verify it passes.
- [ ] Run worker tests, type checking, and linting to detect regressions.
