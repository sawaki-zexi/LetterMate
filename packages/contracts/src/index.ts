import { z } from 'zod';

export const discoveryQueueName = 'topic-discovery';
export const trendQueueName = 'trend-discovery';
export const creatorQueueName = 'creator-discovery';
export const digestQueueName = 'daily-digest';
export const digestVerificationQueueName = 'digest-email-verification';
export const digestTestEmailQueueName = 'digest-test-email';
export const maxTopicExpandedTerms = 32;
export const defaultFeedPageLimit = 30;
export const maxFeedPageLimit = 50;

export const discoveryKindSchema = z.enum(['hot', 'quality']);
export const runStatusSchema = z.enum(['queued', 'running', 'succeeded', 'degraded', 'failed']);
export const sourceTypeSchema = z.enum([
  'web',
  'feed',
  'social',
  'video',
  'community',
  'code',
  'paper',
]);
export const discoveryTriggerSchema = z.enum(['initial', 'manual', 'scheduled']);
export const feedRangeSchema = z.enum(['1d', '3d', '7d', '30d', '90d', 'all']);
export const feedOriginSchema = z.enum(['all', 'topic', 'trend', 'creator']);
export const readingStateSchema = z.enum(['saved', 'archived']);
export const feedbackValueSchema = z.enum(['interested', 'less']);
export const interestEventTypeSchema = z.enum([
  'topic_state',
  'creator_state',
  'feedback_state',
]);
export const interestTagKindSchema = z.enum(['topic', 'entity', 'content_type']);
export const interestTagStatusSchema = z.enum(['active', 'retired']);
export const httpUrlSchema = z.url().refine((url) => /^https?:\/\//i.test(url), {
  message: 'URL must use HTTP or HTTPS',
});
export const provenanceKindSchema = z.enum([
  'ai_citation',
  'api_record',
  'feed_entry',
  'fetched_page',
]);

export const creatorPlatformSchema = z.enum(['rss', 'x', 'bilibili', 'youtube', 'bluesky']);
export const creatorContentTypeSchema = z.enum(['original', 'repost', 'reply']);
export const creatorLegacyInputSchema = z.strictObject({
  url: httpUrlSchema,
});
export const creatorResolutionInputSchema = z.strictObject({
  input: z.string().trim().min(1).max(500),
});
export const creatorConfirmationInputSchema = z.strictObject({
  resolutionTokens: z.array(z.string().trim().min(16).max(10_000)).min(1).max(10),
});
export const creatorInputSchema = z.union([
  creatorLegacyInputSchema,
  creatorConfirmationInputSchema,
]);
export const creatorIdentityCandidateSchema = z.strictObject({
  resolutionToken: z.string().trim().min(16).max(10_000),
  platform: creatorPlatformSchema,
  displayName: z.string().trim().min(1).max(200),
  handle: z.string().trim().min(1).max(200).nullable(),
  avatarUrl: httpUrlSchema.nullable(),
  bio: z.string().trim().min(1).max(1_000).nullable(),
  verified: z.boolean().nullable(),
  profileUrl: httpUrlSchema,
  feedUrl: httpUrlSchema.nullable(),
});
export const creatorResolutionResultSchema = z.strictObject({
  candidates: z.array(creatorIdentityCandidateSchema).max(25),
});
export const creatorPlatformStatusSchema = z.strictObject({
  id: creatorPlatformSchema,
  label: z.string().trim().min(1).max(100),
  status: z.enum(['enabled', 'not_configured']),
});
export const creatorUpdateInputSchema = z.object({
  paused: z.boolean(),
});

export const discoverySourceStatusSchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
  category: sourceTypeSchema,
  status: z.enum(['enabled', 'not_configured']),
});

export const topicInputSchema = z.object({
  keyword: z.string().trim().min(1).max(100),
});

const feedSearchTextSchema = z.string().trim().max(100)
  .transform((value) => value || undefined)
  .optional();

export const feedQuerySchema = z.strictObject({
  topicId: z.string().trim().min(1).optional(),
  kind: discoveryKindSchema.optional(),
  range: feedRangeSchema.default('30d'),
  origin: feedOriginSchema.default('all'),
  q: feedSearchTextSchema,
  reading: readingStateSchema.optional(),
  limit: z.coerce.number().int().min(1).max(maxFeedPageLimit).default(defaultFeedPageLimit),
  cursor: z.string().trim().min(1).max(1024).regex(/^[A-Za-z0-9_-]+$/u).optional(),
}).superRefine((filter, context) => {
  if (filter.topicId && (filter.origin === 'trend' || filter.origin === 'creator')) {
    context.addIssue({
      code: 'custom',
      path: ['origin'],
      message: 'topicId cannot be combined with trend origin',
    });
  }
});

export const topicUpdateInputSchema = z.object({
  keyword: z.string().trim().min(1).max(100),
  /** @deprecated Internal query variants are regenerated from the keyword. */
  expandedTerms: z.array(z.string().trim().min(1).max(100)).max(maxTopicExpandedTerms).optional(),
}).superRefine(({ expandedTerms }, context) => {
  if (expandedTerms === undefined) return;
  const normalizedTerms = new Set<string>();
  expandedTerms.forEach((term, index) => {
    const normalizedTerm = term.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
    if (normalizedTerms.has(normalizedTerm)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: '扩展词不能重复',
        path: ['expandedTerms', index],
      });
      return;
    }
    normalizedTerms.add(normalizedTerm);
  });
});

export const safeErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
});

export const creatorDegradedSourceSchema = z.strictObject({
  source: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/),
  code: z.string().trim().regex(/^[A-Z0-9][A-Z0-9_-]{0,79}$/),
  retryable: z.boolean(),
});

const runSummaryBaseShape = {
  id: z.string().min(1),
  trigger: discoveryTriggerSchema,
  startedAt: z.iso.datetime(),
};

export const runSummarySchema = z.discriminatedUnion('status', [
  z.strictObject({
    ...runSummaryBaseShape,
    status: z.literal('queued'),
    finishedAt: z.null(),
    newItemCount: z.null(),
  }),
  z.strictObject({
    ...runSummaryBaseShape,
    status: z.literal('running'),
    finishedAt: z.null(),
    newItemCount: z.null(),
  }),
  z.strictObject({
    ...runSummaryBaseShape,
    status: z.literal('succeeded'),
    finishedAt: z.iso.datetime(),
    newItemCount: z.number().int().nonnegative(),
  }),
  z.strictObject({
    ...runSummaryBaseShape,
    status: z.literal('degraded'),
    finishedAt: z.iso.datetime(),
    newItemCount: z.number().int().nonnegative(),
  }),
  z.strictObject({
    ...runSummaryBaseShape,
    status: z.literal('failed'),
    finishedAt: z.iso.datetime(),
    newItemCount: z.null(),
  }),
]);

export const topicSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  keyword: z.string().min(1).max(100),
  expandedTerms: z.array(z.string().min(1)),
  createdAt: z.iso.datetime(),
  pausedAt: z.iso.datetime().nullable().default(null),
  lastRunAt: z.iso.datetime().nullable(),
  nextRunAt: z.iso.datetime().nullable(),
  scheduleIntervalHours: z.union([z.literal(6), z.literal(12), z.literal(24)]),
  runStatus: runStatusSchema,
  lastError: safeErrorSchema.nullable(),
  lastRun: runSummarySchema.nullable(),
});

export const trendStatusSchema = z.object({
  runStatus: runStatusSchema,
  nextRunAt: z.iso.datetime().nullable(),
  intervalHours: z.number().int().min(2).max(24),
  lastError: safeErrorSchema.nullable(),
  lastRun: runSummarySchema.nullable(),
}).strict();

export const discoveryCandidateSchema = z.object({
  kind: discoveryKindSchema,
  title: z.string().trim().min(1).max(300),
  summary: z.string().trim().min(1).max(1_000),
  reason: z.string().trim().min(1).max(500),
  sourceUrls: z.array(httpUrlSchema).min(1).max(8),
  publishedAt: z.iso.datetime().nullable(),
  sourceType: sourceTypeSchema,
  platform: z.string().trim().min(1),
  authorName: z.string().trim().min(1).nullable(),
  authorHandle: z.string().trim().min(1).nullable(),
  externalId: z.string().trim().min(1).nullable(),
  provenanceKind: provenanceKindSchema,
});

export const discoveryResultSchema = z.object({
  items: z.array(discoveryCandidateSchema).max(30),
  citations: z.array(httpUrlSchema).max(100),
});

export const discoveryItemSchema = discoveryCandidateSchema.extend({
  id: z.string().min(1),
  topicId: z.string().min(1),
  discoveredAt: z.iso.datetime(),
});

export const creatorItemSchema = discoveryCandidateSchema.extend({
  id: z.string().min(1),
  creatorId: z.string().min(1),
  discoveredAt: z.iso.datetime(),
  feedEligible: z.boolean(),
  contentType: creatorContentTypeSchema,
  originalAuthorName: z.string().trim().min(1).nullable(),
  originalAuthorHandle: z.string().trim().min(1).nullable(),
  originalContentId: z.string().trim().min(1).nullable(),
  originalContentUrl: httpUrlSchema.nullable(),
  parentContentId: z.string().trim().min(1).nullable(),
  parentContentUrl: httpUrlSchema.nullable(),
  parentContentText: z.string().trim().min(1).max(5_000).nullable(),
});

export const topicFeedOriginSchema = z.strictObject({
  origin: z.literal('topic'),
  topicId: z.string().min(1),
  topicKeyword: z.string().trim().min(1).max(100),
  topicKeywordActive: z.boolean(),
});

export const trendFeedOriginSchema = z.strictObject({
  origin: z.literal('trend'),
});

export const creatorFeedOriginSchema = z.strictObject({
  origin: z.literal('creator'),
  creatorId: z.string().min(1),
  creatorName: z.string().trim().min(1),
  platform: z.string().trim().min(1),
  contentType: creatorContentTypeSchema,
});

export const feedOriginDetailSchema = z.discriminatedUnion('origin', [
  topicFeedOriginSchema,
  trendFeedOriginSchema,
  creatorFeedOriginSchema,
]);

export const recommendationLaneSchema = z.enum([
  'subscription', 'interest', 'trend', 'exploration',
]);
export const recommendationReasonSchema = z.enum([
  'followed_topic',
  'followed_creator',
  'related_interest',
  'recent_hot',
  'exploration',
]);
export const feedRecommendationSchema = z.strictObject({
  lane: recommendationLaneSchema,
  reason: recommendationReasonSchema,
  isExploration: z.boolean(),
  decisionId: z.string().trim().min(1).max(200).optional(),
});

const feedMergeFields = {
  contentKey: httpUrlSchema,
  origins: z.array(feedOriginDetailSchema).min(1).max(50),
  feedback: feedbackValueSchema.nullable(),
  readingState: readingStateSchema.nullable().optional(),
  recommendation: feedRecommendationSchema.optional(),
};

export const feedbackInputSchema = z.strictObject({
  value: feedbackValueSchema.nullable(),
});

export const contentFeedbackSchema = z.strictObject({
  contentKey: httpUrlSchema,
  value: feedbackValueSchema.nullable(),
});

export const savedContentInputSchema = z.strictObject({
  state: readingStateSchema.nullable(),
});

export const savedContentBatchInputSchema = z.strictObject({
  contentKeys: z.array(httpUrlSchema).min(1).max(maxFeedPageLimit),
  state: z.literal('archived'),
}).superRefine((input, context) => {
  const keys = input.contentKeys.map((key) => key.toLowerCase());
  if (new Set(keys).size !== keys.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['contentKeys'],
      message: 'contentKeys must not contain duplicates',
    });
  }
});

export const savedContentSchema = z.strictObject({
  contentKey: httpUrlSchema,
  state: readingStateSchema.nullable(),
});

export const savedContentBatchSchema = z.strictObject({
  items: z.array(savedContentSchema).max(maxFeedPageLimit),
});

export const feedImpressionInputSchema = z.strictObject({
  decisionId: z.string().trim().min(1).max(200),
  contentKeys: z.array(httpUrlSchema).min(1).max(100),
}).superRefine((input, context) => {
  const keys = input.contentKeys.map((key) => key.toLowerCase());
  if (new Set(keys).size !== keys.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['contentKeys'],
      message: '曝光内容不能重复',
    });
  }
});

export const feedImpressionReceiptSchema = z.strictObject({
  recorded: z.number().int().nonnegative(),
});

export const topicInterestEventPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  state: z.enum(['active', 'paused', 'deleted']),
  topicId: z.string().min(1),
  keyword: z.string().trim().min(1).max(100),
  normalizedKeyword: z.string().trim().min(1).max(100),
});

export const creatorInterestEventPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  state: z.enum(['active', 'paused', 'cancelled']),
  creatorId: z.string().min(1),
  platform: creatorPlatformSchema,
  accountKey: z.string().trim().min(1).max(2_000),
  displayName: z.string().trim().min(1).max(200),
});

export const feedbackInterestEventPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  state: feedbackValueSchema.nullable(),
  contentKey: httpUrlSchema,
});

const interestEventBaseShape = {
  id: z.string().min(1),
  userId: z.string().min(1),
  sourceRef: z.string().min(1),
  occurredAt: z.iso.datetime(),
  recordedAt: z.iso.datetime(),
  supersededAt: z.iso.datetime().nullable(),
};

export const interestEventSchema = z.discriminatedUnion('eventType', [
  z.strictObject({
    ...interestEventBaseShape,
    eventType: z.literal('topic_state'),
    payload: topicInterestEventPayloadSchema,
  }),
  z.strictObject({
    ...interestEventBaseShape,
    eventType: z.literal('creator_state'),
    payload: creatorInterestEventPayloadSchema,
  }),
  z.strictObject({
    ...interestEventBaseShape,
    eventType: z.literal('feedback_state'),
    payload: feedbackInterestEventPayloadSchema,
  }),
]);

export const interestTagSuggestionSchema = z.strictObject({
  slug: z.string().trim().min(1).max(100)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  displayName: z.string().trim().min(1).max(100),
  kind: interestTagKindSchema,
  confidence: z.number().min(0).max(1),
});

export const interestTagExtractionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  tags: z.array(interestTagSuggestionSchema).min(1).max(5),
});

export const interestThemeSourceSchema = z.enum(['keyword', 'creator', 'feedback']);
export const interestMemoryThemeSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(100),
  kind: interestTagKindSchema,
  sources: z.array(interestThemeSourceSchema).min(1).max(3),
  updatedAt: z.iso.datetime(),
});
export const interestMemorySchema = z.strictObject({
  personalizationEnabled: z.boolean(),
  resetAt: z.iso.datetime().nullable(),
  recent: z.array(interestMemoryThemeSchema).max(100),
  longTerm: z.array(interestMemoryThemeSchema).max(100),
  reduced: z.array(interestMemoryThemeSchema).max(100),
});
export const interestMemorySettingsInputSchema = z.strictObject({
  personalizationEnabled: z.boolean(),
});

export const localSendTimeSchema = z.string().regex(
  /^(?:[01]\d|2[0-3]):[0-5]\d$/,
  '发送时间必须使用 24 小时制 HH:mm 格式',
);

export const ianaTimeZoneSchema = z.string().trim().min(1).max(100).refine((value) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}, '时区必须是有效的 IANA 时区');

export const digestPreferenceInputSchema = z.strictObject({
  enabled: z.boolean(),
  localTime: localSendTimeSchema,
  timezone: ianaTimeZoneSchema,
});

export const digestPreferenceSchema = digestPreferenceInputSchema;

export const digestRecipientStatusSchema = z.enum([
  'unverified', 'pending', 'verified', 'suppressed',
]);

export const digestRecipientSchema = z.strictObject({
  email: z.email().nullable(),
  status: digestRecipientStatusSchema,
  verifiedAt: z.iso.datetime().nullable(),
});

export const digestRecipientInputSchema = z.strictObject({
  email: z.email(),
});

export const digestRecipientVerificationInputSchema = z.strictObject({
  token: z.string().min(32).max(500),
});

export const digestRecipientVerificationResultSchema = z.strictObject({
  status: z.literal('verified'),
});

export const digestUnsubscribeInputSchema = z.strictObject({
  token: z.string().min(32).max(500),
});

export const digestUnsubscribeResultSchema = z.strictObject({
  status: z.literal('unsubscribed'),
});

export const digestVerificationJobDataSchema = z.strictObject({
  verificationId: z.string().min(1),
  recipient: z.email(),
  verificationUrl: httpUrlSchema,
  expiresAt: z.iso.datetime(),
});

export const digestTestEmailStatusSchema = z.enum([
  'queued', 'running', 'retrying', 'succeeded', 'failed',
]);

export const digestTestEmailSchema = z.strictObject({
  id: z.string().min(1),
  status: digestTestEmailStatusSchema,
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  errorCode: z.string().min(1).max(100).nullable(),
});

export const digestTestEmailJobDataSchema = z.strictObject({
  testEmailId: z.string().min(1),
  userId: z.string().min(1),
});

export const digestBriefSchema = z.strictObject({
  conclusion: z.string().trim().min(1),
  evidence: z.string().trim().min(1),
  uncertainty: z.string().trim().min(1),
  followUp: z.string().trim().min(1),
});

export const digestCitationSchema = z.strictObject({
  contentKey: httpUrlSchema,
  url: httpUrlSchema,
  platform: z.string().trim().min(1).max(200),
  publishedAt: z.iso.datetime().nullable(),
});

export const digestPreviewItemSchema = z.strictObject({
  contentKey: httpUrlSchema,
  title: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  reason: z.string().trim().min(1),
  sourceUrl: httpUrlSchema,
  publishedAt: z.iso.datetime().nullable(),
  platform: z.string().trim().min(1).max(200),
  brief: digestBriefSchema,
  citations: z.array(digestCitationSchema).min(1).max(20),
});

export const digestPreviewSchema = z.strictObject({
  generatedAt: z.iso.datetime(),
  items: z.array(digestPreviewItemSchema).max(10),
});

export const digestJobDataSchema = z.strictObject({
  runId: z.string().min(1),
  userId: z.string().min(1),
});

export const digestRunStatusSchema = z.enum([
  'queued', 'running', 'succeeded', 'skipped', 'failed',
]);

export const digestRecentRunSchema = z.strictObject({
  status: digestRunStatusSchema,
  scheduledLocalDate: z.iso.date(),
  finishedAt: z.iso.datetime().nullable(),
  itemCount: z.number().int().min(0).max(10),
}).nullable();

export const digestDeliveryCapabilitySchema = z.enum(['configured', 'not_configured']);

export const digestNextLocalSendSchema = z.strictObject({
  localDate: z.iso.date(),
  localTime: localSendTimeSchema,
  timezone: ianaTimeZoneSchema,
}).nullable();

export const digestStatusSchema = z.strictObject({
  deliveryCapability: digestDeliveryCapabilitySchema,
  nextLocalSend: digestNextLocalSendSchema,
  recentRun: digestRecentRunSchema,
});

export const authLoginInputSchema = z.strictObject({
  email: z.email(),
  password: z.string().min(8).max(200),
});

export const authRegisterInputSchema = authLoginInputSchema.extend({
  timezone: ianaTimeZoneSchema.default('Asia/Shanghai'),
});

export const authUserSchema = z.strictObject({
  id: z.string().min(1),
  email: z.email(),
  timezone: ianaTimeZoneSchema,
});

export const authSessionSchema = z.strictObject({
  authenticated: z.boolean(),
  user: authUserSchema.nullable(),
  csrfToken: z.string().min(16).nullable(),
});

export const topicFeedItemSchema = discoveryItemSchema.extend({
  origin: z.literal('topic'),
  topicId: z.string().min(1),
  topicKeyword: z.string().trim().min(1).max(100),
  topicKeywordActive: z.boolean(),
  ...feedMergeFields,
}).strict();

export const trendFeedItemSchema = discoveryItemSchema.omit({ topicId: true }).extend({
  origin: z.literal('trend'),
  topicId: z.null(),
  ...feedMergeFields,
}).strict();

export const creatorFeedItemSchema = discoveryCandidateSchema.extend({
  id: z.string().min(1),
  topicId: z.null(),
  origin: z.literal('creator'),
  creatorId: z.string().min(1),
  creatorName: z.string().trim().min(1),
  discoveredAt: z.iso.datetime(),
  feedEligible: z.literal(true),
  ...feedMergeFields,
}).strict();

export const feedItemSchema = z.discriminatedUnion('origin', [
  topicFeedItemSchema,
  trendFeedItemSchema,
  creatorFeedItemSchema,
]);

export const feedPageSchema = z.strictObject({
  items: z.array(feedItemSchema).max(maxFeedPageLimit),
  nextCursor: z.string().min(1).max(1024).nullable(),
  truncated: z.boolean(),
});

export const discoveryJobDataSchema = z.object({
  topicId: z.string().min(1),
  userId: z.string().min(1),
  trigger: discoveryTriggerSchema,
});

export const trendJobDataSchema = z.discriminatedUnion('trigger', [
  z.strictObject({
    userId: z.string().min(1),
    trigger: z.literal('manual'),
    runId: z.string().min(1),
  }),
  z.strictObject({
    userId: z.string().min(1),
    trigger: z.literal('scheduled'),
    dueAt: z.iso.datetime(),
  }),
]);

export const creatorJobDataSchema = z.object({
  creatorId: z.string().min(1),
  userId: z.string().min(1),
  trigger: z.enum(['manual', 'scheduled']),
});

export const creatorSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  platform: creatorPlatformSchema,
  displayName: z.string().trim().min(1),
  profileUrl: httpUrlSchema,
  feedUrl: httpUrlSchema.nullable(),
  createdAt: z.iso.datetime(),
  pausedAt: z.iso.datetime().nullable(),
  lastRunAt: z.iso.datetime().nullable(),
  nextRunAt: z.iso.datetime().nullable(),
  runStatus: runStatusSchema,
  lastError: safeErrorSchema.nullable(),
  degradedSources: z.array(creatorDegradedSourceSchema).max(16).default([]),
  lastRun: runSummarySchema.nullable(),
});

export const apiErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
  traceId: z.string().min(1),
});

export const healthDependencySchema = z.strictObject({
  status: z.enum(['ok', 'error', 'not_configured']),
  code: z.string().min(1).optional(),
});

export const readinessSchema = z.strictObject({
  status: z.enum(['ok', 'degraded']),
  timestamp: z.iso.datetime(),
  dependencies: z.record(z.string().min(1), healthDependencySchema),
});

export const agentRunStageSchema = z.enum([
  'plan',
  'collect',
  'classify',
  'retrieve',
  'quality_gate',
  'persist',
]);

export const operationalLogSchema = z.strictObject({
  timestamp: z.iso.datetime(),
  level: z.enum(['info', 'warn', 'error']),
  service: z.enum(['api', 'worker']),
  event: z.string().trim().min(1).max(100),
  component: z.string().trim().min(1).max(100).optional(),
  stage: agentRunStageSchema.optional(),
  traceId: z.string().trim().min(1).max(100).optional(),
  runId: z.string().trim().min(1).max(100).optional(),
  jobId: z.string().trim().min(1).max(200).optional(),
  queue: z.string().trim().min(1).max(100).optional(),
  method: z.string().trim().min(1).max(20).optional(),
  path: z.string().trim().min(1).max(500).optional(),
  statusCode: z.number().int().min(100).max(599).optional(),
  durationMs: z.number().int().nonnegative().optional(),
  attempt: z.number().int().positive().optional(),
  code: z.string().trim().min(1).max(100).optional(),
  dependency: z.enum(['database', 'redis', 'external']).optional(),
  counts: z.strictObject({
    waiting: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    delayed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }).optional(),
  metrics: z.strictObject({
    inputCount: z.number().int().nonnegative().optional(),
    outputCount: z.number().int().nonnegative().optional(),
    failureCount: z.number().int().nonnegative().optional(),
  }).optional(),
});

export type TopicInput = z.infer<typeof topicInputSchema>;
export type TopicUpdateInput = z.infer<typeof topicUpdateInputSchema>;
export type Topic = z.infer<typeof topicSchema>;
export type DiscoveryCandidate = z.infer<typeof discoveryCandidateSchema>;
export type DiscoveryResult = z.infer<typeof discoveryResultSchema>;
export type DiscoveryItem = z.infer<typeof discoveryItemSchema>;
export type Creator = z.infer<typeof creatorSchema>;
export type CreatorDegradedSource = z.infer<typeof creatorDegradedSourceSchema>;
export type CreatorInput = z.infer<typeof creatorInputSchema>;
export type CreatorConfirmationInput = z.infer<typeof creatorConfirmationInputSchema>;
export type CreatorIdentityCandidate = z.infer<typeof creatorIdentityCandidateSchema>;
export type CreatorLegacyInput = z.infer<typeof creatorLegacyInputSchema>;
export type CreatorPlatformStatus = z.infer<typeof creatorPlatformStatusSchema>;
export type CreatorPlatform = z.infer<typeof creatorPlatformSchema>;
export type CreatorResolutionInput = z.infer<typeof creatorResolutionInputSchema>;
export type CreatorResolutionResult = z.infer<typeof creatorResolutionResultSchema>;
export type CreatorUpdateInput = z.infer<typeof creatorUpdateInputSchema>;
export type CreatorItem = z.infer<typeof creatorItemSchema>;
export type CreatorContentType = z.infer<typeof creatorContentTypeSchema>;
export type CreatorJobData = z.infer<typeof creatorJobDataSchema>;
export type DiscoveryKind = z.infer<typeof discoveryKindSchema>;
export type DiscoveryJobData = z.infer<typeof discoveryJobDataSchema>;
export type DiscoverySourceStatus = z.infer<typeof discoverySourceStatusSchema>;
export type DiscoveryTrigger = z.infer<typeof discoveryTriggerSchema>;
export type FeedItem = z.infer<typeof feedItemSchema>;
export type FeedPage = z.infer<typeof feedPageSchema>;
export type FeedbackInput = z.infer<typeof feedbackInputSchema>;
export type FeedImpressionInput = z.infer<typeof feedImpressionInputSchema>;
export type FeedImpressionReceipt = z.infer<typeof feedImpressionReceiptSchema>;
export type FeedbackValue = z.infer<typeof feedbackValueSchema>;
export type ContentFeedback = z.infer<typeof contentFeedbackSchema>;
export type SavedContentInput = z.infer<typeof savedContentInputSchema>;
export type SavedContentBatchInput = z.infer<typeof savedContentBatchInputSchema>;
export type SavedContent = z.infer<typeof savedContentSchema>;
export type SavedContentBatch = z.infer<typeof savedContentBatchSchema>;
export type ReadingState = z.infer<typeof readingStateSchema>;
export type InterestEvent = z.infer<typeof interestEventSchema>;
export type InterestEventType = z.infer<typeof interestEventTypeSchema>;
export type InterestTagExtraction = z.infer<typeof interestTagExtractionSchema>;
export type InterestTagKind = z.infer<typeof interestTagKindSchema>;
export type InterestTagSuggestion = z.infer<typeof interestTagSuggestionSchema>;
export type FeedRecommendation = z.infer<typeof feedRecommendationSchema>;
export type InterestMemory = z.infer<typeof interestMemorySchema>;
export type InterestMemoryTheme = z.infer<typeof interestMemoryThemeSchema>;
export type InterestMemorySettingsInput = z.infer<typeof interestMemorySettingsInputSchema>;
export type DigestPreference = z.infer<typeof digestPreferenceSchema>;
export type DigestPreferenceInput = z.infer<typeof digestPreferenceInputSchema>;
export type DigestRecipientStatus = z.infer<typeof digestRecipientStatusSchema>;
export type DigestRecipient = z.infer<typeof digestRecipientSchema>;
export type DigestRecipientInput = z.infer<typeof digestRecipientInputSchema>;
export type DigestRecipientVerificationInput = z.infer<typeof digestRecipientVerificationInputSchema>;
export type DigestRecipientVerificationResult = z.infer<typeof digestRecipientVerificationResultSchema>;
export type DigestUnsubscribeInput = z.infer<typeof digestUnsubscribeInputSchema>;
export type DigestUnsubscribeResult = z.infer<typeof digestUnsubscribeResultSchema>;
export type DigestVerificationJobData = z.infer<typeof digestVerificationJobDataSchema>;
export type DigestTestEmailStatus = z.infer<typeof digestTestEmailStatusSchema>;
export type DigestTestEmail = z.infer<typeof digestTestEmailSchema>;
export type DigestTestEmailJobData = z.infer<typeof digestTestEmailJobDataSchema>;
export type DigestBrief = z.infer<typeof digestBriefSchema>;
export type DigestCitation = z.infer<typeof digestCitationSchema>;
export type DigestPreview = z.infer<typeof digestPreviewSchema>;
export type DigestPreviewItem = z.infer<typeof digestPreviewItemSchema>;
export type DigestJobData = z.infer<typeof digestJobDataSchema>;
export type DigestRunStatus = z.infer<typeof digestRunStatusSchema>;
export type DigestRecentRun = z.infer<typeof digestRecentRunSchema>;
export type DigestDeliveryCapability = z.infer<typeof digestDeliveryCapabilitySchema>;
export type DigestNextLocalSend = z.infer<typeof digestNextLocalSendSchema>;
export type DigestStatus = z.infer<typeof digestStatusSchema>;
export type AuthLoginInput = z.infer<typeof authLoginInputSchema>;
export type AuthRegisterInput = z.infer<typeof authRegisterInputSchema>;
export type AuthUser = z.infer<typeof authUserSchema>;
export type AuthSession = z.infer<typeof authSessionSchema>;
export type RecommendationLane = z.infer<typeof recommendationLaneSchema>;
export type RecommendationReason = z.infer<typeof recommendationReasonSchema>;
export type FeedOrigin = z.infer<typeof feedOriginSchema>;
export type FeedOriginDetail = z.infer<typeof feedOriginDetailSchema>;
export type FeedQuery = z.infer<typeof feedQuerySchema>;
export type FeedQueryInput = z.input<typeof feedQuerySchema>;
export type FeedRange = z.infer<typeof feedRangeSchema>;
export type HealthDependency = z.infer<typeof healthDependencySchema>;
export type ProvenanceKind = z.infer<typeof provenanceKindSchema>;
export type Readiness = z.infer<typeof readinessSchema>;
export type OperationalLog = z.infer<typeof operationalLogSchema>;
export type AgentRunStage = z.infer<typeof agentRunStageSchema>;
export type RunSummary = z.infer<typeof runSummarySchema>;
export type SafeError = z.infer<typeof safeErrorSchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;
export type SourceType = z.infer<typeof sourceTypeSchema>;
export type TopicFeedItem = z.infer<typeof topicFeedItemSchema>;
export type TrendFeedItem = z.infer<typeof trendFeedItemSchema>;
export type TrendJobData = z.infer<typeof trendJobDataSchema>;
export type CreatorFeedItem = z.infer<typeof creatorFeedItemSchema>;
export type TrendStatus = z.infer<typeof trendStatusSchema>;
