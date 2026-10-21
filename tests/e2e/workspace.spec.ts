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
  const account = page.getByRole('dialog', { name: '添加账号备注' });
  await expect(account).toBeVisible();
  await account.getByLabel('账号名称').fill('品牌测试账号');
  await account.getByLabel('平台账号 ID').fill('e2e-brand');
  await account.getByRole('button', { name: '添加账号', exact: true }).click();
  await expect(account).not.toBeVisible();
  await expect(editor.getByLabel('拟用账号（备注）')).toHaveValue('e2e-brand');
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
  await expect(editor.getByRole('button', { name: '复制发布文案', exact: true })).toBeVisible();
  await expect(editor.getByRole('button', { name: '发布作品', exact: true })).toHaveCount(0);
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
    const started = page.waitForResponse(
      (r) => r.url().endsWith('/api/workflows') && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '一键执行获客', exact: true }).click();
    const created = await started;
    expect(created.status()).toBe(201);
    const workflow = await created.json();
    await expect(page).toHaveURL(new RegExp(workflow.id));
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

test('collection budgets can be edited independently and survive reload', async ({ page }) => {
  await page.goto('/#settings');
  await expect(page.getByLabel('抖音搜索每日批次数')).toHaveValue('100');
  await page.getByLabel('抖音搜索每日批次数').fill('125');
  await page.getByLabel('抖音评论采集间隔秒数').fill('22');
  const saved = page.waitForResponse(
    (r) => r.url().endsWith('/api/protection/douyin') && r.request().method() === 'PUT',
  );
  await page.getByRole('button', { name: '保存抖音采集配置' }).click();
  const response = await saved;
  expect(response.status(), await response.text()).toBe(200);
  expect((await response.json()).policy.search.dailyLimit).toBe(125);
  await expect(page.getByLabel('抖音采集额度')).toContainText('剩余 125 / 125 批');
  await page.reload();
  await expect(page.getByLabel('抖音搜索每日批次数')).toHaveValue('125');
  await expect(page.getByLabel('抖音评论采集间隔秒数')).toHaveValue('22');
  await expect(page.getByLabel('每个采集步骤最多请求次数（1–100）')).toHaveValue('20');
  await expect(page.getByLabel('抖音采集额度')).toContainText('每日 UTC 00:00 重置');
});

test('model settings sync available IDs, test generation and display optional semantic evidence without changing rule candidates', async ({
  page,
}) => {
  const { createServer } = await import('node:http');
  const server = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/models') {
      res.end(
        JSON.stringify({
          data: [
            { id: 'fixture-chat-new', created: 2 },
            { id: 'fixture-chat-old', created: 1 },
          ],
        }),
      );
      return;
    }
    const body = JSON.parse(text);
    let result: unknown = { ok: true };
    if (!body.messages[0].content.includes('Connection test')) {
      const input = JSON.parse(body.messages[1].content).untrustedComments;
      result = {
        items: input.map((x: { id: string; comment: string }) => ({
          id: x.id,
          verdict: 'interest',
          reason: '兼容服务测试：还需人工确认购买计划',
          quotes: [x.comment],
          limitations: ['仅为本地协议测试，不代表真实模型判断'],
        })),
      };
    }
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await page.goto('/#settings');
    await page
      .getByLabel('模型服务地址', { exact: true })
      .fill('http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1');
    await page.getByLabel('模型 API Key', { exact: true }).fill('fixture-secret');
    await page.getByRole('button', { name: '同步最新模型列表', exact: true }).click();
    await expect(
      page.getByText('已同步服务当前账号可用的 2 个模型', { exact: false }),
    ).toBeVisible();
    await page.getByLabel('复核模型 ID').selectOption('fixture-chat-new');
    const llmPanel = page.getByLabel('大模型设置');
    await page.getByLabel('新增文字模型').fill('fixture-chat-custom');
    await llmPanel.getByRole('button', { name: '添加模型', exact: true }).click();
    await expect(page.getByLabel('复核模型 ID')).toContainText('fixture-chat-custom');
    await page.getByLabel('复核模型 ID').selectOption('fixture-chat-custom');
    await llmPanel.getByRole('button', { name: '删除当前自定义模型', exact: true }).click();
    await expect(
      page.getByLabel('复核模型 ID').locator('option[value="fixture-chat-custom"]'),
    ).toHaveCount(0);
    await page.getByLabel('复核模型 ID').selectOption('fixture-chat-new');
    await page.getByRole('button', { name: '测试模型连接', exact: true }).click();
    await expect(
      page.getByText('所选模型 fixture-chat-new 的真实生成与 JSON 输出测试通过', { exact: false }),
    ).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('复核模型 ID', { exact: true })).toHaveValue('fixture-chat-new');
    await expect(page.getByLabel('模型 API Key', { exact: true })).toHaveValue('');
    // Run this review explicitly without enabling future automatic data transfers.
    await page.getByRole('button', { name: '保存模型设置', exact: true }).click();
    await expect(page.getByText('模型配置已保存', { exact: true })).toBeVisible();
    await page.goto('/#acquisition');
    // This test must also work alone with a fresh isolated workspace.
    if (!(await page.locator('.workflow-status').count())) {
      await page.getByRole('button', { name: '一键执行获客', exact: true }).click();
    }
    await expect(page.locator('.workflow-status')).toHaveText('已完成');
    const before = await page.locator('.workflow-lead').count();
    await page.getByRole('button', { name: '本次使用模型复核', exact: true }).click();
    await expect(page.getByLabel('线索逐条复核')).toContainText('模型补充复核完成');
    await page.getByText(/规则与模型对照 · 已复核/).click();
    await expect(page.locator('.comparison-panel')).toContainText('有效模型结果');
    expect((await (await page.request.get('/api/llm')).json()).enabled).toBe(false);
    await expect(page.locator('.workflow-lead')).toHaveCount(before);
    await page.locator('.workflow-lead .assessment-details summary').first().click();
    await expect(page.locator('.workflow-lead .semantic-result').first()).toContainText(
      'fixture-chat-new',
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('sales workbench logs actual conversations, requires outcome evidence and persists stop-contact', async ({
  page,
}) => {
  await page.goto('/#acquisition');
  await expect(page.locator('.page-heading h1')).toBeVisible();
  if (!(await page.locator('.workflow-status').count())) {
    await page.getByRole('button', { name: '一键执行获客', exact: true }).click();
    await expect(page.locator('.workflow-status')).toHaveText('已完成');
  }
  await page.goto('/#leads');
  const customer = page.locator('.lead-table tbody tr').first();
  const leadId = await customer.getAttribute('data-lead-id');
  await customer.getByRole('button', { name: '查看与跟进', exact: true }).click();
  const desk = page.getByRole('region', { name: '沟通成交工作台' });
  await expect(desk.getByText('先填写真实业务身份', { exact: false })).toBeVisible();
  await desk.getByText('真实业务资料 · 生成话术前填写', { exact: true }).click();
  await desk.getByLabel('业务身份', { exact: true }).fill('测试家居顾问');
  await desk.getByLabel('产品或服务', { exact: true }).fill('测试花瓶选型');
  await desk.getByLabel('这次能提供的具体帮助', { exact: true }).fill('提供可核实的尺寸说明');
  await desk.getByRole('button', { name: '保存业务资料', exact: true }).click();
  await expect(desk.getByRole('button', { name: '复制本次沟通草稿', exact: true })).toBeVisible();
  await desk.getByLabel('沟通记录类型', { exact: true }).selectOption('outgoing');
  await desk.getByLabel('实际沟通内容', { exact: true }).fill('实际已确认需求是否仍存在（演示）');
  await desk.getByRole('button', { name: '登记沟通记录', exact: true }).click();
  await expect(desk.getByText('首条沟通尚无回复', { exact: false })).toBeVisible();
  await desk.getByLabel('沟通记录类型', { exact: true }).selectOption('incoming');
  await desk.getByLabel('实际沟通内容', { exact: true }).fill('想买桌面花瓶，这周需要（演示）');
  await desk.getByRole('button', { name: '登记沟通记录', exact: true }).click();
  await desk.getByLabel('客户确认的需求', { exact: true }).fill('桌面花瓶');
  await desk.getByLabel('行动时间', { exact: true }).fill('本周');
  await desk.getByLabel('销售阶段', { exact: true }).selectOption('qualified');
  await desk.getByRole('button', { name: '保存销售进展', exact: true }).click();
  await expect(page.getByText('销售进展已保存', { exact: true })).toBeVisible();
  await desk.getByLabel('沟通记录类型', { exact: true }).selectOption('optout');
  await desk.getByLabel('实际沟通内容', { exact: true }).fill('不需要了，请停止联系（演示）');
  await desk.getByRole('button', { name: '登记沟通记录', exact: true }).click();
  await expect(desk.getByText('对方已拒绝联系：', { exact: false })).toBeVisible();
  await page.reload();
  await page
    .locator(`[data-lead-id="${leadId}"]`)
    .getByRole('button', { name: '查看与跟进', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: '沟通成交工作台' }).getByLabel('销售阶段', { exact: true }),
  ).toHaveValue('lost');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
});
