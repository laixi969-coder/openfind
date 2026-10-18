import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Note, AcquisitionWorkflow } from '../shared/types.ts';
const dir = mkdtempSync(join(tmpdir(), 'openfind-links-api-'));
process.env.NODE_ENV = 'test';
process.env.OPENFIND_DATA_DIR = dir;
const calls: { path: string; body: any }[] = [];
const browser = http.createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  const b = JSON.parse(raw);
  calls.push({ path: req.url!, body: b });
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/resolve-work') {
    const nativeId = b.url.split('/').at(-1)!.split('?')[0];
    const note: Note = {
      id: (b.platform === 'douyin' ? 'dy:' : 'xhs:') + nativeId,
      nativeId,
      platform: b.platform,
      title: '花瓶作品',
      body: '桌面花瓶',
      author: '测试创作者',
      authorId: 'creator',
      type: 'image',
      cover: '',
      images: [],
      likes: 10,
      comments: 2,
      commentCountKnown: true,
      saves: 1,
      publishedAt: '',
      tags: [],
      source: 'live',
      url: b.url,
      detailState: 'complete',
    };
    res.end(JSON.stringify(note));
  } else if (req.url === '/comments')
    res.end(
      JSON.stringify({
        items: [
          {
            id: b.note.id + ':comment',
            noteId: b.note.id,
            platform: b.note.platform,
            parentId: null,
            author: '受控测试用户',
            authorId: 'test-buyer',
            body: '花瓶在哪里买，多少钱？',
            region: '',
            createdAt: new Date().toISOString(),
            likes: 0,
            source: 'live',
          },
          {
            id: b.note.id + ':old',
            noteId: b.note.id,
            platform: b.note.platform,
            parentId: null,
            author: '旧评论',
            authorId: 'old-buyer',
            body: '想买这个花瓶',
            region: '',
            createdAt: '2020-01-01T00:00:00Z',
            likes: 0,
            source: 'live',
          },
        ],
        nextCursor: null,
      }),
    );
  else {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'unexpected RPC' }));
  }
});
browser.listen(0, '127.0.0.1');
await new Promise<void>((r) => browser.once('listening', r));
process.env.OPENFIND_BROWSER_PORT = String((browser.address() as any).port);
const { app } = await import('../server/index.ts');
const { configSet, encrypt, db } = await import('../server/store.ts');
const { saveCollectionPolicy, protectionStatus } = await import('../server/protection.ts');
configSet('connectionType', 'browser');
configSet('browserServiceToken', encrypt('test-browser-token'));
for (const p of ['douyin', 'xiaohongshu'] as const)
  saveCollectionPolicy(p, {
    search: { dailyLimit: 100, intervalMs: 1000 },
    comments: { dailyLimit: 100, intervalMs: 1000 },
  });
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((r) => server.once('listening', r));
const base = 'http://127.0.0.1:' + (server.address() as any).port + '/api';
const post = (p: string, b: unknown) =>
  fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(b),
  });
async function finished(id: string) {
  for (let i = 0; i < 200; i++) {
    const state = await (await fetch(base + '/state')).json();
    const w: AcquisitionWorkflow = state.workflows.find((w: AcquisitionWorkflow) => w.id === id);
    if (w.status !== 'running') return w;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error('workflow did not finish');
}
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => browser.close(() => r()));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
test('Link API runs both platforms from real-mode transport through comments to qualified visible results', async () => {
  for (const [p, url] of [
    [
      'xiaohongshu',
      'https://www.xiaohongshu.com/explore/abcdef0123456789abcdef01?xsec_token=test-signature',
    ],
    ['douyin', 'https://www.douyin.com/video/7654321098765432109'],
  ] as const) {
    const r = await post('/workflows/links', { content: '分享作品 ' + url, commentLimit: 2 });
    assert.equal(r.status, 201);
    const started = await r.json();
    const w = await finished(started.id);
    assert.equal(w.status, 'completed', w.message);
    assert.equal(w.commentIds.length, 2);
    assert.equal(w.leadIds.length, 1);
    assert.equal(w.searchJobIds.length, 0);
    assert.equal(w.input.mode, 'live');
    const state = await (await fetch(base + '/state')).json();
    assert.ok(state.leads.some((l: any) => l.id === w.leadIds[0] && l.source === 'live'));
    assert.equal(
      state.jobs.filter((j: any) => j.platform === p && j.source === 'live' && j.type === 'search')
        .length,
      0,
    );
    assert.equal(protectionStatus(p).counts.search, 1);
    assert.equal(protectionStatus(p).counts.comments, 1);
  }
  assert.equal(calls.filter((c) => c.path === '/resolve-work').length, 2);
  assert.equal(calls.filter((c) => c.path === '/comments').length, 2);
});
test('Invalid, mixed and oversized link batches are rejected before any browser RPC', async () => {
  const before = calls.length;
  for (const content of [
    'https://127.0.0.1/secret',
    'https://www.douyin.com/user/test',
    'https://www.douyin.com/video/7654321098765432109 https://xhslink.com/a/test',
    Array.from({ length: 6 }, (_, i) => 'https://www.douyin.com/video/765432109876543210' + i).join(
      '\n',
    ),
  ])
    assert.equal((await post('/workflows/links', { content })).status, 400);
  assert.equal(calls.length, before);
});
