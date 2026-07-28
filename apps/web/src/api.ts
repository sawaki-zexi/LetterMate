import {
  apiErrorSchema,
  discoveryKindSchema,
  discoverySourceStatusSchema,
  feedItemSchema,
  feedOriginSchema,
  feedRangeSchema,
  topicInputSchema,
  topicSchema,
  trendStatusSchema,
  type DiscoveryKind,
  type FeedOrigin,
  type FeedRange,
  type TopicInput,
} from '@lettermate/contracts';
import { z } from 'zod';

const headers = { 'content-type': 'application/json', 'x-user-id': 'user-a' };

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function compact(values: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

async function apiRequest<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    headers: { ...headers, ...init?.headers },
  });
  if (!response.ok) {
    const raw = await response.json().catch(() => null);
    const parsed = apiErrorSchema.safeParse(raw);
    if (parsed.success) {
      throw new ApiError(parsed.data.code, parsed.data.message, response.status);
    }
    throw new ApiError('HTTP_ERROR', `请求失败 (${response.status})`, response.status);
  }
  return schema.parse(await response.json());
}

export const api = {
  topics: () => apiRequest('/topics', z.array(topicSchema)),
  createTopic: (input: TopicInput) => apiRequest('/topics', topicSchema, {
    method: 'POST',
    body: JSON.stringify(topicInputSchema.parse(input)),
  }),
  refreshTopic: (id: string) => apiRequest(`/topics/${encodeURIComponent(id)}/refresh`, topicSchema, { method: 'POST' }),
  feed: (filter: {
    topicId?: string;
    kind?: DiscoveryKind;
    range?: FeedRange;
    origin?: FeedOrigin;
  } = {}) => {
    const query = new URLSearchParams(compact({
      topicId: filter.topicId,
      kind: filter.kind && discoveryKindSchema.parse(filter.kind),
      range: feedRangeSchema.parse(filter.range ?? '30d'),
      origin: filter.origin && feedOriginSchema.parse(filter.origin),
    }));
    const suffix = query.size ? `?${query.toString()}` : '';
    return apiRequest(`/feed${suffix}`, z.array(feedItemSchema));
  },
  trendStatus: () => apiRequest('/trends/status', trendStatusSchema),
  refreshTrends: () => apiRequest('/trends/refresh', trendStatusSchema, { method: 'POST' }),
  discoverySources: () => apiRequest(
    '/discovery-sources',
    z.array(discoverySourceStatusSchema),
  ),
  item: (id: string) => apiRequest(`/items/${encodeURIComponent(id)}`, feedItemSchema),
};
