import { readDouyinTranscript } from './douyin-message-dom.ts';
import { xhsMessageDirection, douyinPeer } from './message-identity.ts';
import { z } from 'zod';
import type { Page } from 'playwright';
import { requireSession, openLogin, checkLogin } from './browser.ts';
import type { Platform } from '../../shared/types.ts';
import type { InboxMessage, NativeInbox } from '../../shared/messages.ts';
import { transcriptHash } from '../message-hash.ts';

const idSchema = z.string().regex(/^[a-zA-Z0-9_:-]{1,200}$/);
const operationSchema = z.object({
  platform: z.enum(['xiaohongshu', 'douyin']),
  operation: z.enum(['list', 'read', 'send']),
  accountId: z.string().optional(),
  nativeId: idSchema.optional(),
  text: z.string().trim().min(1).max(1000).optional(),
  expectedHash: z.string().optional(),
  refresh: z.boolean().optional(),
});
async function inboxPage(platform: Platform) {
  const session = await requireSession(platform);
  if (!session.state.accountId) throw new Error('未验证当前登录账号');
  if (platform !== 'xiaohongshu') throw new Error('抖音普通账号私信尚未完成实机验证，发送保持关闭');
  let page = session.context
    .pages()
    .find((p) => p.url().startsWith('https://www.xiaohongshu.com/chat'));
  if (!page) {
    const href = await session.page.locator('a[href^="/chat"]').first().getAttribute('href');
    if (!href?.startsWith('/chat')) throw new Error('官方页面没有可用的消息入口');
    page = await session.context.newPage();
    await page.goto(new URL(href, 'https://www.xiaohongshu.com').href, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
  }
  await page.locator('.xhs-im-conv-list').waitFor({ timeout: 20000 });
  await assertInboxPage(page, platform);
  return { session, page };
}
async function readMessages(
  page: Page,
  accountId: string,
  nativeId: string,
): Promise<InboxMessage[]> {
  const active = page.locator(
    `.xhs-im-conv-item[data-conv-id="${nativeId}"][data-conv-kind="c2c"]`,
  );
  await active.waitFor({ state: 'visible', timeout: 20000 });
  if ((await active.count()) !== 1) throw new Error('官方会话不存在或身份不唯一，请刷新列表');
  await active.click();
  await page.locator('.xhs-im-chat-window').waitFor({ timeout: 15000 });
  await page.locator('.xhs-im-msg-skeleton').waitFor({ state: 'hidden', timeout: 20000 });
  // IDs identify the conversation participants, not the sender. Direction comes
  // from the official me/other bubble markers, checked for ambiguity.
  const messages = await page
    .locator('.xhs-im-msg-list .chat-item[data-message-id]')
    .evaluateAll((nodes) =>
      nodes.map((n) => ({
        nativeId: n.getAttribute('data-message-id') || '',
        me: !!n.querySelector('.chat-item__bubble--me'),
        other: !!n.querySelector('.chat-item__bubble--other'),
        text: (() => {
          const body = n.querySelector('.xhs-im-bubble__text')?.cloneNode(true) as
            Element | undefined;
          body
            ?.querySelectorAll('img')
            .forEach((img) => img.replaceWith(img.getAttribute('alt') || ''));
          return body?.textContent || '';
        })(),
        timeLabel: (() => {
          let p = n.previousElementSibling;
          while (p) {
            if (p.classList.contains('xhs-im-msg-list__time-divider')) return p.textContent || '';
            p = p.previousElementSibling;
          }
          return '';
        })(),
        kind:
          n.getAttribute('data-content-type') === '1' ? ('text' as const) : ('attachment' as const),
      })),
    );
  return messages.map((m) => {
    return {
      nativeId: m.nativeId,
      kind: m.kind,
      timeLabel: m.timeLabel,
      text: m.text.slice(0, 5000),
      direction: xhsMessageDirection(m.nativeId, accountId, nativeId, m.me, m.other),
    };
  });
}
export async function messaging(input: unknown): Promise<NativeInbox> {
  const args = operationSchema.parse(input);
  if (args.platform === 'douyin') return dyMessaging(args);
  const { session, page } = await inboxPage(args.platform);
  const accountId = session.state.accountId!;
  if (args.accountId && args.accountId !== accountId)
    throw new Error('登录账号已变化，请刷新会话并重新确认');
  if (args.refresh) {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.locator('.xhs-im-conv-list').waitFor({ timeout: 20000 });
  }
  const threads = await page.locator('.xhs-im-conv-item[data-conv-kind="c2c"]').evaluateAll((ns) =>
    ns.map((n) => ({
      nativeId: n.getAttribute('data-conv-id') || '',
      name: n.querySelector('.xhs-im-conv-item__name')?.textContent || '',
      preview: n.querySelector('.xhs-im-conv-item__summary-text')?.textContent || '',
      timeLabel: n.querySelector('.xhs-im-conv-item__time')?.textContent || '',
    })),
  );
  const result: NativeInbox = {
    platform: args.platform,
    accountId,
    accountName: session.state.accountName || '',
    threads,
  };
  if (args.operation === 'list') return result;
  if (!args.nativeId) throw new Error('请选择具体会话');
  const messages = await readMessages(page, accountId, args.nativeId);
  // A freshly opened inbox may populate its virtual list after the first read.
  // Include only the verified selected row, never guess it from a nickname.
  if (!result.threads.some((t) => t.nativeId === args.nativeId)) {
    const row = await page
      .locator(`.xhs-im-conv-item[data-conv-id="${args.nativeId}"][data-conv-kind="c2c"]`)
      .evaluate((n) => ({
        nativeId: n.getAttribute('data-conv-id') || '',
        name: n.querySelector('.xhs-im-conv-item__name')?.textContent || '',
        preview: n.querySelector('.xhs-im-conv-item__summary-text')?.textContent || '',
        timeLabel: n.querySelector('.xhs-im-conv-item__time')?.textContent || '',
      }));
    result.threads.push(row);
  }
  result.selected = { nativeId: args.nativeId, messages };
  if (args.operation === 'send') {
    if (!args.text || !args.expectedHash || transcriptHash(messages) !== args.expectedHash)
      throw new Error('会话已变化，请重新查看并确认回复');
    const editor = page.locator('.xhs-im-input-bar-editor[contenteditable="true"]');
    if ((await editor.count()) !== 1 || !(await editor.isVisible()))
      throw new Error('官方消息输入框不可用');
    if ((await editor.innerText()).trim())
      throw new Error('官方输入框已有未发送内容，请本人处理后重试');
    if (session.state.accountId !== accountId) throw new Error('登录账号已变化');
    await assertInboxPage(page, args.platform);
    await editor.fill(args.text);
    // Submit once; an unknown result must be reconciled instead of retried.
    await editor.press('Enter');
    const previousIds = new Set(messages.map((m) => m.nativeId));
    for (let attempt = 0; attempt < 12; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const after = await readMessages(page, accountId, args.nativeId);
      const receipts = after.filter(
        (m) => m.direction === 'outgoing' && m.text === args.text && !previousIds.has(m.nativeId),
      );
      if (receipts.length === 1) {
        // Reload the official page and read back the same ID; an optimistic
        // bubble immediately after Enter is not sufficient evidence of acceptance.
        const receiptId = receipts[0].nativeId;
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.locator('.xhs-im-conv-list').waitFor({ timeout: 20000 });
        const confirmed = await readMessages(page, accountId, args.nativeId);
        if (
          !confirmed.some(
            (m) => m.nativeId === receiptId && m.direction === 'outgoing' && m.text === args.text,
          )
        )
          throw new Error('刷新官方会话后未能核对发送结果');
        result.selected = { nativeId: args.nativeId, messages: confirmed };
        return result;
      }
      if (receipts.length > 1) throw new Error('平台出现多条匹配消息，请人工核对');
    }
    throw new Error('未观察到唯一平台消息标识，请人工核对，不能重发');
  }
  return result;
}
async function assertInboxPage(page: Page, platform: Platform) {
  const host = platform === 'douyin' ? 'www.douyin.com' : 'www.xiaohongshu.com';
  if (new URL(page.url()).hostname !== host)
    throw new Error('平台页面已跳转，请本人处理登录或验证');
  if (
    await page
      .locator(
        'iframe[src*="captcha"]:visible, .captcha_verify_container:visible, #captcha_container:visible',
      )
      .count()
  )
    throw new Error('平台验证码暂停，请本人完成后手动恢复同步');
}
export async function loginPreview(platform: Platform) {
  const session = await openLogin(platform);
  const state = await checkLogin(platform);
  if (state.status === 'ready') throw new Error('当前账号已登录，无需扫码');
  const page = session.page;
  if (
    !page
      .url()
      .startsWith(
        platform === 'xiaohongshu' ? 'https://www.xiaohongshu.com/' : 'https://www.douyin.com/',
      )
  )
    throw new Error('平台站点尚未连通，暂无二维码');
  const login = page.getByRole('button', { name: '登录', exact: true });
  if (await login.isVisible().catch(() => false)) await login.click();
  const refresh = page.getByText('点击刷新', { exact: true });
  if (await refresh.isVisible().catch(() => false)) await refresh.click();
  await page.waitForTimeout(350);
  return page.screenshot({ type: 'png' });
}
// Only rendered official message/conversation identity fields are read. No SDK
// requests, authentication state, tickets or private message APIs are invoked.
async function dyList(page: Page, accountId: string): Promise<NativeInbox['threads']> {
  await assertInboxPage(page, 'douyin');
  if (
    !(await page
      .locator('.StackLayoutStackLayoutV2wrapper')
      .isVisible()
      .catch(() => false))
  )
    await page.getByText('消息', { exact: true }).first().click();
  await page.locator('[data-stack-layer="list"]').waitFor({ timeout: 15000 });
  const rows = await page.locator('[data-e2e="conversation-item"]').evaluateAll((ns) =>
    ns.map((n) => {
      const key = Object.keys(n).find((k) => k.startsWith('__reactFiber'));
      let f = key ? (n as any)[key] : null;
      let model: any;
      for (let i = 0; f && i < 12; i++, f = f.return) {
        if (f.memoizedProps?.conversation) {
          model = f.memoizedProps.conversation;
          break;
        }
      }
      return {
        nativeId: String(model?.id || ''),
        peerId: String(model?.toParticipantSecUserId || ''),
        name: n.querySelector('.conversationConversationItemtitle')?.textContent || '',
        preview: n.querySelector('.ConversationItemHinttextBox')?.textContent || '',
        timeLabel: n.querySelector('.ConversationItemTagNextToTitletimeStr')?.textContent || '',
      };
    }),
  );
  for (const r of rows) {
    douyinPeer(r.nativeId, accountId);
    if (!/^MS4w[A-Za-z0-9_-]+$/.test(r.peerId || ''))
      throw new Error('抖音用户标识不可验证，请重新同步');
  }
  if (new Set(rows.map((r) => r.nativeId)).size !== rows.length)
    throw new Error('抖音会话身份不唯一');
  return rows;
}
async function dyRead(page: Page, accountId: string, nativeId: string): Promise<InboxMessage[]> {
  douyinPeer(nativeId, accountId);
  // On narrow layouts the chat layer covers the list. Use the official back control.
  if (
    await page
      .locator('[data-stack-layer="chat"]')
      .isVisible()
      .catch(() => false)
  )
    await page.locator('[data-stack-layer="chat"] .StackLayoutStackTitleBarleftArea').click();
  await page
    .locator('.StackLayoutStackLayoutV2stackLayerLeaving')
    .waitFor({ state: 'detached', timeout: 10000 });
  const rows = await dyList(page, accountId);
  const index = rows.findIndex((r) => r.nativeId === nativeId);
  if (index < 0) throw new Error('抖音当前已加载列表没有此会话，请先同步列表');
  await page.locator('[data-e2e="conversation-item"]').nth(index).click();
  await page
    .locator('[data-stack-layer="chat"] [data-e2e="msg-input"]')
    .waitFor({ timeout: 15000 });
  await page.waitForFunction(
    (id) => {
      const n =
        document.querySelector('[data-stack-layer="chat"] .messageMessageBoxmessageBox') ||
        document.querySelector('[data-stack-layer="chat"] [data-e2e="msg-input"]');
      const key = n && Object.keys(n).find((k) => k.startsWith('__reactFiber'));
      let f = key ? (n as any)[key] : null;
      for (let i = 0; f && i < 18; i++, f = f.return) {
        if (String(f.memoizedProps?.curConversation?.id || '') === id) return true;
      }
      return false;
    },
    nativeId,
    { timeout: 15000 },
  );
  return readDouyinTranscript(page, accountId, nativeId);
}
async function dyMessaging(args: z.infer<typeof operationSchema>): Promise<NativeInbox> {
  const session = await requireSession('douyin');
  const accountId = session.state.accountId;
  if (!accountId || (args.accountId && args.accountId !== accountId))
    throw new Error('抖音登录账号已变化，请重新同步');
  const page = session.page;
  if (args.refresh) await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
  const result: NativeInbox = {
    platform: 'douyin',
    accountId,
    accountName: session.state.accountName || '',
    threads: await dyList(page, accountId),
  };
  if (args.operation === 'list') return result;
  if (!args.nativeId) throw new Error('请选择具体会话');
  const messages = await dyRead(page, accountId, args.nativeId);
  result.selected = { nativeId: args.nativeId, messages };
  if (args.operation !== 'send') return result;
  if (!args.text || !args.expectedHash || transcriptHash(messages) !== args.expectedHash)
    throw new Error('会话已变化，请重新查看并确认回复');
  const editor = page.locator(
    '[data-stack-layer="chat"] [data-slate-editor="true"][contenteditable="true"]',
  );
  if ((await editor.count()) !== 1 || !(await editor.isVisible()))
    throw new Error('抖音官方消息输入框不可用');
  if ((await editor.innerText()).replace(/[\u200b-\u200d\ufeff]/g, '').trim())
    throw new Error('官方输入框已有未发送内容，请本人处理后重试');
  if (session.state.accountId !== accountId) throw new Error('登录账号已变化');
  await assertInboxPage(page, 'douyin');
  await editor.fill(args.text);
  await editor.press('Enter'); // Submit once only. Unknown outcomes never retry.
  const previousIds = new Set(messages.map((m) => m.nativeId));
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(700);
    const after = await dyRead(page, accountId, args.nativeId);
    const receipts = after.filter(
      (m) => m.direction === 'outgoing' && m.text === args.text && !previousIds.has(m.nativeId),
    );
    if (receipts.length > 1) throw new Error('平台出现多条匹配消息，请人工核对');
    if (receipts.length === 1) {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
      await dyList(page, accountId);
      const confirmed = await dyRead(page, accountId, args.nativeId);
      if (
        !confirmed.some(
          (m) =>
            m.nativeId === receipts[0].nativeId &&
            m.direction === 'outgoing' &&
            m.text === args.text,
        )
      )
        throw new Error('刷新抖音官方会话后未能核对发送结果');
      result.selected = { nativeId: args.nativeId, messages: confirmed };
      return result;
    }
  }
  throw new Error('未取得唯一抖音平台发送回执，请核对，不能重发');
}
