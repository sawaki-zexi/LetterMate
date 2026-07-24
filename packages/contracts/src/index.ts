import { z } from 'zod';

export const trustStatusSchema = z.enum(['pending', 'confirmed', 'rejected']);
export const trustLevelSchema = z.enum(['primary', 'secondary', 'interest']);
export const prioritySchema = z.enum(['low', 'normal', 'high']);

export const monitorScopeSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('all') }),
  z.object({ mode: z.literal('types'), sourceTypes: z.array(z.enum(['rss', 'web'])).min(1) }),
  z.object({ mode: z.literal('sources'), sourceIds: z.array(z.string().min(1)).min(1) }),
]);

export const monitorRuleInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  keywords: z.array(z.string().trim().min(1)).min(1).max(20),
  synonyms: z.array(z.string().trim().min(1)).max(40).default([]),
  exclusions: z.array(z.string().trim().min(1)).max(40).default([]),
  scope: monitorScopeSchema.default({ mode: 'all' }),
  priority: prioritySchema.default('normal'),
  notifyImmediately: z.boolean().default(false),
  enabled: z.boolean().default(true),
});

export const monitorRuleSchema = monitorRuleInputSchema.extend({
  id: z.string().min(1),
  userId: z.string().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const eventEvidenceSchema = z.object({
  id: z.string().min(1),
  eventId: z.string().min(1),
  sourceId: z.string().min(1),
  sourceName: z.string().min(1),
  sourceUrl: z.url(),
  title: z.string().min(1),
  publishedAt: z.iso.datetime(),
  trustLevel: trustLevelSchema,
  independenceGroup: z.string().min(1),
  stance: z.enum(['supports', 'contradicts']),
});

export const eventSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  subject: z.string().min(1),
  action: z.string().min(1),
  summary: z.string().nullable(),
  summaryStatus: z.enum(['ready', 'unavailable']),
  status: trustStatusSchema,
  statusReason: z.string().min(1),
  firstPublishedAt: z.iso.datetime(),
  lastDiscoveredAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  sourceCount: z.number().int().nonnegative(),
  matchedRuleIds: z.array(z.string()),
});

export const notificationSchema = z.object({
  id: z.string().min(1),
  eventId: z.string().min(1),
  type: z.enum(['confirmed', 'correction', 'evidence_update']),
  status: z.enum(['unread', 'read']),
  title: z.string().min(1),
  createdAt: z.iso.datetime(),
  readAt: z.iso.datetime().nullable(),
});

export const sourceSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    type: z.enum(['rss', 'web']),
    baseUrl: z.url().optional(),
    trustLevel: trustLevelSchema,
    complianceStatus: z.enum(['pending', 'allowed', 'blocked']),
    independenceGroup: z.string().min(1).optional(),
    enabled: z.boolean(),
    lastSuccessAt: z.iso.datetime().nullable().optional(),
    failureReason: z.string().nullable().optional(),
  })
  .superRefine((source, context) => {
    if (source.complianceStatus !== 'allowed' && source.enabled) {
      context.addIssue({
        code: 'custom',
        path: ['enabled'],
        message: 'Only allowed sources can be enabled',
      });
    }
  });

export const apiErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
  traceId: z.string().min(1),
});

export type MonitorRuleInput = z.infer<typeof monitorRuleInputSchema>;
export type MonitorRule = z.infer<typeof monitorRuleSchema>;
export type Event = z.infer<typeof eventSchema>;
export type EventEvidence = z.infer<typeof eventEvidenceSchema>;
export type Notification = z.infer<typeof notificationSchema>;
export type Source = z.infer<typeof sourceSchema>;
export type TrustStatus = z.infer<typeof trustStatusSchema>;
export type TrustLevel = z.infer<typeof trustLevelSchema>;
