import type { SourceCandidate } from '@lettermate/domain';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ConnectorResult, SourceQueryPlan } from './types.js';
import { ConnectorError } from './types.js';

const API_BASE_URL = 'https://api.bilibili.com';
const headers = {
  accept: 'application/json',
  'user-agent': 'Mozilla/5.0 (compatible; LetterMate/0.1)',
  referer: 'https://www.bilibili.com/',
};
const mixinTable = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
] as const;

const numeric = z.union([z.number(), z.string()]).transform(Number).pipe(z.number().finite().nonnegative());
const videoSchema = z.object({
  bvid: z.string().regex(/^BV[A-Za-z0-9]+$/),
  title: z.string().min(1),
  description: z.string().optional().nullable(),
  desc: z.string().optional().nullable(),
  author: z.string().optional().nullable(),
  mid: z.union([z.string(), z.number()]).transform(String),
  pubdate: numeric.optional().default(0),
  play: numeric.optional().default(0),
  video_review: numeric.optional().default(0),
  like: numeric.optional().default(0),
}).passthrough();
const userSchema = z.object({
  mid: z.union([z.string(), z.number()]).transform(String),
  uname: z.string().min(1),
  res: z.array(z.unknown()).optional().default([]),
}).passthrough();
const cardSchema = z.object({
  mid: z.union([z.string(), z.number()]).transform(String),
  name: z.string().trim().min(1),
}).passthrough();
const cardResponseSchema = z.object({
  code: z.number().int(),
  data: z.object({ card: z.unknown() }).optional().nullable(),
}).passthrough();
const searchResponseSchema = z.object({
  code: z.number().int(),
  data: z.object({
    result: z.array(z.unknown()),
    numPages: z.number().int().nonnegative().optional(),
    next: z.number().int().nonnegative().optional(),
  }).optional().nullable(),
}).passthrough();
const navSchema = z.object({
  data: z.object({ wbi_img: z.object({ img_url: z.string().url(), sub_url: z.string().url() }) }),
}).passthrough();
const dynamicAuthorSchema = z.object({
  mid: z.union([z.string(), z.number()]).transform(String),
  name: z.string().trim().min(1),
  pub_ts: numeric.optional().default(0),
}).passthrough();
const dynamicCountSchema = z.object({ count: numeric.optional().default(0) }).passthrough();
const dynamicMajorPayloadSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String).optional(),
  bvid: z.string().regex(/^BV[A-Za-z0-9]+$/).optional(),
  title: z.string().optional().nullable(),
  desc: z.string().optional().nullable(),
  jump_url: z.string().optional().nullable(),
  summary: z.union([
    z.string(),
    z.object({ text: z.string().optional().default('') }).passthrough(),
  ]).optional().nullable(),
}).passthrough();
const dynamicMajorSchema = z.object({
  type: z.string().optional().default(''),
  archive: z.unknown().optional().nullable(),
  article: z.unknown().optional().nullable(),
  opus: z.unknown().optional().nullable(),
  common: z.unknown().optional().nullable(),
  draw: z.unknown().optional().nullable(),
}).passthrough();
const dynamicItemSchema = z.object({
  id_str: z.union([z.string(), z.number()]).transform(String).pipe(z.string().regex(/^\d+$/)),
  type: z.string().min(1),
  modules: z.object({
    module_author: dynamicAuthorSchema,
    module_dynamic: z.object({
      desc: z.object({ text: z.string().optional().default('') }).passthrough().optional().nullable(),
      major: dynamicMajorSchema.optional().nullable(),
    }).passthrough(),
    module_stat: z.object({
      comment: dynamicCountSchema.optional().default({ count: 0 }),
      forward: dynamicCountSchema.optional().default({ count: 0 }),
      like: dynamicCountSchema.optional().default({ count: 0 }),
    }).passthrough().optional().default({
      comment: { count: 0 }, forward: { count: 0 }, like: { count: 0 },
    }),
  }).passthrough(),
  orig: z.unknown().optional().nullable(),
}).passthrough();
const dynamicResponseSchema = z.object({
  code: z.number().int(),
  data: z.object({
    has_more: z.boolean().optional().default(false),
    offset: z.union([z.string(), z.number()]).transform(String).optional().nullable(),
    items: z.array(z.unknown()).max(100).optional().default([]),
  }).optional().nullable(),
}).passthrough();

export interface BilibiliCreatorConnectorConfig {
  mid: string;
  pageBudget?: number;
  timeoutMs?: number;
  now?: () => Date;
}

const clean = (value: string | null | undefined): string => (
  value?.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() ?? ''
);

const dynamicUrl = (id: string): string => `https://t.bilibili.com/${id}`;

function absoluteBilibiliUrl(value: string | null | undefined): string | null {
  const input = value?.trim();
  if (!input) return null;
  try {
    const url = input.startsWith('//')
      ? new URL(`https:${input}`)
      : new URL(input, 'https://www.bilibili.com');
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function summaryText(value: z.infer<typeof dynamicMajorPayloadSchema>['summary']): string {
  return clean(typeof value === 'string' ? value : value?.text);
}

function joinContent(...values: Array<string | null | undefined>): string {
  return [...new Set(values.map((value) => clean(value)).filter(Boolean))].join('\n\n');
}

interface DynamicContent {
  title: string;
  text: string;
  url: string;
  sourceType: SourceCandidate['sourceType'];
  key: string;
  externalId: string;
}

function providerCode(payload: unknown): number {
  return typeof payload === 'object' && payload !== null && 'code' in payload
    ? Number((payload as { code: unknown }).code)
    : NaN;
}

function providerError(payload: unknown): ConnectorError {
  const code = providerCode(payload);
  if (code === -412 || code === -352) {
    return new ConnectorError('CONNECTOR_ACCESS_RESTRICTED', 'Bilibili public API is temporarily restricted', true);
  }
  return new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'Bilibili returned an invalid response', false);
}

export class BilibiliCreatorConnector {
  private readonly pageBudget: number;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private mixinKeyCache: string | null = null;

  constructor(
    private readonly config: BilibiliCreatorConnectorConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    if (!/^\d{1,20}$/.test(config.mid)) throw new Error('Bilibili mid is invalid');
    this.pageBudget = config.pageBudget ?? 3;
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.now = config.now ?? (() => new Date());
    if (!Number.isInteger(this.pageBudget) || this.pageBudget < 1) throw new Error('pageBudget must be positive');
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 1) throw new Error('timeoutMs must be positive');
  }

  async search(plan: SourceQueryPlan, signal: AbortSignal): Promise<ConnectorResult> {
    const card = await this.fetchCard(signal);
    let requestCount = 1;
    const drafts = new Map<string, SourceCandidate>();

    const userPayload = await this.requestSigned('/x/web-interface/wbi/search/type', {
      keyword: card.name,
      page: '1',
      search_type: 'bili_user',
    }, signal);
    requestCount += 2;
    const userResponse = searchResponseSchema.safeParse(userPayload);
    if (!userResponse.success || userResponse.data.code !== 0 || !userResponse.data.data) throw providerError(userPayload);
    for (const raw of userResponse.data.data.result) {
      const user = userSchema.safeParse(raw);
      if (!user.success || user.data.mid !== this.config.mid) continue;
      user.data.res.forEach((video) => this.addVideo(drafts, video, card.name, plan));
    }

    for (let page = 1; page <= this.pageBudget && drafts.size < plan.maxCandidates; page += 1) {
      const payload = await this.requestSigned('/x/web-interface/wbi/search/type', {
        keyword: card.name,
        order: 'pubdate',
        page: String(page),
        search_type: 'video',
      }, signal);
      requestCount += 1;
      const response = searchResponseSchema.safeParse(payload);
      if (!response.success || response.data.code !== 0 || !response.data.data) throw providerError(payload);
      response.data.data.result.forEach((video) => this.addVideo(drafts, video, card.name, plan));
      const pages = response.data.data.numPages;
      if (response.data.data.result.length === 0 || (pages !== undefined && page >= pages)) break;
    }

    let offset: string | null = null;
    for (let page = 1; page <= this.pageBudget; page += 1) {
      const url = new URL('/x/polymer/web-dynamic/v1/feed/space', API_BASE_URL);
      url.searchParams.set('host_mid', this.config.mid);
      if (offset) url.searchParams.set('offset', offset);
      const payload = await this.request(url, signal);
      requestCount += 1;
      const response = dynamicResponseSchema.safeParse(payload);
      if (!response.success || response.data.code !== 0 || !response.data.data) throw providerError(payload);
      response.data.data.items.forEach((item) => this.addDynamic(drafts, item, card.name, plan));
      const nextOffset = response.data.data.offset?.trim() || null;
      if (!response.data.data.has_more || response.data.data.items.length === 0 || !nextOffset) break;
      offset = nextOffset;
    }

    return {
      candidates: [...drafts.values()]
        .sort((left, right) => (
          Date.parse(right.publishedAt ?? '') - Date.parse(left.publishedAt ?? '') || 0
        ))
        .slice(0, plan.maxCandidates),
      requestCount,
      identity: {
        displayName: card.name,
        profileUrl: `https://space.bilibili.com/${this.config.mid}`,
        handle: `UID ${this.config.mid}`,
      },
    };
  }

  private addVideo(
    drafts: Map<string, SourceCandidate>,
    raw: unknown,
    displayName: string,
    plan: SourceQueryPlan,
  ): void {
    const parsed = videoSchema.safeParse(raw);
    if (!parsed.success || parsed.data.mid !== this.config.mid || drafts.has(parsed.data.bvid)) return;
    const video = parsed.data;
    const publishedAt = video.pubdate > 0 ? new Date(video.pubdate * 1_000).toISOString() : null;
    if (publishedAt && (publishedAt < plan.windowStart || publishedAt > plan.windowEnd)) return;
    const title = clean(video.title);
    if (!title) return;
    const description = clean(video.description ?? video.desc);
    drafts.set(video.bvid, {
      connectorId: 'bilibili-creator',
      sourceType: 'video',
      platform: 'Bilibili',
      externalId: video.bvid,
      url: `https://www.bilibili.com/video/${video.bvid}`,
      title,
      content: description || title,
      excerpt: null,
      authorName: clean(video.author) || displayName,
      authorHandle: `UID ${this.config.mid}`,
      publishedAt,
      language: 'zh',
      engagement: { views: video.play, comments: video.video_review, likes: video.like },
      proof: { kind: 'api_record', connectorId: 'bilibili-creator', externalId: video.bvid },
      creatorContext: {
        contentType: 'original',
        originalAuthorName: null,
        originalAuthorHandle: null,
        originalContentId: null,
        originalContentUrl: null,
        parentContentId: null,
        parentContentUrl: null,
        parentContentText: null,
      },
    });
  }

  private addDynamic(
    drafts: Map<string, SourceCandidate>,
    raw: unknown,
    displayName: string,
    plan: SourceQueryPlan,
  ): void {
    const parsed = dynamicItemSchema.safeParse(raw);
    if (!parsed.success || parsed.data.modules.module_author.mid !== this.config.mid) return;
    const item = parsed.data;
    const publishedAt = item.modules.module_author.pub_ts > 0
      ? new Date(item.modules.module_author.pub_ts * 1_000).toISOString()
      : null;
    if (publishedAt && (publishedAt < plan.windowStart || publishedAt > plan.windowEnd)) return;

    const isRepost = item.type === 'DYNAMIC_TYPE_FORWARD';
    const originalResult = isRepost ? dynamicItemSchema.safeParse(item.orig) : null;
    const originalItem = originalResult?.success ? originalResult.data : null;
    const originalContent = originalItem ? this.dynamicContent(originalItem) : null;
    if (isRepost && (!originalItem || !originalContent)) return;

    const content = this.dynamicContent(item);
    if (!isRepost && !content) return;
    const commentary = clean(item.modules.module_dynamic.desc?.text);
    const body = isRepost
      ? joinContent(commentary, `原帖：${originalContent!.text}`)
      : content!.text;
    if (!body) return;

    const author = isRepost ? originalItem!.modules.module_author : item.modules.module_author;
    const title = isRepost ? `转发：${originalContent!.title}`.slice(0, 300) : content!.title;
    const candidateUrl = isRepost ? dynamicUrl(item.id_str) : content!.url;
    const externalId = isRepost ? item.id_str : content!.externalId;
    const key = isRepost ? `dynamic:${item.id_str}` : content!.key;
    if (drafts.has(key)) return;
    const stats = item.modules.module_stat;
    drafts.set(key, {
      connectorId: 'bilibili-creator',
      sourceType: isRepost ? 'social' : content!.sourceType,
      platform: 'Bilibili',
      externalId,
      url: candidateUrl,
      title,
      content: body,
      excerpt: null,
      authorName: clean(author.name) || displayName,
      authorHandle: `UID ${author.mid}`,
      publishedAt,
      language: 'zh',
      engagement: {
        comments: stats.comment.count,
        reposts: stats.forward.count,
        likes: stats.like.count,
      },
      proof: { kind: 'api_record', connectorId: 'bilibili-creator', externalId },
      creatorContext: {
        contentType: isRepost ? 'repost' : 'original',
        originalAuthorName: isRepost ? clean(originalItem!.modules.module_author.name) : null,
        originalAuthorHandle: isRepost ? `UID ${originalItem!.modules.module_author.mid}` : null,
        originalContentId: isRepost ? originalItem!.id_str : null,
        originalContentUrl: isRepost ? originalContent!.url : null,
        parentContentId: null,
        parentContentUrl: null,
        parentContentText: null,
      },
    });
  }

  private dynamicContent(item: z.infer<typeof dynamicItemSchema>): DynamicContent | null {
    const id = item.id_str;
    const description = clean(item.modules.module_dynamic.desc?.text);
    const major = item.modules.module_dynamic.major;
    const archive = dynamicMajorPayloadSchema.safeParse(major?.archive);
    if (archive.success && archive.data.bvid) {
      const title = clean(archive.data.title) || description.slice(0, 120);
      const text = joinContent(description, archive.data.desc, summaryText(archive.data.summary));
      if (!title || !text) return null;
      return {
        title,
        text,
        url: `https://www.bilibili.com/video/${archive.data.bvid}`,
        sourceType: 'video',
        key: archive.data.bvid,
        externalId: archive.data.bvid,
      };
    }

    const article = dynamicMajorPayloadSchema.safeParse(major?.article);
    if (article.success) {
      const articleId = article.data.id?.replace(/^cv/i, '') ?? null;
      const url = absoluteBilibiliUrl(article.data.jump_url)
        ?? (articleId ? `https://www.bilibili.com/read/cv${articleId}` : dynamicUrl(id));
      const title = clean(article.data.title) || description.slice(0, 120);
      const text = joinContent(description, article.data.desc, summaryText(article.data.summary));
      if (!title || !text) return null;
      return { title, text, url, sourceType: 'web', key: `dynamic:${id}`, externalId: id };
    }

    const opus = dynamicMajorPayloadSchema.safeParse(major?.opus);
    if (opus.success) {
      const title = clean(opus.data.title) || description.slice(0, 120);
      const text = joinContent(description, opus.data.desc, summaryText(opus.data.summary));
      if (!title || !text) return null;
      return {
        title,
        text,
        url: absoluteBilibiliUrl(opus.data.jump_url) ?? dynamicUrl(id),
        sourceType: 'web',
        key: `dynamic:${id}`,
        externalId: id,
      };
    }

    const common = dynamicMajorPayloadSchema.safeParse(major?.common);
    if (common.success) {
      const title = clean(common.data.title) || description.slice(0, 120);
      const text = joinContent(description, common.data.desc, summaryText(common.data.summary));
      if (!title || !text) return null;
      return {
        title,
        text,
        url: absoluteBilibiliUrl(common.data.jump_url) ?? dynamicUrl(id),
        sourceType: 'web',
        key: `dynamic:${id}`,
        externalId: id,
      };
    }

    if (!description) return null;
    return {
      title: description.slice(0, 120),
      text: description,
      url: dynamicUrl(id),
      sourceType: 'social',
      key: `dynamic:${id}`,
      externalId: id,
    };
  }

  private async fetchCard(signal: AbortSignal): Promise<z.infer<typeof cardSchema>> {
    const url = new URL('/x/web-interface/card', API_BASE_URL);
    url.searchParams.set('mid', this.config.mid);
    const payload = await this.request(url, signal);
    const response = cardResponseSchema.safeParse(payload);
    if (!response.success || response.data.code !== 0 || !response.data.data) throw providerError(payload);
    const card = cardSchema.safeParse(response.data.data.card);
    if (!card.success || card.data.mid !== this.config.mid) throw providerError(payload);
    return card.data;
  }

  private async requestSigned(
    path: string,
    parameters: Record<string, string>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const key = await this.mixinKey(signal);
    const signed = { ...parameters, wts: String(Math.floor(this.now().getTime() / 1_000)) };
    const query = Object.entries(signed)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value.replace(/[!'()*]/g, ''))}`)
      .join('&');
    const url = new URL(path, API_BASE_URL);
    url.search = `${query}&w_rid=${createHash('md5').update(query + key).digest('hex')}`;
    return this.request(url, signal);
  }

  private async mixinKey(signal: AbortSignal): Promise<string> {
    if (this.mixinKeyCache) return this.mixinKeyCache;
    const payload = await this.request(new URL('/x/web-interface/nav', API_BASE_URL), signal);
    const parsed = navSchema.safeParse(payload);
    if (!parsed.success) throw providerError(payload);
    const source = [parsed.data.data.wbi_img.img_url, parsed.data.data.wbi_img.sub_url]
      .map((url) => /\/([^/]+)\.[^.]+$/.exec(new URL(url).pathname)?.[1] ?? '')
      .join('');
    const key = mixinTable.map((index) => source[index] ?? '').join('').slice(0, 32);
    if (key.length !== 32) throw providerError(payload);
    this.mixinKeyCache = key;
    return key;
  }

  private async request(url: URL, parentSignal: AbortSignal): Promise<unknown> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    parentSignal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(url.toString(), { headers, signal: controller.signal });
    } catch {
      if (parentSignal.aborted) throw new ConnectorError('CONNECTOR_ABORTED', 'Bilibili request was aborted', true);
      if (controller.signal.aborted) throw new ConnectorError('CONNECTOR_TIMEOUT', 'Bilibili request timed out', true);
      throw new ConnectorError('CONNECTOR_UPSTREAM_UNAVAILABLE', 'Bilibili is temporarily unavailable', true);
    } finally {
      clearTimeout(timer);
      parentSignal.removeEventListener('abort', abort);
    }
    if (response.status === 412) throw new ConnectorError('CONNECTOR_ACCESS_RESTRICTED', 'Bilibili public API is temporarily restricted', true);
    if (response.status === 429) throw new ConnectorError('CONNECTOR_RATE_LIMITED', 'Bilibili rate limit reached', true);
    if (!response.ok) throw new ConnectorError('CONNECTOR_UPSTREAM_UNAVAILABLE', 'Bilibili is temporarily unavailable', response.status >= 500);
    try {
      return await response.json();
    } catch {
      throw new ConnectorError('CONNECTOR_RESPONSE_INVALID', 'Bilibili returned an invalid response', false);
    }
  }
}
