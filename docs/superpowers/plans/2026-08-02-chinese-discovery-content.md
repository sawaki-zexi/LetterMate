# Chinese Discovery Content Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ensure newly generated Feed titles, summaries, and recommendation reasons are written in Simplified Chinese while preserving source metadata.

**Architecture:** Add a small Worker-only language predicate. The OpenRouter gateway will strengthen its composition prompt and repair only invalid generated items once, replacing only the three user-facing text fields. The QualityPipeline will apply the same predicate as a final guard so alternate gateways or test doubles cannot persist English content.

**Tech Stack:** TypeScript, Vitest, Zod, OpenRouter structured JSON responses, existing Worker `OpenRouterAiGateway` and `QualityPipeline`.

---

### Task 1: Add the Chinese content predicate

**Files:**
- Create: `apps/worker/src/chinese-content.ts`
- Test: `apps/worker/src/chinese-content.test.ts`

- [ ] **Step 1: Write the failing tests**

Add tests for `isChineseContent`: accept normal Chinese prose with product/version names, reject English prose, and reject a string containing only one incidental Chinese character.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm test -- apps/worker/src/chinese-content.test.ts`
Expected: FAIL because `./chinese-content.js` does not exist.

- [ ] **Step 3: Implement the minimal predicate**

Export `isChineseContent(value: string): boolean`. Trim the value, count Han characters and ASCII letters, require at least two Han characters, and require Han characters to be at least 10% of Han-plus-letter characters. This permits names such as `GPT-5.7` while rejecting an English paragraph with an incidental Chinese token.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `npm test -- apps/worker/src/chinese-content.test.ts`
Expected: PASS.

### Task 2: Strengthen composition and repair invalid items

**Files:**
- Modify: `apps/worker/src/openrouter-gateway.ts`
- Test: `apps/worker/src/openrouter-gateway.test.ts`

- [ ] **Step 1: Write the failing gateway tests**

Add a test whose first structured response has English `title`, `summary`, and `reason`, followed by a Chinese repair response. Assert that two requests occur, the final text is Chinese, and repaired source metadata is ignored in favor of the original response. Add a second test with one valid item and one item whose repair remains English; assert that only the valid item is returned.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `npm test -- apps/worker/src/openrouter-gateway.test.ts`
Expected: FAIL because the current gateway returns the first response without language validation or repair.

- [ ] **Step 3: Implement prompt, validation, and repair**

Import `isChineseContent`. Update the composition system message to require Simplified Chinese for all three user-facing fields, allow necessary proper nouns and versions, and preserve source metadata. After the existing structured composition response, collect invalid items. Send one structured repair request containing only those drafts plus their original candidate context. Match repair results by canonical first source URL, replace only `title`, `summary`, and `reason`, and drop items with missing or still-invalid repairs. Keep all original source fields from the first response.

- [ ] **Step 4: Run the focused tests and verify they pass**

Run: `npm test -- apps/worker/src/openrouter-gateway.test.ts`
Expected: PASS.

### Task 3: Add the final QualityPipeline guard

**Files:**
- Modify: `apps/worker/src/quality-pipeline.ts`
- Test: `apps/worker/src/quality-pipeline.test.ts`

- [ ] **Step 1: Write the failing pipeline test**

Add a test where the gateway returns one English composed item and one Chinese composed item. Assert that only the Chinese item is returned.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm test -- apps/worker/src/quality-pipeline.test.ts`
Expected: FAIL because the current pipeline accepts every schema-valid composed item.

- [ ] **Step 3: Implement the final guard**

Filter raw composed items with `isChineseContent` on `title`, `summary`, and `reason` before source URL validation and persistence mapping. Leave all existing candidate, claim-support, deduplication, and source-proof checks unchanged.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `npm test -- apps/worker/src/quality-pipeline.test.ts`
Expected: PASS.

### Task 4: Full verification and review

**Files:**
- Review only: `docs/superpowers/specs/2026-08-02-chinese-discovery-content-design.md`

- [ ] **Step 1: Run Worker tests**

Run: `npm test -- apps/worker`
Expected: PASS with zero failed tests.

- [ ] **Step 2: Run repository verification**

Run: `npm run lint`; `npm run typecheck`; `npm test`; `npm run build`
Expected: all commands exit 0.

- [ ] **Step 3: Review the diff**

Run: `git diff --check` and `git diff -- apps/worker/src/chinese-content.ts apps/worker/src/openrouter-gateway.ts apps/worker/src/quality-pipeline.ts`
Expected: no whitespace errors, no source metadata mutation, and no unrelated file changes from this feature.
