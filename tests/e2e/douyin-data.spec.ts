import { test, expect } from '@playwright/test';
test('Douyin provider settings preserve XHS and separate keys without making paid requests', async ({
  page,
  request,
}) => {
  const xhs = await (await request.get('/api/xhs-data')).json();
  await page.goto('/#settings');
  const panel = page.getByRole('region', { name: '抖音数据源' });
  await expect(panel.getByLabel('抖音采集数据源')).toHaveValue('browser');
  await expect(panel).toContainText('US$0.01');
  await expect(panel).toContainText('¥0.02');
  await expect(panel).toContainText('权限');
  await panel.getByLabel('抖音采集数据源').selectOption('tikhub');
  await panel.getByLabel(/抖音 TikHub API Key/).fill('test-dy-key');
  await panel.getByRole('button', { name: '保存抖音数据源', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('抖音数据源已保存，小红书设置未改变');
  await expect(panel.getByLabel(/抖音 TikHub API Key/)).toHaveValue('');
  await panel.getByLabel('抖音采集数据源').selectOption('redfox');
  await expect(panel.getByRole('note')).toContainText('不');
  await panel.getByLabel(/抖音 RedFox API Key/).fill('test-red-key');
  await panel.getByRole('button', { name: '保存抖音数据源', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('抖音数据源已保存，小红书设置未改变');
  await page.reload();
  await expect(panel.getByLabel('抖音采集数据源')).toHaveValue('redfox');
  expect(await (await request.get('/api/xhs-data')).json()).toEqual(xhs);
  const saved = await (await request.get('/api/douyin-data')).json();
  expect(saved.hasKeys).toEqual({ tikhub: true, redfox: true });
  expect(saved.commentsSupported).toBe(false);
  expect(JSON.stringify(saved)).not.toContain('test-red-key');
  await request.put('/api/douyin-data', {
    data: { provider: 'redfox', apiKey: '', maxRequests: 20 },
  });
  await request.put('/api/douyin-data', {
    data: { provider: 'tikhub', apiKey: '', maxRequests: 20 },
  });
  await request.put('/api/douyin-data', { data: { provider: 'browser', maxRequests: 20 } });
});
