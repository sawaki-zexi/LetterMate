import {
  apiErrorSchema,
  authLoginInputSchema,
  authRegisterInputSchema,
  authSessionSchema,
  creatorConfirmationInputSchema,
  creatorInputSchema,
  creatorPlatformStatusSchema,
  creatorResolutionInputSchema,
  creatorResolutionResultSchema,
  creatorItemSchema,
  creatorSchema,
  creatorUpdateInputSchema,
  digestPreferenceInputSchema,
  digestPreferenceSchema,
  digestPreviewSchema,
  digestStatusSchema,
  discoverySourceStatusSchema,
  contentFeedbackSchema,
  feedImpressionInputSchema,
  feedImpressionReceiptSchema,
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
  type FeedImpressionInput,
  type FeedbackInput,
  type CreatorInput,
  type CreatorConfirmationInput,
  type CreatorResolutionInput,
  type CreatorUpdateInput,
  type TopicInput,
  type TopicUpdateInput,
  type InterestMemorySettingsInput,
  type DigestPreferenceInput,
  type AuthLoginInput,
  type AuthRegisterInput,
} from '@lettermate/contracts';
import { z } from 'zod';

let csrfToken: string | null = null;

const requestHeaders = (init?: RequestInit): Headers => {
  const headers = new Headers(init?.headers);
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  if (import.meta.env.DEV) headers.set('x-user-id', 'user-a');
  const method = (init?.method ?? 'GET').toUpperCase();
  if (csrfToken && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    headers.set('x-csrf-token', csrfToken);
  }
  return headers;
};

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
    credentials: 'include',
    headers: requestHeaders(init),
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
  const init = { method: 'DELETE' } satisfies RequestInit;
  const response = await fetch(`/api/v1${path}`, {
    ...init, credentials: 'include', headers: requestHeaders(init),
  });
  if (!response.ok) {
    const raw = await response.json().catch(() => null);
    const parsed = apiErrorSchema.safeParse(raw);
    throw parsed.success
      ? new ApiError(parsed.data.code, parsed.data.message, response.status)
      : new ApiError('HTTP_ERROR', `请求失败 (${response.status})`, response.status);
  }
}

async function apiDeleteResponse<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const init = { method: 'DELETE' } satisfies RequestInit;
  const response = await fetch(`/api/v1${path}`, {
    ...init, credentials: 'include', headers: requestHeaders(init),
  });
  if (!response.ok) {
    const raw = await response.json().catch(() => null);
    const parsed = apiErrorSchema.safeParse(raw);
    throw parsed.success
      ? new ApiError(parsed.data.code, parsed.data.message, response.status)
      : new ApiError('HTTP_ERROR', `请求失败 (${response.status})`, response.status);
  }
  return schema.parse(await response.json());
}

async function apiVoid(path: string, init: RequestInit): Promise<void> {
  const response = await fetch(`/api/v1${path}`, {
    ...init, credentials: 'include', headers: requestHeaders(init),
  });
  if (!response.ok) {
    const raw = await response.json().catch(() => null);
    const parsed = apiErrorSchema.safeParse(raw);
    throw parsed.success
      ? new ApiError(parsed.data.code, parsed.data.message, response.status)
      : new ApiError('HTTP_ERROR', `请求失败 (${response.status})`, response.status);
  }
}

const rememberSession = <T extends { csrfToken: string | null }>(session: T): T => {
  csrfToken = session.csrfToken;
  return session;
};

export const api = {
  session: async () => rememberSession(await apiRequest('/auth/session', authSessionSchema)),
  login: async (input: AuthLoginInput) => rememberSession(await apiRequest(
    '/auth/login',
    authSessionSchema,
    { method: 'POST', body: JSON.stringify(authLoginInputSchema.parse(input)) },
  )),
  register: async (input: AuthRegisterInput) => rememberSession(await apiRequest(
    '/auth/register',
    authSessionSchema,
    { method: 'POST', body: JSON.stringify(authRegisterInputSchema.parse(input)) },
  )),
  logout: async () => {
    await apiVoid('/auth/logout', { method: 'POST' });
    csrfToken = null;
  },
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
  recordFeedImpressions: (input: FeedImpressionInput) => apiRequest(
    '/impressions',
    feedImpressionReceiptSchema,
    { method: 'POST', body: JSON.stringify(feedImpressionInputSchema.parse(input)) },
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
  digestPreference: () => apiRequest('/digest-preference', digestPreferenceSchema),
  setDigestPreference: (input: DigestPreferenceInput) => apiRequest(
    '/digest-preference',
    digestPreferenceSchema,
    {
      method: 'PUT',
      body: JSON.stringify(digestPreferenceInputSchema.parse(input)),
    },
  ),
  digestPreview: () => apiRequest('/digest-preview', digestPreviewSchema),
  digestStatus: () => apiRequest('/digest-status', digestStatusSchema),
  item: (id: string) => apiRequest(`/items/${encodeURIComponent(id)}`, feedItemSchema),
};
