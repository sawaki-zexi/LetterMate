import { z } from 'zod';

export const discoveryQueueName = 'topic-discovery';
export const trendQueueName = 'trend-discovery';

export const discoveryKindSchema = z.enum(['hot', 'quality']);
export const runStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed']);
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
export const feedOriginSchema = z.enum(['all', 'topic', 'trend']);
export const httpUrlSchema = z.url().refine((url) => /^https?:\/\//i.test(url), {
  message: 'URL must use HTTP or HTTPS',
});
export const provenanceKindSchema = z.enum([
  'ai_citation',
  'api_record',
  'feed_entry',
  'fetched_page',
]);

export const discoverySourceStatusSchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
  category: sourceTypeSchema,
  status: z.enum(['enabled', 'not_configured']),
});

export const topicInputSchema = z.object({
  keyword: z.string().trim().min(1).max(100),
});

export const safeErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
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

export const topicFeedItemSchema = discoveryItemSchema.extend({
  origin: z.literal('topic'),
  topicId: z.string().min(1),
}).strict();

export const trendFeedItemSchema = discoveryItemSchema.omit({ topicId: true }).extend({
  origin: z.literal('trend'),
  topicId: z.null(),
}).strict();

export const feedItemSchema = z.discriminatedUnion('origin', [
  topicFeedItemSchema,
  trendFeedItemSchema,
]);

export const discoveryJobDataSchema = z.object({
  topicId: z.string().min(1),
  userId: z.string().min(1),
  trigger: discoveryTriggerSchema,
});

export const trendJobDataSchema = z.strictObject({
  userId: z.string().min(1),
  trigger: discoveryTriggerSchema,
});

export const apiErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
  traceId: z.string().min(1),
});

export type TopicInput = z.infer<typeof topicInputSchema>;
export type Topic = z.infer<typeof topicSchema>;
export type DiscoveryCandidate = z.infer<typeof discoveryCandidateSchema>;
export type DiscoveryResult = z.infer<typeof discoveryResultSchema>;
export type DiscoveryItem = z.infer<typeof discoveryItemSchema>;
export type DiscoveryKind = z.infer<typeof discoveryKindSchema>;
export type DiscoveryJobData = z.infer<typeof discoveryJobDataSchema>;
export type DiscoverySourceStatus = z.infer<typeof discoverySourceStatusSchema>;
export type DiscoveryTrigger = z.infer<typeof discoveryTriggerSchema>;
export type FeedItem = z.infer<typeof feedItemSchema>;
export type FeedOrigin = z.infer<typeof feedOriginSchema>;
export type FeedRange = z.infer<typeof feedRangeSchema>;
export type ProvenanceKind = z.infer<typeof provenanceKindSchema>;
export type RunSummary = z.infer<typeof runSummarySchema>;
export type SafeError = z.infer<typeof safeErrorSchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;
export type SourceType = z.infer<typeof sourceTypeSchema>;
export type TopicFeedItem = z.infer<typeof topicFeedItemSchema>;
export type TrendFeedItem = z.infer<typeof trendFeedItemSchema>;
export type TrendJobData = z.infer<typeof trendJobDataSchema>;
export type TrendStatus = z.infer<typeof trendStatusSchema>;
