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

test('legacy model receipt erasure is separately disclosed and requires an explicit choice', async ({
  page,
}) => {
  let confirmed = false;
  await page.route('**/api/state', async (route) => {
    const response = await route.fetch();
    if (response.status() === 304) {
      await route.fulfill({ response });
      return;
    }
    const data = await response.json();
    data.leads = [{ id: 'synthetic-privacy-lead', name: '资料清除交互测试', platform: 'douyin' }];
    await route.fulfill({ response, json: data });
  });
  await page.route('**/api/maintenance/forget', async (route) => {
    const data = route.request().postDataJSON();
    if (data.confirm) {
      expect(data.includeLegacyModelReceipts).toBe(true);
      confirmed = true;
      await route.fulfill({
        json: { counts: { leads: 1, 'request-receipts': 1 }, deletedBackups: 0 },
      });
    } else {
      await route.fulfill({
        json: {
          leadId: data.leadId,
          token: 'synthetic-preview',
          counts: { leads: 1 },
          managedBackups: 0,
          legacyModelReceipts: ['synthetic-receipt'],
        },
      });
    }
  });
  await page.goto('/#settings');
  const panel = page.getByRole('region', { name: '数据安全与预算' });
  await panel.getByLabel('要清除资料的客户').selectOption('synthetic-privacy-lead');
  await panel.getByRole('button', { name: '预览资料清除范围', exact: true }).click();
  const confirm = panel.getByRole('button', { name: '确认清除客户资料', exact: true });
  await expect(confirm).toBeDisabled();
  await panel.getByLabel(/同时清除 1 条旧版无来源模型原始回执/).check();
  await expect(confirm).toBeEnabled();
  page.once('dialog', (dialog) => dialog.accept());
  await confirm.click();
  await expect.poll(() => confirmed).toBe(true);
  // All erasure requests were mocked: no actual customer or receipt was removed.
});
