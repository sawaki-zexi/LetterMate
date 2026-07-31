import { expect, test } from '@playwright/test';
import type { Topic, TrendStatus } from '@lettermate/contracts';
import { randomUUID } from 'node:crypto';

const forbiddenPublicLanguage = /可信|已核实|证据数量|已确认|待核实|已驳回|证据链|来源排名|评分|\b(?:trust|trusted|trustworthy|verified|confirmed|unverified|rejected|rank|ranking|score|scoring|rating)\b|\b(?:pending verification|evidence (?:chain|count)|source (?:rank|ranking))\b/iu;

test('creates a precise topic and exercises the unified discovery lifecycle', async ({ page }, testInfo) => {
  const keyword = 'gpt-5.7';
  const userId = [
    'e2e',
    testInfo.project.name,
    `repeat-${testInfo.repeatEachIndex}`,
    `retry-${testInfo.retry}`,
    randomUUID(),
  ].join('-');
  const requestHeaders = { 'x-user-id': userId };
  const feedRequests: URL[] = [];
  await page.route('**/api/v1/**', async (route) => {
    await route.continue({
      headers: { ...route.request().headers(), 'x-user-id': userId },
    });
  });
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/v1/feed') feedRequests.push(url);
  });

  await page.goto('/topics');
  await page.getByLabel('主题关键词').fill(keyword);
  const createTopicResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === 'POST' && url.pathname === '/api/v1/topics';
  });
  await page.getByRole('button', { name: '创建主题' }).click();
  expect((await createTopicResponse).ok()).toBe(true);
  const enqueuedTopicsResponse = await page.request.get('/api/v1/topics', { headers: requestHeaders });
  expect(enqueuedTopicsResponse.ok()).toBe(true);
  const enqueuedTopics = await enqueuedTopicsResponse.json() as Topic[];
  expect(enqueuedTopics).toHaveLength(1);
  expect(['queued', 'running']).toContain(enqueuedTopics[0]?.runStatus);
  await expect(page.getByRole('heading', { name: keyword })).toBeVisible();
  const expandedTerms = page.getByLabel('AI 扩展词');
  await expect(expandedTerms.getByText('gpt-5.7', { exact: true })).toBeVisible();
  await expect(expandedTerms.getByText('gpt 5.7', { exact: true })).toBeVisible();
  await expect(expandedTerms.getByText('gpt5.7', { exact: true })).toBeVisible();
  await expect(page.getByText(/每 12 小时/).first()).toBeVisible();
  await expect(page.getByText('Hacker News').first()).toBeVisible();

  const createdTopicsResponse = await page.request.get('/api/v1/topics', { headers: requestHeaders });
  expect(createdTopicsResponse.ok()).toBe(true);
  const createdTopics = await createdTopicsResponse.json() as Topic[];
  expect(createdTopics).toHaveLength(1);
  expect(createdTopics[0]?.keyword).toBe(keyword);
  const topicId = createdTopics[0]?.id;
  expect(topicId).toBeTruthy();
  if (!topicId) throw new Error('Created Topic response did not include an id');

  await page.getByRole('link', { name: '发现' }).last().click();
  await expect(page.getByText('gpt-5.7 Agent 工程实践指南').first()).toBeVisible();
  await expect.poll(() => feedRequests.some((url) =>
    url.searchParams.get('range') === '30d' && url.searchParams.get('origin') === 'all',
  )).toBe(true);

  const threeDayResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/v1/feed'
      && url.searchParams.get('range') === '3d'
      && url.searchParams.get('origin') === 'all';
  });
  await page.getByLabel('时间范围').selectOption('3d');
  await threeDayResponse;

  const refreshStartedAt = new Date().toISOString();
  const refreshButton = page.getByRole('button', { name: '刷新发现' });
  const topicRefreshResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === 'POST'
      && url.pathname === `/api/v1/topics/${topicId}/refresh`;
  });
  const trendRefreshResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === 'POST' && url.pathname === '/api/v1/trends/refresh';
  });
  await refreshButton.click();
  await expect(refreshButton).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByRole('status')).toHaveText('正在更新 2 个目标');
  const enqueueResponses = await Promise.all([topicRefreshResponse, trendRefreshResponse]);
  expect(enqueueResponses.every((response) => response.ok())).toBe(true);
  const enqueuedManualTopicsResponse = await page.request.get('/api/v1/topics', { headers: requestHeaders });
  const enqueuedManualTrendResponse = await page.request.get('/api/v1/trends/status', { headers: requestHeaders });
  expect(enqueuedManualTopicsResponse.ok()).toBe(true);
  expect(enqueuedManualTrendResponse.ok()).toBe(true);
  const enqueuedManualTopics = await enqueuedManualTopicsResponse.json() as Topic[];
  const enqueuedManualTrend = await enqueuedManualTrendResponse.json() as TrendStatus;
  expect(enqueuedManualTopics).toHaveLength(1);
  expect(['queued', 'running']).toContain(enqueuedManualTopics[0]?.runStatus);
  expect(['queued', 'running']).toContain(enqueuedManualTrend.runStatus);
  const completion = page.getByLabel('刷新结果');
  await expect(completion).toHaveText(/刷新完成，新增 \d+ 条内容/);
  await expect(refreshButton).toHaveAttribute('aria-busy', 'false');

  const topicsResponse = await page.request.get('/api/v1/topics', { headers: requestHeaders });
  const trendResponse = await page.request.get('/api/v1/trends/status', { headers: requestHeaders });
  expect(topicsResponse.ok()).toBe(true);
  expect(trendResponse.ok()).toBe(true);
  const topics = await topicsResponse.json() as Topic[];
  const trend = await trendResponse.json() as TrendStatus;
  expect(topics).toHaveLength(1);
  expect(topics[0]?.id).toBe(topicId);
  const topicManualRun = topics[0]?.lastRun;
  const trendManualRun = trend.lastRun;
  expect(topicManualRun).toMatchObject({ trigger: 'manual', status: 'succeeded' });
  expect(trendManualRun).toMatchObject({ trigger: 'manual', status: 'succeeded' });
  expect(topicManualRun?.startedAt >= refreshStartedAt).toBe(true);
  expect(trendManualRun?.startedAt >= refreshStartedAt).toBe(true);
  if (topicManualRun?.status !== 'succeeded' || trendManualRun?.status !== 'succeeded') {
    throw new Error('Both Topic and trend must expose one later succeeded manual run');
  }
  const persistedNewItemCount = topicManualRun.newItemCount + trendManualRun.newItemCount;
  await expect(completion).toHaveText(`刷新完成，新增 ${persistedNewItemCount} 条内容`);

  await expect(page.locator('.origin-label', { hasText: `来自「${keyword}」` }).first()).toBeVisible();
  await expect(page.locator('.origin-label', { hasText: '来自全网趋势' }).first()).toBeVisible();
  await expect(page.getByText('精选').first()).toBeVisible();
  await expect(page.getByText(/关键词追踪|趋势发现|优质/)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '今天', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '昨天', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '近 3 天', exact: true })).toBeVisible();

  const sourceSelect = page.getByLabel('来源');
  await expect(sourceSelect).toHaveValue('all');
  const selectedTopicResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/v1/feed'
      && url.searchParams.get('origin') === 'topic'
      && url.searchParams.get('topicId') === topicId;
  });
  await sourceSelect.selectOption(`topic:${topicId}`);
  const selectedTopicFeed = await selectedTopicResponse;
  expect(selectedTopicFeed.ok()).toBe(true);
  const selectedTopicUrl = new URL(selectedTopicFeed.url());
  expect(selectedTopicUrl.searchParams.get('origin')).toBe('topic');
  expect(selectedTopicUrl.searchParams.get('topicId')).toBe(topicId);
  const topicCards = page.locator('.discovery-card');
  await expect(topicCards).toHaveCount(2);
  expect((await topicCards.allTextContents()).every((content) => content.includes(keyword))).toBe(true);
  await expect(page.locator('.origin-label', { hasText: `来自「${keyword}」` })).toHaveCount(2);
  await expect(page.locator('.origin-label', { hasText: '来自全网趋势' })).toHaveCount(0);

  const trendOnlyResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/v1/feed'
      && url.searchParams.get('origin') === 'trend'
      && !url.searchParams.has('topicId');
  });
  await sourceSelect.selectOption('trend');
  await trendOnlyResponse;
  await expect(page.locator('.origin-label', { hasText: '来自全网趋势' }).first()).toBeVisible();
  await expect(page.locator('.origin-label', { hasText: `来自「${keyword}」` })).toHaveCount(0);

  await sourceSelect.selectOption('all');
  await expect(sourceSelect).toHaveValue('all');
  await expect(page.locator('.origin-label', { hasText: '来自全网趋势' }).first()).toBeVisible();
  await expect(page.locator('.origin-label', { hasText: `来自「${keyword}」` }).first()).toBeVisible();

  if (testInfo.project.name === 'mobile' || testInfo.project.name === 'compact-mobile') {
    await page.evaluate(() => window.scrollTo(0, 0));
    const pageContainer = page.locator('main.page');
    await pageContainer.dispatchEvent('touchstart', {
      touches: [{ identifier: 1, clientX: 160, clientY: 80 }],
      changedTouches: [{ identifier: 1, clientX: 160, clientY: 80 }],
    });
    await pageContainer.dispatchEvent('touchmove', {
      touches: [{ identifier: 1, clientX: 160, clientY: 180 }],
      changedTouches: [{ identifier: 1, clientX: 160, clientY: 180 }],
    });
    await expect(page.locator('.pull-indicator')).toHaveClass(/pull-indicator--armed/);
    await pageContainer.dispatchEvent('touchend', {
      touches: [],
      changedTouches: [{ identifier: 1, clientX: 160, clientY: 180 }],
    });
    await expect(refreshButton).toHaveAttribute('aria-busy', 'true');
    await expect(completion).toHaveAttribute('data-notification-id', '2');
    await expect(completion).toHaveText('刷新完成，暂无新增内容');
    await expect(refreshButton).toHaveAttribute('aria-busy', 'false');
  }

  expect(feedRequests.some((url) =>
    url.searchParams.get('origin') === 'trend' && url.searchParams.has('topicId'),
  )).toBe(false);
  await expect(page.locator('body')).not.toContainText(forbiddenPublicLanguage);
  const hasHorizontalOverflow = await page.evaluate(() =>
    document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(hasHorizontalOverflow).toBe(false);

  if (testInfo.project.name === 'desktop' || testInfo.project.name === 'compact-mobile') {
    await page.screenshot({
      path: testInfo.outputPath(`${testInfo.project.name}-feed.png`),
      fullPage: true,
    });
  }
});
