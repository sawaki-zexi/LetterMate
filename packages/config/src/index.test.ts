import { describe, expect, it } from 'vitest';
import { parseConfig } from './index.js';

describe('configuration', () => {
  it('requires secrets in production', () => {
    expect(() =>
      parseConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://db/app' }),
    ).toThrow(/SESSION_SECRET/);
  });

  it('provides safe local service defaults', () => {
    expect(parseConfig({ NODE_ENV: 'development' })).toMatchObject({
      PORT: 3000,
      WEB_ORIGIN: 'http://localhost:5173',
    });
  });

  it('defaults to OpenRouter auto routing and web search', () => {
    expect(parseConfig({ NODE_ENV: 'development', AI_API_KEY: 'secret' })).toMatchObject({
      AI_API_KEY: 'secret',
      AI_MODEL: 'openrouter/auto',
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
});
