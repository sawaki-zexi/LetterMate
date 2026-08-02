# Refresh Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make discovery refreshes start reliably, survive transient scheduler failures, and display accurate progress across navigation while giving immediate Topic creation feedback.

**Architecture:** BullMQ remains the execution boundary and API `queued/running` state becomes the durable UI source of truth. The worker scheduler contains transient scan failures without exiting, while React derives refresh indicators from both local sessions and server snapshots. Topic creation uses a temporary presentation row without inventing a persisted Topic identity.

**Tech Stack:** TypeScript, NestJS, BullMQ, React, TanStack Query, Vitest

---

### Task 1: Contain Topic scheduler failures

**Files:**
- Modify: `apps/worker/src/scheduler.ts`
- Test: `apps/worker/src/scheduler.test.ts`

- [x] Add a failing test proving an initial rejected scan is logged and a later interval scan still runs.
- [x] Implement guarded, non-overlapping scheduler scans with rejection handling and close-time draining.
- [x] Run the focused scheduler tests.

### Task 2: Restore refresh state from the server

**Files:**
- Modify: `apps/web/src/App.tsx`
- Test: `apps/web/src/App.test.tsx`

- [x] Add failing tests for Topic row progress restored from `queued/running` state and Feed refresh progress restored after navigation.
- [x] Poll trend status while it is queued or running.
- [x] Derive button busy/disabled/spin state from local refresh sessions plus matching server run state.
- [x] Run focused web tests.

### Task 3: Show immediate Topic creation feedback

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/src/App.test.tsx`

- [x] Add a failing test that a pending Topic row appears synchronously after form submission and disappears on failure.
- [x] Render a stable pending row using the submitted keyword until the mutation settles.
- [x] Run focused web tests.

### Task 4: Verify and restore runtime

**Files:**
- No production files beyond Tasks 1-3.

- [x] Run `npm run lint`, `npm run typecheck`, and `npm test`.
- [x] Restart the worker and verify a worker child process remains alive.
- [x] Confirm queued jobs begin processing and report any external provider blocker separately.
