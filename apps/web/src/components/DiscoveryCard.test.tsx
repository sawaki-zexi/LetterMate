// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FeedItem } from '@lettermate/contracts';
import { DiscoveryCard } from './DiscoveryCard.js';
import '../test-setup.js';

const topicItem: FeedItem = {
  id: 'item-1',
  origin: 'topic',
  topicId: 'topic-1',
  topicKeyword: 'gpt-5.7',
  topicKeywordActive: true,
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
  contentKey: 'https://x.com/project/status/100',
  feedback: null,
  origins: [{
    origin: 'topic', topicId: 'topic-1', topicKeyword: 'gpt-5.7', topicKeywordActive: true,
  }],
};

describe('DiscoveryCard', () => {
  afterEach(cleanup);

  it('renders Topic context, details, and safe source links without retired trust labels', () => {
    render(<DiscoveryCard item={topicItem} />);
    expect(screen.getByText('来自「gpt-5.7」')).toBeVisible();
    expect(screen.getByTitle('来自「gpt-5.7」')).toHaveAttribute('aria-label', '来自「gpt-5.7」');
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
    const trendItem: FeedItem = {
      ...topicItem, id: 'radar-1', origin: 'trend', topicId: null,
      origins: [{ origin: 'trend' }],
    };
    render(<DiscoveryCard item={trendItem} />);

    expect(screen.getByText('来自全网趋势')).toBeVisible();
    expect(screen.queryByText('关键词追踪')).not.toBeInTheDocument();
    expect(screen.queryByText('趋势发现')).not.toBeInTheDocument();
  });

  it('labels historical content when its keyword is inactive', () => {
    render(<DiscoveryCard item={{
      ...topicItem,
      topicKeywordActive: false,
      origins: [{
        origin: 'topic', topicId: 'topic-1', topicKeyword: 'gpt-5.7', topicKeywordActive: false,
      }],
    }} />);

    expect(screen.getByText('关键词已失效')).toBeVisible();
  });

  it('shows a public recommendation explanation without ranking internals', () => {
    render(<DiscoveryCard item={{
      ...topicItem,
      recommendation: {
        lane: 'subscription', reason: 'followed_topic', isExploration: false,
      },
    }} />);

    expect(screen.getByText('关注关键词')).toBeVisible();
    expect(screen.queryByText(/score|权重|置信度|tag-/i)).not.toBeInTheDocument();
  });

  it('clearly labels exploration without exposing internal adjacency data', () => {
    render(<DiscoveryCard item={{
      ...topicItem,
      recommendation: { lane: 'exploration', reason: 'exploration', isExploration: true },
    }} />);

    expect(screen.getByText('拓展发现')).toBeVisible();
    expect(screen.queryByText(/adjacen|tag-|置信度|权重|score/i)).not.toBeInTheDocument();
  });

  it('shows every merged discovery and distinguishes creator reposts', () => {
    render(<DiscoveryCard item={{
      ...topicItem,
      origins: [
        ...topicItem.origins,
        { origin: 'trend' },
        {
          origin: 'creator', creatorId: 'creator-1', creatorName: 'Project Maintainer',
          platform: 'X', contentType: 'repost',
        },
      ],
    }} />);

    expect(screen.getByText('来自「gpt-5.7」、全网趋势、「Project Maintainer」转发')).toBeVisible();
  });

  it('uses an h2 by default and supports an h3 inside grouped feeds', () => {
    const { rerender } = render(<DiscoveryCard item={topicItem} />);
    expect(screen.getByRole('heading', { level: 2, name: topicItem.title })).toBeVisible();

    rerender(<DiscoveryCard item={topicItem} headingLevel={3} />);
    expect(screen.getByRole('heading', { level: 3, name: topicItem.title })).toBeVisible();
    expect(screen.queryByRole('heading', { level: 2, name: topicItem.title })).not.toBeInTheDocument();
  });

  it('renders persisted feedback state and emits switch or clear actions', () => {
    const onFeedback = vi.fn();
    const { rerender } = render(<DiscoveryCard
      item={{ ...topicItem, feedback: 'interested' }}
      onFeedback={onFeedback}
    />);

    const interested = screen.getByRole('button', { name: '感兴趣' });
    const less = screen.getByRole('button', { name: '减少推荐' });
    expect(interested).toHaveAttribute('aria-pressed', 'true');
    expect(less).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(interested);
    fireEvent.click(less);
    expect(onFeedback).toHaveBeenNthCalledWith(1, null);
    expect(onFeedback).toHaveBeenNthCalledWith(2, 'less');

    rerender(<DiscoveryCard
      item={{ ...topicItem, feedback: 'less' }}
      onFeedback={onFeedback}
    />);
    expect(screen.getByRole('status')).toHaveTextContent('已减少此条及相似内容的推荐');
  });

  it('supports save, archive, restore, and remove reading-list actions', () => {
    const onReadingState = vi.fn();
    const { rerender } = render(<DiscoveryCard item={topicItem} onReadingState={onReadingState} />);

    const save = screen.getByRole('button', { name: '保存到稍后读' });
    expect(save).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(save);
    expect(onReadingState).toHaveBeenCalledWith('saved');

    rerender(<DiscoveryCard item={{ ...topicItem, readingState: 'saved' }} onReadingState={onReadingState} />);
    const remove = screen.getByRole('button', { name: '取消稍后读' });
    expect(remove).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(remove);
    expect(onReadingState).toHaveBeenLastCalledWith(null);
    fireEvent.click(screen.getByRole('button', { name: '归档' }));
    expect(onReadingState).toHaveBeenLastCalledWith('archived');

    rerender(<DiscoveryCard item={{ ...topicItem, readingState: 'archived' }} onReadingState={onReadingState} />);
    fireEvent.click(screen.getByRole('button', { name: '恢复到稍后读' }));
    expect(onReadingState).toHaveBeenLastCalledWith('saved');
    fireEvent.click(screen.getByRole('button', { name: '从阅读列表移除' }));
    expect(onReadingState).toHaveBeenLastCalledWith(null);
  });
});
