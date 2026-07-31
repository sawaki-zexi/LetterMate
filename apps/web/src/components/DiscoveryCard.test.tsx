// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { FeedItem } from '@lettermate/contracts';
import { DiscoveryCard } from './DiscoveryCard.js';
import '../test-setup.js';

const topicItem: FeedItem = {
  id: 'item-1',
  origin: 'topic',
  topicId: 'topic-1',
  kind: 'quality',
  title: 'Agent guide',
  summary: '完整介绍了实现方式。',
  reason: '包含可复现代码与性能数据。',
  sourceUrls: ['https://x.com/project/status/100'],
  publishedAt: null,
  discoveredAt: '2026-07-24T08:00:00.000Z',
  sourceType: 'social',
  platform: 'X',
  authorName: 'Project Team With A Very Long Display Name',
  authorHandle: 'project',
  externalId: '100',
  provenanceKind: 'api_record',
};

describe('DiscoveryCard', () => {
  afterEach(cleanup);

  it('renders Topic context, details, and safe source links without retired trust labels', () => {
    render(<DiscoveryCard item={topicItem} topicKeyword="gpt-5.7" />);
    expect(screen.getByText('来自「gpt-5.7」')).toBeVisible();
    expect(screen.getByTitle('gpt-5.7')).toHaveAttribute('aria-label', '来自「gpt-5.7」');
    expect(screen.getByText('精选')).toBeVisible();
    expect(screen.queryByText('关键词追踪')).not.toBeInTheDocument();
    expect(screen.queryByText('优质')).not.toBeInTheDocument();
    expect(screen.getByText('完整介绍了实现方式。')).toBeVisible();
    expect(screen.getByText(/可复现代码/)).toBeVisible();
    expect(screen.getByText('X')).toBeVisible();
    expect(screen.getByText('社交')).toBeVisible();
    expect(screen.getByText(/@project/)).toBeVisible();
    expect(screen.getByText(/Project Team With A Very Long Display Name/)).toHaveClass('source-author');
    expect(screen.getByRole('link', { name: /查看原文/ })).toHaveAttribute('href', 'https://x.com/project/status/100');
    expect(screen.getByRole('link', { name: /查看原文/ })).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(screen.queryByText(/可信|已核实|评分|证据|排名/)).not.toBeInTheDocument();
  });

  it('labels Radar items as global trend discoveries', () => {
    const trendItem: FeedItem = { ...topicItem, id: 'radar-1', origin: 'trend', topicId: null };
    render(<DiscoveryCard item={trendItem} />);

    expect(screen.getByText('来自全网趋势')).toBeVisible();
    expect(screen.queryByText('关键词追踪')).not.toBeInTheDocument();
    expect(screen.queryByText('趋势发现')).not.toBeInTheDocument();
  });

  it('falls back to the generic Topic context without a keyword', () => {
    render(<DiscoveryCard item={topicItem} />);

    expect(screen.getByText('来自关注主题')).toBeVisible();
  });

  it('uses an h2 by default and supports an h3 inside grouped feeds', () => {
    const { rerender } = render(<DiscoveryCard item={topicItem} />);
    expect(screen.getByRole('heading', { level: 2, name: topicItem.title })).toBeVisible();

    rerender(<DiscoveryCard item={topicItem} headingLevel={3} />);
    expect(screen.getByRole('heading', { level: 3, name: topicItem.title })).toBeVisible();
    expect(screen.queryByRole('heading', { level: 2, name: topicItem.title })).not.toBeInTheDocument();
  });
});
