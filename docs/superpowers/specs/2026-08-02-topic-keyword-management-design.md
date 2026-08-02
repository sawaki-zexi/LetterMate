# Topic Keyword Management Design

**Date:** 2026-08-02
**Status:** Approved for implementation planning

## Goal

Allow users to edit and delete tracked Topic keywords while preserving historical Feed content. Historical content must show the keyword that produced it and indicate when that keyword is no longer active. Users must also have full control over AI-generated deterministic keyword variants.

## Product Behavior

### Editing a Topic

- A user can edit a Topic's primary keyword from the Topic list.
- Changing the primary keyword keeps the Topic identity and all historical Feed items.
- Feed items created before the change retain the previous primary keyword and show a `关键词已失效` label.
- The updated Topic is queued for discovery once using the new keyword.
- Feed items created after the change use the new primary keyword and do not show the inactive label while that keyword remains current.
- If only deterministic variants change, existing Feed items remain active because the primary keyword did not change.

### Deleting a Topic

- Deletion is a soft delete. The Topic disappears from the Topic list immediately and is excluded from future scheduling.
- Historical Feed items and their original links remain available.
- Every historical Feed item from the deleted Topic retains its discovery-time keyword and shows `关键词已失效`.
- A Feed view filtered to the deleted Topic returns to the unfiltered view after deletion.
- A deleted primary keyword may be used to create a new active Topic later.

### Deterministic Variants

- AI generates the initial deterministic variant list once during the Topic's initial discovery flow.
- After the initial list is stored, later discovery runs must not automatically add, remove, or change variants.
- Users can add, edit, and delete variants in the Topic editor.
- Discovery uses exactly the saved primary keyword and saved variant list.
- Variants must preserve the complete keyword meaning and may only cover deterministic formatting differences such as case, spacing, punctuation, or hyphenation. They must not broaden the Topic into related concepts.
- Inputs are trimmed and deduplicated after the same normalization used for Topic keyword uniqueness.

## Data Model

Use a keyword snapshot on each Topic discovery item and soft deletion on Topic.

- Add nullable `deletedAt` to `Topic`.
- Add immutable `topicKeyword` to `DiscoveryItem`.
- Capture the primary keyword and deterministic variants used by each discovery run so an in-flight run cannot be relabeled by a concurrent edit.
- Persist each accepted item with the run's primary-keyword snapshot.
- Backfill existing discovery items from their related Topic keyword in the migration.
- Replace the current unconditional `(userId, normalizedKeyword)` uniqueness rule with active-Topic uniqueness. The implementation plan must choose a PostgreSQL partial unique index or an equivalent transactional enforcement that permits reuse after soft deletion without weakening concurrent duplicate protection.

A separate keyword-revision model is intentionally excluded. Per-item and per-run snapshots provide the required historical accuracy without exposing version-history features that are outside scope.

## API And Contracts

Add the following authenticated endpoints under `/api/v1`:

- `PATCH /topics/:id` updates the primary keyword and complete deterministic variant list.
- `DELETE /topics/:id` soft-deletes a Topic.

The update request contains the full desired state, not incremental variant operations:

```json
{
  "keyword": "gpt-5.7",
  "expandedTerms": ["gpt 5.7", "gpt5.7"]
}
```

Update and delete operations enforce current-user ownership. A missing, deleted, or other-user Topic returns `404` so resource existence is not disclosed. Invalid keywords, invalid variants, and duplicates return the existing structured field-error format. A duplicate active primary keyword returns the existing Topic-conflict error semantics.

Topic list responses include only active Topics. Topic-origin Feed items add:

- `topicKeyword`: the primary keyword snapshot used to discover the item.
- `topicKeywordActive`: true only when the related Topic is active and its current primary keyword matches the item's snapshot.

The server computes activity state; the web client does not infer it from its currently loaded Topic list.

## Scheduling And Concurrency

- Every discovery run freezes its primary keyword and deterministic variants before connector work begins.
- Editing during an in-flight run does not alter that run's search inputs or item labels.
- A primary-keyword change queues one discovery run for the new state.
- A variants-only change does not invalidate old Feed content, but queues one discovery run so the updated exact variants take effect promptly.
- Soft-deleted Topics are excluded from scheduled scans.
- Queued work that has not started checks Topic activity and exits without discovery after deletion.
- Work already running may complete. Accepted items remain historical content and use the frozen run keyword, so they are inactive after deletion or a primary-keyword change.
- Refresh and update enqueueing retains the existing single-active-run and pending-refresh guarantees.

## Web Interaction

Each Topic row gains icon buttons for edit and delete, with accessible labels and hover tooltips.

Editing happens inline or in the existing compact Topic management surface. It provides:

- A primary keyword input.
- A list editor for deterministic variants with add, edit, and remove controls.
- Save and cancel actions.
- Inline validation and a disabled submitting state.

Deletion opens a confirmation dialog stating that the keyword will be removed from the list while historical content remains and is marked inactive. The Topic row is removed only after a successful API response.

Topic-origin Feed items display `topicKeyword`. When `topicKeywordActive` is false, a restrained `关键词已失效` status label appears next to it. The item title, summary, reason, metadata, and original link remain unchanged and usable.

## Error Handling

- Empty or over-100-character primary keywords are rejected.
- Empty variants, variants over the contract limit, and normalized duplicates are rejected with field-level feedback.
- Requests against deleted or unowned Topics return `404`.
- Failed updates and deletes leave the current UI state visible and show the server-safe error without optimistic data loss.
- Queue failure after a successful edit does not roll back the saved Topic state; it is surfaced through the existing safe run/error model and can be retried.

## Verification

Implementation follows test-driven development and covers:

- Contract parsing for update input and Feed keyword state.
- Memory and Prisma store update, soft-delete, ownership, active uniqueness, and item/run snapshots.
- API update/delete success, validation, conflicts, and cross-user `404` behavior.
- Scheduler exclusion of deleted Topics and queued-job deletion checks.
- Worker preservation of frozen keyword and variants during concurrent changes.
- Web editing, variant management, deletion confirmation, filter reset, errors, and inactive labels.
- A Playwright flow that edits a keyword, verifies old content is inactive, deletes the Topic, and confirms history remains while the Topic list entry disappears.
- Prisma Client generation, migration application, lint, typecheck, unit/integration tests, build, and applicable end-to-end tests.

## Out Of Scope

- Restoring deleted Topics.
- Displaying a complete keyword revision history.
- Automatically regenerating variants after initial generation.
- Broad semantic synonyms or related-topic expansion.
- Deleting historical Feed content as part of Topic deletion.
