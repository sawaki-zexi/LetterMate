import { describe, expect, it } from 'vitest';
import { isChineseContent } from './chinese-content.js';

describe('isChineseContent', () => {
  it('accepts Chinese prose with product names and versions', () => {
    expect(isChineseContent('GPT-5.7 发布了新的工具调用能力。')).toBe(true);
    expect(isChineseContent('这篇文章解释了 React 19 的迁移步骤和已知限制。')).toBe(true);
  });

  it('rejects an English paragraph', () => {
    expect(isChineseContent('This article explains the release and migration details.')).toBe(false);
  });

  it('rejects one incidental Chinese character in an English paragraph', () => {
    expect(isChineseContent('This article explains the 新 release details.')).toBe(false);
  });
});
