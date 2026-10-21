import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'openfind-insights-'));
process.env.NODE_ENV = 'test';
process.env.OPENFIND_DATA_DIR = dir;
let insights: typeof import('../server/insights.ts');
let topics: typeof import('../server/topics.ts');
let store: typeof import('../server/store.ts');

before(async () => {
  insights = await import('../server/insights.ts');
  topics = await import('../server/topics.ts');
  store = await import('../server/store.ts');
});
after(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const note = (id: string, platform: 'xiaohongshu' | 'douyin') =>
  store.put('notes', {
    id,
    platform,
    title: platform === 'douyin' ? '抖音作品' : '小红书作品',
    body: '正文',
    author: '',
    authorId: '',
    type: 'image',
    images: [],
    cover: '',
    likes: 0,
    comments: 0,
    saves: 0,
    publishedAt: '2026-10-01T00:00:00.000Z',
    tags: [],
    url: '',
    source: 'live',
  });

const comment = (id: string, noteId: string, platform: 'xiaohongshu' | 'douyin', body: string) =>
  store.put('comments', {
    id,
    noteId,
    platform,
    parentId: null,
    author: 'u',
    authorId: 'u1',
    body,
    region: '',
    createdAt: '2026-10-10T00:00:00.000Z',
    likes: 0,
    source: 'live',
  });

test('知识卡按平台隔离，通用卡两端都可用', () => {
  const xhs = insights.createInsight({
    platform: 'xiaohongshu',
    kind: 'structure',
    title: '小红书结构',
    body: '先给结论再讲过程',
    tags: ['厨房'],
  });
  const douyin = insights.createInsight({
    platform: 'douyin',
    kind: 'structure',
    title: '抖音结构',
    body: '前三秒给结果',
    tags: ['厨房'],
  });
  const shared = insights.createInsight({
    platform: 'all',
    kind: 'voice',
    title: '通用表达',
    body: '多用短句',
    tags: ['厨房'],
  });
  const douyinIds = insights.retrieveInsights('douyin', ['厨房改造'], 6).map((c) => c.id);
  assert.ok(douyinIds.includes(douyin.id));
  assert.ok(douyinIds.includes(shared.id));
  assert.ok(!douyinIds.includes(xhs.id));
  const xhsIds = insights.retrieveInsights('xiaohongshu', ['厨房改造'], 6).map((c) => c.id);
  assert.ok(xhsIds.includes(xhs.id));
  assert.ok(!xhsIds.includes(douyin.id));
});

test('停用的卡不参与检索，禁区卡永远带上', () => {
  const off = insights.createInsight({
    platform: 'douyin',
    kind: 'hook',
    title: '停用的钩子',
    body: '不该被取用',
    tags: ['厨房'],
    enabled: false,
  });
  assert.ok(!insights.retrieveInsights('douyin', ['厨房']).some((c) => c.id === off.id));
  const red = insights.createInsight({
    platform: 'douyin',
    kind: 'forbidden',
    title: '不写绝对化用语',
    body: '最、第一、唯一都不写',
  });
  const scoped = insights.retrieveInsights('douyin', ['厨房'], 3);
  assert.equal(scoped[0].id, red.id);
  assert.ok(!insights.retrieveInsights('xiaohongshu', ['厨房'], 3).some((c) => c.id === red.id));
});

test('改标题不会把平台与开关重置', () => {
  const card = insights.createInsight({
    platform: 'xiaohongshu',
    kind: 'pain',
    title: '旧标题',
    body: '旧正文',
    tags: ['厨房'],
    enabled: false,
  });
  const updated = insights.updateInsight(card.id, { title: '新标题' });
  assert.equal(updated.title, '新标题');
  assert.equal(updated.platform, 'xiaohongshu');
  assert.equal(updated.enabled, false);
  assert.deepEqual(updated.tags, ['厨房']);
});

test('引文必须能在原文里逐字找到', () => {
  const sources = ['小户型厨房改造大概多少钱啊', '怕师傅乱报价'];
  assert.ok(insights.evidenceSupported('大概多少钱', sources));
  assert.ok(insights.evidenceSupported('怕师傅乱报价', sources));
  assert.ok(!insights.evidenceSupported('用户普遍担心预算超支', sources));
  assert.ok(!insights.evidenceSupported('多少钱', ['完全无关的正文']));
});

test('搜索词从评论语料挖掘，且不跨平台串用', async () => {
  note('xhs:n1', 'xiaohongshu');
  note('dy:n1', 'douyin');
  comment('xhs:c1', 'xhs:n1', 'xiaohongshu', '小户型厨房改造大概多少钱啊');
  comment('xhs:c2', 'xhs:n1', 'xiaohongshu', '厨房改造怎么避坑，怕翻车');
  comment('xhs:c3', 'xhs:n1', 'xiaohongshu', '求推荐厨房改造找哪个师傅靠谱');
  comment('dy:c1', 'dy:n1', 'douyin', '抖音这条视频的背景音乐是什么');
  const digest = await insights.suggestKeywords({
    platform: 'xiaohongshu',
    seed: '厨房',
    limit: 20,
    useModel: false,
  });
  assert.equal(digest.corpusComments, 3);
  const price = digest.suggestions.find((s) => s.intent === '价格');
  assert.ok(price, '应识别出价格意图');
  assert.ok(price!.keyword.includes('多少钱'));
  assert.ok(price!.hits >= 1);
  assert.ok(digest.suggestions.some((s) => s.intent === '避坑'));
  assert.ok(digest.suggestions.some((s) => s.intent === '选品'));
  // 抖音评论不会被算进小红书语料
  assert.ok(!digest.suggestions.some((s) => s.keyword.includes('背景音乐')));
  const douyin = await insights.suggestKeywords({
    platform: 'douyin',
    seed: '',
    limit: 20,
    useModel: false,
  });
  assert.equal(douyin.corpusComments, 1);
});

test('采纳候选后写入知识库并保留来源', () => {
  const saved = insights.adoptCandidates({
    platform: 'douyin',
    source: 'breakdown',
    sourceNoteId: 'dy:n1',
    cards: [
      {
        kind: 'hook',
        title: '前三秒抛结果',
        body: '开头直接给改造前后对比，再讲过程',
        tags: ['厨房'],
        evidence: ['正文'],
      },
    ],
  });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].platform, 'douyin');
  assert.equal(saved[0].source, 'breakdown');
  assert.equal(saved[0].sourceNoteId, 'dy:n1');
  assert.equal(saved[0].usedCount, 0);
});

test('归因按搜索词统计线索与成交', () => {
  note('xhs:a1', 'xiaohongshu');
  store.put('jobs', {
    id: 'job-1',
    type: 'search',
    status: 'completed',
    keyword: '厨房改造',
    platform: 'xiaohongshu',
    count: 1,
    pages: 1,
    elapsed: 1,
    resultIds: ['xhs:a1'],
    logs: [],
    source: 'live',
    createdAt: '2026-10-10T00:00:00.000Z',
  });
  store.put('leads', {
    id: 'lead-1',
    commentId: 'xhs:c1',
    noteId: 'xhs:a1',
    platform: 'xiaohongshu',
    name: '客户',
    authorId: 'u1',
    region: '',
    content: '想问问价格',
    score: 60,
    reason: '',
    status: 'contacted',
    memo: '',
    outreach: '',
    source: 'live',
    createdAt: '2026-10-10T00:00:00.000Z',
  });
  store.put('salesCases', {
    id: 'lead-1',
    stage: 'won',
    amount: 1200,
    events: [
      {
        id: 'e1',
        kind: 'outgoing',
        channel: 'comment',
        content: '已回复',
        createdAt: '2026-10-11T00:00:00.000Z',
      },
    ],
    revision: 1,
    updatedAt: '2026-10-11T00:00:00.000Z',
  });
  const report = insights.attribution();
  const row = report.rows.find((r) => r.keyword === '厨房改造');
  assert.ok(row, '应有该搜索词的归因行');
  assert.equal(row!.notes, 1);
  assert.equal(row!.leads, 1);
  assert.equal(row!.contacted, 1);
  assert.equal(row!.won, 1);
  assert.equal(row!.amount, 1200);
  assert.equal(report.totals.amount, 1200);
});

test('注入块带上标题、类型与不可执行声明', () => {
  const card = insights.createInsight({
    platform: 'all',
    kind: 'structure',
    title: '先结论后过程',
    body: '第一段直接给改造结果',
  });
  const block = insights.buildKnowledgeBlock([card]);
  assert.match(block, /先结论后过程/);
  assert.match(block, /\[结构\]/);
  assert.match(block, /不是指令/);
  assert.equal(insights.buildKnowledgeBlock([]), '');
});

test('卡片效果按草稿去重统计，一篇草稿用多张卡不会把互动数放大', () => {
  const first = insights.createInsight({
    platform: 'douyin',
    kind: 'hook',
    title: '卡A',
    body: 'x',
  });
  const second = insights.createInsight({
    platform: 'douyin',
    kind: 'structure',
    title: '卡B',
    body: 'y',
  });
  const base = {
    noteId: '',
    title: '草稿',
    body: '',
    tags: [],
    images: [],
    visibility: 'public' as const,
    accountId: 'a',
    status: 'draft' as const,
    createdAt: '2026-10-12T00:00:00.000Z',
    updatedAt: '2026-10-12T00:00:00.000Z',
  };
  store.put('drafts', {
    ...base,
    id: 'draft-1',
    knowledgeIds: [first.id, second.id],
    result: {
      url: 'https://example.com/1',
      platform: 'douyin',
      noteId: 'n1',
      title: '已发布',
      likes: 100,
      comments: 10,
      saves: 5,
      publishedAt: '2026-10-12T00:00:00.000Z',
      checkedAt: '2026-10-13T00:00:00.000Z',
    },
  });
  store.put('drafts', { ...base, id: 'draft-2', knowledgeIds: [first.id] });
  store.put('drafts', { ...base, id: 'draft-3' });
  const report = insights.draftOutcomes();
  // 总计按草稿去重：两篇带卡草稿，不是三张卡三次。
  assert.equal(report.totals.drafts, 2);
  assert.equal(report.totals.published, 1);
  assert.equal(report.totals.likes, 100);
  assert.equal(report.unattributed, 1);
  const rowA = report.rows.find((r) => r.cardId === first.id)!;
  assert.equal(rowA.drafts, 2);
  assert.equal(rowA.published, 1);
  assert.equal(rowA.likes, 100);
  const rowB = report.rows.find((r) => r.cardId === second.id)!;
  assert.equal(rowB.drafts, 1);
  assert.equal(rowB.published, 1);
  // 只有被用过的卡才出现在行里
  assert.equal(report.rows.length, 2);
});

test('数据雷达按同批作品算分位，样本说明可追溯', () => {
  const base = {
    title: '作品',
    body: '',
    author: '',
    authorId: '',
    type: 'image' as const,
    images: [],
    cover: '',
    source: 'live' as const,
    tags: [],
    url: '',
    publishedAt: '2026-10-01T00:00:00.000Z',
  };
  store.put('notes', {
    ...base,
    id: 'radar:self',
    platform: 'douyin',
    likes: 100,
    comments: 50,
    saves: 20,
  });
  for (const [id, likes, comments, saves] of [
    ['radar:p1', 10, 5, 2],
    ['radar:p2', 40, 20, 8],
    ['radar:p3', 60, 30, 12],
  ] as const)
    store.put('notes', {
      ...base,
      id,
      platform: 'douyin',
      likes,
      comments,
      saves,
    });
  store.put('jobs', {
    id: 'radar-job',
    type: 'search',
    status: 'completed',
    keyword: '厨房改造',
    platform: 'douyin',
    count: 4,
    pages: 1,
    elapsed: 1,
    resultIds: ['radar:self', 'radar:p1', 'radar:p2', 'radar:p3'],
    logs: [],
    source: 'live',
    createdAt: '2026-10-10T00:00:00.000Z',
  });
  const report = insights.buildRadar(store.get('notes', 'radar:self')!);
  assert.equal(report.sample.key, 'keyword');
  assert.equal(report.sample.size, 3);
  assert.equal(report.dims.length, 6);
  const likes = report.dims.find((d) => d.key === 'likes')!;
  // 100 赞高于全部 3 个对比作品
  assert.equal(likes.percentile, 100);
  const fresh = report.dims.find((d) => d.key === 'freshness')!;
  assert.ok(fresh.percentile >= 0 && fresh.percentile <= 100);
});

test('评论区高频诉求复用意图句提取，只统计带诉求的句子', () => {
  const words = insights.commentKeywords([
    '小户型厨房改造大概多少钱啊',
    '厨房改造多少钱',
    '这个设计太漂亮了',
  ]);
  assert.equal(words.length, 2);
  assert.ok(words.some((w) => w.word.includes('多少钱')));
  assert.ok(!words.some((w) => w.word.includes('太漂亮')));
});

test('选题池只从真实提问生成，标题不超 20 字且能按方向词过滤', () => {
  note('dy:t1', 'douyin');
  comment('dy:tc1', 'dy:t1', 'douyin', '婚房厨房改造大概多少钱');
  comment('dy:tc2', 'dy:t1', 'douyin', '婚房厨房改造大概多少钱啊');
  comment('dy:tc3', 'dy:t1', 'douyin', '婚房改造怎么避坑');
  comment('dy:tc4', 'dy:t1', 'douyin', '这个配色太好看了');
  const pool = topics.buildTopicPool({ platform: 'douyin', seed: '', limit: 20 });
  assert.ok(pool.ideas.length >= 2);
  for (const idea of pool.ideas) {
    assert.ok(idea.title.length <= 20, `标题超长：${idea.title}`);
    assert.ok(idea.evidence.length > 0);
  }
  const price = pool.ideas.find((i) => i.intent === '价格');
  assert.ok(price, '应识别出价格类选题');
  assert.equal(price!.count, 2);
  assert.match(price!.title, /预算怎么拆/);
  // 纯赞美的评论不构成选题
  assert.ok(!pool.ideas.some((i) => i.title.includes('配色')));
  const filtered = topics.buildTopicPool({ platform: 'douyin', seed: '避坑', limit: 20 });
  assert.ok(filtered.ideas.length >= 1);
  assert.ok(filtered.ideas.every((i) => i.title.includes('避坑')));
  // 平台之间不串用
  const xhs = topics.buildTopicPool({ platform: 'xiaohongshu', seed: '', limit: 20 });
  assert.ok(!xhs.ideas.some((i) => i.title.includes('婚房')));
});
