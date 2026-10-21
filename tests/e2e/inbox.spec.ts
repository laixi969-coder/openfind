import { test, expect } from '@playwright/test';
import type { InboxThread, ReplyDraft } from '../../shared/messages';

test('Reply drafts can be copied without sending, polling the platform or hosting controls', async ({
  page,
}) => {
  const thread: InboxThread = {
    id: 'thread-test',
    platform: 'xiaohongshu',
    accountId: 'operator',
    accountName: '测试账号',
    nativeId: 'peer',
    name: '测试会话',
    preview: '请发资料',
    timeLabel: '刚刚',
    messages: [],
    revision: 1,
    watching: false,
    autoSuggest: false,
    stopped: false,
    syncedAt: new Date().toISOString(),
    error: '',
  };
  const draft: ReplyDraft = {
    id: 'draft-test',
    threadId: thread.id,
    contextHash: 'before',
    text: '我来整理资料',
    rationale: '根据来信',
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  let platformCalls = 0;
  await page.addInitScript(() =>
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async (text: string) => {
          (window as any).copiedText = text;
        },
      },
    }),
  );
  await page.route('**/api/inbox', (route) =>
    route.fulfill({ json: { threads: [thread], drafts: [draft] } }),
  );
  await page.route('**/api/inbox/**', (route) => {
    platformCalls++;
    return route.fulfill({ json: {} });
  });
  await page.goto('/#inbox');
  await page.getByRole('button', { name: /^测试会话/ }).click();
  await page.getByRole('button', { name: '复制回复草稿', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).copiedText)).toBe(draft.text);
  expect(platformCalls).toBe(0);
  await expect(page.getByRole('button', { name: '核对并确认发送', exact: true })).toHaveCount(0);
  await expect(page.getByText('每60秒自动同步本会话', { exact: false })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  draft.status = 'stale';
  await expect(page.getByRole('button', { name: '复制回复草稿' })).toBeDisabled({ timeout: 10000 });
  expect(platformCalls).toBe(0);
});
