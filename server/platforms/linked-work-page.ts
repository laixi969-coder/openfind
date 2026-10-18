import type { Page, Response } from 'playwright';
import type { Note } from '../../shared/types.ts';
import { parseWorkLink, allowedWorkNavigation, type WorkLink } from '../../shared/work-links.ts';
import { xhsNotes, douyinNotes, parsePlatformJSON } from './model.ts';
export function linkedWorkFromPayload(link: WorkLink, payload: any): Note | undefined {
  if (!link.nativeId) return;
  if (link.platform === 'xiaohongshu')
    return xhsNotes(payload).find((n) => n.nativeId === link.nativeId);
  const list = payload?.aweme_detail
    ? [payload.aweme_detail]
    : payload?.item_list ||
      payload?.aweme_list ||
      payload?.data?.item_list ||
      payload?.data?.aweme_list ||
      (Array.isArray(payload?.data) ? payload.data : []);
  return douyinNotes({ aweme_list: list }).find((n) => n.nativeId === link.nativeId);
}
export function linkedWorkFromHydration(link: WorkLink, root: any): Note | undefined {
  if (!link.nativeId) return;
  if (link.platform === 'xiaohongshu') {
    const note = root?.[link.nativeId]?.note;
    if (!note) return;
    if (note.noteId && String(note.noteId) !== link.nativeId) return;
    return linkedWorkFromPayload(link, {
      data: { items: [{ id: link.nativeId, note_card: note }] },
    });
  }
  const pending = [root];
  const seen = new Set<object>();
  for (let steps = 0; pending.length && steps < 12000; steps++) {
    const n = pending.pop();
    if (!n || typeof n !== 'object' || seen.has(n)) continue;
    seen.add(n);
    if (String(n.aweme_id || '') === link.nativeId && n.author)
      return linkedWorkFromPayload(link, { aweme_list: [n] });
    for (const [key, value] of Object.entries(n))
      if (
        !/token|cookie|password|login|account|userinfo/i.test(key) &&
        value &&
        typeof value === 'object'
      )
        pending.push(value);
  }
}
// Read only the public work props rendered by Douyin's image detail page.
// Exact IDs prevent recommendation cards from being mistaken for the pasted work.
async function renderedDouyinWork(page: Page, link: WorkLink): Promise<Note | undefined> {
  const raw = await page
    .locator('div,span,p')
    .evaluateAll((nodes, id) => {
      const seen = new Set<object>();
      for (const node of nodes.slice(0, 12000)) {
        const key = Object.keys(node).find((k) => k.startsWith('__reactFiber'));
        let fiber = key ? (node as any)[key] : null;
        for (let depth = 0; fiber && depth < 20; depth++, fiber = fiber.return) {
          if (seen.has(fiber)) break;
          seen.add(fiber);
          const props = fiber.memoizedProps;
          for (const name of ['awemeInfo', 'itemInfo']) {
            const work = props?.[name];
            if (!work || String(work.awemeId || '') !== id) continue;
            const author = work.authorInfo || {},
              stats = work.stats || {};
            return {
              aweme_id: String(work.awemeId),
              desc: String(work.desc || ''),
              create_time: work.createTime,
              author: { sec_uid: author.secUid, uid: author.uid, nickname: author.nickname },
              statistics: {
                comment_count: stats.commentCount,
                digg_count: stats.diggCount,
                collect_count: stats.collectCount,
              },
              images: Array.isArray(work.images)
                ? work.images.map((image: any) => ({ url_list: image.urlList || [] }))
                : [],
              video: { cover: work.video?.cover },
              text_extra: Array.isArray(work.textExtra)
                ? work.textExtra.map((tag: any) => ({ hashtag_name: tag.hashtagName }))
                : [],
            };
          }
        }
      }
      return null;
    }, link.nativeId)
    .catch(() => null);
  return raw ? linkedWorkFromPayload(link, { aweme_list: [raw] }) : undefined;
}
export async function readLinkedWork(
  page: Page,
  original: WorkLink,
  signal?: AbortSignal,
): Promise<Note> {
  if (original.short) throw new Error('分享短链接须先校验官方跳转，再读取作品');
  signal?.throwIfAborted();
  let captured: Note | undefined;
  let blocked = '';
  const capture = async (response: Response) => {
    const u = new URL(response.url());
    const official =
      original.platform === 'xiaohongshu'
        ? u.hostname.endsWith('.xiaohongshu.com')
        : u.hostname.endsWith('.douyin.com') || u.hostname.endsWith('.iesdouyin.com');
    if (
      !official ||
      !(original.platform === 'xiaohongshu' ? /\/feed(?:\?|$)/ : /\/aweme\/(?:detail|post)\//).test(
        response.url(),
      )
    )
      return;
    if ([403, 429].includes(response.status())) {
      blocked = `平台限制作品读取（${response.status()}），请检查官方窗口`;
      return;
    }
    try {
      const final = parseWorkLink(page.url());
      if (
        final.platform !== original.platform ||
        (original.nativeId && final.nativeId !== original.nativeId)
      )
        return;
      const payload = parsePlatformJSON(await response.text());
      if (payload.success === false || (payload.status_code && payload.status_code !== 0)) {
        blocked = '平台未授权读取该作品，请检查登录或验证';
        return;
      }
      captured = linkedWorkFromPayload(final, payload) || captured;
    } catch {}
  };
  await page.route('**/*', async (route) => {
    const r = route.request();
    if (
      r.isNavigationRequest() &&
      r.frame() === page.mainFrame() &&
      !allowedWorkNavigation(original.platform, r.url())
    ) {
      blocked = '分享链接跳转到了非平台官方地址，已停止读取';
      await route.abort();
    } else await route.fallback();
  });
  page.on('response', capture);
  const cancel = () => {
    void page.close().catch(() => {});
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    try {
      await page.goto(original.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch (e) {
      if (blocked) throw Error(blocked);
      throw e;
    }
    for (let i = 0; i < 80; i++) {
      signal?.throwIfAborted();
      if (blocked) throw Error(blocked);
      const body = await page
        .locator('body')
        .innerText()
        .catch(() => '');
      const captcha = await page
        .locator(
          'iframe[src*="captcha"]:visible,.captcha_verify_container:visible,#captcha_container:visible',
        )
        .count();
      if (captcha || /请完成下列验证|请完成验证|按住左边按钮|点击两个形状相同/.test(body))
        throw Error('平台要求本人完成安全验证，作品页已保留；完成后恢复平台保护并继续流程');
      const final = parseWorkLink(page.url());
      if (
        final.platform !== original.platform ||
        final.short ||
        !final.nativeId ||
        (original.nativeId && original.nativeId !== final.nativeId)
      )
        throw Error('分享链接没有进入原指定作品，请检查链接是否有效或过期');
      if (!captured) {
        const hydration = await page
          .evaluate((which) => {
            if (which === 'xiaohongshu')
              return JSON.stringify((window as any).__INITIAL_STATE__?.note?.noteDetailMap || {});
            return JSON.stringify((window as any)._ROUTER_DATA?.loaderData || {});
          }, original.platform)
          .catch(() => '{}');
        captured = linkedWorkFromHydration(final, parsePlatformJSON(hydration));
        if (!captured && original.platform === 'douyin') {
          const raw = await page
            .locator('script#RENDER_DATA')
            .textContent({ timeout: 300 })
            .catch(() => null);
          if (raw) {
            try {
              captured = linkedWorkFromHydration(final, parsePlatformJSON(decodeURIComponent(raw)));
            } catch {}
          }
        }
      }
      if (!captured && original.platform === 'douyin')
        captured = await renderedDouyinWork(page, final);
      if (captured && captured.nativeId === final.nativeId && captured.authorId)
        return { ...captured, url: final.url, detailState: 'complete', source: 'live' };
      if (
        /笔记不存在|笔记已删除|作品不存在|作品已删除|视频已删除|暂时无法访问该笔记|内容无法展示/.test(
          body,
        )
      )
        throw Error('作品已删除、私密或当前账号无权访问，未生成虚构结果');
      await page.waitForTimeout(250);
    }
    throw Error(
      '未取得指定作品的真实详情，可能需要登录、有效分享签名或页面已变化；请检查官方窗口后继续',
    );
  } finally {
    page.off('response', capture);
    signal?.removeEventListener('abort', cancel);
  }
}
