# Feed Search Design

**Status:** Approved design
**Date:** 2026-08-02

## Goal

Let a user search articles already stored in LetterMate by title, summary, and
recommendation reason. Search results must be relevance-ranked, user-scoped,
and composable with the existing Feed filters.

Search never starts an external discovery run. It only queries persisted Topic
and trend Feed items.

## User Experience

The discovery page places a compact search form below the page header and above
the existing filters. It contains a text input, a Search icon button, and a
Clear icon button while a search is active.

Typing does not issue requests. Pressing Enter or clicking Search submits the
trimmed value. The input value and submitted query are separate so edits do not
change results until the user submits again. Clearing the active query restores
the normal Feed under the current filters.

While a search request is pending, the Search button shows a stable loading
state and the input remains editable. Changing source, Topic, kind, or time
range while a query is active reruns the same submitted query with the new
filters.

Search results reuse the existing discovery cards and date grouping. An empty
result displays a specific no-matches state. A failed request keeps the input,
submitted query, and filters so the user can retry without reconstructing the
search.

The form must remain usable without horizontal overflow at the existing 320px
minimum viewport.

## API Contract

`GET /api/v1/feed` accepts an optional `q` query parameter in addition to the
existing `origin`, `topicId`, `kind`, and `range` parameters.

- Leading and trailing whitespace is removed.
- A missing or empty value means normal Feed mode.
- A non-empty query contains 1-100 characters after trimming.
- Invalid input returns the existing validated API error shape.
- Existing filter restrictions remain in force, including rejecting
  `origin=trend` together with `topicId`.

The web API client includes `q` only for an active submitted query. The response
continues to use the existing `FeedItem[]` contract; relevance scores are an
internal query concern and are not exposed to clients.

## Storage And Ranking

PostgreSQL provides search through the `pg_trgm` extension. A Prisma migration
enables the extension and creates trigram GIN indexes for `title`, `summary`,
and `reason` on both `DiscoveryItem` and `RadarItem`.

The store always applies ownership before matching:

- Topic items are reachable only through Topics belonging to the current user.
- Trend items must have the current `userId`.

An item matches when the query is a case-insensitive substring of its title,
summary, or recommendation reason. Trigram similarity ranks those matches; it
does not admit fuzzy-only results. This keeps results predictable while still
providing useful relevance ordering for Chinese content.

Field weights are, from strongest to weakest:

1. title
2. summary
3. recommendation reason

Title containment receives the strongest ranking bonus, followed by summary
and reason containment. Within equal relevance, items sort by effective article
time descending (`publishedAt`, otherwise `discoveredAt`) and then by ID for a
stable result. Without `q`, the existing chronological Feed query and ordering
remain unchanged.

All existing filters are applied inside each Topic and trend query before the
two result sets are merged. The merged list is then sorted by relevance and the
stable tie breakers above.

## Component Boundaries

- `packages/contracts` defines and tests the reusable Feed query shape,
  including `q` validation.
- `apps/api` parses the request, preserves ownership checks, and passes the
  normalized query to `TopicStore.listFeed`.
- `apps/api/src/topic-store.ts` owns PostgreSQL matching and ranking. The
  in-memory store implements equivalent deterministic behavior for API and E2E
  tests.
- `apps/web/src/api.ts` serializes the submitted query with existing filters.
- The discovery page owns draft/submitted search state and renders the search
  form without changing the existing card component.

No worker, connector, OpenRouter, queue, or discovery pipeline changes are
required.

## Error Handling

Database failures use the existing API exception path and safe error response.
The web query displays the existing retry state and retains search context.
Search does not fall back to unfiltered results after an error because doing so
would present unrelated articles as matches.

## Verification

Contract tests cover trimming, empty input, the 100-character limit, and
compatibility with existing filter restrictions.

Store and API tests cover:

- matching Chinese text in title, summary, and reason;
- title matches ranking above summary and reason matches;
- effective article time and ID tie breakers;
- Topic and trend result merging;
- combination with source, Topic, kind, and time filters;
- strict user ownership isolation;
- unchanged chronological behavior without a query.

Web tests cover:

- no request while typing;
- Enter and Search button submission;
- current filters included in search requests;
- filter changes rerunning the submitted query;
- clearing search and restoring normal Feed;
- loading, empty, error, and retry states;
- accessible labels and stable mobile layout.

Final verification runs lint, type checking, unit/integration tests, build, the
relevant Playwright flow, and a real local API search against PostgreSQL.
