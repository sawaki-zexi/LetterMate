import { z } from 'zod';

export const discoveryKindSchema = z.enum(['hot', 'quality']);
export const runStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed']);

export const topicInputSchema = z.object({
  keyword: z.string().trim().min(1).max(100),
});

export const safeErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
});

export const topicSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  keyword: z.string().min(1).max(100),
  expandedTerms: z.array(z.string().min(1)),
  createdAt: z.iso.datetime(),
  lastRunAt: z.iso.datetime().nullable(),
  runStatus: runStatusSchema,
  lastError: safeErrorSchema.nullable(),
});

export const discoveryCandidateSchema = z.object({
  kind: discoveryKindSchema,
  title: z.string().trim().min(1).max(300),
  summary: z.string().trim().min(1).max(1_000),
  reason: z.string().trim().min(1).max(500),
  sourceUrls: z.array(z.url()).min(1).max(8),
  publishedAt: z.iso.datetime().nullable(),
});

export const discoveryResultSchema = z.object({
  items: z.array(discoveryCandidateSchema).max(30),
  citations: z.array(z.url()).max(100),
});

export const discoveryItemSchema = discoveryCandidateSchema.extend({
  id: z.string().min(1),
  topicId: z.string().min(1),
  discoveredAt: z.iso.datetime(),
});

export const discoveryJobDataSchema = z.object({
  topicId: z.string().min(1),
  userId: z.string().min(1),
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
export type SafeError = z.infer<typeof safeErrorSchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;
