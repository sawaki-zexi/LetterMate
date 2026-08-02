# Topic Chip Editing and Feed Runtime Design

## Scope

This change addresses two regressions in the topic keyword management branch:

1. Expanded terms must remain compact while editing and expose an inline remove control.
2. The discovery homepage must load Topic and Trend feed items without a frontend contract failure.

No API contract, database schema, or keyword lifecycle behavior is broadened.

## Expanded Term Editing

When a Topic enters edit mode, each expanded term is rendered as a compact editable chip. The chip contains an inline text field and a trailing `X` icon button. Editing the text updates only the local draft. Pressing `X` removes that term only from the local draft.

The existing save boundary remains authoritative. Save normalizes the main keyword and expanded terms, removes blank terms, and submits one Topic update. Cancel discards all chip edits and removals by leaving edit mode; reopening edit mode rebuilds the draft from the persisted Topic. A compact add action appends a new editable chip and moves focus to it.

Each remove button has an accessible label containing its term. Chip dimensions and wrapping remain stable at desktop and mobile widths. The normal, non-editing Topic row keeps its current term-chip presentation.

## Homepage Feed Failure

The observed failure is a runtime version mismatch. The frontend at port `5173` is running from the feature worktree and validates Topic Feed items against the new required fields `topicKeyword` and `topicKeywordActive`. Port `3000` is owned by an API process started from the main worktree, which returns older Topic Feed payloads without those fields. Trend items are unaffected.

The fix preserves the strict shared contract. The API remains responsible for emitting both fields for every Topic Feed item; the frontend must not invent missing keyword lifecycle data. Local verification and development startup must run the web client and API from the same worktree. Existing processes on the default ports will be identified and replaced or the feature worktree will be run on a coordinated alternate port pair.

Regression coverage will assert that both feed listing and item-detail endpoints return the keyword snapshot and active flag for Topic items. Web API tests will retain strict parsing so an incompatible backend cannot silently display incorrect state.

## Error Handling

Chip deletion is reversible until Save. Failed saves keep edit mode and the current draft visible with the existing inline error treatment. Empty main keywords continue to block Save. Blank expanded terms are omitted during submission.

The homepage continues to show its existing load-error state for genuine network or contract errors. Development startup alignment fixes the current mismatch rather than weakening this behavior.

## Verification

- Component tests cover inline chip removal, text editing, addition, save, cancel, and save failure.
- API tests cover Topic Feed keyword fields for active, renamed, and deleted Topics.
- Contract and web API tests confirm strict Topic/Trend discrimination.
- Playwright verifies the full Topic edit flow and successful homepage loading against the feature-worktree API.
- Desktop and mobile screenshots verify compact wrapping, focus behavior, and absence of overlap.

## Out of Scope

- Immediate persistence when pressing a chip's `X`.
- Undo after a successful Save.
- Making Topic Feed keyword fields optional or deriving them in the browser.
- Changing the persisted Feed history or keyword invalidation semantics.
