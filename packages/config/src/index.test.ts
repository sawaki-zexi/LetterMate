import { describe, expect, it } from 'vitest';
import { isEmailDeliveryConfigured, parseConfig } from './index.js';

describe('configuration', () => {
  it('requires secrets in production', () => {
    expect(() =>
      parseConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://db/app' }),
    ).toThrow(/SESSION_SECRET/);
  });

  it('provides safe local service defaults', () => {
    expect(parseConfig({ NODE_ENV: 'development' })).toMatchObject({
      PORT: 3000,
      METRICS_PORT: 9464,
      WEB_ORIGIN: 'http://localhost:5173',
      ALLOW_DEV_IDENTITY: true,
      EMAIL_PROVIDER: 'none',
      SMTP_ENABLED: false,
      SMTP_PORT: 587,
      SMTP_SECURE: false,
      SMTP_REQUIRE_TLS: true,
    });
  });

  it('selects and validates the Resend email provider', () => {
    const config = parseConfig({
      EMAIL_PROVIDER: 'resend',
      RESEND_API_KEY: 're_secret',
      RESEND_FROM: 'LetterMate <digest@mail.example.com>',
      RESEND_TIMEOUT_MS: '15000',
    });

    expect(config).toMatchObject({
      EMAIL_PROVIDER: 'resend',
      RESEND_API_KEY: 're_secret',
      RESEND_FROM: 'LetterMate <digest@mail.example.com>',
      RESEND_API_BASE_URL: 'https://api.resend.com',
      RESEND_TIMEOUT_MS: 15_000,
    });
    expect(isEmailDeliveryConfigured(config)).toBe(true);
    expect(() => parseConfig({ EMAIL_PROVIDER: 'resend' }))
      .toThrow(/RESEND_API_KEY, RESEND_FROM/);
    expect(() => parseConfig({
      EMAIL_PROVIDER: 'resend',
      RESEND_API_KEY: 're_secret',
      RESEND_FROM: 'digest@example.com',
      RESEND_API_BASE_URL: 'http://api.example.com',
    })).toThrow(/HTTPS/);
  });

  it('requires a dedicated unsubscribe secret for configured production email', () => {
    const production = {
      NODE_ENV: 'production',
      WEB_ORIGIN: 'https://discovery.example.com',
      SESSION_SECRET: 's'.repeat(32),
      CSRF_SECRET: 'c'.repeat(32),
      ALLOW_DEV_IDENTITY: 'false',
      EMAIL_PROVIDER: 'resend',
      RESEND_API_KEY: 're_secret',
      RESEND_FROM: 'digest@example.com',
    };
    expect(() => parseConfig(production)).toThrow(/EMAIL_UNSUBSCRIBE_SECRET/);
    expect(parseConfig({
      ...production,
      EMAIL_UNSUBSCRIBE_SECRET: 'u'.repeat(32),
      RESEND_WEBHOOK_SECRET: `whsec_${Buffer.from('webhook-secret-value').toString('base64')}`,
    }).EMAIL_UNSUBSCRIBE_SECRET).toBe('u'.repeat(32));
  });

  it('requires and validates the Resend webhook secret in production', () => {
    const production = {
      NODE_ENV: 'production',
      WEB_ORIGIN: 'https://discovery.example.com',
      SESSION_SECRET: 's'.repeat(32),
      CSRF_SECRET: 'c'.repeat(32),
      ALLOW_DEV_IDENTITY: 'false',
      EMAIL_PROVIDER: 'resend',
      EMAIL_UNSUBSCRIBE_SECRET: 'u'.repeat(32),
      RESEND_API_KEY: 're_secret',
      RESEND_FROM: 'digest@example.com',
    };
    expect(() => parseConfig(production)).toThrow(/RESEND_WEBHOOK_SECRET/);
    expect(() => parseConfig({ ...production, RESEND_WEBHOOK_SECRET: 'not-a-webhook-secret' }))
      .toThrow();
    expect(parseConfig({
      ...production,
      RESEND_WEBHOOK_SECRET: `whsec_${Buffer.from('webhook-secret-value').toString('base64')}`,
    }).RESEND_WEBHOOK_SECRET).toMatch(/^whsec_/);
  });

  it('validates complete SMTP configuration without exposing credentials', () => {
    expect(parseConfig({
      SMTP_ENABLED: 'true',
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '465',
      SMTP_SECURE: 'true',
      SMTP_USER: 'mailer',
      SMTP_PASSWORD: 'secret',
      SMTP_FROM: 'LetterMate <digest@example.com>',
      SMTP_MESSAGE_ID_DOMAIN: 'mail.example.com',
    })).toMatchObject({
      EMAIL_PROVIDER: 'smtp',
      SMTP_ENABLED: true,
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: 465,
      SMTP_SECURE: true,
      SMTP_USER: 'mailer',
      SMTP_PASSWORD: 'secret',
      SMTP_FROM: 'LetterMate <digest@example.com>',
      SMTP_MESSAGE_ID_DOMAIN: 'mail.example.com',
    });
    expect(() => parseConfig({ SMTP_ENABLED: 'true' })).toThrow(/SMTP_HOST, SMTP_FROM/);
    expect(() => parseConfig({
      SMTP_ENABLED: 'true', SMTP_HOST: 'smtp.example.com', SMTP_FROM: 'digest@example.com',
      SMTP_USER: 'mailer',
    })).toThrow(/configured together/);
    expect(() => parseConfig({ SMTP_MESSAGE_ID_DOMAIN: 'https://mail.example.com' })).toThrow();
    expect(() => parseConfig({
      EMAIL_PROVIDER: 'none',
      SMTP_ENABLED: 'true',
      SMTP_HOST: 'smtp.example.com',
      SMTP_FROM: 'digest@example.com',
    })).toThrow(/EMAIL_PROVIDER/);
  });

  it('provides bounded discovery execution defaults', () => {
    expect(parseConfig({})).toMatchObject({
      DISCOVERY_RUN_TIMEOUT_MS: 600_000,
      DISCOVERY_CONNECTOR_CONCURRENCY: 4,
      DISCOVERY_SCHEDULER_ENABLED: true,
    });
  });

  it('provides safe trend monitor defaults', () => {
    expect(parseConfig({})).toMatchObject({
      TREND_MONITOR_ENABLED: true,
      TREND_INTERVAL_HOURS: 4,
      TREND_X_WOEIDS: [1],
      TREND_YOUTUBE_REGION: 'US',
      TREND_REDDIT_COMMUNITIES: [
        'MachineLearning',
        'LocalLLaMA',
        'programming',
        'technology',
      ],
      TREND_GOOGLE_RSS_URLS: [],
    });
  });

  it('parses explicit trend monitor configuration', () => {
    expect(parseConfig({
      TREND_MONITOR_ENABLED: 'false',
      TREND_INTERVAL_HOURS: '12',
      TREND_X_WOEIDS: '1, 23424977',
      TREND_YOUTUBE_REGION: 'CA',
      TREND_REDDIT_COMMUNITIES: 'MachineLearning, tech-news, local_ai',
      TREND_GOOGLE_RSS_URLS: 'https://example.com/trends.xml, https://example.org/rss',
    })).toMatchObject({
      TREND_MONITOR_ENABLED: false,
      TREND_INTERVAL_HOURS: 12,
      TREND_X_WOEIDS: [1, 23424977],
      TREND_YOUTUBE_REGION: 'CA',
      TREND_REDDIT_COMMUNITIES: ['MachineLearning', 'tech-news', 'local_ai'],
      TREND_GOOGLE_RSS_URLS: [
        'https://example.com/trends.xml',
        'https://example.org/rss',
      ],
    });
  });

  it('rejects trend intervals outside the configured bounds', () => {
    expect(() => parseConfig({ TREND_INTERVAL_HOURS: '1' })).toThrow();
    expect(() => parseConfig({ TREND_INTERVAL_HOURS: '25' })).toThrow();
  });

  it.each(['0', '-1', '1.5', 'worldwide', '1,0'])('rejects invalid trend WOEIDs: %s', (value) => {
    expect(() => parseConfig({ TREND_X_WOEIDS: value })).toThrow();
  });

  it.each(['us', 'USA', 'U1', ' U S '])('rejects invalid YouTube region codes: %s', (value) => {
    expect(() => parseConfig({ TREND_YOUTUBE_REGION: value })).toThrow();
  });

  it('rejects Reddit community paths', () => {
    expect(() => parseConfig({ TREND_REDDIT_COMMUNITIES: 'r/programming' })).toThrow();
    expect(() => parseConfig({ TREND_REDDIT_COMMUNITIES: 'programming/news' })).toThrow();
  });

  it('rejects non-HTTPS trend RSS URLs', () => {
    expect(() => parseConfig({ TREND_GOOGLE_RSS_URLS: 'http://example.com/trends.xml' })).toThrow();
    expect(() => parseConfig({ TREND_GOOGLE_RSS_URLS: 'ftp://example.com/trends.xml' })).toThrow();
  });

  it('defaults to OpenRouter auto routing and web search', () => {
    expect(parseConfig({ NODE_ENV: 'development', AI_API_KEY: 'secret' })).toMatchObject({
      AI_API_KEY: 'secret',
      AI_MODEL: 'openrouter/auto',
      AI_PROVIDER_ORDER: ['DeepSeek'],
      AI_PROVIDER_FALLBACKS: false,
      AI_RUN_MAX_CALLS: 200,
      AI_RUN_MAX_COST_USD: 10,
      AI_WEB_SEARCH: true,
      AI_TIMEOUT_MS: 60_000,
    });
  });

  it('allows selecting another OpenRouter model without code changes', () => {
    expect(
      parseConfig({ AI_API_KEY: 'secret', AI_MODEL: 'openai/gpt-4.1-mini' }).AI_MODEL,
    ).toBe('openai/gpt-4.1-mini');
  });

  it('treats an empty example Key as not configured', () => {
    expect(parseConfig({ AI_API_KEY: '' }).AI_API_KEY).toBeUndefined();
  });

  it('rejects ambiguous web search configuration', () => {
    expect(() => parseConfig({ AI_WEB_SEARCH: 'yes' })).toThrow();
  });

  it('accepts optional connector configuration', () => {
    expect(
      parseConfig({
        TWITTERAPI_IO_API_KEY: 'x-key',
        GITHUB_TOKEN: 'github-token',
        YOUTUBE_API_KEY: 'youtube-key',
        REDDIT_CLIENT_ID: 'reddit-client',
        REDDIT_CLIENT_SECRET: 'reddit-secret',
        SEARCH_PROVIDER: 'search-provider',
        SEARCH_API_KEY: 'search-key',
        SEARCH_API_BASE_URL: 'https://search.example.com/v1',
        TAVILY_API_KEY: 'tavily-key',
        TAVILY_API_BASE_URL: 'https://tavily.example.com/search',
        BING_SEARCH_ENABLED: 'false',
        BING_SEARCH_BASE_URL: 'https://cn.bing.com/search',
      }),
    ).toMatchObject({
      TWITTERAPI_IO_API_KEY: 'x-key',
      GITHUB_TOKEN: 'github-token',
      YOUTUBE_API_KEY: 'youtube-key',
      REDDIT_CLIENT_ID: 'reddit-client',
      REDDIT_CLIENT_SECRET: 'reddit-secret',
      SEARCH_PROVIDER: 'search-provider',
      SEARCH_API_KEY: 'search-key',
      SEARCH_API_BASE_URL: 'https://search.example.com/v1',
      TAVILY_API_KEY: 'tavily-key',
      TAVILY_API_BASE_URL: 'https://tavily.example.com/search',
      BING_SEARCH_ENABLED: false,
      BING_SEARCH_BASE_URL: 'https://cn.bing.com/search',
    });
  });

  it('parses and validates configured RSS feed URLs', () => {
    expect(parseConfig({
      DISCOVERY_RSS_FEED_URLS: 'https://example.com/feed.xml, https://example.org/rss',
    }).DISCOVERY_RSS_FEED_URLS).toEqual([
      'https://example.com/feed.xml',
      'https://example.org/rss',
    ]);
    expect(() => parseConfig({
      DISCOVERY_RSS_FEED_URLS: 'https://example.com/feed.xml,not-a-url',
    })).toThrow();
  });

  it('treats empty optional connector configuration as absent', () => {
    expect(
      parseConfig({
        TWITTERAPI_IO_API_KEY: '',
        SEARCH_API_BASE_URL: '',
      }),
    ).toMatchObject({
      TWITTERAPI_IO_API_KEY: undefined,
      SEARCH_API_BASE_URL: undefined,
    });
  });

  it('validates discovery execution bounds and search URLs', () => {
    expect(() => parseConfig({ DISCOVERY_RUN_TIMEOUT_MS: '59999' })).toThrow();
    expect(() => parseConfig({ DISCOVERY_RUN_TIMEOUT_MS: '900001' })).toThrow();
    expect(() => parseConfig({ DISCOVERY_CONNECTOR_CONCURRENCY: '0' })).toThrow();
    expect(() => parseConfig({ DISCOVERY_CONNECTOR_CONCURRENCY: '17' })).toThrow();
    expect(() => parseConfig({ SEARCH_API_BASE_URL: 'not-a-url' })).toThrow();
  });

  it('parses an explicitly disabled discovery scheduler', () => {
    expect(parseConfig({ DISCOVERY_SCHEDULER_ENABLED: 'false' }).DISCOVERY_SCHEDULER_ENABLED).toBe(
      false,
    );
  });

  it('does not require optional connector keys in production', () => {
    expect(() =>
      parseConfig({
        NODE_ENV: 'production',
        WEB_ORIGIN: 'https://discovery.example.com',
        SESSION_SECRET: 's'.repeat(32),
        CSRF_SECRET: 'c'.repeat(32),
        ALLOW_DEV_IDENTITY: 'false',
      }),
    ).not.toThrow();
  });

  it('validates the internal Worker metrics port', () => {
    expect(parseConfig({ METRICS_PORT: '19464' }).METRICS_PORT).toBe(19464);
    expect(() => parseConfig({ METRICS_PORT: '0' })).toThrow();
  });

  it('parses task model routes, fallbacks, and conservative run budgets', () => {
    expect(parseConfig({
      AI_FAST_MODEL: 'fast/model',
      AI_QUALITY_MODEL: 'quality/model',
      AI_FALLBACK_MODELS: 'fallback/a, fallback/b',
      AI_PROVIDER_ORDER: 'Provider A, Provider B',
      AI_PROVIDER_FALLBACKS: 'true',
      AI_RUN_MAX_CALLS: '12',
      AI_RUN_MAX_COST_USD: '2.5',
    })).toMatchObject({
      AI_FAST_MODEL: 'fast/model',
      AI_QUALITY_MODEL: 'quality/model',
      AI_FALLBACK_MODELS: ['fallback/a', 'fallback/b'],
      AI_PROVIDER_ORDER: ['Provider A', 'Provider B'],
      AI_PROVIDER_FALLBACKS: true,
      AI_RUN_MAX_CALLS: 12,
      AI_RUN_MAX_COST_USD: 2.5,
    });
  });

  it('requires production to disable the development identity', () => {
    expect(() => parseConfig({
      NODE_ENV: 'production',
      SESSION_SECRET: 's'.repeat(32),
      CSRF_SECRET: 'c'.repeat(32),
    })).toThrow(/ALLOW_DEV_IDENTITY/);
    expect(parseConfig({
      NODE_ENV: 'production',
      WEB_ORIGIN: 'https://discovery.example.com',
      SESSION_SECRET: 's'.repeat(32),
      CSRF_SECRET: 'c'.repeat(32),
      ALLOW_DEV_IDENTITY: 'false',
    }).ALLOW_DEV_IDENTITY).toBe(false);
  });

  it('requires an HTTPS Web origin in production', () => {
    expect(() => parseConfig({
      NODE_ENV: 'production',
      WEB_ORIGIN: 'http://discovery.example.com',
      SESSION_SECRET: 's'.repeat(32),
      CSRF_SECRET: 'c'.repeat(32),
      ALLOW_DEV_IDENTITY: 'false',
    })).toThrow(/WEB_ORIGIN.*HTTPS/);
  });
});
