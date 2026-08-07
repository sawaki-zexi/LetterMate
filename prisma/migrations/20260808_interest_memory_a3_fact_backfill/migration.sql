-- Backfill current-state facts created before the interest event ledger existed.
INSERT INTO "InterestEvent" (
    "id", "userId", "eventType", "sourceRef", "activeKey", "payload", "occurredAt", "recordedAt"
)
SELECT
    'backfill-topic-' || topic."id",
    topic."userId",
    'topic_state'::"InterestEventType",
    topic."id",
    topic."id",
    jsonb_build_object(
        'schemaVersion', 1,
        'state', CASE
            WHEN topic."deletedAt" IS NOT NULL THEN 'deleted'
            WHEN topic."pausedAt" IS NOT NULL THEN 'paused'
            ELSE 'active'
        END,
        'topicId', topic."id",
        'keyword', topic."keyword",
        'normalizedKeyword', topic."normalizedKeyword"
    ),
    COALESCE(topic."deletedAt", topic."pausedAt", topic."createdAt"),
    CURRENT_TIMESTAMP
FROM "Topic" AS topic
ON CONFLICT ("userId", "eventType", "activeKey") DO NOTHING;

INSERT INTO "InterestEvent" (
    "id", "userId", "eventType", "sourceRef", "activeKey", "payload", "occurredAt", "recordedAt"
)
SELECT
    'backfill-creator-' || creator."id",
    creator."userId",
    'creator_state'::"InterestEventType",
    creator."id",
    creator."id",
    jsonb_build_object(
        'schemaVersion', 1,
        'state', CASE
            WHEN creator."cancelledAt" IS NOT NULL THEN 'cancelled'
            WHEN creator."pausedAt" IS NOT NULL THEN 'paused'
            ELSE 'active'
        END,
        'creatorId', creator."id",
        'platform', creator."platform"::text,
        'accountKey', creator."accountKey",
        'displayName', creator."displayName"
    ),
    COALESCE(creator."cancelledAt", creator."pausedAt", creator."createdAt"),
    CURRENT_TIMESTAMP
FROM "CreatorSubscription" AS creator
ON CONFLICT ("userId", "eventType", "activeKey") DO NOTHING;

INSERT INTO "InterestEvent" (
    "id", "userId", "eventType", "sourceRef", "activeKey", "payload", "occurredAt", "recordedAt"
)
SELECT
    'backfill-feedback-' || feedback."id",
    feedback."userId",
    'feedback_state'::"InterestEventType",
    feedback."contentKey",
    feedback."contentKey",
    jsonb_build_object(
        'schemaVersion', 1,
        'state', feedback."value"::text,
        'contentKey', feedback."contentKey"
    ),
    feedback."updatedAt",
    CURRENT_TIMESTAMP
FROM "ContentFeedback" AS feedback
ON CONFLICT ("userId", "eventType", "activeKey") DO NOTHING;
