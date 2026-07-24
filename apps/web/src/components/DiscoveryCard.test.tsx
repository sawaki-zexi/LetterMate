// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { DiscoveryItem } from '@lettermate/contracts';
import { DiscoveryCard } from './DiscoveryCard.js';
import '../test-setup.js';

const item: DiscoveryItem = {
  id: 'item-1',
  topicId: 'topic-1',
  kind: 'quality',
  title: 'Agent guide',
  summary: '完整介绍了实现方式。',
  reason: '包含可复现代码与性能数据。',
  sourceUrls: ['https://example.com/guide'],
  publishedAt: null,
  discoveredAt: '2026-07-24T08:00:00.000Z',
};

describe('DiscoveryCard', () => {
  it('renders classification, summary, reason and safe source links', () => {
    render(<DiscoveryCard item={item} />);
    expect(screen.getByText('优质')).toBeVisible();
    expect(screen.getByText('完整介绍了实现方式。')).toBeVisible();
    expect(screen.getByText(/可复现代码/)).toBeVisible();
    expect(screen.getByRole('link', { name: /查看原文/ })).toHaveAttribute('href', 'https://example.com/guide');
    expect(screen.getByRole('link', { name: /查看原文/ })).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });
});
