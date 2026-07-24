import { expect, test } from '@playwright/test';

test('user creates a keyword rule and sees it in the workspace', async ({ page }) => {
  await page.goto('/monitor-rules');
  await page.getByRole('button', { name: '新建监控' }).click();
  await page.getByLabel('规则名称').fill('AI Agent 动态');
  await page.getByLabel('关键词').fill('AI Agent, Agentic AI');
  await page.getByLabel('优先级').selectOption('high');
  await page.getByLabel('符合确认规则时发送即时通知').check();
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('AI Agent 动态').first()).toBeVisible();
  await expect(page.getByText('高优先级').first()).toBeVisible();
});

test('confirmed event exposes its evidence chain', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: '查看证据' }).first().click();
  await expect(page.getByRole('heading', { name: '证据链' })).toBeVisible();
  await expect(page.getByText('一级来源与独立二级来源交叉佐证')).toBeVisible();
  await expect(page.getByRole('link', { name: /OpenAI 官方博客/ })).toHaveAttribute('rel', /noopener/);
});

test('registers the service worker required for browser push', async ({ page }) => {
  await page.goto('/');
  const scriptUrl = await page.evaluate(async () => {
    const registration = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('service worker unavailable')), 2_000)),
    ]);
    return registration.active?.scriptURL;
  });
  expect(scriptUrl).toContain('/sw.js');
});
