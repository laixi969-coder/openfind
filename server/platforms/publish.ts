import { randomUUID, createHash } from 'node:crypto';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Page, Response, Locator } from 'playwright';
import type { Draft, Platform } from '../../shared/types.ts';
import { get, put, dataDir } from '../store.ts';
import { openCreator, requireSession } from './browser.ts';
import { allowNetworkRequest } from './network.ts';
import { installDiagnostics } from './diagnostics.ts';
import { parsePlatformJSON } from './model.ts';
interface Prepared {
  draftId: string;
  fingerprint: string;
  page: Page;
  platform: Platform;
  accountId: string;
}
const prepared = new Map<string, Prepared>();
function editorText(editor: Locator) {
  return editor.evaluate((e) =>
    e instanceof HTMLTextAreaElement || e instanceof HTMLInputElement
      ? e.value
      : (e as HTMLElement).innerText,
  );
}
function fingerprint(d: Draft) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        d.title,
        d.body,
        d.images,
        d.video,
        d.tags,
        d.visibility,
        d.accountId,
        d.platform,
        d.kind,
      ]),
    )
    .digest('hex');
}
async function clickLabel(page: Page, label: string) {
  const matches = page.getByText(label, { exact: true });
  const viewport = page.viewportSize() || { width: 1280, height: 860 };
  for (const loc of await matches.all()) {
    const box = await loc.boundingBox();
    if (
      box &&
      box.width > 0 &&
      box.height > 0 &&
      box.x >= 0 &&
      box.y >= 0 &&
      box.x < viewport.width &&
      box.y < viewport.height
    ) {
      try {
        await loc.click({ timeout: 1500 });
        return true;
      } catch {
        continue;
      }
    }
  }
  return false;
}
async function closedPublishButton(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    type Node = {
      nodeName: string;
      nodeValue: string;
      backendNodeId: number;
      attributes?: string[];
      children?: Node[];
      shadowRoots?: Node[];
    };
    const descend = (n: Node): Node[] => [
      n,
      ...(n.children || []).flatMap(descend),
      ...(n.shadowRoots || []).flatMap(descend),
    ];
    const host = descend(root as Node).find((n) => n.nodeName === 'XHS-PUBLISH-BTN');
    if (!host) return null;
    const button = descend(host).find(
      (n) =>
        n.nodeName === 'BUTTON' &&
        descend(n).some((c) => c.nodeName === '#text' && c.nodeValue.trim() === '发布'),
    );
    if (!button || button.attributes?.includes('disabled')) return null;
    const id = button.backendNodeId;
    return {
      click: async () => {
        const next = await page.context().newCDPSession(page);
        try {
          const { object } = await next.send('DOM.resolveNode', { backendNodeId: id });
          if (!object.objectId) throw new Error('发布控件已失效，请重新预览');
          const result = await next.send('Runtime.callFunctionOn', {
            objectId: object.objectId,
            functionDeclaration:
              'function(){if(this.disabled||this.getAttribute("aria-disabled")=="true")throw new Error("发布按钮尚不可用");this.click();}',
            returnByValue: true,
          });
          if (result.exceptionDetails) throw new Error('平台发布按钮尚不可用');
        } finally {
          await next.detach();
        }
      },
    };
  } finally {
    await cdp.detach();
  }
}
async function submitControl(page: Page) {
  for (let i = 0; i < 40; i++) {
    for (const frame of page.frames()) {
      const buttons = frame
        .getByRole('button', { name: /^(发布|确认发布)$/ })
        .or(frame.getByText('发布', { exact: true }))
        .and(frame.locator(':visible'));
      for (const loc of await buttons.all())
        if (await loc.isVisible().catch(() => false)) return loc;
    }
    // The official XHS editor renders its footer in a closed Web Component.
    // Read that specific component through Chrome's DOM accessibility tooling,
    // then invoke that enabled button's standard click handler. Platform API and validation remain in place.
    if (page.url().startsWith('https://creator.xiaohongshu.com/')) {
      const button = await closedPublishButton(page);
      if (button) return button;
    }
    await delay(500);
  }
  throw new Error('未找到平台发布控件，请检查官方编辑器是否已加载完成');
}
export async function preparePublish(draft: Draft) {
  const prior = get<any>('publish-attempts', draft.id);
  if (prior && ['submitting', 'uncertain'].includes(prior.status))
    throw new Error('该作品提交结果待核对，请先检查平台作品管理，不能用重新预览覆盖提交状态');
  const platform = draft.platform || 'xiaohongshu';
  const s = await requireSession(platform);
  installDiagnostics(s.context, platform);
  const expected = `browser:${platform}:${s.state.accountId}`;
  if (draft.accountId !== expected)
    throw new Error('当前平台登录账号与所选发布账号不一致，请重新选择');
  const { page } = await openCreator(platform);
  await page
    .locator('input[type=file],input[placeholder*="手机号"],input[placeholder*="验证码"]')
    .first()
    .waitFor({ state: 'attached', timeout: 45000 })
    .catch(() => {});
  await delay(1000);
  const body = await page.locator('body').innerText();
  if (
    /扫码登录|短信登录|手机号登录/.test(body) &&
    !(await page.locator('input[type=file]').count())
  )
    throw new Error('创作者中心还需要登录，请在新打开的官方页面扫码后重试');
  if (draft.kind !== 'video') {
    for (const label of ['上传图文', '发布图文', '图文']) {
      if (await clickLabel(page, label)) break;
    }
    await delay(500);
  }
  const folder = join(dataDir, 'publish-media', draft.id);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const paths: string[] = [];
  if (draft.kind === 'video') {
    if (!draft.video || !/^\/api\/media\/[a-f0-9-]+\.(mp4|webm|mov)$/.test(draft.video))
      throw new Error('请选择已上传的本地视频');
    paths.push(join(dataDir, 'uploads', draft.video.split('/').at(-1)!));
  } else {
    for (let i = 0; i < draft.images.length; i++) {
      const url = draft.images[i];
      let buffer: Buffer;
      if (url.startsWith('data:image/')) buffer = Buffer.from(url.split(',')[1], 'base64');
      else if (/^https?:\/\//.test(url)) {
        allowNetworkRequest(url);
        const r = await s.context.request.get(url, { timeout: 30000 });
        if (!r.ok()) throw new Error('图片素材下载失败，请重新上传');
        if (!r.headers()['content-type']?.startsWith('image/'))
          throw new Error('素材地址返回的不是图片');
        buffer = await r.body();
      } else throw new Error('演示素材不能用于真实发布，请上传自己的图片');
      if (buffer.length > 10 * 1024 * 1024) throw new Error('图片超过10MB');
      const ext = buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        ? 'png'
        : buffer.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
          ? 'jpg'
          : buffer.toString('ascii', 8, 12) === 'WEBP'
            ? 'webp'
            : null;
      if (!ext) throw new Error('真实发布仅接受PNG、JPEG、WebP素材');
      const path = join(folder, `${i + 1}.${ext}`);
      await writeFile(path, buffer, { mode: 0o600 });
      paths.push(path);
    }
  }
  const file = page
    .locator(
      draft.kind === 'video'
        ? 'input[type=file][accept*="video"]'
        : 'input[type=file][accept*="image"]',
    )
    .first();
  const target = (await file.count()) ? file : page.locator('input[type=file]').first();
  await target.setInputFiles(paths, { timeout: 30000 });
  if (platform === 'douyin' && draft.kind !== 'video') {
    await page
      .getByText(new RegExp('已添加\\s*' + paths.length + '\\s*张图片'))
      .waitFor({ state: 'visible', timeout: 90000 });
    const cover = page.getByText('编辑封面', { exact: true }).first();
    await cover.waitFor({ state: 'visible', timeout: 30000 });
    await cover.click();
    await delay(500);
    const complete = page.getByRole('button', { name: '确定', exact: true });
    await complete.waitFor({ state: 'visible', timeout: 45000 });
    await page.waitForFunction(
      () =>
        [...document.images].some(
          (i) => i.complete && i.naturalWidth > 0 && i.getBoundingClientRect().height > 200,
        ) || [...document.querySelectorAll('canvas')].some((c) => c.width > 200 && c.height > 200),
      undefined,
      { timeout: 20000 },
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      await complete.click();
      await page
        .waitForURL((u) => !u.pathname.includes('/publish/poster'), { timeout: 8000 })
        .catch(() => {});
      if (!page.url().includes('/publish/poster')) break;
    }
    if (page.url().includes('/publish/poster'))
      throw new Error('抖音封面尚未保存完成，请检查封面编辑器提示');
  }
  const title = page
    .locator(
      'input[placeholder*="标题"],textarea[placeholder*="标题"],input[placeholder*="作品名称"]',
    )
    .first();
  await title.waitFor({ state: 'visible', timeout: 90000 });
  await title.fill(draft.title);
  const editor = page
    .locator(
      '[contenteditable=true],textarea[placeholder*="正文"],textarea[placeholder*="介绍"],textarea[placeholder*="描述"]',
    )
    .first();
  if (draft.body && !(await editor.count()))
    throw new Error('平台正文编辑器尚未就绪，已停止准备，避免漏发正文');
  if (await editor.count()) {
    await editor.fill(draft.body);
    const entered = await editorText(editor);
    if (draft.body && !entered.replace(/\u200b/g, '').includes(draft.body))
      throw new Error('平台正文与草稿不一致，已停止准备');
    for (const tag of draft.tags) {
      await editor.press('End');
      await editor.press('Enter');
      await editor.pressSequentially('#' + tag, { delay: 50 });
      await delay(500);
      const suggestion = page.getByText(tag, { exact: true }).last();
      if (await suggestion.isVisible().catch(() => false)) await suggestion.click();
      else await editor.press('Space');
    }
  }
  if (platform === 'douyin') {
    const privateLabel = page
      .locator('label')
      .filter({ hasText: draft.visibility === 'private' ? '仅自己可见' : /^公开$/ })
      .first();
    await privateLabel.click({ timeout: 10000 });
    if ((await privateLabel.getAttribute('data-checked')) !== 'true')
      throw new Error('未确认抖音可见范围设置，已停止发布');
  } else if (draft.visibility === 'private') {
    let changed = false;
    const option = page
      .getByText(/^(仅自己可见|仅自己|私密)$/)
      .and(page.locator(':visible'))
      .first();
    if (await option.isVisible().catch(() => false)) {
      await option.click();
      changed = true;
    } else {
      for (const label of ['公开可见', '公开', '谁可以看', '权限设置']) {
        const control = page
          .getByText(label, { exact: true })
          .and(page.locator(':visible'))
          .first();
        if (await control.isVisible().catch(() => false)) {
          await control.click();
          await delay(300);
          if (await option.isVisible().catch(() => false)) {
            await option.click();
            changed = true;
            break;
          }
        }
      }
    }
    if (!changed) throw new Error('没有找到仅自己可见的设置，已停止，不会改为公开发布');
  } else {
    const privateOption = page
      .getByText('仅自己可见', { exact: true })
      .and(page.locator(':visible'))
      .first();
    if (await privateOption.isVisible().catch(() => false)) await privateOption.click();
    const publicOption = page
      .getByText(/^(公开可见|公开)$/)
      .and(page.locator(':visible'))
      .first();
    if (!(await publicOption.isVisible().catch(() => false)))
      throw new Error('未确认小红书公开范围，请检查官方编辑器');
    await publicOption.click();
  }
  const guide = page.getByRole('button', { name: '我知道了', exact: true });
  if (await guide.count()) await guide.click({ timeout: 5000 }).catch(() => {});
  await submitControl(page);
  prepared.set(draft.id, {
    draftId: draft.id,
    fingerprint: fingerprint(draft),
    page,
    platform,
    accountId: draft.accountId,
  });
  put('publish-attempts', {
    id: draft.id,
    status: 'prepared',
    platform,
    preparedAt: new Date().toISOString(),
    fingerprint: fingerprint(draft),
  });
  return {
    status: 'prepared',
    url: page.url(),
    message: '素材和文案已填入平台编辑器，请核对内容与可见范围',
  };
}
export async function publishNative(draft: Draft) {
  const previous = get<any>('publish-attempts', draft.id);
  if (previous?.status === 'published' && previous.fingerprint === fingerprint(draft))
    return previous.receipt;
  if (previous && ['submitting', 'uncertain'].includes(previous.status))
    throw new Error('该作品已经提交过，请先到平台确认结果，避免重复发布');
  let p = prepared.get(draft.id);
  if (!p || p.page.isClosed() || p.fingerprint !== fingerprint(draft)) {
    await preparePublish(draft);
    p = prepared.get(draft.id)!;
  }
  const session = await requireSession(p.platform);
  if (draft.accountId !== `browser:${p.platform}:${session.state.accountId}`)
    throw new Error('发布账号已变化，已停止提交');
  const liveTitle = p.page.locator('input[placeholder*="标题"]').first();
  if ((await liveTitle.inputValue()) !== draft.title)
    throw new Error('官方页面标题已变化，请重新预览核对后发布');
  const liveEditor = p.page
    .locator(
      '[contenteditable=true],textarea[placeholder*="正文"],textarea[placeholder*="介绍"],textarea[placeholder*="描述"]',
    )
    .first();
  if (
    draft.body &&
    (!(await liveEditor.count()) ||
      !(await editorText(liveEditor)).replace(/\u200b/g, '').includes(draft.body))
  )
    throw new Error('官方页面正文已变化，请重新预览核对后发布');
  if (p.platform === 'douyin') {
    const selected = p.page
      .locator('label')
      .filter({ hasText: draft.visibility === 'private' ? '仅自己可见' : /^公开$/ })
      .first();
    if ((await selected.getAttribute('data-checked')) !== 'true')
      throw new Error('官方页面可见范围已变化，请重新预览核对后发布');
  }
  let receipt: { id: string; url: string } | undefined;
  let failure = '';
  let accepted = false;
  const responseMetadata: unknown[] = [];
  const uiMessages = new Set<string>();
  const scriptErrors: string[] = [];
  const onPageError = (e: Error) => scriptErrors.push(e.message.slice(0, 300));
  p.page.on('pageerror', onPageError);
  const observe = async (r: Response) => {
    if (
      r.request().method() !== 'POST' ||
      !(/publish|create/.test(r.url()) || /\/web_api\/sns\/v\d+\/note(?:\?|$)/.test(r.url())) ||
      /(?:upload|cover|precheck|check|config|limit_app_groups)(?:\/|\b)/.test(
        new URL(r.url()).pathname,
      )
    )
      return;
    try {
      const body = parsePlatformJSON(await r.text());
      responseMetadata.push({
        path: new URL(r.url()).pathname,
        status: r.status(),
        keys: Object.keys(body),
        dataKeys: body.data && typeof body.data === 'object' ? Object.keys(body.data) : [],
        code: body.code ?? body.status_code,
      });
      if (
        body.success === false ||
        (typeof body.status_code === 'number' && body.status_code !== 0) ||
        (typeof body.code === 'number' && body.code !== 0)
      ) {
        failure = '平台发布接口未接受本次提交';
        return;
      }
      const d = body.data || body;
      const id =
        d.note_id ||
        d.noteId ||
        d.aweme_id ||
        d.item_id ||
        d.itemId ||
        d.note?.id ||
        d.aweme?.aweme_id ||
        d.aweme?.item_id ||
        d.id;
      if (id) {
        receipt = {
          id: String(id),
          url:
            p!.platform === 'xiaohongshu'
              ? `https://www.xiaohongshu.com/explore/${id}`
              : `https://www.douyin.com/${draft.kind === 'video' ? 'video' : 'note'}/${id}`,
        };
      }
      if (
        (body.success === true || body.code === 0 || body.status_code === 0) &&
        (/\/web_api\/sns\/v\d+\/note(?:\?|$)/.test(r.url()) ||
          /\/media\/aweme\/create/.test(r.url()))
      )
        accepted = true;
    } catch {}
  };
  p.page.on('response', observe);
  const control = await submitControl(p.page);
  const controlLabel = 'textContent' in control ? await control.textContent() : '小红书发布组件';
  put('publish-attempts', {
    id: draft.id,
    status: 'submitting',
    controlLabel,
    platform: p.platform,
    fingerprint: p.fingerprint,
    submittedAt: new Date().toISOString(),
  });
  try {
    const baseline = new Set(
      (await p.page.locator('body').innerText()).split('\n').map((s) => s.trim()),
    );
    await control.click();
    for (let i = 0; i < 120 && !receipt && !failure; i++) {
      await delay(500);
      const current = await p.page
        .locator('body')
        .innerText()
        .catch(() => '');
      for (const line of current.split('\n').map((s) => s.trim()))
        if (line && !baseline.has(line) && uiMessages.size < 40) uiMessages.add(line.slice(0, 300));
      if (
        /验证码|短信验证|安全验证/.test(
          await p.page
            .locator('body')
            .innerText()
            .catch(() => ''),
        )
      ) {
        failure = '平台要求本人验证，请在发布浏览器中处理；请先核对是否已经提交';
        break;
      }
    }
    if (!receipt) {
      const anchors = await p.page
        .locator('a[href*="/explore/"],a[href*="/video/"],a[href*="/note/"]')
        .evaluateAll((a) =>
          a.map((x) => ({ href: (x as HTMLAnchorElement).href, text: x.textContent || '' })),
        );
      const link = anchors.find((x) => x.text.includes(draft.title));
      if (link) {
        const id = link.href.match(/\/(?:explore|video|note)\/([a-zA-Z0-9]+)/)?.[1];
        if (id) receipt = { id, url: link.href };
      }
    }
    if (!receipt) {
      put('publish-attempts', {
        id: draft.id,
        status: 'uncertain',
        platform: p.platform,
        fingerprint: p.fingerprint,
        accepted,
        uiMessages: [...uiMessages],
        scriptErrors,
        responseMetadata,
        message: failure || '平台未返回可核对的内容ID/URL，请在平台作品管理中确认',
      });
      throw new Error(
        failure ||
          (accepted
            ? '平台已接受提交，但尚未取得作品URL，已阻止自动重试以免重复发布'
            : '未取得平台发布回执，请检查发布页；没有标记为成功'),
      );
    }
    put('publish-attempts', {
      id: draft.id,
      status: 'published',
      responseMetadata,
      platform: p.platform,
      fingerprint: p.fingerprint,
      receipt,
      publishedAt: new Date().toISOString(),
    });
    return receipt;
  } finally {
    p.page.off('response', observe);
    p.page.off('pageerror', onPageError);
  }
}

export async function reconcilePublish(draft: Draft) {
  const previous = get<any>('publish-attempts', draft.id);
  if (previous?.status === 'published') return previous;
  const session = await requireSession(draft.platform || 'xiaohongshu');
  if (draft.accountId !== `browser:${draft.platform || 'xiaohongshu'}:${session.state.accountId}`)
    throw new Error('当前账号与待核对作品不一致');
  const page = await session.context.newPage();
  const lists: any[] = [];
  const endpoints: string[] = [];
  page.on('response', async (r) => {
    if (!/note|aweme|item|work/.test(r.url()) || !/list|posted|manager|aweme\/post/.test(r.url()))
      return;
    try {
      const d = parsePlatformJSON(await r.text());
      lists.push(d);
      endpoints.push(new URL(r.url()).pathname);
    } catch {}
  });
  await page.goto(
    draft.platform === 'douyin'
      ? 'https://creator.douyin.com/creator-micro/content/upload'
      : 'https://creator.xiaohongshu.com/publish/publish?source=official',
    { waitUntil: 'domcontentloaded', timeout: 45000 },
  );
  if (draft.platform === 'douyin') {
    const menu = page.getByText('内容管理', { exact: true }).first();
    await menu.waitFor({ state: 'visible', timeout: 20000 });
    await menu.click();
  }
  if (draft.platform !== 'douyin')
    await page.getByText('笔记管理', { exact: true }).first().click({ timeout: 15000 });
  await delay(1000);
  if (draft.platform === 'douyin')
    await page
      .getByText('没有更多作品', { exact: true })
      .waitFor({ state: 'visible', timeout: 20000 })
      .catch(() => {});
  await page.bringToFront();
  function find(x: any): any {
    if (!x || typeof x !== 'object') return null;
    if (
      (x.title === draft.title ||
        x.display_title === draft.title ||
        x.item_title?.includes(draft.title) ||
        (draft.platform === 'douyin' &&
          typeof x.desc === 'string' &&
          x.desc.replace(/[。.!！\s]+$/u, '') === draft.title.replace(/[。.!！\s]+$/u, '') &&
          Number(x.create_time) * 1000 >= Date.parse(draft.createdAt) - 60000 &&
          (draft.visibility !== 'private' || x.status?.is_private === true)) ||
        x.desc === draft.body ||
        (typeof x.desc === 'string' &&
          x.desc.startsWith(draft.title) &&
          x.desc.includes(draft.body))) &&
      (x.note_id || x.id || x.aweme_id || x.item_id)
    )
      return x;
    for (const v of Object.values(x)) {
      if (typeof v === 'object') {
        const n = Array.isArray(v) ? v.map(find).find(Boolean) : find(v);
        if (n) return n;
      }
    }
    return null;
  }
  const found = lists.map(find).find(Boolean);
  if (found) {
    const id = String(found.note_id || found.aweme_id || found.item_id || found.id);
    const receipt = {
      id,
      url:
        draft.platform === 'douyin'
          ? `https://www.douyin.com/${draft.kind === 'video' ? 'video' : 'note'}/${id}`
          : `https://www.xiaohongshu.com/explore/${id}`,
    };
    put('publish-attempts', {
      ...previous,
      id: draft.id,
      status: 'published',
      fingerprint: fingerprint(draft),
      receipt,
      publishedAt: new Date().toISOString(),
      reconciled: true,
    });
    return { status: 'published', receipt };
  }
  const text = await page.locator('body').innerText();
  const empty = /暂无笔记|还没有发布过笔记|暂无作品|暂无相关笔记|暂无内容|还没有作品/.test(text);
  if (
    !text.includes(draft.title) &&
    (lists.some(
      (d) =>
        (d.success === true && d.data?.page === -1 && Array.isArray(d.data?.notes)) ||
        (draft.platform === 'douyin' &&
          d.status_code === 0 &&
          d.has_more === 0 &&
          Array.isArray(d.aweme_list)),
    ) ||
      (empty && lists.length) ||
      (draft.platform === 'douyin' &&
        page.url().includes('/content/manage') &&
        text.includes('没有更多作品') &&
        !text.includes(draft.title)))
  ) {
    put('publish-attempts', {
      ...previous,
      id: draft.id,
      status: 'not_submitted',
      fingerprint: fingerprint(draft),
      checkedAt: new Date().toISOString(),
    });
    return {
      status: 'not_submitted',
      message: '官方全部作品列表已加载完，未发现本次测试稿，可以重新准备发布',
      endpoints,
    };
  }
  return {
    status: 'uncertain',
    message: '已打开官方作品管理，仍未取得足够证据确认发布结果',
    text: text.slice(0, 2500),
    endpoints,
  };
}
