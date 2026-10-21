import { test, expect } from '@playwright/test';

test('Collected works are separated by platform, source and collection topic; selection scopes comments', async ({
  page,
  request,
}) => {
  const state = await (await request.get('/api/state')).json();
  const template = state.notes[0];
  const notes = [
    {
      ...template,
      id: 'home',
      platform: 'xiaohongshu',
      source: 'demo',
      title: '沙发选购',
      author: '家居作者',
    },
    {
      ...template,
      id: 'research',
      platform: 'xiaohongshu',
      source: 'demo',
      title: '内容研究',
      author: '研究作者',
    },
    { ...template, id: 'dy', platform: 'douyin', source: 'demo', title: '抖音作品' },
    { ...template, id: 'live', platform: 'xiaohongshu', source: 'live', title: '真实作品' },
  ];
  const jobs = [
    {
      ...state.jobs.find((j: any) => j.type === 'search'),
      id: 'search-home',
      type: 'search',
      keyword: '家居',
      resultIds: ['home'],
    },
    {
      ...state.jobs.find((j: any) => j.type === 'search'),
      id: 'search-research',
      type: 'search',
      keyword: '研究',
      resultIds: ['research'],
    },
    {
      id: 'comments-home',
      type: 'comments',
      noteId: 'home',
      resultIds: ['comment-home'],
      status: 'completed',
      count: 1,
      logs: [],
    },
  ];
  await page.route('**/api/state', (route) =>
    route.fulfill({
      json: {
        ...state,
        notes,
        jobs,
        workflows: [],
        comments: [
          {
            ...state.comments[0],
            id: 'comment-home',
            noteId: 'home',
            body: '沙发的评论',
            source: 'demo',
            createdAt: new Date().toISOString(),
          },
        ],
      },
    }),
  );
  await page.goto('/#comments');
  await page.getByLabel('作品平台', { exact: true }).selectOption('xiaohongshu');
  await page.getByLabel('作品数据来源').selectOption('demo');
  await page.getByLabel('采集主题').selectOption('家居');
  await expect(page.locator('#comment-note option')).toHaveCount(2);
  await page.locator('#comment-note').selectOption('home');
  await expect(page.locator('.comment-row')).toContainText('沙发的评论');
  await page.getByLabel('采集主题').selectOption('研究');
  await page.locator('#comment-note').selectOption('research');
  await expect(page.locator('.comment-row')).toHaveCount(0);
  await page.getByLabel('搜索已采集作品').fill('不存在');
  await expect(page.getByText('当前分类没有匹配作品', { exact: false })).toBeVisible();
  await page.getByLabel('搜索已采集作品').fill('');
  await page.getByLabel('作品平台', { exact: true }).selectOption('douyin');
  await expect(page.locator('#comment-note option')).toHaveCount(2);
  await expect(page.locator('#comment-note')).toContainText('抖音作品');
});
