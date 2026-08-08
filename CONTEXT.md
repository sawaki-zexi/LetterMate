# LetterMate Discovery Context

LetterMate discovers timely, useful information from multiple public sources for a user's keyword monitors and daily feed.

## Language

**Keyword Monitor**:
A user-created monitor for one keyword that continuously searches available sources and tracks newly discovered information.
_Avoid_: Search rule, source subscription

**Source Coverage**:
The set of source families a Keyword Monitor is allowed to query for one run.
_Avoid_: Source ranking, source preference

**Default Source Coverage**:
The baseline policy of querying every available no-extra-credential source, including domestic video and community sources, before quality filtering.
_Avoid_: All-source guarantee, source diversity guarantee

**Candidate**:
A source-backed record that may enter quality evaluation but is not yet a Feed item.
_Avoid_: Article, result, notification

**Feed Item**:
A candidate that passed relevance, evidence, freshness, deduplication, and content-quality checks and was persisted for user reading.
_Avoid_: Search result, source record

**Creator Subscription**:
A user-confirmed subscription to one verified public account on one supported platform. It is anchored to the platform's stable account identity, not only to a display name.
_Avoid_: Name watch, unverified profile, arbitrary platform follow

**Identity Candidate**:
A platform-specific account returned by name or handle resolution before the user confirms which account to follow. Candidates must show enough identity context to distinguish same-name or impersonating accounts.
_Avoid_: Automatically selected first result, guessed account

**Creator Resolution Input**:
User input used to find Identity Candidates. An explicit `@handle` or supported-platform profile URL requests an exact account lookup. All other bare text, including a single incomplete word, is a cross-platform discovery query delegated to each provider's native ranked search; an exact candidate may still rank first.
_Avoid_: Treating every short ASCII word as an exact handle, locally invented substring matching

**Supported Platform**:
A platform with an implemented public-content connector and the configuration required to run it. A platform may be listed as `unconfigured` and visible in capability displays while remaining unavailable for new subscriptions.
_Avoid_: Any platform, all-platform guarantee

**Creator Content**:
A public item published, reposted, or substantially replied to by a subscribed account. Original posts, commentary reposts, pure reposts, and independently useful replies may qualify after content-quality evaluation. Reposts preserve both the subscribed account and the original author and are labeled as reposts; replies preserve the parent post as context. Short social replies are excluded.
_Avoid_: Original-only archive, unlabeled repost, context-free reply

**Creator Archive Item**:
A valid Creator Content record retained in a subscribed creator's detail view whether or not it qualifies for the unified Feed. Every visible archive item has a Chinese title and summary while preserving original quoted context and source links.
_Avoid_: Feed Item, raw scrape, untranslated candidate

**Interest Event**:
A time-stamped, user-owned fact that may affect personalization, such as a Keyword Monitor state, Creator Subscription state, or explicit content feedback. It remains the auditable source from which derived interests can be rebuilt.
_Avoid_: Click score, inferred user fact, free-text memory

**Interest Memory**:
The rebuildable, user-correctable view of recent, long-term, and negative interests derived from Interest Events. It never changes source proof, content quality, or exact Keyword Monitor matching.
_Avoid_: User embedding, AI profile, chat memory

**Interest Theme**:
A normalized subject associated with qualified content and used to explain or compare interests. A theme is a recommendation aid, not a Keyword Monitor and not a statement the user explicitly made.
_Avoid_: Hidden keyword, user fact, trust label

**Recommendation Decision**:
A versioned record of how qualified candidates were ordered for one user and surface at one time, including protected subscriptions, explanation references, and exploration placement.
_Avoid_: User preference, content judgment

**Exploration Item**:
A qualified Feed Item from an adjacent Interest Theme, inserted within a strict exploration budget and clearly identified as outside the user's direct subscriptions. Exploration Items never enter the daily email.
_Avoid_: Random item, low-quality filler, sponsored result
