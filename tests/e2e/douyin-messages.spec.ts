import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readDouyinTranscript } from '../../server/platforms/douyin-message-dom';
async function fixture(
  page: Page,
  rows: { id: string; sender: string; text: string; me?: boolean; skip?: boolean }[],
) {
  await page.setContent('<div data-stack-layer="chat"></div>');
  await page.evaluate((rows) => {
    const root = document.querySelector('[data-stack-layer="chat"]')!;
    for (const row of rows) {
      const n = document.createElement('div');
      n.className = 'messageMessageBoxmessageBox';
      const body = document.createElement('div');
      body.className = row.skip ? 'MessageItemHiGroupHiBox' : 'TextMessageTexttextInnerContent';
      body.textContent = row.text;
      n.append(body);
      if (row.me) {
        const marker = document.createElement('div');
        marker.className = 'messageMessageBoxisFromMe';
        n.append(marker);
      }
      // Synthetic rendered identity metadata; no real accounts or chat fixtures.
      (n as any).__reactFiber_test = {
        memoizedProps: {
          message: { serverId: row.id, conversationId: '0:1:123:456', sender: row.sender },
        },
      };
      root.append(n);
    }
  }, rows);
}
test('Douyin reversed DOM retains repeated text with distinct server IDs and ignores pending own bubbles', async ({
  page,
}) => {
  await fixture(page, [
    { id: '0', sender: '123', text: 'pending', me: true },
    { id: '102', sender: '123', text: 'same', me: true },
    { id: '101', sender: '456', text: 'same' },
    { id: '100', sender: '456', text: 'greeting UI', skip: true },
  ]);
  const actual = await readDouyinTranscript(page, '123', '0:1:123:456');
  expect(actual.map((m) => ({ id: m.nativeId, direction: m.direction, text: m.text }))).toEqual([
    { id: '101', direction: 'incoming', text: 'same' },
    { id: '102', direction: 'outgoing', text: 'same' },
  ]);
});
test('Douyin missing inbound identity, inconsistent sender markers and duplicate IDs stop extraction', async ({
  page,
}) => {
  await fixture(page, [{ id: '0', sender: '456', text: 'not acknowledged' }]);
  await expect(readDouyinTranscript(page, '123', '0:1:123:456')).rejects.toThrow(/消息身份/);
  await fixture(page, [{ id: '101', sender: '123', text: 'wrong bubble' }]);
  await expect(readDouyinTranscript(page, '123', '0:1:123:456')).rejects.toThrow(/消息身份/);
  await fixture(page, [
    { id: '101', sender: '456', text: 'one' },
    { id: '101', sender: '456', text: 'two' },
  ]);
  await expect(readDouyinTranscript(page, '123', '0:1:123:456')).rejects.toThrow(/标识重复/);
});

test('Restored Douyin chat can read hidden list metadata without clicking through the chat layer', async ({
  page,
}) => {
  const { readDouyinThreads } = await import('../../server/platforms/douyin-message-dom');
  await page.setContent(
    '<div data-stack-layer="list" style="display:none"><div data-e2e="conversation-item"><div class="conversationConversationItemtitle">controlled test</div></div></div><div data-stack-layer="chat">restored chat</div>',
  );
  await page.locator('[data-e2e="conversation-item"]').evaluate((n) => {
    (n as any).__reactFiber_test = {
      memoizedProps: {
        conversation: { id: '0:1:123:456', toParticipantSecUserId: 'MS4wSyntheticPeer' },
      },
    };
  });
  const rows = await readDouyinThreads(page, '123');
  expect(rows).toHaveLength(1);
  expect(rows[0].nativeId).toBe('0:1:123:456');
  await expect(page.locator('[data-stack-layer="list"]')).toBeHidden();
  await expect(page.locator('[data-stack-layer="chat"]')).toBeVisible();
});
