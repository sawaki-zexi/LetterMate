import { describe, expect, it } from 'vitest';
import { urlBase64ToUint8Array } from './push.js';

describe('Web Push key handling', () => {
  it('converts a URL-safe base64 VAPID key to bytes', () => {
    expect([...urlBase64ToUint8Array('AQIDBA')]).toEqual([1, 2, 3, 4]);
  });
});
