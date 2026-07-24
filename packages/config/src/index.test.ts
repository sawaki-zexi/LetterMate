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
});
