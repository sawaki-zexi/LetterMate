import { lookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import { load } from 'cheerio';
import ipaddr from 'ipaddr.js';
import { Agent } from 'undici';

export class ContentFetchError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'ContentFetchError'; }
}

export interface ContentFetcherOptions {
  maxBytes?: number; maxRedirects?: number; timeoutMs?: number;
  resolveHostname?: (hostname: string) => Promise<string[]>;
}
export interface FetchedText { finalUrl: string; title: string | null; text: string; contentType: string }

const defaultResolve = async (hostname: string): Promise<string[]> => (
  (await lookup(hostname, { all: true, verbatim: true })).map((result) => result.address)
);
const unsafeHostname = new Set(['metadata.google.internal', 'metadata', 'instance-data']);
const unsafeIp = (address: string): boolean => {
  try {
    return ipaddr.process(address).range() !== 'unicast';
  } catch {
    return true;
  }
};

interface SafeTarget {
  address: string;
  family: 4 | 6;
}

export class ContentFetcher {
  private readonly maxBytes: number; private readonly maxRedirects: number; private readonly timeoutMs: number; private readonly resolveHostname: (hostname: string) => Promise<string[]>;
  constructor(options: ContentFetcherOptions = {}, private readonly fetcher: typeof fetch = fetch) {
    this.maxBytes = options.maxBytes ?? 1_000_000; this.maxRedirects = options.maxRedirects ?? 3; this.timeoutMs = options.timeoutMs ?? 20_000; this.resolveHostname = options.resolveHostname ?? defaultResolve;
  }

  async fetchText(inputUrl: string, parentSignal?: AbortSignal): Promise<FetchedText> {
    let current = inputUrl; const visited = new Set<string>();
    for (let redirects = 0; redirects <= this.maxRedirects; redirects += 1) {
      if (visited.has(current)) throw new ContentFetchError('TOO_MANY_REDIRECTS', 'Source redirect loop detected');
      visited.add(current);
      const target = await this.assertSafeUrl(current);
      const controller = new AbortController();
      let timedOut = false;
      const abort = () => controller.abort();
      if (parentSignal?.aborted) controller.abort();
      else parentSignal?.addEventListener('abort', abort, { once: true });
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
        } as RequestInit & { dispatcher: Agent });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          await response.body?.cancel();
          if (!location) throw new ContentFetchError('CONTENT_FETCH_FAILED', 'Source redirect has no location');
          if (redirects === this.maxRedirects) throw new ContentFetchError('TOO_MANY_REDIRECTS', 'Source has too many redirects');
          current = new URL(location, current).toString();
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new ContentFetchError('CONTENT_FETCH_FAILED', 'Source request failed');
        }
        const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
        if (!['text/html', 'application/xhtml+xml', 'text/plain'].includes(contentType)) {
          await response.body?.cancel();
          throw new ContentFetchError('UNSUPPORTED_CONTENT_TYPE', 'Source content type is not text');
        }
        const declaredLength = Number(response.headers.get('content-length') ?? 0);
        if (declaredLength > this.maxBytes) {
          await response.body?.cancel();
          throw new ContentFetchError('CONTENT_TOO_LARGE', 'Source content exceeds the size limit');
        }
        const body = await this.readBody(response);
        return { finalUrl: current, contentType, ...this.extract(body, contentType) };
      } catch (error) {
        if (error instanceof ContentFetchError) throw error;
        if (parentSignal?.aborted) throw new ContentFetchError('CONTENT_FETCH_ABORTED', 'Source request was aborted');
        if (timedOut) throw new ContentFetchError('CONTENT_FETCH_TIMEOUT', 'Source request timed out');
        throw new ContentFetchError('CONTENT_FETCH_FAILED', 'Source request failed');
      } finally {
        clearTimeout(timer);
        parentSignal?.removeEventListener('abort', abort);
        await dispatcher.close();
      }
    }
    throw new ContentFetchError('TOO_MANY_REDIRECTS', 'Source has too many redirects');
  }

  private async assertSafeUrl(value: string): Promise<SafeTarget> {
    let url: URL; try { url = new URL(value); } catch { throw new ContentFetchError('UNSAFE_SOURCE_URL', 'Source URL is invalid'); }
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || unsafeHostname.has(hostname.toLowerCase())) throw new ContentFetchError('UNSAFE_SOURCE_URL', 'Source URL is not public HTTP(S)');
    let addresses: string[];
    if (isIP(hostname)) addresses = [hostname];
    else {
      try { addresses = await this.resolveHostname(hostname); }
      catch { throw new ContentFetchError('UNSAFE_SOURCE_URL', 'Source hostname could not be resolved safely'); }
    }
    if (addresses.length === 0 || addresses.some(unsafeIp)) throw new ContentFetchError('UNSAFE_SOURCE_URL', 'Source hostname resolves to a private address');
    const address = addresses[0]!;
    const family = isIP(address);
    if (family !== 4 && family !== 6) throw new ContentFetchError('UNSAFE_SOURCE_URL', 'Source hostname returned an invalid address');
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
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > this.maxBytes) {
          await reader.cancel();
          throw new ContentFetchError('CONTENT_TOO_LARGE', 'Source content exceeds the size limit');
        }
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder().decode(bytes);
  }

  private extract(body: string, contentType: string): { title: string | null; text: string } {
    if (contentType === 'text/plain') return { title: null, text: body.trim() };
    const $ = load(body); $('script,style,noscript,nav,form,header,footer,aside').remove();
    const title = $('title').first().text().replace(/\s+/g, ' ').trim() || null;
    const root = $('article,main').first(); const text = (root.length ? root.text() : $('body').text()).replace(/\s+/g, ' ').trim();
    return { title, text };
  }
}
