import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SearchInput, Note } from '../shared/types.ts';
const dir = mkdtempSync(join(tmpdir(), 'openfind-dy-'));
process.env.OPENFIND_DATA_DIR = dir;
process.env.NODE_ENV = 'test';
const {
  douyinClient,
  douyinProvider,
  douyinSettings,
  saveDouyinSettings,
  douyinFingerprint,
  normalizeRedfoxDouyin,
} = await import('../server/douyin-data.ts');
const { saveXhsSettings, xhsSettings } = await import('../server/xhs-data.ts');
const { db, configSet, configGet, put } = await import('../server/store.ts');
const { cachedJob } = await import('../server/jobs-cache.ts');
after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
const input: SearchInput = {
  keyword: '桌子',
  limit: 2,
  sort: 'latest',
  noteType: 'all',
  interval: 1000,
  mode: 'live',
  platform: 'douyin',
};
const native = '7654321098765432109';
const aweme = {
  aweme_id: native,
  desc: '桌子',
  statistics: { comment_count: 2 },
  author: { nickname: '作者' },
  video: { cover: { url_list: ['https://example.com/c.jpg'] } },
};
const note = {
  id: 'dy:' + native,
  nativeId: native,
  url: 'https://www.douyin.com/video/' + native,
} as Note;
const transport = (fn: (u: URL, i?: RequestInit) => unknown) =>
  (async (u, init) => Response.json(fn(new URL(String(u)), init))) as typeof fetch;
test('default follows old connection; provider/key edits are isolated across platforms', () => {
  assert.equal(douyinProvider(), 'browser');
  configSet('connectionType', 'http');
  assert.equal(douyinProvider(), 'http');
  saveXhsSettings({ provider: 'redfox', apiKey: 'xhs-secret', maxRequests: 3 });
  const xhs = xhsSettings();
  saveDouyinSettings({ provider: 'tikhub', apiKey: 'dy-secret', maxRequests: 2 });
  const fingerprint = douyinFingerprint();
  saveDouyinSettings({ provider: 'tikhub', apiKey: 'dy-secret', maxRequests: 2 });
  assert.equal(douyinFingerprint(), fingerprint);
  assert.deepEqual(xhsSettings(), xhs);
  assert.ok(!configGet('douyin.key.tikhub').includes('dy-secret'));
  assert.ok(!JSON.stringify(douyinSettings()).includes('secret'));
  saveDouyinSettings({ provider: 'redfox', apiKey: 'red-secret', maxRequests: 2 });
  assert.notEqual(douyinFingerprint(), fingerprint);
  saveDouyinSettings({ provider: 'tikhub', maxRequests: 2 });
  assert.equal(douyinFingerprint(), fingerprint);
});
test('TikHub POST search preserves response array, session, sort, string IDs and budget', async () => {
  let calls = 0;
  const client = douyinClient(
    undefined,
    transport((u, i) => {
      calls++;
      assert.equal(u.pathname, '/api/v1/douyin/search/fetch_general_search_v1');
      assert.equal(i?.method, 'POST');
      assert.equal(new Headers(i?.headers).get('Authorization'), 'Bearer dy-secret');
      assert.equal(new Headers(i?.headers).get('Cookie'), null);
      assert.equal(i?.redirect, 'error');
      const body = JSON.parse(String(i?.body));
      assert.equal(body.sort_type, '2');
      assert.equal(body.cursor, calls === 1 ? 0 : 10);
      if (calls === 2) {
        assert.equal(body.search_id, 's');
        assert.equal(body.backtrace, 'b');
      }
      return {
        code: 200,
        data: {
          data: [{ aweme_info: aweme }],
          cursor: 10,
          has_more: calls === 1,
          search_id: 's',
          backtrace: 'b',
        },
      };
    }),
  );
  const first = await client.search(input, null);
  assert.equal(first.items[0].nativeId, native);
  assert.ok(first.nextCursor);
  const second = await client.search(input, first.nextCursor);
  assert.equal(second.nextCursor, null);
  await assert.rejects(client.search(input, null), /上限/);
  assert.equal(calls, 2);
});
test('TikHub comment count is fixed at vendor default, paginates, retains replies', async () => {
  saveDouyinSettings({ provider: 'tikhub', maxRequests: 5 });
  const client = douyinClient(
    undefined,
    transport((u) => {
      assert.equal(u.searchParams.get('count'), '20');
      assert.equal(u.searchParams.get('aweme_id'), native);
      return {
        code: 200,
        data: {
          comments: [{ cid: 'c', text: '多少钱', reply_comment: [{ cid: 'r', text: '回复' }] }],
          has_more: 1,
          cursor: 20,
        },
      };
    }),
  );
  const r = await client.comments(note, 100, null);
  assert.equal(r.items[1].parentId, 'dy:c');
  await assert.rejects(client.comments(note, 100, r.nextCursor), /重复分页/);
});
test('RedFox search and detail field mapping; comments rejected without any request', async () => {
  saveDouyinSettings({ provider: 'redfox', maxRequests: 5 });
  let calls = 0;
  const client = douyinClient(
    undefined,
    transport((u, i) => {
      calls++;
      const body = JSON.parse(String(i?.body));
      assert.equal(new Headers(i?.headers).get('REDFOX_API_KEY'), 'red-secret');
      const row = {
        workId: native,
        workType: '图文',
        title: '图文',
        publishTime: '2026-10-20 09:00:00',
        commentCount: 7,
      };
      if (u.pathname.endsWith('queryWork')) {
        assert.equal(body.workUrl, note.url);
        return { code: 2000, data: row };
      }
      assert.equal(body.offset, calls === 1 ? 0 : 20);
      assert.equal(body.sortType, '_2');
      return { code: 2000, data: { list: [row], hasMore: calls === 1 } };
    }),
  );
  const a = await client.search(input, null);
  await client.search(input, a.nextCursor);
  assert.equal(a.items[0].type, 'image');
  assert.equal(a.items[0].publishedAt, '2026-10-20T01:00:00.000Z');
  assert.equal((await client.detail(note)).comments, 7);
  await assert.rejects(client.comments(note, 20, null), /未提供/);
  assert.equal(calls, 3);
  assert.throws(() => normalizeRedfoxDouyin([{}]), /workId/);
});
test('errors never trigger browser fallback or chargeable retries', async () => {
  saveDouyinSettings({ provider: 'tikhub', maxRequests: 5 });
  let calls = 0;
  const client = douyinClient(undefined, (async () => {
    calls++;
    throw Error('network');
  }) as typeof fetch);
  await assert.rejects(client.search(input, null), /未自动重试/);
  assert.equal(calls, 1);
  for (const payload of [
    { code: 401, data: {} },
    { code: 200, data: null },
    { code: 200, data: { status_code: 1 } },
    { code: 200, data: {} },
  ])
    await assert.rejects(
      douyinClient(
        undefined,
        transport(() => payload),
      ).search(input, null),
    );
  await assert.rejects(
    douyinClient(
      undefined,
      transport(() => ({ code: 200, data: { aweme_list: [], filter_list: [{ reason: 5 }] } })),
    ).detail(note),
    /私密/,
  );
});
test('cache separates browser, API supplier and key identity', () => {
  saveDouyinSettings({ provider: 'tikhub', maxRequests: 5 });
  put('notes', note);
  const job: any = {
    id: 'cached',
    type: 'search',
    platform: 'douyin',
    keyword: input.keyword,
    source: 'live',
    status: 'completed',
    query: input,
    count: 2,
    resultIds: [note.id],
    finishedAt: new Date().toISOString(),
    dataProvider: douyinFingerprint(),
  };
  put('jobs', job);
  assert.ok(cachedJob({ ...job, id: 'next' }, input));
  saveDouyinSettings({ provider: 'browser', maxRequests: 5 });
  assert.equal(cachedJob({ ...job, id: 'next' }, input), undefined);
  saveDouyinSettings({ provider: 'tikhub', apiKey: 'new-key', maxRequests: 5 });
  assert.equal(cachedJob({ ...job, id: 'next' }, input), undefined);
});
