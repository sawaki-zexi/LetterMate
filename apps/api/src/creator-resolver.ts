import {
  creatorIdentityCandidateSchema,
  creatorPlatformStatusSchema,
  creatorResolutionResultSchema,
  type CreatorIdentityCandidate,
  type CreatorPlatformStatus,
  type CreatorResolutionResult,
} from '@lettermate/contracts';
import { canonicalizeUrl } from '@lettermate/domain';
import { load } from 'cheerio';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import ipaddr from 'ipaddr.js';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import { Agent } from 'undici';
import { z } from 'zod';

const feedContentTypes = [
  'application/atom+xml',
  'application/rss+xml',
  'application/xml',
  'application/xhtml+xml',
  'text/html',
  'text/plain',
  'text/xml',
] as const;

const xmlParser = new XMLParser({
  attributeNamePrefix: '@_',
  ignoreAttributes: false,
  trimValues: true,
});

type XmlObject = Record<string, unknown>;

export class CreatorResolutionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus: 400 | 503,
  ) {
    super(message);
    this.name = 'CreatorResolutionError';
  }
}

export interface ResolvedCreatorIdentity {
  platform: 'rss' | 'x' | 'bilibili';
  accountKey: string;
  resolutionInput: string;
  displayName: string;
  handle: string | null;
  avatarUrl: string | null;
  bio: string | null;
  verified: boolean | null;
  profileUrl: string;
  feedUrl: string | null;
}

export interface CreatorIdentityResolver {
  readonly platform: 'rss' | 'x' | 'bilibili';
  readonly label: string;
  readonly status: CreatorPlatformStatus['status'];
  supports(input: string): boolean;
  resolve(input: string): Promise<ResolvedCreatorIdentity[]>;
}

export interface CreatorResolutionGateway {
  capabilities(): CreatorPlatformStatus[];
  resolve(userId: string, input: string): Promise<CreatorResolutionResult>;
  confirm(userId: string, tokens: string[]): Promise<ResolvedCreatorIdentity[]>;
}

interface FetchedRemoteText {
  finalUrl: string;
  text: string;
  contentType: string;
}

interface SafeRemoteTextFetcherOptions {
  maxBytes?: number;
  maxRedirects?: number;
  timeoutMs?: number;
  resolveHostname?: (hostname: string) => Promise<string[]>;
}

export class RemoteTextFetchError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'RemoteTextFetchError';
  }
}

const defaultResolve = async (hostname: string): Promise<string[]> => (
  (await lookup(hostname, { all: true, verbatim: true })).map((result) => result.address)
);

const unsafeHostname = new Set(['metadata.google.internal', 'metadata', 'instance-data']);

function unsafeIp(address: string): boolean {
  try {
    return ipaddr.process(address).range() !== 'unicast';
  } catch {
    return true;
  }
}

interface SafeTarget {
  address: string;
  family: 4 | 6;
}

export class SafeRemoteTextFetcher {
  private readonly maxBytes: number;
  private readonly maxRedirects: number;
  private readonly timeoutMs: number;
  private readonly resolveHostname: (hostname: string) => Promise<string[]>;

  constructor(
    options: SafeRemoteTextFetcherOptions = {},
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.maxBytes = options.maxBytes ?? 512_000;
    this.maxRedirects = options.maxRedirects ?? 3;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.resolveHostname = options.resolveHostname ?? defaultResolve;
  }

  async fetch(inputUrl: string): Promise<FetchedRemoteText> {
    let current = inputUrl;
    const visited = new Set<string>();
    for (let redirects = 0; redirects <= this.maxRedirects; redirects += 1) {
      if (visited.has(current)) {
        throw new RemoteTextFetchError('TOO_MANY_REDIRECTS', '公开地址重定向循环');
      }
      visited.add(current);
      const target = await this.assertSafeUrl(current);
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.timeoutMs);
      const dispatcher = this.createPinnedDispatcher(target);
      try {
        const response = await this.fetcher(current, {
          redirect: 'manual',
          signal: controller.signal,
          dispatcher,
          headers: { accept: feedContentTypes.join(', ') },
        } as RequestInit & { dispatcher: Agent });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          await response.body?.cancel();
          if (!location) throw new RemoteTextFetchError('FETCH_FAILED', '公开地址重定向无效');
          if (redirects === this.maxRedirects) {
            throw new RemoteTextFetchError('TOO_MANY_REDIRECTS', '公开地址重定向过多');
          }
          current = new URL(location, current).toString();
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new RemoteTextFetchError('FETCH_FAILED', '公开地址暂时不可用', response.status);
        }
        const contentType = response.headers.get('content-type')
          ?.split(';')[0]?.trim().toLowerCase() ?? '';
        if (!(feedContentTypes as readonly string[]).includes(contentType)) {
          await response.body?.cancel();
          throw new RemoteTextFetchError('UNSUPPORTED_CONTENT_TYPE', '公开地址不是可解析的网页或 Feed');
        }
        const declaredLength = Number(response.headers.get('content-length') ?? 0);
        if (declaredLength > this.maxBytes) {
          await response.body?.cancel();
          throw new RemoteTextFetchError('CONTENT_TOO_LARGE', '公开地址内容超过大小限制');
        }
        return { finalUrl: current, contentType, text: await this.readBody(response) };
      } catch (error) {
        if (error instanceof RemoteTextFetchError) throw error;
        if (timedOut) throw new RemoteTextFetchError('FETCH_TIMEOUT', '公开地址请求超时');
        throw new RemoteTextFetchError('FETCH_FAILED', '公开地址暂时不可用');
      } finally {
        clearTimeout(timer);
        await dispatcher.close();
      }
    }
    throw new RemoteTextFetchError('TOO_MANY_REDIRECTS', '公开地址重定向过多');
  }

  private async assertSafeUrl(value: string): Promise<SafeTarget> {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new RemoteTextFetchError('UNSAFE_URL', '公开地址无效');
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (
      !['http:', 'https:'].includes(url.protocol)
      || url.username
      || url.password
      || unsafeHostname.has(hostname.toLowerCase())
    ) {
      throw new RemoteTextFetchError('UNSAFE_URL', '公开地址必须是安全的 HTTP(S) 地址');
    }
    let addresses: string[];
    if (isIP(hostname)) {
      addresses = [hostname];
    } else {
      try {
        addresses = await this.resolveHostname(hostname);
      } catch {
        throw new RemoteTextFetchError('UNSAFE_URL', '公开地址无法安全解析');
      }
    }
    if (addresses.length === 0 || addresses.some(unsafeIp)) {
      throw new RemoteTextFetchError('UNSAFE_URL', '公开地址不能指向私有网络');
    }
    const address = addresses[0]!;
    const family = isIP(address);
    if (family !== 4 && family !== 6) {
      throw new RemoteTextFetchError('UNSAFE_URL', '公开地址解析结果无效');
    }
    return { address, family };
  }

  private createPinnedDispatcher(target: SafeTarget): Agent {
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all) callback(null, [{ address: target.address, family: target.family }]);
      else callback(null, target.address, target.family);
    };
    return new Agent({ connect: { lookup: pinnedLookup } });
  }

  private async readBody(response: Response): Promise<string> {
    if (response.body === null) return response.text();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > this.maxBytes) {
          await reader.cancel();
          throw new RemoteTextFetchError('CONTENT_TOO_LARGE', '公开地址内容超过大小限制');
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  }
}

export class RssCreatorIdentityResolver implements CreatorIdentityResolver {
  readonly platform = 'rss' as const;
  readonly label = 'RSS/Atom';
  readonly status = 'enabled' as const;

  constructor(
    private readonly textFetcher: Pick<SafeRemoteTextFetcher, 'fetch'> = new SafeRemoteTextFetcher(),
  ) {}

  supports(input: string): boolean {
    try {
      return ['http:', 'https:'].includes(new URL(input).protocol);
    } catch {
      return false;
    }
  }

  async resolve(input: string): Promise<ResolvedCreatorIdentity[]> {
    if (!this.supports(input)) return [];
    try {
      const first = await this.textFetcher.fetch(canonicalizeUrl(input));
      const feed = this.isHtml(first.contentType)
        ? await this.discoverFeed(first)
        : first;
      if (!feed || XMLValidator.validate(feed.text) !== true) return [];
      return [this.parseFeed(feed)];
    } catch (error) {
      if (!(error instanceof RemoteTextFetchError)) {
        throw new CreatorResolutionError('CREATOR_IDENTITY_INVALID', '无法解析该公开账号', 400);
      }
      const unavailable = error.code === 'FETCH_TIMEOUT'
        || (error.status !== undefined && (error.status === 429 || error.status >= 500));
      throw new CreatorResolutionError(
        unavailable ? 'CREATOR_IDENTITY_UNAVAILABLE' : 'CREATOR_IDENTITY_INVALID',
        unavailable ? '公开账号来源暂时不可用' : error.message,
        unavailable ? 503 : 400,
      );
    }
  }

  private isHtml(contentType: string): boolean {
    return contentType === 'text/html' || contentType === 'application/xhtml+xml';
  }

  private async discoverFeed(page: FetchedRemoteText): Promise<FetchedRemoteText | null> {
    const $ = load(page.text);
    let discovered: string | null = null;
    $('link[rel~="alternate"]').each((_index, element) => {
      if (discovered) return;
      const type = ($(element).attr('type') ?? '').toLowerCase();
      const href = $(element).attr('href');
      if (href && ['application/atom+xml', 'application/rss+xml'].includes(type)) {
        discovered = new URL(href, page.finalUrl).toString();
      }
    });
    return discovered ? this.textFetcher.fetch(discovered) : null;
  }

  private parseFeed(feed: FetchedRemoteText): ResolvedCreatorIdentity {
    const parsed = asObject(xmlParser.parse(feed.text));
    if (!parsed) throw new Error('Unsupported feed');
    const rssChannel = asObject(asObject(parsed.rss)?.channel);
    const atomFeed = asObject(parsed.feed);
    const root = rssChannel ?? atomFeed;
    if (!root) throw new Error('Unsupported feed');
    const feedUrl = canonicalizeUrl(feed.finalUrl);
    const title = stringValue(root.title) ?? new URL(feedUrl).hostname;
    const profileUrl = httpUrl(
      rssChannel ? rssChannel.link : atomAlternateLink(atomFeed),
      feedUrl,
    ) ?? feedUrl;
    const avatarUrl = httpUrl(
      rssChannel ? asObject(rssChannel.image)?.url : atomFeed?.icon ?? atomFeed?.logo,
      feedUrl,
    );
    const author = rssChannel
      ? stringValue(rssChannel.managingEditor) ?? stringValue(rssChannel['dc:creator'])
      : atomAuthor(atomFeed);
    const bio = stringValue(rssChannel?.description ?? atomFeed?.subtitle);
    return {
      platform: 'rss',
      accountKey: feedUrl,
      resolutionInput: feedUrl,
      displayName: title.slice(0, 200),
      handle: author?.slice(0, 200) ?? null,
      avatarUrl,
      bio: bio?.slice(0, 1_000) ?? null,
      verified: null,
      profileUrl,
      feedUrl,
    };
  }
}

const xUserSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  userName: z.string().optional().nullable(),
  screen_name: z.string().optional().nullable(),
  username: z.string().optional().nullable(),
  name: z.string().trim().min(1),
  profilePicture: z.string().optional().nullable(),
  profile_image_url_https: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  isBlueVerified: z.boolean().optional(),
  verifiedType: z.string().optional().nullable(),
  unavailable: z.boolean().optional(),
}).passthrough();

const xUserInfoResponseSchema = z.object({ data: z.unknown(), status: z.string().optional() }).passthrough();
const xUserSearchResponseSchema = z.object({ users: z.array(z.unknown()), status: z.string().optional() }).passthrough();

function xHandle(input: string): string | null {
  const trimmed = input.trim();
  const explicitHandle = trimmed.match(/^@([A-Za-z0-9_]{1,15})$/);
  if (explicitHandle) return explicitHandle[1]!;
  try {
    const url = new URL(trimmed);
    if (!['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname.toLowerCase())) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    return parts.length === 1 && /^[A-Za-z0-9_]{1,15}$/.test(parts[0]!) ? parts[0]! : null;
  } catch {
    return null;
  }
}

export class XCreatorIdentityResolver implements CreatorIdentityResolver {
  readonly platform = 'x' as const;
  readonly label = 'X';
  readonly status: CreatorPlatformStatus['status'];

  constructor(
    private readonly apiKey: string | undefined,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.status = apiKey?.trim() ? 'enabled' : 'not_configured';
  }

  supports(input: string): boolean {
    const value = input.trim();
    if (!value) return false;
    try {
      const url = new URL(value);
      return ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname.toLowerCase())
        && xHandle(value) !== null;
    } catch {
      return true;
    }
  }

  async resolve(input: string): Promise<ResolvedCreatorIdentity[]> {
    const apiKey = this.apiKey?.trim();
    if (!apiKey) return [];
    const handle = xHandle(input);
    const url = new URL(handle ? '/twitter/user/info' : '/twitter/user/search', 'https://api.twitterapi.io');
    url.searchParams.set(handle ? 'userName' : 'query', handle ?? input.trim());
    if (!handle) url.searchParams.set('cursor', '');
    const payload = await this.request(url, apiKey);
    let values: unknown[];
    if (handle) {
      const response = xUserInfoResponseSchema.safeParse(payload);
      if (!response.success) {
        throw new CreatorResolutionError('CREATOR_IDENTITY_INVALID', 'X 账号响应无效', 400);
      }
      values = [response.data.data];
    } else {
      const response = xUserSearchResponseSchema.safeParse(payload);
      if (!response.success) {
        throw new CreatorResolutionError('CREATOR_IDENTITY_INVALID', 'X 账号响应无效', 400);
      }
      values = response.data.users.slice(0, 10);
    }
    return values.flatMap((value) => {
      const parsed = xUserSchema.safeParse(value);
      if (!parsed.success || parsed.data.unavailable) return [];
      const user = parsed.data;
      const normalizedHandle = (user.userName ?? user.screen_name ?? user.username ?? '').replace(/^@/, '');
      if (!/^[A-Za-z0-9_]{1,15}$/.test(normalizedHandle)) return [];
      return [{
        platform: 'x' as const,
        accountKey: user.id,
        resolutionInput: `@${normalizedHandle}`,
        displayName: user.name.slice(0, 200),
        handle: `@${normalizedHandle}`,
        avatarUrl: httpUrl(user.profilePicture ?? user.profile_image_url_https, 'https://x.com/'),
        bio: user.description?.trim().slice(0, 1_000) || null,
        verified: Boolean(user.isBlueVerified || user.verifiedType?.trim()),
        profileUrl: `https://x.com/${normalizedHandle}`,
        feedUrl: null,
      }];
    });
  }

  private async request(url: URL, apiKey: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(url.toString(), { headers: { 'x-api-key': apiKey } });
    } catch {
      throw new CreatorResolutionError('CREATOR_IDENTITY_UNAVAILABLE', 'X 账号来源暂时不可用', 503);
    }
    if (response.status === 401 || response.status === 403 || response.status === 429 || response.status >= 500) {
      throw new CreatorResolutionError('CREATOR_IDENTITY_UNAVAILABLE', 'X 账号来源暂时不可用', 503);
    }
    if (!response.ok) {
      throw new CreatorResolutionError('CREATOR_IDENTITY_INVALID', '无法解析该 X 账号', 400);
    }
    try {
      return await response.json();
    } catch {
      throw new CreatorResolutionError('CREATOR_IDENTITY_INVALID', 'X 账号响应无效', 400);
    }
  }
}

const bilibiliCardSchema = z.object({
  mid: z.union([z.string(), z.number()]).transform(String),
  name: z.string().trim().min(1),
  face: z.string().optional().nullable(),
  sign: z.string().optional().nullable(),
  official_verify: z.object({ type: z.number().int(), desc: z.string().optional() }).optional().nullable(),
}).passthrough();

const bilibiliUserSchema = z.object({
  mid: z.union([z.string(), z.number()]).transform(String),
  uname: z.string().trim().min(1),
  upic: z.string().optional().nullable(),
  usign: z.string().optional().nullable(),
  official_verify: z.object({ type: z.number().int(), desc: z.string().optional() }).optional().nullable(),
  is_upuser: z.number().int().optional(),
  videos: z.number().int().nonnegative().optional(),
}).passthrough();

const bilibiliCardResponseSchema = z.object({
  code: z.number().int(),
  data: z.object({ card: z.unknown() }).optional().nullable(),
}).passthrough();

const bilibiliSearchResponseSchema = z.object({
  code: z.number().int(),
  data: z.object({ result: z.array(z.unknown()) }).optional().nullable(),
}).passthrough();

const bilibiliNavSchema = z.object({
  code: z.number().int(),
  data: z.object({
    wbi_img: z.object({ img_url: z.string().url(), sub_url: z.string().url() }),
  }).optional().nullable(),
}).passthrough();

const bilibiliMixinTable = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
] as const;

const bilibiliHeaders = {
  accept: 'application/json',
  'user-agent': 'Mozilla/5.0 (compatible; LetterMate/0.1)',
  referer: 'https://www.bilibili.com/',
};

const bilibiliAvatar = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const url = value.startsWith('//') ? `https:${value}` : value;
  return /^https?:\/\//i.test(url) ? url : null;
};

const bilibiliMid = (input: string): string | null => {
  const value = input.trim();
  const internal = /^mid:(\d{1,20})$/.exec(value);
  if (internal) return internal[1]!;
  try {
    const url = new URL(value);
    if (!['space.bilibili.com', 'www.space.bilibili.com'].includes(url.hostname.toLowerCase())) return null;
    return /^\/(\d{1,20})\/?$/.exec(url.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
};

export class BilibiliCreatorIdentityResolver implements CreatorIdentityResolver {
  readonly platform = 'bilibili' as const;
  readonly label = 'Bilibili';
  readonly status = 'enabled' as const;
  private mixinCache: { key: string; expiresAt: number } | null = null;

  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  supports(input: string): boolean {
    const value = input.trim();
    if (!value) return false;
    if (bilibiliMid(value)) return true;
    try {
      new URL(value);
      return false;
    } catch {
      return !value.startsWith('@');
    }
  }

  async resolve(input: string): Promise<ResolvedCreatorIdentity[]> {
    const mid = bilibiliMid(input);
    if (mid) return [await this.resolveMid(mid)];
    if (!this.supports(input)) return [];
    const payload = await this.requestSigned('/x/web-interface/wbi/search/type', {
      keyword: input.trim(),
      page: '1',
      search_type: 'bili_user',
    });
    const response = bilibiliSearchResponseSchema.safeParse(payload);
    if (!response.success || response.data.code !== 0 || !response.data.data) {
      throw this.providerError(payload);
    }
    return response.data.data.result.slice(0, 10).flatMap((value) => {
      const parsed = bilibiliUserSchema.safeParse(value);
      return parsed.success
        && !(parsed.data.is_upuser === 0 && (parsed.data.videos ?? 0) === 0)
        ? [this.fromUser(parsed.data)]
        : [];
    });
  }

  private async resolveMid(mid: string): Promise<ResolvedCreatorIdentity> {
    const url = new URL('/x/web-interface/card', 'https://api.bilibili.com');
    url.searchParams.set('mid', mid);
    const payload = await this.request(url);
    const response = bilibiliCardResponseSchema.safeParse(payload);
    if (!response.success || response.data.code !== 0 || !response.data.data) {
      throw this.providerError(payload);
    }
    const card = bilibiliCardSchema.safeParse(response.data.data.card);
    if (!card.success || card.data.mid !== mid) {
      throw new CreatorResolutionError('CREATOR_IDENTITY_INVALID', 'Bilibili 账号响应无效', 400);
    }
    return this.fromUser({
      mid: card.data.mid,
      uname: card.data.name,
      upic: card.data.face,
      usign: card.data.sign,
      official_verify: card.data.official_verify,
    });
  }

  private fromUser(user: z.infer<typeof bilibiliUserSchema>): ResolvedCreatorIdentity {
    return {
      platform: 'bilibili',
      accountKey: user.mid,
      resolutionInput: `mid:${user.mid}`,
      displayName: user.uname.slice(0, 200),
      handle: `UID ${user.mid}`,
      avatarUrl: bilibiliAvatar(user.upic),
      bio: user.usign?.trim().slice(0, 1_000) || null,
      verified: user.official_verify ? ![127, -1].includes(user.official_verify.type) : false,
      profileUrl: `https://space.bilibili.com/${user.mid}`,
      feedUrl: null,
    };
  }

  private async requestSigned(path: string, parameters: Record<string, string>): Promise<unknown> {
    const key = await this.mixinKey();
    const signed = { ...parameters, wts: String(Math.floor(this.now().getTime() / 1_000)) };
    const query = Object.entries(signed)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value.replace(/[!'()*]/g, ''))}`)
      .join('&');
    const url = new URL(path, 'https://api.bilibili.com');
    url.search = `${query}&w_rid=${createHash('md5').update(query + key).digest('hex')}`;
    return this.request(url);
  }

  private async mixinKey(): Promise<string> {
    const now = this.now().getTime();
    if (this.mixinCache && this.mixinCache.expiresAt > now) return this.mixinCache.key;
    const payload = await this.request(new URL('/x/web-interface/nav', 'https://api.bilibili.com'));
    const parsed = bilibiliNavSchema.safeParse(payload);
    if (!parsed.success || !parsed.data.data) throw this.providerError(payload);
    const source = [parsed.data.data.wbi_img.img_url, parsed.data.data.wbi_img.sub_url]
      .map((url) => /\/([^/]+)\.[^.]+$/.exec(new URL(url).pathname)?.[1] ?? '')
      .join('');
    const key = bilibiliMixinTable.map((index) => source[index] ?? '').join('').slice(0, 32);
    if (key.length !== 32) throw new CreatorResolutionError('CREATOR_IDENTITY_UNAVAILABLE', 'Bilibili 身份服务暂时不可用', 503);
    this.mixinCache = { key, expiresAt: now + 10 * 60_000 };
    return key;
  }

  private async request(url: URL): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(url.toString(), { headers: bilibiliHeaders, signal: AbortSignal.timeout(10_000) });
    } catch {
      throw new CreatorResolutionError('CREATOR_IDENTITY_UNAVAILABLE', 'Bilibili 身份服务暂时不可用', 503);
    }
    if (response.status === 412 || response.status === 429 || response.status >= 500) {
      throw new CreatorResolutionError('CREATOR_IDENTITY_UNAVAILABLE', 'Bilibili 身份服务暂时不可用', 503);
    }
    if (!response.ok) throw new CreatorResolutionError('CREATOR_IDENTITY_INVALID', '无法解析该 Bilibili 账号', 400);
    try {
      return await response.json();
    } catch {
      throw new CreatorResolutionError('CREATOR_IDENTITY_INVALID', 'Bilibili 账号响应无效', 400);
    }
  }

  private providerError(payload: unknown): CreatorResolutionError {
    const code = typeof payload === 'object' && payload !== null && 'code' in payload
      ? Number((payload as { code: unknown }).code)
      : NaN;
    return [-412, -352].includes(code)
      ? new CreatorResolutionError('CREATOR_IDENTITY_UNAVAILABLE', 'Bilibili 身份服务暂时不可用', 503)
      : new CreatorResolutionError('CREATOR_IDENTITY_INVALID', '无法解析该 Bilibili 账号', 400);
  }
}

const tokenCandidateSchema = z.strictObject({
  platform: z.enum(['rss', 'x', 'bilibili']),
  accountKey: z.string().trim().min(1).max(2_000),
  resolutionInput: z.string().trim().min(1).max(2_000),
  displayName: z.string().trim().min(1).max(200),
  handle: z.string().trim().min(1).max(200).nullable(),
  avatarUrl: z.string().url().nullable(),
  bio: z.string().trim().min(1).max(1_000).nullable(),
  verified: z.boolean().nullable(),
  profileUrl: z.string().url(),
  feedUrl: z.string().url().nullable(),
});

const tokenPayloadSchema = z.strictObject({
  version: z.literal(1),
  userId: z.string().min(1),
  expiresAt: z.number().int().positive(),
  candidate: tokenCandidateSchema,
});

export class CreatorResolutionService implements CreatorResolutionGateway {
  private readonly byPlatform: Map<string, CreatorIdentityResolver>;

  constructor(
    private readonly resolvers: readonly CreatorIdentityResolver[],
    private readonly secret: string = randomBytes(32).toString('base64url'),
    private readonly now: () => Date = () => new Date(),
    private readonly ttlMs = 10 * 60_000,
  ) {
    this.byPlatform = new Map(resolvers.map((resolver) => [resolver.platform, resolver]));
  }

  capabilities(): CreatorPlatformStatus[] {
    return this.resolvers.map((resolver) => creatorPlatformStatusSchema.parse({
      id: resolver.platform,
      label: resolver.label,
      status: resolver.status,
    }));
  }

  async resolve(userId: string, input: string): Promise<CreatorResolutionResult> {
    const supported = this.resolvers
      .filter((resolver) => resolver.status === 'enabled' && resolver.supports(input));
    const matches = await Promise.allSettled(supported.map((resolver) => resolver.resolve(input)));
    const candidates = matches.flatMap((match) => match.status === 'fulfilled' ? match.value : [])
      .map((candidate) => this.toPublicCandidate(userId, candidate));
    if (matches.length > 0 && matches.every((match) => match.status === 'rejected')) {
      throw (matches[0] as PromiseRejectedResult).reason;
    }
    return creatorResolutionResultSchema.parse({ candidates });
  }

  async confirm(userId: string, tokens: string[]): Promise<ResolvedCreatorIdentity[]> {
    const decoded = tokens.map((token) => this.verify(token, userId));
    const uniqueKeys = new Set(decoded.map(({ platform, accountKey }) => `${platform}:${accountKey}`));
    if (uniqueKeys.size !== decoded.length) {
      throw new CreatorResolutionError('CREATOR_RESOLUTION_DUPLICATE', '不能重复确认同一个账号', 400);
    }
    return Promise.all(decoded.map(async (candidate) => {
      const resolver = this.byPlatform.get(candidate.platform);
      if (!resolver || resolver.status !== 'enabled') {
        throw new CreatorResolutionError('CREATOR_PLATFORM_UNAVAILABLE', '该平台当前不可用', 503);
      }
      const current = await resolver.resolve(candidate.resolutionInput);
      const verified = current.find((item) => item.accountKey === candidate.accountKey);
      if (!verified) {
        throw new CreatorResolutionError('CREATOR_IDENTITY_CHANGED', '账号身份已变化，请重新查找', 400);
      }
      return verified;
    }));
  }

  private toPublicCandidate(
    userId: string,
    candidate: ResolvedCreatorIdentity,
  ): CreatorIdentityCandidate {
    const expiresAt = this.now().getTime() + this.ttlMs;
    const payload = Buffer.from(JSON.stringify({
      version: 1,
      userId,
      expiresAt,
      candidate,
    })).toString('base64url');
    const signature = this.sign(payload);
    return creatorIdentityCandidateSchema.parse({
      resolutionToken: `v1.${payload}.${signature}`,
      platform: candidate.platform,
      displayName: candidate.displayName,
      handle: candidate.handle,
      avatarUrl: candidate.avatarUrl,
      bio: candidate.bio,
      verified: candidate.verified,
      profileUrl: candidate.profileUrl,
      feedUrl: candidate.feedUrl,
    });
  }

  private verify(token: string, userId: string): ResolvedCreatorIdentity {
    const [version, payload, signature, extra] = token.split('.');
    if (version !== 'v1' || !payload || !signature || extra) return this.invalidToken();
    const expected = Buffer.from(this.sign(payload));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return this.invalidToken();
    let raw: unknown;
    try {
      raw = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      return this.invalidToken();
    }
    const parsed = tokenPayloadSchema.safeParse(raw);
    if (!parsed.success || parsed.data.userId !== userId || parsed.data.expiresAt <= this.now().getTime()) {
      return this.invalidToken();
    }
    return parsed.data.candidate;
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url');
  }

  private invalidToken(): never {
    throw new CreatorResolutionError('CREATOR_RESOLUTION_INVALID', '账号确认已失效，请重新查找', 400);
  }
}

function asObject(value: unknown): XmlObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as XmlObject
    : null;
}

function stringValue(value: unknown): string | null {
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value).replace(/\s+/g, ' ').trim();
    return text || null;
  }
  const object = asObject(value);
  return object ? stringValue(object['#text']) : null;
}

function atomAuthor(feed: XmlObject | null): string | null {
  if (!feed) return null;
  const authors = Array.isArray(feed.author) ? feed.author : [feed.author];
  for (const author of authors) {
    const name = stringValue(asObject(author)?.name ?? author);
    if (name) return name;
  }
  return null;
}

function atomAlternateLink(feed: XmlObject | null): unknown {
  if (!feed) return null;
  const links = Array.isArray(feed.link) ? feed.link : [feed.link];
  for (const link of links) {
    const object = asObject(link);
    if (object && (stringValue(object['@_rel']) ?? 'alternate') === 'alternate') {
      return object['@_href'];
    }
    if (typeof link === 'string') return link;
  }
  return null;
}

function httpUrl(value: unknown, baseUrl: string): string | null {
  const raw = stringValue(value);
  if (!raw) return null;
  try {
    const url = new URL(raw, baseUrl);
    return ['http:', 'https:'].includes(url.protocol) ? canonicalizeUrl(url.toString()) : null;
  } catch {
    return null;
  }
}
