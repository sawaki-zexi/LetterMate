import { describe, expect, it, vi } from 'vitest';
import { ContentFetcher } from './content-fetcher.js';

const publicResolver = async (_hostname: string): Promise<string[]> => ['93.184.216.34'];
const makeResponse = (body: string, headers: Record<string, string> = {}) => new Response(body, {
  status: 200, headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
});

describe('ContentFetcher', () => {
  it('extracts substantive HTML text and removes navigation noise', async () => {
    const fetcher = new ContentFetcher({ resolveHostname: publicResolver }, vi.fn().mockResolvedValue(
      makeResponse('<html><head><title>Article</title><script>bad()</script></head><body><nav>Menu</nav><main><h1>Article</h1><p>Substantive body text.</p></main><form>Ads</form></body></html>'),
    ) as typeof fetch);

    const result = await fetcher.fetchText('https://example.com/article');
    expect(result).toMatchObject({ title: 'Article', text: expect.stringContaining('Substantive body text.') });
    expect(result.text).not.toContain('Menu');
  });

  it.each([
    'http://127.0.0.1/admin', 'http://10.0.0.1/internal', 'http://169.254.169.254/latest/meta-data',
    'http://[::1]/admin', 'http://[fe90::1]/internal', 'http://[::ffff:127.0.0.1]/admin',
  ])('rejects unsafe literal address %s before fetching', async (url) => {
    const request = vi.fn();
    const fetcher = new ContentFetcher({ resolveHostname: publicResolver }, request as typeof fetch);
    await expect(fetcher.fetchText(url)).rejects.toMatchObject({ code: 'UNSAFE_SOURCE_URL' });
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects a hostname resolving to a private address', async () => {
    const request = vi.fn();
    const fetcher = new ContentFetcher({ resolveHostname: async () => ['192.168.1.12'] }, request as typeof fetch);
    await expect(fetcher.fetchText('https://private.example/article')).rejects.toMatchObject({ code: 'UNSAFE_SOURCE_URL' });
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects a hostname resolving to an IPv4-mapped private IPv6 address', async () => {
    const request = vi.fn();
    const fetcher = new ContentFetcher({ resolveHostname: async () => ['::ffff:7f00:1'] }, request as typeof fetch);

    await expect(fetcher.fetchText('https://private.example/article')).rejects.toMatchObject({ code: 'UNSAFE_SOURCE_URL' });
    expect(request).not.toHaveBeenCalled();
  });

  it('pins the validated DNS address on the actual request', async () => {
    const resolver = vi.fn(publicResolver);
    const request = vi.fn().mockResolvedValue(makeResponse('Public body content.'));
    const fetcher = new ContentFetcher({ resolveHostname: resolver }, request as typeof fetch);

    await fetcher.fetchText('https://example.com/article');

    expect(resolver).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]![1]).toHaveProperty('dispatcher');
  });

  it('keeps the timeout active while reading the response body', async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const signal = init?.signal;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('partial'));
            signal?.addEventListener('abort', () => {
              controller.error(new DOMException('Aborted', 'AbortError'));
            }, { once: true });
          },
        });
        return new Response(stream, { headers: { 'content-type': 'text/plain' } });
      });
      const fetcher = new ContentFetcher({ resolveHostname: publicResolver, timeoutMs: 20 }, request as typeof fetch);
      const result = fetcher.fetchText('https://example.com/slow');
      let rejection: unknown;
      void result.catch((error: unknown) => { rejection = error; });

      await vi.advanceTimersByTimeAsync(21);

      expect(rejection).toMatchObject({ code: 'CONTENT_FETCH_TIMEOUT' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('validates redirects, redirect count, MIME type, and response size', async () => {
    const privateRedirect = new ContentFetcher({ resolveHostname: publicResolver }, vi.fn().mockResolvedValue(
      new Response('', { status: 302, headers: { location: 'http://127.0.0.1/private' } }),
    ) as typeof fetch);
    await expect(privateRedirect.fetchText('https://example.com/start')).rejects.toMatchObject({ code: 'UNSAFE_SOURCE_URL' });

    const redirectFetcher = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 302, headers: { location: 'https://example.com/two' } }))
      .mockResolvedValueOnce(new Response('', { status: 302, headers: { location: 'https://example.com/three' } }));
    await expect(new ContentFetcher({ resolveHostname: publicResolver, maxRedirects: 1 }, redirectFetcher as typeof fetch)
      .fetchText('https://example.com/one')).rejects.toMatchObject({ code: 'TOO_MANY_REDIRECTS' });

    const binary = new ContentFetcher({ resolveHostname: publicResolver }, vi.fn().mockResolvedValue(
      new Response('image', { status: 200, headers: { 'content-type': 'image/png' } }),
    ) as typeof fetch);
    await expect(binary.fetchText('https://example.com/image')).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT_TYPE' });

    const large = new ContentFetcher({ resolveHostname: publicResolver, maxBytes: 10 }, vi.fn().mockResolvedValue(
      makeResponse('01234567890'),
    ) as typeof fetch);
    await expect(large.fetchText('https://example.com/large')).rejects.toMatchObject({ code: 'CONTENT_TOO_LARGE' });
  });
});
