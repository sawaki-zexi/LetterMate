import {
  discoveryCandidateSchema,
  type DiscoveryResult,
} from '@lettermate/contracts';
import { z } from 'zod';
import {
  AiGatewayError,
  type AiGateway,
  type ExpandedTopic,
} from './ai-gateway.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const expansionSchema = z.object({
  terms: z.array(z.string().trim().min(1).max(100)).min(1).max(20),
  searchQueries: z.array(z.string().trim().min(1).max(200)).min(1).max(12),
});

const discoveryContentSchema = z.object({
  items: z.array(discoveryCandidateSchema).max(30),
});

const openRouterMessageSchema = z.object({
  role: z.string().optional(),
  content: z.string(),
  annotations: z.array(z.unknown()).optional().default([]),
});

const openRouterResponseSchema = z.object({
  choices: z.array(z.object({ message: openRouterMessageSchema })).min(1),
});

const citationSchema = z.object({
  type: z.literal('url_citation'),
  url_citation: z.object({
    url: z.url(),
    title: z.string().optional(),
  }),
});

type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

type OpenRouterMessage = z.infer<typeof openRouterMessageSchema>;

export interface OpenRouterGatewayConfig {
  apiKey: string;
  model: string;
  webSearch: boolean;
  timeoutMs: number;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}

function mapOpenRouterError(status: number, retryAfter: string | null): AiGatewayError {
  if (status === 429) {
    return new AiGatewayError(
      'AI_RATE_LIMITED',
      'OpenRouter 请求过于频繁，请稍后重试',
      true,
      parseRetryAfter(retryAfter),
    );
  }
  if (status === 401 || status === 403 || status === 402) {
    return new AiGatewayError('AI_AUTH_FAILED', 'OpenRouter Key 无效或不可用', false);
  }
  if (status === 400 || status === 404) {
    return new AiGatewayError('AI_MODEL_UNAVAILABLE', '配置的 OpenRouter 模型不可用', false);
  }
  if (status >= 500 || status === 408) {
    return new AiGatewayError('AI_UPSTREAM_UNAVAILABLE', 'OpenRouter 暂时不可用', true);
  }
  return new AiGatewayError('AI_UPSTREAM_UNAVAILABLE', 'OpenRouter 请求失败', false);
}

function stripCodeFence(content: string): string {
  const trimmed = content.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match?.[1] ?? trimmed;
}

function parseStructured<T>(content: string, schema: z.ZodType<T>): T | null {
  try {
    const json: unknown = JSON.parse(stripCodeFence(content));
    const parsed = schema.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export class OpenRouterAiGateway implements AiGateway {
  constructor(
    private readonly config: OpenRouterGatewayConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async expandTopic(input: { keyword: string }): Promise<ExpandedTopic> {
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          'You expand a user topic for web discovery. Return JSON only with terms and searchQueries arrays. Include concise Chinese and English synonyms, related concepts, and useful current-search expressions. Do not add exclusions or user-facing configuration.',
      },
      {
        role: 'user',
        content: `Expand this single topic keyword: ${input.keyword}`,
      },
    ];
    const { data } = await this.completeStructured(messages, expansionSchema, false);
    return {
      terms: unique(data.terms),
      searchQueries: unique(data.searchQueries),
    };
  }

  async discover(input: {
    keyword: string;
    expandedTerms: string[];
    lookbackDays: number;
    now: string;
  }): Promise<DiscoveryResult> {
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          'Use web search to find real recent material for the topic. Return JSON only as {"items": [...]}. Every item must contain kind (hot or quality), title, a concise Chinese summary, a Chinese reason, sourceUrls copied exactly from search sources, and publishedAt as an ISO timestamp or null. Use hot for clear recent attention growth or clustered updates; use quality for substantive new material. If both apply, use hot. Never invent a URL or date. Return an empty items array when nothing qualifies.',
      },
      {
        role: 'user',
        content: [
          `Topic: ${input.keyword}`,
          `Related terms and search expressions: ${input.expandedTerms.join(' | ')}`,
          `Current time: ${input.now}`,
          `Only consider the last ${input.lookbackDays} days.`,
        ].join('\n'),
      },
    ];
    const { data, message } = await this.completeStructured(
      messages,
      discoveryContentSchema,
      true,
    );
    const citations = unique(
      message.annotations.flatMap((annotation) => {
        const parsed = citationSchema.safeParse(annotation);
        return parsed.success ? [parsed.data.url_citation.url] : [];
      }),
    );
    return { items: data.items, citations };
  }

  private async completeStructured<T>(
    messages: ChatMessage[],
    schema: z.ZodType<T>,
    useWeb: boolean,
  ): Promise<{ data: T; message: OpenRouterMessage }> {
    const first = await this.complete(messages, useWeb);
    const firstData = parseStructured(first.content, schema);
    if (firstData !== null) return { data: firstData, message: first };

    const correction: ChatMessage[] = [
      ...messages,
      { role: 'assistant', content: first.content },
      {
        role: 'user',
        content:
          'The previous response was invalid. Return only valid JSON matching the requested object shape, with every required field and no Markdown.',
      },
    ];
    const second = await this.complete(correction, useWeb);
    const secondData = parseStructured(second.content, schema);
    if (secondData !== null) return { data: secondData, message: second };

    throw new AiGatewayError(
      'AI_RESPONSE_INVALID',
      'OpenRouter 返回了无法解析的结构化结果',
      false,
    );
  }

  private async complete(messages: ChatMessage[], useWeb: boolean): Promise<OpenRouterMessage> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await this.fetcher(OPENROUTER_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.model,
          messages,
          temperature: 0.1,
          ...(useWeb && this.config.webSearch ? { plugins: [{ id: 'web' }] } : {}),
        }),
      });
      if (!response.ok) {
        throw mapOpenRouterError(response.status, response.headers.get('retry-after'));
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new AiGatewayError(
          'AI_RESPONSE_INVALID',
          'OpenRouter 返回了无法解析的响应',
          false,
        );
      }
      const parsed = openRouterResponseSchema.safeParse(payload);
      if (!parsed.success) {
        throw new AiGatewayError(
          'AI_RESPONSE_INVALID',
          'OpenRouter 返回了不完整的响应',
          false,
        );
      }
      return parsed.data.choices[0]!.message;
    } catch (error) {
      if (error instanceof AiGatewayError) throw error;
      throw new AiGatewayError('AI_UPSTREAM_UNAVAILABLE', 'OpenRouter 暂时不可用', true);
    } finally {
      clearTimeout(timeout);
    }
  }
}
