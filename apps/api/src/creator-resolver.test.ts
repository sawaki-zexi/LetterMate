import { describe, expect, it, vi } from 'vitest';
import {
  CreatorResolutionError,
  CreatorResolutionService,
  RssCreatorIdentityResolver,
  SafeRemoteTextFetcher,
  XCreatorIdentityResolver,
  BilibiliCreatorIdentityResolver,
} from './creator-resolver.js';

const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Example Engineering</title>
    <link>https://example.com/blog</link>
    <description>Deep engineering notes</description>
    <managingEditor>editor@example.com (Example Team)</managingEditor>
    <image><url>https://example.com/avatar.png</url></image>
    <item><title>Release</title><link>https://example.com/release</link></item>
  </channel>
</rss>`;

const atom = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Author</title>
  <subtitle>Research updates</subtitle>
  <link rel="alternate" href="https://example.org/" />
  <author><name>Ada</name></author>
</feed>`;

describe('creator identity resolution', () => {
  it('parses an RSS identity and confirms a short-lived user-bound token', async () => {
    const textFetcher = {
      fetch: vi.fn().mockResolvedValue({
        finalUrl: 'https://example.com/feed.xml',
        contentType: 'application/rss+xml',
        text: rss,
      }),
    };
    const resolver = new RssCreatorIdentityResolver(textFetcher);
    const now = new Date('2026-08-07T12:00:00.000Z');
    const service = new CreatorResolutionService([resolver], 'test-resolution-secret', () => now);

    const result = await service.resolve('user-a', 'https://example.com/feed.xml');

    expect(result.candidates).toEqual([expect.objectContaining({
      platform: 'rss',
      displayName: 'Example Engineering',
      handle: 'editor@example.com (Example Team)',
      profileUrl: 'https://example.com/blog',
      feedUrl: 'https://example.com/feed.xml',
      bio: 'Deep engineering notes',
      avatarUrl: 'https://example.com/avatar.png',
      verified: null,
    })]);
    const token = result.candidates[0]!.resolutionToken;
    await expect(service.confirm('user-a', [token])).resolves.toEqual([
      expect.objectContaining({ accountKey: 'https://example.com/feed.xml' }),
    ]);
    await expect(service.confirm('user-b', [token])).rejects.toMatchObject({
      code: 'CREATOR_RESOLUTION_INVALID',
    });
  });

  it('discovers an Atom feed from a public homepage before parsing identity', async () => {
    const textFetcher = {
      fetch: vi.fn()
        .mockResolvedValueOnce({
          finalUrl: 'https://example.org/',
          contentType: 'text/html',
          text: '<html><head><link rel="alternate" type="application/atom+xml" href="/atom.xml"></head></html>',
        })
        .mockResolvedValueOnce({
          finalUrl: 'https://example.org/atom.xml',
          contentType: 'application/atom+xml',
          text: atom,
        }),
    };

    const candidates = await new RssCreatorIdentityResolver(textFetcher)
      .resolve('https://example.org/');

    expect(textFetcher.fetch).toHaveBeenNthCalledWith(2, 'https://example.org/atom.xml');
    expect(candidates).toEqual([expect.objectContaining({
      displayName: 'Atom Author',
      handle: 'Ada',
      profileUrl: 'https://example.org/',
      feedUrl: 'https://example.org/atom.xml',
    })]);
  });

  it('returns no candidates for a name until a matching platform resolver exists', async () => {
    const resolver = new RssCreatorIdentityResolver({ fetch: vi.fn() });
    const service = new CreatorResolutionService([resolver], 'test-resolution-secret');

    await expect(service.resolve('user-a', 'Karpathy')).resolves.toEqual({ candidates: [] });
    expect(resolver.supports('Karpathy')).toBe(false);
  });

  it('rejects expired and duplicate confirmations', async () => {
    let current = new Date('2026-08-07T12:00:00.000Z');
    const resolver = new RssCreatorIdentityResolver({
      fetch: vi.fn().mockResolvedValue({
        finalUrl: 'https://example.com/feed.xml', contentType: 'application/rss+xml', text: rss,
      }),
    });
    const service = new CreatorResolutionService(
      [resolver],
      'test-resolution-secret',
      () => current,
      1_000,
    );
    const token = (await service.resolve('user-a', 'https://example.com/feed.xml'))
      .candidates[0]!.resolutionToken;

    await expect(service.confirm('user-a', [token, token])).rejects.toMatchObject({
      code: 'CREATOR_RESOLUTION_DUPLICATE',
    });
    current = new Date('2026-08-07T12:00:02.000Z');
    await expect(service.confirm('user-a', [token])).rejects.toBeInstanceOf(CreatorResolutionError);
  });

  it('rejects private network feed targets before issuing a request', async () => {
    const request = vi.fn();
    const fetcher = new SafeRemoteTextFetcher(
      { resolveHostname: async () => ['127.0.0.1'] },
      request as typeof fetch,
    );

    await expect(fetcher.fetch('https://private.example/feed.xml')).rejects.toMatchObject({
      code: 'UNSAFE_URL',
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('resolves and revalidates an X profile by stable provider user ID', async () => {
    const user = {
      id: '44196397',
      userName: 'elonmusk',
      name: 'Elon Musk',
      url: '',
      profilePicture: 'https://pbs.twimg.com/profile_images/example.jpg',
      description: 'Mars & cars',
      isBlueVerified: true,
    };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: user, status: 'success' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: user, status: 'success' }), { status: 200 }));
    const resolver = new XCreatorIdentityResolver('test-key', fetcher as typeof fetch);
    const service = new CreatorResolutionService([resolver], 'test-resolution-secret');

    const result = await service.resolve('user-a', 'https://x.com/elonmusk');

    expect(result.candidates).toEqual([expect.objectContaining({
      platform: 'x',
      displayName: 'Elon Musk',
      handle: '@elonmusk',
      verified: true,
      profileUrl: 'https://x.com/elonmusk',
      feedUrl: null,
    })]);
    await expect(service.confirm('user-a', [result.candidates[0]!.resolutionToken]))
      .resolves.toEqual([expect.objectContaining({ accountKey: '44196397' })]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetcher.mock.calls[0]![0])).pathname).toBe('/twitter/user/info');
  });

  it('searches bare X text with provider-native fields and exposes an unconfigured platform', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      users: [{
        id: '1',
        screen_name: 'karpathy',
        name: 'Andrej Karpathy',
        url: '',
        profile_image_url_https: 'https://pbs.twimg.com/profile_images/karpathy.jpg',
        isBlueVerified: true,
      }, {
        id: '2',
        screen_name: 'defaultavatar',
        name: 'Default Avatar',
        url: '',
        profile_image_url_https: 'https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png',
      }],
      has_next_page: false,
      next_cursor: '',
    }), { status: 200 }));
    const enabled = new XCreatorIdentityResolver('test-key', fetcher as typeof fetch);
    const disabled = new XCreatorIdentityResolver(undefined, fetcher as typeof fetch);

    await expect(enabled.resolve('karp')).resolves.toEqual([
      expect.objectContaining({
        accountKey: '1',
        handle: '@karpathy',
        avatarUrl: 'https://wsrv.nl/?url=https%3A%2F%2Fpbs.twimg.com%2Fprofile_images%2Fkarpathy.jpg&w=96&h=96&fit=cover&output=webp',
      }),
      expect.objectContaining({
        accountKey: '2',
        handle: '@defaultavatar',
        avatarUrl: 'https://wsrv.nl/?url=https%3A%2F%2Fabs.twimg.com%2Fsticky%2Fdefault_profile_images%2Fdefault_profile_normal.png&w=96&h=96&fit=cover&output=webp',
      }),
    ]);
    expect(new URL(String(fetcher.mock.calls[0]![0])).pathname).toBe('/twitter/user/search');
    expect(new URL(String(fetcher.mock.calls[0]![0])).searchParams.get('query')).toBe('karp');
    expect(new CreatorResolutionService([disabled]).capabilities()).toEqual([
      { id: 'x', label: 'X', status: 'not_configured' },
    ]);
    await expect(new CreatorResolutionService([disabled]).resolve('user-a', 'Karpathy'))
      .resolves.toEqual({ candidates: [] });
  });

  it('resolves Bilibili UP names through signed search results', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: -101,
        data: {
          wbi_img: {
            img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
            sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
          },
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0,
        data: { result: [{
          mid: 946974,
          uname: '影视飓风',
          upic: '//i0.hdslb.com/avatar.jpg',
          usign: '无限进步',
          official_verify: { type: 0, desc: '百大 UP 主' },
        }] },
      }), { status: 200 }));
    const resolver = new BilibiliCreatorIdentityResolver(
      fetcher as typeof fetch,
      () => new Date('2026-08-07T12:00:00.000Z'),
    );

    const candidates = await resolver.resolve('影视飓风');

    expect(candidates).toEqual([expect.objectContaining({
      platform: 'bilibili',
      accountKey: '946974',
      displayName: '影视飓风',
      handle: 'UID 946974',
      verified: true,
      profileUrl: 'https://space.bilibili.com/946974',
      feedUrl: null,
    })]);
    const searchUrl = new URL(String(fetcher.mock.calls[1]![0]));
    expect(searchUrl.pathname).toBe('/x/web-interface/wbi/search/type');
    expect(searchUrl.searchParams.get('search_type')).toBe('bili_user');
    expect(searchUrl.searchParams.get('w_rid')).toMatch(/^[a-f0-9]{32}$/);
  });

  it('resolves and revalidates a Bilibili space URL by stable mid', async () => {
    const card = {
      code: 0,
      data: { card: {
        mid: '946974', name: '影视飓风', face: 'https://i0.hdsl.com/avatar.jpg',
        sign: '无限进步', official_verify: { type: 0, desc: '百大 UP 主' },
      } },
    };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(card), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(card), { status: 200 }));
    const resolver = new BilibiliCreatorIdentityResolver(fetcher as typeof fetch);
    const service = new CreatorResolutionService([resolver], 'test-resolution-secret');

    const result = await service.resolve('user-a', 'https://space.bilibili.com/946974');
    await expect(service.confirm('user-a', [result.candidates[0]!.resolutionToken]))
      .resolves.toEqual([expect.objectContaining({ accountKey: '946974', resolutionInput: 'mid:946974' })]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps successful creator platforms available when another name resolver fails', async () => {
    const failed = {
      platform: 'bilibili' as const,
      label: 'Bilibili',
      status: 'enabled' as const,
      supports: () => true,
      resolve: vi.fn().mockRejectedValue(new CreatorResolutionError(
        'CREATOR_IDENTITY_UNAVAILABLE', 'Bilibili 身份服务暂时不可用', 503,
      )),
    };
    const successful = {
      platform: 'x' as const,
      label: 'X',
      status: 'enabled' as const,
      supports: () => true,
      resolve: vi.fn().mockResolvedValue([{
        platform: 'x' as const,
        accountKey: '1',
        resolutionInput: '@example',
        displayName: 'Example',
        handle: '@example',
        avatarUrl: null,
        bio: null,
        verified: false,
        profileUrl: 'https://x.com/example',
        feedUrl: null,
      }]),
    };
    const service = new CreatorResolutionService([failed, successful], 'test-resolution-secret');

    await expect(service.resolve('user-a', 'Example')).resolves.toEqual({
      candidates: [expect.objectContaining({ platform: 'x', displayName: 'Example' })],
    });
  });
});
