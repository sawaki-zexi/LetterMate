import { expect, test } from '@playwright/test';

test('creates one-keyword topic and shows AI discovery with original link', async ({ page }, testInfo) => {
  await page.goto('/topics');
  await page.getByLabel('主题关键词').fill(`${testInfo.project.name} AI Agent`);
  await page.getByRole('button', { name: '创建主题' }).click();
  await expect(page.getByText('智能体').first()).toBeVisible();
  await expect(page.getByText(/每 12 小时/).first()).toBeVisible();
  await expect(page.getByText('Hacker News').first()).toBeVisible();

  await page.getByRole('link', { name: '发现' }).last().click();
  await expect(page.getByText('Agent 工程实践指南').first()).toBeVisible();
  await expect(page.getByText('优质').first()).toBeVisible();
  await expect(page.getByText('文章总结了可复现的工程方法。').first()).toBeVisible();
  await expect(page.getByText('Example').first()).toBeVisible();
  await expect(page.getByText('网页').first()).toBeVisible();
  await expect(page.getByRole('link', { name: /查看原文/ }).first()).toHaveAttribute('href', 'https://example.com/agent-guide');
  await page.getByRole('button', { name: '全部历史' }).click();
  await expect(page.getByRole('button', { name: '全部历史' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText(/已确认|待核实|已驳回|证据链|可信/)).toHaveCount(0);

  const hasHorizontalOverflow = await page.evaluate(() =>
    document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(hasHorizontalOverflow).toBe(false);
});
