import {
  eventEvidenceSchema,
  eventSchema,
  monitorRuleInputSchema,
  monitorRuleSchema,
  notificationSchema,
  sourceSchema,
  type MonitorRuleInput,
} from '@lettermate/contracts';
import { z } from 'zod';

const headers = { 'content-type': 'application/json', 'x-user-id': 'user-a' };

async function apiRequest<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1${path}`, { ...init, headers: { ...headers, ...init?.headers } });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: '请求失败' }));
    throw new Error(error.message ?? `请求失败 (${response.status})`);
  }
  return schema.parse(await response.json());
}

export const api = {
  events: () => apiRequest('/events', z.array(eventSchema)),
  event: (id: string) => apiRequest(`/events/${id}`, z.object({ event: eventSchema, evidence: z.array(eventEvidenceSchema) })),
  rules: () => apiRequest('/monitor-rules', z.array(monitorRuleSchema)),
  createRule: (input: MonitorRuleInput) => apiRequest('/monitor-rules', monitorRuleSchema, {
    method: 'POST', body: JSON.stringify(monitorRuleInputSchema.parse(input)),
  }),
  notifications: () => apiRequest('/notifications', z.array(notificationSchema)),
  readNotification: (id: string) => apiRequest(`/notifications/${id}/read`, notificationSchema, { method: 'POST' }),
  sources: () => apiRequest('/sources', z.array(sourceSchema)),
  createPushSubscription: (input: { endpoint: string; keys: { p256dh: string; auth: string } }) =>
    apiRequest('/push-subscriptions', z.object({ id: z.string(), endpoint: z.url(), createdAt: z.iso.datetime() }).passthrough(), {
      method: 'POST', body: JSON.stringify(input),
    }),
};
