import { test, expect } from '@playwright/test';

test('data safety settings persist budgets and offer a non-destructive cleanup preview', async ({
  page,
  request,
}) => {
  const budget = await (await request.get('/api/model-budget')).json();
  await page.goto('/#settings');
  const panel = page.getByRole('region', { name: '数据安全与预算' });
  await expect(panel.getByRole('heading', { name: '模型预算', exact: true })).toBeVisible();
  await panel.getByLabel('每日文字调用上限', { exact: true }).fill('75');
  await panel.getByRole('button', { name: '保存模型预算', exact: true }).click();
  await expect
    .poll(async () => (await (await request.get('/api/model-budget')).json()).policy.textRequests)
    .toBe(75);
  await expect(panel).toContainText('副本包含凭证密钥');
  await panel.getByRole('button', { name: '预览可清理素材', exact: true }).click();
  await expect(panel.getByRole('button', { name: '确认清理', exact: true })).toBeVisible();
  await expect(panel).toContainText('外部备份');
  await page.reload();
  await expect(
    page
      .getByRole('region', { name: '数据安全与预算' })
      .getByLabel('每日文字调用上限', { exact: true }),
  ).toHaveValue('75');
  // No destructive action or vendor call; restore policy for subsequent scenarios.
  await request.put('/api/model-budget', { data: budget.policy });
});
