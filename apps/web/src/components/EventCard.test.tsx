// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { Event } from '@lettermate/contracts';
import { EventCard } from './EventCard.js';
import '../test-setup.js';

const confirmedEvent: Event = {
  id: 'event-1',
  title: 'OpenAI 发布 Agent Studio',
  subject: 'Agent Studio',
  action: '发布',
  summary: '面向开发者的新工具。',
  summaryStatus: 'ready',
  status: 'confirmed',
  statusReason: '一级来源直接发布',
  firstPublishedAt: '2026-07-24T06:30:00.000Z',
  lastDiscoveredAt: '2026-07-24T07:00:00.000Z',
  updatedAt: '2026-07-24T07:00:00.000Z',
  sourceCount: 2,
  matchedRuleIds: [],
};

describe('EventCard', () => {
  it('shows text status, source count and evidence navigation', () => {
    render(<MemoryRouter><EventCard event={confirmedEvent} /></MemoryRouter>);
    expect(screen.getByText('已确认')).toBeVisible();
    expect(screen.getByText('2 个独立来源')).toBeVisible();
    expect(screen.getByRole('link', { name: '查看证据' })).toHaveAttribute('href', '/events/event-1');
  });

  it('states when an AI summary is unavailable', () => {
    render(
      <MemoryRouter>
        <EventCard event={{ ...confirmedEvent, summary: null, summaryStatus: 'unavailable' }} />
      </MemoryRouter>,
    );
    expect(screen.getByText('摘要暂不可用')).toBeVisible();
  });
});
