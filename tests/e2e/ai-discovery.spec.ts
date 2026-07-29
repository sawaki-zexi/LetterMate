import { expect, test } from '@playwright/test';

const forbiddenPublicLanguage = /trust|可信|已核实|证据数量|\brank\b|\bscore\b/i;

test('creates a precise topic and exercises the unified discovery lifecycle', async ({ page }, testInfo) => {
  const keyword = `${testInfo.project.name} gpt-5.7`;
  const userId = `e2e-${testInfo.project.name}`;
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
  await page.getByRole('button', { name: '创建主题' }).click();
  await expect(page.getByRole('heading', { name: keyword })).toBeVisible();
  await expect(page.getByText('gpt-5.7', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/每 12 小时/).first()).toBeVisible();
  await expect(page.getByText('Hacker News').first()).toBeVisible();

  await page.getByRole('link', { name: '发现' }).last().click();
  await expect(page.getByText('Agent 工程实践指南').first()).toBeVisible();
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
  await refreshButton.click();
  await expect(refreshButton).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByRole('status')).toContainText(/正在更新 \d+ 个目标/);
  const completion = page.getByLabel('刷新结果');
  await expect(completion).toHaveText(/刷新完成，新增 \d+ 条内容/);
  await expect(refreshButton).toHaveAttribute('aria-busy', 'false');

  const requestHeaders = { 'x-user-id': userId };
  const topicsResponse = await page.request.get('/api/v1/topics', { headers: requestHeaders });
  const trendResponse = await page.request.get('/api/v1/trends/status', { headers: requestHeaders });
  expect(topicsResponse.ok()).toBe(true);
  expect(trendResponse.ok()).toBe(true);
  const topics = await topicsResponse.json() as Array<{
    lastRun: null | { trigger: string; status: string; startedAt: string; newItemCount: number | null };
  }>;
  const trend = await trendResponse.json() as {
    lastRun: null | { trigger: string; status: string; startedAt: string; newItemCount: number | null };
  };
  const completedManualRuns = [...topics.map((topic) => topic.lastRun), trend.lastRun]
    .filter((run): run is NonNullable<typeof run> => Boolean(
      run
      && run.trigger === 'manual'
      && run.status === 'succeeded'
      && run.startedAt >= refreshStartedAt,
    ));
  const persistedNewItemCount = completedManualRuns.reduce(
    (total, run) => total + (run.newItemCount ?? 0),
    0,
  );
  await expect(completion).toHaveText(`刷新完成，新增 ${persistedNewItemCount} 条内容`);

  await expect(page.locator('.origin-label', { hasText: '趋势发现' }).first()).toBeVisible();
  await expect(page.locator('.origin-label', { hasText: '关键词追踪' }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: '今天', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '昨天', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '近 3 天', exact: true })).toBeVisible();

  const topicOnlyResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/v1/feed' && url.searchParams.get('origin') === 'topic';
  });
  await page.getByRole('button', { name: '关键词追踪' }).click();
  await topicOnlyResponse;
  await expect(page.locator('.origin-label', { hasText: '关键词追踪' }).first()).toBeVisible();
  await expect(page.locator('.origin-label', { hasText: '趋势发现' })).toHaveCount(0);
  await page.getByLabel('主题').selectOption({ label: keyword });

  const trendOnlyResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/v1/feed'
      && url.searchParams.get('origin') === 'trend'
      && !url.searchParams.has('topicId');
  });
  await page.getByRole('button', { name: '趋势发现' }).click();
  await trendOnlyResponse;
  await expect(page.getByLabel('主题')).toHaveCount(0);
  await expect(page.locator('.origin-label', { hasText: '趋势发现' }).first()).toBeVisible();
  await expect(page.locator('.origin-label', { hasText: '关键词追踪' })).toHaveCount(0);

  await page.getByRole('group', { name: '发现来源' })
    .getByRole('button', { name: '全部', exact: true })
    .click();
  await expect(page.locator('.origin-label', { hasText: '趋势发现' }).first()).toBeVisible();
  await expect(page.locator('.origin-label', { hasText: '关键词追踪' }).first()).toBeVisible();
  await expect.poll(() => feedRequests.some((url) =>
    url.searchParams.get('origin') === 'all' && !url.searchParams.has('topicId'),
  )).toBe(true);

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
