import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'openfind-dy-api-'));
process.env.OPENFIND_DATA_DIR = dir;
process.env.NODE_ENV = 'test';
process.env.OPENFIND_BROWSER_PORT = '65501';
const { app } = await import('../server/index.ts');
const { db } = await import('../server/store.ts');
const original = globalThis.fetch;
const calls: string[] = [];
const native = '7654321098765432109';
globalThis.fetch = async (input, init) => {
  const u = new URL(String(input));
  if (u.origin === 'https://api.tikhub.io') {
    calls.push(u.pathname);
    const d = u.pathname.endsWith('fetch_video_comments')
      ? {
          comments: [
            {
              cid: 'c',
              text: '桌子哪里买',
              create_time: Math.floor(Date.now() / 1000),
              user: { uid: 'u' },
            },
          ],
          has_more: 0,
        }
      : u.pathname.endsWith('fetch_one_video_by_share_url')
        ? { aweme_list: [{ aweme_id: native, desc: '桌子', statistics: { comment_count: 1 } }] }
        : {
            data: [
              { aweme_info: { aweme_id: native, desc: '桌子', statistics: { comment_count: 1 } } },
            ],
            has_more: 0,
          };
    return Response.json({ code: 200, data: d });
  }
  if (u.port === '65501') {
    calls.push('browser' + u.pathname);
    const b = JSON.parse(String(init?.body));
    assert.equal(b.platform, 'douyin');
    return Response.json({ items: [], nextCursor: null });
  }
  if (u.origin === 'https://redfox.hk') {
    calls.push('redfox' + u.pathname);
    return Response.json({ code: 2000, data: { list: [], hasMore: false } });
  }
  return original(input, init);
};
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((r) => server.once('listening', r));
const base = 'http://127.0.0.1:' + (server.address() as any).port + '/api';
async function req(path: string, body?: unknown, method?: string) {
  return original(base + path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}
async function done(id: string) {
  for (let i = 0; i < 100; i++) {
    const s = await (await req('/state')).json();
    const j = s.jobs.find((j: any) => j.id === id);
    if (j.status !== 'running') return j;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error('timeout');
}
after(async () => {
  globalThis.fetch = original;
  await new Promise<void>((r) => server.close(() => r()));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
test('real-mode search, detail, comments route to TikHub; RedFox blocks comment workflows before billing; browser remains selectable', async () => {
  const before = await (await req('/xhs-data')).json();
  assert.equal(
    (await req('/douyin-data', { provider: 'tikhub', apiKey: 'test-key', maxRequests: 5 }, 'PUT'))
      .status,
    200,
  );
  const input = {
    keyword: '桌子',
    platform: 'douyin',
    mode: 'live',
    limit: 5,
    sort: 'latest',
    noteType: 'all',
    interval: 1000,
  };
  const j = await (await req('/jobs', input)).json();
  assert.equal((await done(j.id)).status, 'completed');
  assert.equal(
    (await req('/notes/' + encodeURIComponent('dy:' + native) + '/detail', {})).status,
    200,
  );
  const c = await (await req('/comments/collect', { noteId: 'dy:' + native, limit: 5 })).json();
  assert.equal((await done(c.id)).count, 1);
  assert.ok(calls.every((c) => !c.startsWith('browser')));
  await req('/douyin-data', { provider: 'redfox', apiKey: 'red-key', maxRequests: 5 }, 'PUT');
  const n = calls.length;
  assert.equal((await req('/comments/collect', { noteId: 'dy:' + native, limit: 5 })).status, 400);
  assert.equal(
    (
      await req('/workflows', {
        keyword: '桌子',
        platform: 'douyin',
        mode: 'live',
        searchLimit: 5,
        maxNotes: 1,
        commentLimit: 5,
        supplement: false,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await req('/workflows/links', {
        content: 'https://www.douyin.com/video/' + native,
        commentLimit: 5,
      })
    ).status,
    400,
  );
  assert.equal(calls.length, n);
  const r = await (await req('/jobs', { ...input, forceRefresh: true })).json();
  assert.equal((await done(r.id)).status, 'completed');
  assert.ok(calls.at(-1)?.startsWith('redfox'));
  await req('/douyin-data', { provider: 'browser', maxRequests: 5 }, 'PUT');
  const b = await (await req('/jobs', { ...input, forceRefresh: true })).json();
  assert.equal((await done(b.id)).status, 'completed');
  assert.equal(calls.at(-1), 'browser/search');
  assert.deepEqual(await (await req('/xhs-data')).json(), before);
  assert.equal((await req('/drafts/anything/publish', {})).status, 410);
});
