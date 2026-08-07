import {
  apiErrorSchema,
  creatorConfirmationInputSchema,
  creatorInputSchema,
  creatorPlatformStatusSchema,
  creatorResolutionInputSchema,
  creatorResolutionResultSchema,
  creatorItemSchema,
  creatorSchema,
  creatorUpdateInputSchema,
  discoverySourceStatusSchema,
  contentFeedbackSchema,
  feedbackInputSchema,
  feedItemSchema,
  feedQuerySchema,
  interestMemorySchema,
  interestMemorySettingsInputSchema,
  topicInputSchema,
  topicUpdateInputSchema,
  topicSchema,
  trendStatusSchema,
  type FeedQueryInput,
  type FeedbackInput,
  type CreatorInput,
  type CreatorConfirmationInput,
  type CreatorResolutionInput,
  type CreatorUpdateInput,
  type TopicInput,
  type TopicUpdateInput,
  type InterestMemorySettingsInput,
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

async function apiDelete(path: string): Promise<void> {
  const response = await fetch(`/api/v1${path}`, { method: 'DELETE', headers });
  if (!response.ok) {
    const raw = await response.json().catch(() => null);
    const parsed = apiErrorSchema.safeParse(raw);
    throw parsed.success
      ? new ApiError(parsed.data.code, parsed.data.message, response.status)
      : new ApiError('HTTP_ERROR', `请求失败 (${response.status})`, response.status);
  }
}

async function apiDeleteResponse<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const response = await fetch(`/api/v1${path}`, { method: 'DELETE', headers });
  if (!response.ok) {
    const raw = await response.json().catch(() => null);
    const parsed = apiErrorSchema.safeParse(raw);
    throw parsed.success
      ? new ApiError(parsed.data.code, parsed.data.message, response.status)
      : new ApiError('HTTP_ERROR', `请求失败 (${response.status})`, response.status);
  }
  return schema.parse(await response.json());
}

export const api = {
  topics: () => apiRequest('/topics', z.array(topicSchema)),
  createTopic: (input: TopicInput) => apiRequest('/topics', topicSchema, {
    method: 'POST',
    body: JSON.stringify(topicInputSchema.parse(input)),
  }),
  updateTopic: (id: string, input: TopicUpdateInput) => apiRequest(
    `/topics/${encodeURIComponent(id)}`,
    topicSchema,
    { method: 'PATCH', body: JSON.stringify(topicUpdateInputSchema.parse(input)) },
  ),
  deleteTopic: (id: string) => apiDelete(`/topics/${encodeURIComponent(id)}`),
  refreshTopic: (id: string) => apiRequest(`/topics/${encodeURIComponent(id)}/refresh`, topicSchema, { method: 'POST' }),
  pauseTopic: (id: string) => apiRequest(`/topics/${encodeURIComponent(id)}/pause`, topicSchema, { method: 'POST' }),
  resumeTopic: (id: string) => apiRequest(`/topics/${encodeURIComponent(id)}/resume`, topicSchema, { method: 'POST' }),
  creators: () => apiRequest('/creators', z.array(creatorSchema)),
  createCreator: (input: CreatorInput) => apiRequest('/creators', creatorSchema, {
    method: 'POST', body: JSON.stringify(creatorInputSchema.parse(input)),
  }),
  resolveCreators: (input: CreatorResolutionInput) => apiRequest(
    '/creators/resolve',
    creatorResolutionResultSchema,
    { method: 'POST', body: JSON.stringify(creatorResolutionInputSchema.parse(input)) },
  ),
  createCreators: (input: CreatorConfirmationInput) => apiRequest(
    '/creators',
    z.array(creatorSchema),
    { method: 'POST', body: JSON.stringify(creatorConfirmationInputSchema.parse(input)) },
  ),
  creatorPlatforms: () => apiRequest(
    '/creator-platforms',
    z.array(creatorPlatformStatusSchema),
  ),
  updateCreator: (id: string, input: CreatorUpdateInput) => apiRequest(
    `/creators/${encodeURIComponent(id)}`,
    creatorSchema,
    { method: 'PATCH', body: JSON.stringify(creatorUpdateInputSchema.parse(input)) },
  ),
  deleteCreator: (id: string) => apiDelete(`/creators/${encodeURIComponent(id)}`),
  refreshCreator: (id: string) => apiRequest(`/creators/${encodeURIComponent(id)}/refresh`, creatorSchema, { method: 'POST' }),
  creatorItems: (id: string) => apiRequest(`/creators/${encodeURIComponent(id)}/items`, z.array(creatorItemSchema)),
  feed: (filter: FeedQueryInput = {}) => {
    const parsed = feedQuerySchema.parse(filter);
    const query = new URLSearchParams(compact({
      topicId: parsed.topicId,
      kind: parsed.kind,
      range: parsed.range,
      origin: parsed.origin,
      q: parsed.q,
    }));
    const suffix = query.size ? `?${query.toString()}` : '';
    return apiRequest(`/feed${suffix}`, z.array(feedItemSchema));
  },
  setFeedback: (contentKey: string, input: FeedbackInput) => apiRequest(
    `/feedback/${encodeURIComponent(contentKey)}`,
    contentFeedbackSchema,
    { method: 'PUT', body: JSON.stringify(feedbackInputSchema.parse(input)) },
  ),
  trendStatus: () => apiRequest('/trends/status', trendStatusSchema),
  refreshTrends: () => apiRequest('/trends/refresh', trendStatusSchema, { method: 'POST' }),
  discoverySources: () => apiRequest(
    '/discovery-sources',
    z.array(discoverySourceStatusSchema),
  ),
  interests: () => apiRequest('/interests', interestMemorySchema),
  setInterestSettings: (input: InterestMemorySettingsInput) => apiRequest(
    '/interests/settings',
    interestMemorySchema,
    {
      method: 'PUT',
      body: JSON.stringify(interestMemorySettingsInputSchema.parse(input)),
    },
  ),
  forgetInterest: (tagId: string) => apiDeleteResponse(
    `/interests/${encodeURIComponent(tagId)}`,
    interestMemorySchema,
  ),
  clearInterestHistory: () => apiDeleteResponse('/interests', interestMemorySchema),
  item: (id: string) => apiRequest(`/items/${encodeURIComponent(id)}`, feedItemSchema),
};
