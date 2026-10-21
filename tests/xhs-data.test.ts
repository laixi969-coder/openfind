import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Note, SearchInput } from '../shared/types.ts';
const dir = mkdtempSync(join(tmpdir(), 'openfind-xhs-'));
process.env.OPENFIND_DATA_DIR = dir;
const {
  saveXhsSettings,
  xhsSettings,
  xhsFingerprint,
  xhsClient,
  unwrap,
  apiDate,
  redfoxNotes,
  XhsPendingError,
} = await import('../server/xhs-data.ts');
const { db, configGet, all } = await import('../server/store.ts');
after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
const input: SearchInput = {
  keyword: '家居',
  limit: 50,
  sort: 'latest',
  noteType: 'all',
  interval: 1000,
  mode: 'live',
  platform: 'xiaohongshu',
};
const note = { id: 'xhs:note1', nativeId: 'note1' } as Note;
function mock(fn: (url: URL, init?: RequestInit) => unknown): typeof fetch {
  return (async (url, init) => Response.json(fn(new URL(String(url)), init))) as typeof fetch;
}
test('separate encrypted keys and provenance, no secret echo', () => {
  saveXhsSettings({ provider: 'tikhub', apiKey: 'tik-secret', maxRequests: 5 });
  const fingerprint = xhsFingerprint();
  assert.ok(!configGet('xhs.key.tikhub').includes('tik-secret'));
  saveXhsSettings({ provider: 'redfox', apiKey: 'red-secret', maxRequests: 5 });
  assert.notEqual(xhsFingerprint(), fingerprint);
  assert.deepEqual(xhsSettings().hasKeys, { tikhub: true, redfox: true });
  assert.ok(!JSON.stringify(xhsSettings()).includes('secret'));
  saveXhsSettings({ provider: 'tikhub', maxRequests: 5 });
  assert.equal(xhsFingerprint(), fingerprint);
});
test('TikHub auth, pagination sessions, request budget, strict malformed data', async () => {
  saveXhsSettings({ provider: 'tikhub', maxRequests: 2 });
  let calls = 0;
  const c = xhsClient(
    undefined,
    mock((u, i) => {
      calls++;
      assert.equal(u.origin, 'https://api.tikhub.io');
      assert.equal(new Headers(i?.headers).get('Authorization'), 'Bearer tik-secret');
      assert.equal(new Headers(i?.headers).get('Cookie'), null);
      assert.equal(u.searchParams.get('sort_type'), 'time_descending');
      if (calls === 2) {
        assert.equal(u.searchParams.get('page'), '2');
        assert.equal(u.searchParams.get('search_id'), 'session');
      }
      return {
        code: 200,
        data: {
          data: {
            items: [{ id: 'n' + calls, note_card: { title: '标题' } }],
            has_more: true,
            search_id: 'session',
            search_session_id: 'ss',
          },
        },
      };
    }),
  );
  const first = await c.search(input, null);
  assert.equal(first.items[0].id, 'xhs:n1');
  assert.ok(first.nextCursor);
  await c.search(input, first.nextCursor);
  await assert.rejects(c.search(input, first.nextCursor), /上限/);
  assert.equal(calls, 2);
  assert.throws(() => unwrap('tikhub', { code: 200, data: null }), /空数据/);
  assert.throws(() => unwrap('tikhub', { code: 200, data: { success: false } }), /未成功/);
  assert.throws(() => unwrap('redfox', { code: 3201, data: {} }), /3201/);
});
test('RedFox search offset and timezone normalization', async () => {
  saveXhsSettings({ provider: 'redfox', maxRequests: 5 });
  let calls = 0;
  const c = xhsClient(
    undefined,
    mock((u, i) => {
      calls++;
      const b = JSON.parse(String(i?.body));
      assert.equal(b.offset, calls === 1 ? 0 : 20);
      assert.equal(b.sortType, '_2');
      assert.equal(new Headers(i?.headers).get('REDFOX_API_KEY'), 'red-secret');
      return {
        code: 2000,
        data: {
          list: [{ workId: 'r1', workTitle: '标题', workPublishTime: '2026-10-20 09:00:00' }],
          hasMore: calls === 1,
        },
      };
    }),
  );
  const r = await c.search(input, null);
  await c.search(input, r.nextCursor);
  assert.equal(r.items[0].publishedAt, '2026-10-20T01:00:00.000Z');
  assert.equal(apiDate('bad-date'), '');
  assert.throws(() => redfoxNotes([{}]), /workId/);
});
test('RedFox pending tasks survive client recreation and only submit once', async () => {
  let submits = 0,
    queries = 0;
  const transport = mock((u) => {
    if (u.pathname.endsWith('commentSubmit')) {
      submits++;
      return {
        code: 2000,
        data: { taskId: 'task-1', status: 'pending', visibleAfterTime: '2026-10-21 10:00:00' },
      };
    }
    queries++;
    assert.equal(u.searchParams.get('taskId'), 'task-1');
    return {
      code: 2000,
      data:
        queries === 1
          ? { status: 'processing' }
          : {
              status: 'completed',
              commentList: [
                { commentId: 'c1', content: '在哪里买', createTime: '2026-10-20 10:00:00' },
              ],
            },
    };
  });
  await assert.rejects(xhsClient(undefined, transport).comments(note, 20, null), XhsPendingError);
  await assert.rejects(xhsClient(undefined, transport).comments(note, 20, null), XhsPendingError);
  const result = await xhsClient(undefined, transport).comments(note, 20, null);
  assert.equal(result.items[0].id, 'xhs:c1');
  await xhsClient(undefined, transport).comments(note, 20, null);
  assert.equal(submits, 1);
  assert.equal(queries, 2);
});
test('uncertain paid submission is not retried and credentials never follow redirects', async () => {
  let attempts = 0;
  const transport = (async (_u: unknown, i?: RequestInit) => {
    attempts++;
    assert.equal(i?.redirect, 'error');
    throw Error('network');
  }) as typeof fetch;
  const n = { ...note, id: 'xhs:uncertain', nativeId: 'uncertain' };
  await assert.rejects(xhsClient(undefined, transport).comments(n, 20, null), /未自动重试/);
  await assert.rejects(xhsClient(undefined, transport).comments(n, 20, null), /提交结果不确定/);
  assert.equal(attempts, 1);
  assert.ok(all<any>('xhs-api-tasks').some((t) => t.state === 'submitting'));
});
test('TikHub comments keep attached replies and reject repeating cursors', async () => {
  saveXhsSettings({ provider: 'tikhub', maxRequests: 5 });
  const transport = mock(() => ({
    code: 200,
    data: {
      data: {
        comments: [{ id: 'c', content: '评论', sub_comments: [{ id: 'reply', content: '回复' }] }],
        has_more: true,
        cursor: 'next',
      },
    },
  }));
  const c = xhsClient(undefined, transport);
  const r = await c.comments(note, 20, null);
  assert.equal(r.items.length, 2);
  assert.equal(r.items[1].parentId, 'xhs:c');
  await assert.rejects(c.comments(note, 20, r.nextCursor), /游标无效/);
});
