import type { Page } from 'playwright';
import type { InboxMessage, NativeInbox } from '../../shared/messages.ts';
import { douyinMessageDirection, douyinPeer } from './message-identity.ts';
export async function readDouyinTranscript(
  page: Page,
  accountId: string,
  nativeId: string,
): Promise<InboxMessage[]> {
  const raw = await page
    .locator('[data-stack-layer="chat"] .messageMessageBoxmessageBox')
    .evaluateAll((ns) =>
      ns.map((n) => {
        const key = Object.keys(n).find((k) => k.startsWith('__reactFiber'));
        let f = key ? (n as any)[key] : null;
        let model: any;
        for (let i = 0; f && i < 12; i++, f = f.return)
          if (f.memoizedProps?.message) {
            model = f.memoizedProps.message;
            break;
          }
        const body = n.querySelector('.TextMessageTexttextInnerContent')?.cloneNode(true) as
          Element | undefined;
        body
          ?.querySelectorAll('img')
          .forEach((img) => img.replaceWith(img.getAttribute('alt') || '[表情]'));
        return {
          nativeId: String(model?.serverId || ''),
          conversationId: String(model?.conversationId || ''),
          sender: String(model?.sender || ''),
          me: !!n.querySelector('.messageMessageBoxisFromMe'),
          text: body?.textContent || '',
          timeLabel: n.querySelector('.MessageBoxTimetimeLayout')?.textContent || '',
          skip: !!n.querySelector('.MessageItemHiGroupHiBox,.messageMessageBoxfullRowContent'),
          kind: body ? ('text' as const) : ('attachment' as const),
        };
      }),
    );
  // The official list uses rotate(180deg); server IDs deduplicate identical text.
  const messages = raw
    .filter((m) => !m.skip)
    .filter(
      (m) =>
        !(
          (!m.nativeId || m.nativeId === '0') &&
          m.me &&
          m.sender === accountId &&
          m.conversationId === nativeId
        ),
    )
    .reverse()
    .map((m) => ({
      nativeId: m.nativeId,
      text: m.text.slice(0, 5000),
      timeLabel: m.timeLabel,
      kind: m.kind,
      direction: douyinMessageDirection(
        nativeId,
        accountId,
        m.conversationId,
        m.sender,
        m.me,
        m.nativeId,
      ),
    }));
  if (new Set(messages.map((m) => m.nativeId)).size !== messages.length)
    throw new Error('抖音消息标识重复，已暂停同步');
  return messages;
}

// A restored chat may cover or hide its list. Metadata needs attachment,
// not visibility; actual navigation still uses the visible official back button.
export async function readDouyinThreads(
  page: Page,
  accountId: string,
): Promise<NativeInbox['threads']> {
  await page.locator('[data-stack-layer="list"]').waitFor({ state: 'attached', timeout: 15000 });
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
