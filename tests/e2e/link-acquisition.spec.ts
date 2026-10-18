import { openDouyinComments } from '../../server/platforms/comment-panel';
import { resolveWorkRedirects } from '../../server/platforms/work-redirects';
import { test, expect } from '@playwright/test';
import { readLinkedWork } from '../../server/platforms/linked-work-page';
import { parseWorkLink } from '../../shared/work-links';
import { toLead } from '../../server/domain';
import type { AcquisitionWorkflow, Note, Comment } from '../../shared/types';
const xhs = 'abcdef0123456789abcdef01',
  dy = '7654321098765432109';
test('Official short-link redirects retain signed work identity and read the actual page hydration', async ({
  page,
  context,
}) => {
  const url = `https://www.xiaohongshu.com/explore/${xhs}?xsec_token=test-signature`;
  await context.route('https://xhslink.com/**', (r) =>
    r.fulfill({ status: 302, headers: { location: url } }),
  );
  await context.route('https://www.xiaohongshu.com/**', (r) =>
    r.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<html><body>花瓶作品<script>window.__INITIAL_STATE__={note:{noteDetailMap:{'${xhs}':{note:{noteId:'${xhs}',title:'花瓶作品',desc:'桌面花瓶',user:{userId:'controlled-creator',nickname:'测试创作者'},interactInfo:{commentCount:2}}}}}};</script></body></html>`,
    }),
  );
  const target = await resolveWorkRedirects(
    parseWorkLink('https://xhslink.com/a/test'),
    async () => ({ status: 302, location: url }),
  );
  const note = await readLinkedWork(page, target);
  expect(note.nativeId).toBe(xhs);
  expect(note.authorId).toBe('controlled-creator');
  expect(note.url).toContain('xsec_token=test-signature');
  expect(note.source).toBe('live');
});
test('Douyin URL reader extracts the specified work, not recommendations', async ({
  page,
  context,
}) => {
  await context.route('https://www.douyin.com/**', (r) =>
    r.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<html><body>作品详情<script>window._ROUTER_DATA={loaderData:{page:{items:[{aweme_id:'1111111111111111111',author:{sec_uid:'wrong'},desc:'无关作品'},{aweme_id:'${dy}',author:{sec_uid:'controlled-creator',nickname:'测试创作者'},desc:'花瓶作品',statistics:{comment_count:3}}]}}};</script></body></html>`,
    }),
  );
  const note = await readLinkedWork(page, parseWorkLink('https://www.douyin.com/video/' + dy));
  expect(note.nativeId).toBe(dy);
  expect(note.body).toBe('花瓶作品');
});
test('Douyin image detail reads public rendered props without reading authentication fields', async ({
  page,
  context,
}) => {
  await context.route('https://www.douyin.com/**', (r) =>
    r.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<html><body><div id="work">花瓶图文</div><script>
  const work={awemeId:'${dy}',desc:'真实图文详情',createTime:1791942847,authorInfo:{secUid:'image-creator',nickname:'图文作者'},stats:{commentCount:5},images:[{urlList:['https://example.com/image.jpg']}]};
  Object.defineProperty(work,'authenticationToken',{get(){throw Error('must not read authentication')}});
  document.getElementById('work').__reactFiberTest={memoizedProps:{awemeInfo:work}};
  </script></body></html>`,
    }),
  );
  const note = await readLinkedWork(page, parseWorkLink('https://www.douyin.com/note/' + dy));
  expect(note.authorId).toBe('image-creator');
  expect(note.type).toBe('image');
  expect(note.comments).toBe(5);
  expect(note.body).toBe('真实图文详情');
});
test('Douyin image comment tab loads actual comment responses, and video action remains supported', async ({
  page,
}) => {
  await page.route('https://www.douyin.com/**', (r) =>
    r.fulfill({ json: { comments: [], has_more: false } }),
  );
  await page.setContent(
    `<div>相关推荐</div><div onclick="fetch('https://www.douyin.com/aweme/v1/web/comment/list/?aweme_id=${dy}')">评论(12)</div>`,
  );
  const received = page.waitForResponse((r) => r.url().includes('/comment/list/'));
  await openDouyinComments(page);
  expect((await received).status()).toBe(200);
  await page.setContent(
    '<button data-e2e="comment-icon" onclick="this.textContent=\'评论已打开\'">评论</button>',
  );
  await openDouyinComments(page);
  await expect(page.getByRole('button')).toHaveText('评论已打开');
});
test('External redirect and CAPTCHA stop work reading even when page metadata is present', async ({
  page,
  context,
}) => {
  let localReached = false;
  await context.route('http://127.0.0.1/**', (r) => {
    localReached = true;
    return r.fulfill({ body: 'private' });
  });
  await expect(
    resolveWorkRedirects(parseWorkLink('https://v.douyin.com/test/'), async () => ({
      status: 302,
      location: 'http://127.0.0.1/private',
    })),
  ).rejects.toThrow(/非平台官方/);
  expect(localReached).toBe(false);
  await page.unroute('**/*');
  await context.route('https://www.douyin.com/**', (r) =>
    r.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: '<div class="captcha_verify_container">请完成验证</div>',
    }),
  );
  await expect(
    readLinkedWork(page, parseWorkLink('https://www.douyin.com/video/' + dy)),
  ).rejects.toThrow(/本人完成安全验证/);
});
test('Paste-link UI explains batch limits, rejects mixed platforms and displays scoped comments and candidates after reload', async ({
  page,
}) => {
  let created = false,
    submits = 0;
  const note: Note = {
    id: 'dy:' + dy,
    nativeId: dy,
    platform: 'douyin',
    title: '受控花瓶作品',
    body: '桌面花瓶',
    author: '测试创作者',
    authorId: 'creator',
    source: 'live',
    url: 'https://www.douyin.com/video/' + dy,
    type: 'video',
    images: [],
    cover: '',
    likes: 3,
    comments: 1,
    saves: 0,
    tags: [],
    publishedAt: '',
  };
  const c: Comment = {
    id: 'controlled-comment',
    noteId: note.id,
    platform: 'douyin',
    parentId: null,
    author: '受控测试用户',
    authorId: 'controlled-user',
    body: '花瓶在哪里买，多少钱？',
    region: '',
    createdAt: new Date().toISOString(),
    likes: 0,
    source: 'live',
  };
  const lead = toLead(c, note, [c]);
  const flow: AcquisitionWorkflow = {
    id: 'controlled-link-flow',
    input: {
      keyword: '指定链接（1篇）',
      platform: 'douyin',
      mode: 'live',
      links: [note.url],
      searchLimit: 1,
      maxNotes: 1,
      commentLimit: 20,
      supplement: false,
    },
    status: 'completed',
    stage: 'done',
    searchIndex: 0,
    searchJobIds: [],
    noteIds: [note.id],
    selectedNoteIds: [note.id],
    completedNoteIds: [note.id],
    commentIds: [c.id],
    leadIds: [lead.id],
    message: '指定作品采集完成',
    logs: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await page.route('**/api/state', async (r) => {
    const response = await r.fetch();
    const d = await response.json();
    if (created) {
      d.workflows = [flow, ...d.workflows.filter((w: any) => w.id !== flow.id)];
      d.notes.push(note);
      d.comments.push(c);
      d.leads.push(lead);
    }
    await r.fulfill({ json: d });
  });
  await page.route('**/api/workflows/links', (r) => {
    submits++;
    expect(r.request().postDataJSON()).toEqual({
      content: note.url + '\n' + note.url,
      commentLimit: 20,
    });
    created = true;
    return r.fulfill({ status: 201, json: flow });
  });
  await page.goto('/#acquisition');
  await page.getByRole('button', { name: '粘贴作品链接', exact: true }).click();
  await expect(page.getByText('推荐一次 3 条', { exact: false })).toContainText('最多 5 条');
  await page
    .getByLabel('作品链接', { exact: true })
    .fill(note.url + '\nhttps://xhslink.com/a/test');
  await expect(page.getByRole('alert')).toContainText('分开执行');
  await expect(page.getByRole('button', { name: '从链接一键获客', exact: true })).toBeDisabled();
  expect(submits).toBe(0);
  await page.getByLabel('作品链接', { exact: true }).fill(note.url + '\n' + note.url);
  await expect(page.getByText('已识别：', { exact: false })).toContainText('1 条作品链接');
  await page.getByRole('button', { name: '从链接一键获客', exact: true }).click();
  await expect(page.locator('.workflow-status')).toHaveText('已完成');
  await expect(page.locator('.workflow-leads')).toContainText(c.body);
  await expect(page.locator('.workflow-comment-list')).toContainText(c.body);
  expect(submits).toBe(1);
  await page.reload();
  await expect(page.locator('.workflow-leads')).toContainText(c.body);
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(() =>
    [...document.querySelectorAll('main *')]
      .filter((n) => n.getBoundingClientRect().right > 391)
      .map((n) => ({
        tag: n.tagName,
        class: n.className,
        text: n.textContent?.slice(0, 40),
        rect: {
          left: n.getBoundingClientRect().left,
          right: n.getBoundingClientRect().right,
          width: n.getBoundingClientRect().width,
        },
        parent: n.parentElement?.className,
        style: { margin: getComputedStyle(n).margin, flex: getComputedStyle(n).flex },
      }))
      .slice(0, 12),
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
    JSON.stringify(overflow),
  ).toBeLessThanOrEqual(391);
});
