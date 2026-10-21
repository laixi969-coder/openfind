import { test, expect } from '@playwright/test';

test('XHS settings switch independently, protect keys, explain prices and disable browser operations', async ({
  page,
  request,
}) => {
  await page.goto('/#settings');
  const panel = page.getByRole('region', { name: '小红书 API 数据源' });
  await expect(panel.getByRole('heading', { name: '小红书 API 数据源' })).toBeVisible();
  await expect(panel).toContainText('封号');
  await expect(panel).toContainText('US$0.01');
  await expect(panel).toContainText('¥0.02');
  await expect(panel).toContainText('24小时');
  await panel.getByLabel(/TikHub API Key/).fill('test-tik-key');
  await panel.getByRole('button', { name: '保存小红书数据源', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('小红书 API 设置已保存');
  await expect(panel.getByLabel(/TikHub API Key/)).toHaveValue('');
  await panel.getByLabel('数据源', { exact: true }).selectOption('redfox');
  await panel.getByLabel(/RedFox API Key/).fill('test-red-key');
  await panel.getByRole('button', { name: '保存小红书数据源', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('小红书 API 设置已保存');
  const config = await (await request.get('/api/xhs-data')).json();
  expect(config.hasKeys).toEqual({ tikhub: true, redfox: true });
  expect(JSON.stringify(config)).not.toContain('test-red-key');
  const blocked = await request.post('/api/platforms/xiaohongshu/login');
  expect(blocked.ok()).toBeFalsy();
  // Restore unconfigured defaults without issuing any vendor request.
  await request.put('/api/xhs-data', { data: { provider: 'redfox', apiKey: '', maxRequests: 20 } });
  await request.put('/api/xhs-data', { data: { provider: 'tikhub', apiKey: '', maxRequests: 20 } });
});
