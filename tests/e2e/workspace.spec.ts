import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
const screenshot = (name: string) => resolve('analysis/screenshots', name + '.png');
test('complete discovery → image pack → multi-account creation → comments → CRM → persistence', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '让好内容，带来新客户。' })).toBeVisible();
  await expect(page.locator('.note-card')).toHaveCount(24);
  await page.screenshot({ path: screenshot('01-discover') });
  await page.getByLabel('搜索关键词').fill('医美');
  await page.getByLabel('结果上限').fill('12');
  await page.getByLabel('笔记类型').selectOption('image');
  await page.getByRole('button', { name: '开始搜索', exact: true }).click();
  await expect(page.locator('.note-card')).toHaveCount(10);
  await expect(page.locator('.status-text')).toContainText('已完成');
  await page.getByRole('textbox', { name: '筛选作品' }).fill('没有这个标题');
  await expect(page.getByRole('heading', { name: '没有符合条件的作品' })).toBeVisible();
  await page.getByRole('button', { name: '清空筛选', exact: true }).click();
  await expect(page.locator('.note-card')).toHaveCount(10);
  const noteDownload = page.waitForEvent('download');
  await page.getByRole('link', { name: '导出 JSON' }).click();
  expect((await noteDownload).suggestedFilename()).toBe('openfind-notes.json');
  await page.locator('.note-select input').first().check();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载图片包', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('openfind-图文素材.zip');
  await page.getByRole('button', { name: '清空选择', exact: true }).click();
  await page.locator('.note-card').first().hover();
  await page.getByRole('button', { name: '一键克隆', exact: true }).first().click();
  const editor = page.getByRole('dialog', { name: '克隆创作', exact: true });
  await expect(editor).toBeVisible();
  await editor.getByRole('button', { name: '添加账号', exact: true }).click();
  const account = page.getByRole('dialog', { name: '添加发布账号' });
  await expect(account).toBeVisible();
  await account.getByLabel('账号名称').fill('品牌测试账号');
  await account.getByLabel('平台账号 ID').fill('e2e-brand');
  await account.getByRole('button', { name: '添加账号', exact: true }).click();
  await expect(account).not.toBeVisible();
  await expect(editor.getByLabel('发布账号')).toHaveValue('e2e-brand');
  await editor.getByLabel('标题', { exact: false }).fill('我的第一篇原创提案');
  await editor
    .getByLabel('正文', { exact: false })
    .fill('这是经过编辑的测试草稿，记录我们的内容灵感。');
  await editor.getByLabel('话题标签').fill('内容创作 灵感记录');
  await editor.getByLabel('可见范围').selectOption('private');
  await editor.getByRole('button', { name: '图片1后移' }).click();
  await editor.locator('input[type=file]').setInputFiles({
    name: 'test.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5p8AAAAASUVORK5CYII=',
      'base64',
    ),
  });
  await expect(editor.locator('.editor-image')).toHaveCount(3);
  await editor.getByRole('button', { name: '删除图片3', exact: true }).click();
  await expect(editor.locator('.editor-image')).toHaveCount(2);
  await editor.getByRole('button', { name: '预览作品', exact: true }).click();
  await expect(editor.locator('.publish-preview')).toBeVisible();
  await editor.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已保存');
  await editor.getByRole('button', { name: '模拟发布', exact: true }).click();
  await expect(editor.getByText('模拟发布完成', { exact: true })).toBeVisible();
  await page.screenshot({ path: screenshot('02-editor') });
  await editor.getByRole('button', { name: '关闭', exact: true }).click();
  await page.locator('.note-card').first().hover();
  await page.getByRole('button', { name: '一键采集客户', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: '找到评论背后，真实的需求。' })).toBeVisible();
  await expect(page.locator('.comment-row')).toHaveCount(60);
  await page.getByRole('button', { name: '楼中楼', exact: true }).click();
  await expect(page.locator('.comment-row')).toHaveCount(20);
  await page.getByRole('button', { name: '全部', exact: true }).click();
  await page.screenshot({ path: screenshot('03-comments') });
  await page.getByRole('button', { name: '保存高意向客户', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已保存');
  await page.locator('.sidebar').getByRole('button', { name: '客户线索', exact: true }).click();
  await expect(page.locator('.lead-table tbody tr').first()).toBeVisible();
  await page.locator('.lead-table select').first().selectOption('qualified');
  await page.getByRole('button', { name: '查看与跟进' }).first().click();
  const customer = page.getByRole('dialog', { name: '客户跟进' });
  await customer.getByLabel('跟进备注').fill('下周一提供报价方案');
  await customer.getByRole('button', { name: '保存记录' }).click();
  await expect(page.getByRole('status')).toContainText('已更新');
  await customer.getByRole('button', { name: '关闭', exact: true }).click();
  await page.screenshot({ path: screenshot('04-leads') });
  await page.locator('.sidebar').getByRole('button', { name: '内容工作室', exact: true }).click();
  await expect(page.getByRole('heading', { name: '我的第一篇原创提案' })).toBeVisible();
  await page.screenshot({ path: screenshot('05-studio') });
  await page.reload();
  await expect(page.getByRole('heading', { name: '我的第一篇原创提案' })).toBeVisible();
  await page.locator('.sidebar').getByRole('button', { name: '任务记录', exact: true }).click();
  await page.getByRole('button', { name: '查看日志' }).first().click();
  await expect(page.locator('.job-log .log-row').first()).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await page.screenshot({ path: screenshot('06-history') });
  await page.locator('.sidebar').getByRole('button', { name: '连接设置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '连接数据，让发现走得更远。' })).toBeVisible();
  await expect(page.locator('.account-list button')).toHaveCount(2);
  await page.screenshot({ path: screenshot('07-settings') });
  await page.locator('.sidebar').getByRole('button', { name: '使用指南与视频解析' }).click();
  await expect(page.getByRole('dialog', { name: '从视频，到 OpenFind' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(errors).toEqual([]);
});
test('mobile navigation, responsive boundaries and keyboard command input', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('.note-card').first()).toBeVisible();
  for (const p of ['discover', 'comments', 'leads', 'studio', 'history', 'settings']) {
    await page.goto('/#' + p);
    await expect(page.locator('.page-heading h1')).toBeVisible();
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width, `overflow on ${p}`).toBeLessThanOrEqual(391);
  }
  await page.goto('/#discover');
  await page.screenshot({ path: screenshot('08-mobile'), fullPage: true });
  await page.keyboard.press('Control+k');
  await expect(page.locator('#agent-input')).toBeFocused();
});

test('One click executes search → comments → candidates on both platforms and survives reload', async ({
  page,
}) => {
  await page.goto('/#acquisition');
  await expect(page.getByRole('heading', { name: '从搜索，到值得复核的需求。' })).toBeVisible();
  for (const platform of ['xiaohongshu', 'douyin']) {
    await page.getByLabel('获客平台', { exact: true }).selectOption(platform);
    await page.getByLabel('获客关键词').fill('沙发一键' + platform);
    await page.getByLabel('每次搜索作品数').fill('4');
    await page.getByLabel('最多采样作品数').fill('1');
    await page.getByLabel('每篇评论上限').fill('12');
    await page.getByRole('button', { name: '一键执行获客', exact: true }).click();
    await expect(page.locator('.workflow-status')).toHaveText('已完成', { timeout: 20000 });
    await expect(page.locator('.workflow-comment-list article')).toHaveCount(12);
    await expect(page.locator('.workflow-lead').first()).toBeVisible();
    await page.reload();
    await expect(page.locator('.workflow-status')).toHaveText('已完成');
    await expect(page.locator('.workflow-comment-list article')).toHaveCount(12);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
  await page.screenshot({ path: screenshot('09-one-click-mobile'), fullPage: true });
});
