import { test, expect } from '@playwright/test';

test('editing during draft save stays dirty and the next save preserves the latest text', async ({
  page,
}) => {
  await page.goto('/#studio');
  await page.getByRole('button', { name: '原创草稿', exact: true }).click();
  await page.locator('#draft-title').fill('保存竞争回归');
  await page.locator('#draft-body').fill('第一次内容');
  await page.locator('input[type=file][accept="image/png,image/jpeg,image/webp"]').setInputFiles({
    name: 'pixel.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      'base64',
    ),
  });
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const received = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route(
    '**/api/drafts',
    async (route) => {
      const response = await route.fetch();
      started();
      await pending;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await received;
  await page.locator('#draft-body').fill('保存期间的新内容');
  release();
  await expect(page.getByRole('button', { name: '保存草稿', exact: true })).toBeEnabled();
  await expect(page.getByText('有未保存的修改', { exact: true })).toBeVisible();
  await expect(page.getByTitle('下载图文包', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(page.getByText('已保存到本机', { exact: true })).toBeVisible();
  const state = await (await page.request.get('/api/state')).json();
  expect(state.drafts.find((d: { title: string }) => d.title === '保存竞争回归').body).toBe(
    '保存期间的新内容',
  );
});
