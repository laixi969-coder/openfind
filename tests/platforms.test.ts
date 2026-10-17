import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  xhsNotes,
  douyinNotes,
  platformComments,
  count,
  responseMore,
  parsePlatformJSON,
} from '../server/platforms/model.ts';
test('Platform numeric IDs remain exact beyond JavaScript integer precision', () => {
  const payload = parsePlatformJSON(
    '{"id":7999999999999999999,"count":42,"text":"7999999999999999999"}',
  );
  assert.equal(payload.id, '7999999999999999999');
  assert.equal(payload.count, 42);
  assert.equal(payload.text, '7999999999999999999');
});
test('Search decoration cards are excluded and missing comment dates stay unknown', () => {
  const notes = xhsNotes({
    data: {
      items: [
        { id: 'search-card', model_type: 'recommended_query' },
        { id: 'n1', model_type: 'note', note_card: { type: 'normal' } },
      ],
    },
  });
  assert.deepEqual(
    notes.map((n) => n.id),
    ['xhs:n1'],
  );
  assert.equal(notes[0].title, '未命名作品');
  const c = platformComments(
    'douyin',
    { comments: [{ cid: 'c', text: '多少钱', user: { uid: 'u' } }] },
    'n',
  )[0];
  assert.equal(c.createdAt, '');
});
test('XHS search and detail normalize real snake/camel fields and preserve signed URLs', () => {
  const n = xhsNotes({
    data: {
      items: [
        {
          id: 'note1',
          xsec_token: 'signed-token',
          note_card: {
            display_title: '真实笔记',
            type: 'normal',
            user: { user_id: 'u1', nickname: '用户' },
            cover: { url_default: 'https://cdn.example/cover.jpg' },
            interact_info: { liked_count: '1.2万', comment_count: '30', collected_count: '500' },
          },
        },
      ],
    },
  })[0];
  assert.equal(n.id, 'xhs:note1');
  assert.equal(n.likes, 12000);
  assert.equal(n.platform, 'xiaohongshu');
  assert.equal(n.source, 'live');
  assert.equal(n.detailState, 'summary');
  assert.ok(n.url.includes('xsec_token=signed-token'));
  const d = xhsNotes({
    data: {
      items: [
        {
          id: 'note1',
          note_card: {
            title: '详情',
            desc: '完整正文',
            type: 'normal',
            user: { userId: 'u1', nickname: '用户' },
            imageList: [
              { urlDefault: 'https://cdn.example/1.jpg' },
              { urlDefault: 'https://cdn.example/2.jpg' },
            ],
            interactInfo: { likedCount: '42' },
            time: 1700000000000,
          },
        },
      ],
    },
  })[0];
  assert.equal(d.images.length, 2);
  assert.equal(d.body, '完整正文');
  assert.equal(d.detailState, 'complete');
});
test('Douyin mixed result types map to separate platform namespace', () => {
  const n = douyinNotes({
    data: [
      {
        aweme_info: {
          aweme_id: '123',
          desc: '需要装修吗 #家居',
          author: { uid: 'u2', sec_uid: 'secure-user', nickname: '抖音用户' },
          statistics: { digg_count: 450, comment_count: 8, collect_count: 9 },
          video: {
            cover: { url_list: ['https://cdn.example/cover.jpg'] },
            play_addr: { url_list: ['https://cdn.example/a.mp4'] },
          },
          create_time: 1700000000,
          text_extra: [{ hashtag_name: '家居' }],
        },
      },
    ],
  })[0];
  assert.equal(n.id, 'dy:123');
  assert.equal(n.platform, 'douyin');
  assert.equal(n.type, 'video');
  assert.equal(n.videoUrl, 'https://cdn.example/a.mp4');
  assert.equal(n.authorId, 'secure-user');
  assert.deepEqual(n.tags, ['家居']);
  assert.ok(n.url.endsWith('/video/123'));
});
test('Comments preserve root/reply relations across both platforms', () => {
  for (const platform of ['xiaohongshu', 'douyin'] as const) {
    const root = {
      id: 'c1',
      cid: 'c1',
      content: '求链接',
      text: '求链接',
      user_info: { user_id: 'u1', nickname: 'A' },
      user: { uid: 'u1', nickname: 'A' },
      sub_comments: [{ id: 'c2', content: '已回复', user_info: { user_id: 'u2', nickname: 'B' } }],
    };
    const comments = platformComments(
      platform,
      platform === 'xiaohongshu' ? { data: { comments: [root] } } : { comments: [root] },
      'note',
    );
    assert.equal(comments.length, 2);
    assert.equal(comments[0].parentId, null);
    assert.equal(comments[1].parentId, comments[0].id);
    assert.ok(comments.every((c) => c.source === 'live'));
  }
});
test('Pagination boundaries distinguish absent flag from explicit exhaustion', () => {
  assert.equal(responseMore('xiaohongshu', { data: { has_more: true } }), true);
  assert.equal(responseMore('douyin', { has_more: 0 }), false);
  assert.equal(responseMore('xiaohongshu', { data: {} }), undefined);
  assert.equal(count('1.5万'), 15000);
  assert.equal(count('1,234'), 1234);
  assert.equal(count('unknown'), 0);
});

test('Douyin UTF-8 search stream replaces speculative cache and retains the complete first screen', async () => {
  const { parseDouyinSearch } = await import('../server/platforms/model.ts');
  const frame = (x: unknown) => {
    const json = JSON.stringify(x);
    return Buffer.byteLength(json).toString(16) + '\r\n' + json + '\r\n';
  };
  const note = (id: string, text: string) => ({ aweme_info: { aweme_id: id, desc: text } });
  const stream =
    frame({ status_code: 0, data: [note('stale', '旧缓存')] }) +
    frame({ ack: -1 }) +
    frame({ status_code: 0, data: [note('first', '新首屏中文😀')], result_status: 2 }) +
    frame({ ack: 0 }) +
    frame({ status_code: 0, data: [note('second', '后续')], has_more: 1, result_status: 4 }) +
    '0\r\n\r\n';
  const payload = parseDouyinSearch(stream);
  assert.deepEqual(
    douyinNotes(payload).map((n) => n.id),
    ['dy:first', 'dy:second'],
  );
  assert.equal(payload.has_more, 1);
  assert.throws(() => parseDouyinSearch(stream.slice(0, -8)));
  assert.throws(() => parseDouyinSearch('ff\n{}\n0\n'));
  assert.equal(parseDouyinSearch('{"status_code":0,"data":[]}').status_code, 0);
});

test('Douyin latest collection rejects late general responses and wrong sort requests', async () => {
  const { matchesDouyinSort } = await import('../server/platforms/model.ts');
  const base = 'https://www.douyin.com/aweme/v1/web/general/search/stream/';
  const filtered =
    base +
    '?filter_selected=' +
    encodeURIComponent(JSON.stringify({ sort_type: '2', publish_time: '0' }));
  assert.equal(matchesDouyinSort(base, 'latest'), false);
  assert.equal(matchesDouyinSort(filtered, 'latest'), true);
  assert.equal(matchesDouyinSort(filtered, 'general'), false);
  assert.equal(matchesDouyinSort(base + '?sort_type=1', 'popular'), true);
  assert.equal(matchesDouyinSort(base + '?filter_selected=broken', 'latest'), false);
});
