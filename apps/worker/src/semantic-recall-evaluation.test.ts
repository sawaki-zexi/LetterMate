import { describe, expect, it } from 'vitest';
import { parseSemanticRecallWindow } from './semantic-recall-evaluation.js';

describe('semantic recall evaluation CLI window', () => {
  it('uses an inclusive through date and a bounded rolling day count', () => {
    expect(parseSemanticRecallWindow('2026-08-10', '14')).toEqual({
      start: new Date('2026-07-28T00:00:00.000Z'),
      end: new Date('2026-08-11T00:00:00.000Z'),
    });
    expect(() => parseSemanticRecallWindow('2026-02-30', '14')).toThrow('date is invalid');
    expect(() => parseSemanticRecallWindow('2026-08-10', '0')).toThrow(/between 1 and 365/);
  });
});
