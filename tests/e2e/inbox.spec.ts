import { test, expect } from '@playwright/test';
import type { InboxThread, ReplyDraft } from '../../shared/messages';
test('Inbox sends only after exact review and shows a verified receipt', async ({ page }) => {
  const thread: InboxThread = {
    id: 'thread-test',
    platform: 'xiaohongshu',
    accountId: 'test-operator',
    accountName: '测试操作账号',
    nativeId: 'test-peer',
    name: '受控测试联系人',
    preview: '测试收到',
    timeLabel: '刚刚',
    messages: [
      {
        nativeId: 'peer.operator.1',
        text: '测试收到',
        direction: 'incoming',
        kind: 'text',
        timeLabel: '刚刚',
      },
    ],
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
    contextHash: 'context-test',
    text: '已收到你的测试回复，谢谢配合。',
    rationale: '根据最后一条测试消息致谢。',
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  let sends = 0;
  await page.route('**/api/inbox', (route) =>
    route.fulfill({ json: { threads: [thread], drafts: [draft] } }),
  );
  await page.route('**/api/inbox/xiaohongshu/sync', (route) => route.fulfill({ json: [thread] }));
  await page.route('**/api/inbox/drafts/draft-test/send', async (route) => {
    sends++;
    expect(route.request().postDataJSON()).toEqual({
      confirmed: true,
      text: draft.text,
      contextHash: draft.contextHash,
    });
    draft.status = 'sent';
    draft.sentMessageId = 'peer.operator.2';
    thread.messages.push({
      nativeId: draft.sentMessageId,
      direction: 'outgoing',
      text: draft.text,
      timeLabel: '刚刚',
      kind: 'text',
    });
    await route.fulfill({ json: { ok: true, messageId: draft.sentMessageId } });
  });
  await page.goto('/#inbox');
  await page.getByRole('button', { name: /^受控测试联系人/ }).click();
  await expect(page.getByLabel('真实私信消息')).toContainText('测试收到');
  await page.getByRole('button', { name: '核对并确认发送', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '确认发送这条私信' });
  await expect(dialog).toContainText('测试操作账号');
  await expect(dialog).toContainText(draft.text);
  expect(sends).toBe(0);
  await dialog.getByRole('button', { name: '确认发送给 受控测试联系人' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText('已取得平台发送回执', { exact: true }).first()).toBeVisible();
  expect(sends).toBe(1);
  await expect(page.getByLabel('真实私信消息')).toContainText(draft.text);
});
test('A new reply disables an already open approval dialog, including on a narrow screen', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const thread: InboxThread = {
    id: 'stale-thread',
    platform: 'xiaohongshu',
    accountId: 'operator',
    accountName: '测试账号',
    nativeId: 'peer',
    name: '测试会话',
    preview: '请发资料',
    timeLabel: '刚刚',
    messages: [],
    revision: 1,
    watching: true,
    autoSuggest: false,
    stopped: false,
    syncedAt: new Date().toISOString(),
    error: '',
  };
  const draft: ReplyDraft = {
    id: 'stale-draft',
    threadId: thread.id,
    contextHash: 'before',
    text: '我来发资料',
    rationale: '旧上下文',
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  let sends = 0;
  await page.route('**/api/inbox', (route) =>
    route.fulfill({ json: { threads: [thread], drafts: [draft] } }),
  );
  await page.route('**/api/inbox/xiaohongshu/sync', (route) => route.fulfill({ json: [thread] }));
  await page.route('**/api/inbox/drafts/stale-draft/send', (route) => {
    sends++;
    return route.fulfill({ json: { ok: false } });
  });
  await page.goto('/#inbox');
  await page.getByRole('button', { name: /^测试会话/ }).click();
  await page.getByRole('button', { name: '核对并确认发送', exact: true }).click();
  draft.status = 'stale';
  thread.messages.push({
    nativeId: 'new',
    direction: 'incoming',
    text: '不用发了',
    timeLabel: '刚刚',
    kind: 'text',
  });
  thread.revision++;
  await expect(page.getByRole('button', { name: '确认发送给 测试会话' })).toBeDisabled({
    timeout: 10000,
  });
  expect(sends).toBe(0);
});
