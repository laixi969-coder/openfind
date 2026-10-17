import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { Snapshot, Job, Draft, Note } from '../shared/types.ts';
import { parseIntent, intentScore } from '../server/domain.ts';
const dir = mkdtempSync(join(tmpdir(), 'openfind-test-'));
process.env.NODE_ENV = 'test';
process.env.OPENFIND_DATA_DIR = dir;
let server: Server;
let base: string;
let db: typeof import('../server/store.ts').db;
async function request(path: string, body?: unknown, method?: string) {
  return fetch(base + path, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function json<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const r = await request(path, body, method);
  assert.ok(r.ok, `${r.status} ${await r.clone().text()}`);
  return r.json() as Promise<T>;
}
async function state() {
  return json<Snapshot>('/api/state');
}
async function waitJob(id: string) {
  for (let i = 0; i < 1000; i++) {
    const j = (await state()).jobs.find((x) => x.id === id)!;
    if (j.status !== 'running') return j;
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error('job timed out');
}
before(async () => {
  const mod = await import('../server/index.ts');
  db = (await import('../server/store.ts')).db;
  server = mod.app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
});
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
const search = {
  keyword: '装修',
  limit: 25,
  sort: 'popular',
  noteType: 'image',
  interval: 1000,
  mode: 'demo',
};
test('natural-language plan handles Chinese counts and explicit ordering', () => {
  assert.equal(parseIntent('找一篇家具高互动作品').limit, 1);
  assert.equal(parseIntent('帮我找三十篇最新装修笔记').limit, 30);
  assert.equal(parseIntent('帮我找20篇医美爆款').sort, 'popular');
  assert.equal(parseIntent('所有家居作品').limit, 0);
  assert.ok(intentScore('想买，求链接，多少钱').score > intentScore('谢谢分享').score);
});
test('Live collection rejects unlimited and oversized batches before contacting platforms', async () => {
  for (const limit of [0, 101])
    assert.equal((await request('/api/jobs', { ...search, mode: 'live', limit })).status, 400);
});
test('Sensitive note context blocks creation of individual marketing leads at the API boundary', async () => {
  const { put } = await import('../server/store.ts');
  const note = {
    ...(await state()).notes[0],
    id: 'restricted-note',
    title: 'HPV治疗',
    body: '公开健康主题',
    tags: [],
  };
  put('notes', note);
  put('comments', {
    id: 'restricted-comment',
    noteId: note.id,
    parentId: null,
    author: '测试用户',
    authorId: 'test-only',
    body: '多少钱，怎么预约',
    region: '',
    createdAt: new Date().toISOString(),
    likes: 0,
    source: 'live',
  });
  const result = await json<{ added: number; restricted: number }>('/api/leads/collect', {
    commentIds: ['restricted-comment'],
  });
  assert.equal(result.added, 0);
  assert.equal(result.restricted, 1);
  assert.ok(!(await state()).leads.some((l) => l.commentId === 'restricted-comment'));
  const { remove } = await import('../server/store.ts');
  remove('comments', 'restricted-comment');
  remove('notes', 'restricted-note');
});
test('snapshot contains seeded demo, accounts, and no plaintext credentials', async () => {
  const s = await state();
  assert.equal(s.notes.length, 24);
  assert.ok(s.notes.every((n) => n.source === 'demo'));
  assert.equal(s.accounts.length, 1);
  assert.ok(!JSON.stringify(s).includes('credential-key'));
});
test('rejects malformed input and cross-origin mutations', async () => {
  assert.equal((await request('/api/jobs', { ...search, keyword: '' })).status, 400);
  assert.equal((await request('/api/jobs', { ...search, interval: 1 })).status, 400);
  const r = await fetch(base + '/api/settings', {
    method: 'PUT',
    headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(r.status, 403);
});
test('search streams real job progress, enforces note type and can persist results', async () => {
  const j = await json<Job>('/api/jobs', search);
  assert.equal(j.status, 'running');
  const done = await waitJob(j.id);
  assert.equal(done.status, 'completed');
  assert.ok(done.count > 0);
  const s = await state();
  const items = s.notes.filter((n) => done.resultIds.includes(n.id));
  assert.ok(items.every((n) => n.type === 'image'));
  assert.equal(new Set(done.resultIds).size, done.count);
  assert.ok(done.logs.length >= 3);
});
test('rejects concurrent jobs and preserves partial results on stop', async () => {
  const j = await json<Job>('/api/jobs', { ...search, keyword: '停止测试', limit: 100 });
  assert.equal((await request('/api/jobs', search)).status, 409);
  await new Promise((r) => setTimeout(r, 500));
  await json('/api/jobs/' + j.id + '/stop', {});
  const stopped = await waitJob(j.id);
  assert.equal(stopped.status, 'stopped');
  assert.ok(stopped.count > 0 && stopped.count < 100);
  assert.ok(stopped.logs.some((l) => l.level === 'WARN'));
});
test('comment replies retain parent relationships; leads are idempotent and editable', async () => {
  const note = (await state()).notes.find((n) => n.source === 'demo')!;
  const j = await json<Job>('/api/comments/collect', {
    noteId: note.id,
    limit: 24,
    interval: 1000,
  });
  const done = await waitJob(j.id);
  assert.equal(done.status, 'completed');
  const comments = (await state()).comments.filter((c) => done.resultIds.includes(c.id));
  assert.ok(comments.some((c) => !!c.parentId));
  for (const c of comments.filter((c) => c.parentId))
    assert.ok(comments.some((p) => p.id === c.parentId));
  const ids = comments.slice(0, 5).map((c) => c.id);
  assert.equal((await json<{ added: number }>('/api/leads/collect', { commentIds: ids })).added, 5);
  assert.equal((await json<{ added: number }>('/api/leads/collect', { commentIds: ids })).added, 0);
  const lead = (await state()).leads[0];
  await json(
    '/api/leads/' + encodeURIComponent(lead.id),
    { memo: '下周跟进', status: 'qualified' },
    'PATCH',
  );
  assert.equal((await state()).leads.find((l) => l.id === lead.id)?.status, 'qualified');
});
test('draft validation, local ZIP, demo publish receipt and duplicate prevention', async () => {
  const n = (await state()).notes.find((n) => n.type === 'image')!;
  const input = {
    noteId: n.id,
    title: '我的创作',
    body: '编辑后的正文',
    images: n.images,
    tags: ['生活'],
    visibility: 'private',
    accountId: 'demo-account',
  };
  assert.equal((await request('/api/drafts', { ...input, title: '字'.repeat(21) })).status, 400);
  assert.equal((await request('/api/drafts', { ...input, images: [] })).status, 400);
  const d = await json<Draft>('/api/drafts', input);
  assert.equal((await state()).drafts.find((x) => x.id === d.id)?.visibility, 'private');
  const bundle = await request('/api/drafts/' + d.id + '/bundle');
  assert.equal(bundle.headers.get('content-type'), 'application/zip');
  assert.ok((await bundle.arrayBuffer()).byteLength > 1000);
  const published = await json<Draft>('/api/drafts/' + d.id + '/publish', {});
  assert.equal(published.status, 'demo_published');
  assert.ok(published.receipt?.startsWith('demo-receipt-'));
  assert.equal((await request('/api/drafts/' + d.id + '/publish', {})).status, 409);
  const fork = await json<Draft>('/api/drafts', { ...input, id: d.id, title: '修改后另存' });
  assert.notEqual(fork.id, d.id);
});
test('credentials encrypted at rest and never returned, session-only preference clears disk copy', async () => {
  const s = (await state()).settings;
  await json(
    '/api/settings',
    {
      ...s,
      cookie: 'a1=secret-cookie-sentinel',
      token: 'token-secret-sentinel',
      rememberCookie: true,
    },
    'PUT',
  );
  const wire = JSON.stringify(await state());
  assert.ok(!wire.includes('secret-cookie-sentinel'));
  assert.ok(!wire.includes('token-secret-sentinel'));
  const rows = db.prepare('SELECT * FROM config').all();
  assert.ok(!JSON.stringify(rows).includes('secret-cookie-sentinel'));
  assert.ok((await state()).settings.hasCookie);
  await json('/api/settings', { ...(await state()).settings, rememberCookie: false }, 'PUT');
  assert.equal(
    db.prepare('SELECT value FROM config WHERE key=?').get('cookie:demo-account')?.value,
    '',
  );
  assert.ok((await state()).settings.hasCookie);
});
test('multiple accounts keep credentials separate and can be selected for publishing', async () => {
  const a = await json<{ id: string }>('/api/accounts', {
    id: 'brand-account',
    name: '品牌账号',
    cookie: 'brand-cookie-secret',
    rememberCookie: true,
  });
  assert.equal(a.id, 'brand-account');
  assert.equal((await request('/api/accounts', { id: a.id, name: '重复' })).status, 409);
  const s = await state();
  assert.equal(s.accounts.length, 2);
  const note = s.notes.find((n) => n.type === 'image')!;
  const d = await json<Draft>('/api/drafts', {
    noteId: note.id,
    title: '品牌账号草稿',
    body: '测试',
    images: note.images,
    tags: [],
    visibility: 'public',
    accountId: a.id,
  });
  assert.equal((await request('/api/drafts/' + d.id + '/publish', {})).status, 200);
  assert.ok(!JSON.stringify(await state()).includes('brand-cookie-secret'));
});
test('CSV escapes spreadsheet formulas and unknown exports return an error', async () => {
  const lead = (await state()).leads[0];
  await json('/api/leads/' + encodeURIComponent(lead.id), { memo: '=HYPERLINK("bad")' }, 'PATCH');
  const csv = await (await request('/api/export/leads?format=csv')).text();
  assert.ok(csv.includes("'=HYPERLINK"));
  assert.equal((await request('/api/export/secrets')).status, 400);
  const subset = await json<Note[]>('/api/export/notes', {
    ids: [(await state()).notes[0].id],
    format: 'json',
  });
  assert.equal(subset.length, 1);
  const empty = await json<Note[]>('/api/export/notes', { ids: [], format: 'json' });
  assert.equal(empty.length, 0);
});
test('live adapter handles pagination, dedup, throttling, account preflight and real receipt', async () => {
  const express = (await import('express')).default;
  const mock = express();
  mock.use(express.json());
  const times: number[] = [];
  let publications = 0;
  const sample = (await state()).notes[0];
  mock.post('/health', (_req, res) =>
    res.json({ ok: true, accountId: 'live-account', accountName: '真实测试账号' }),
  );
  mock.post('/search', (req, res) => {
    times.push(Date.now());
    const n = {
      ...sample,
      id: req.body.cursor ? 'live-two' : 'live-one',
      source: undefined,
      url: 'https://www.xiaohongshu.com/explore/test',
    };
    res.json({
      items: req.body.cursor ? [{ ...n, id: 'live-one' }, n] : [n],
      nextCursor: req.body.cursor ? null : 'page-two',
    });
  });
  mock.post('/publish', (req, res) => {
    assert.equal(req.body.accountId, 'live-account');
    assert.ok(req.body.idempotencyKey);
    publications++;
    res.json({ id: 'receipt-real', url: 'https://www.xiaohongshu.com/explore/published-test' });
  });
  const ms = mock.listen(0, '127.0.0.1');
  await new Promise<void>((r) => ms.once('listening', r));
  try {
    const s = (await state()).settings;
    await json(
      '/api/settings',
      {
        ...s,
        mode: 'live',
        connectionType: 'http',
        providerUrl: 'http://127.0.0.1:' + (ms.address() as { port: number }).port,
        accountId: 'live-account',
        accountName: '真实测试账号',
        rememberCookie: false,
      },
      'PUT',
    );
    const j = await json<Job>('/api/jobs', {
      ...search,
      mode: 'live',
      keyword: '真实测试',
      interval: 500,
      limit: 10,
    });
    const done = await waitJob(j.id);
    assert.equal(done.status, 'completed');
    assert.equal(done.count, 2);
    assert.ok(times[1] - times[0] >= 14800);
    const cachedJob = await json<Job>('/api/jobs', {
      ...search,
      mode: 'live',
      keyword: '真实测试',
      interval: 500,
      limit: 2,
    });
    const cachedDone = await waitJob(cachedJob.id);
    assert.equal(cachedDone.count, 2);
    assert.equal(
      cachedDone.dataFetchedAt,
      done.dataFetchedAt,
      'cache reads must not extend data freshness',
    );
    assert.equal(times.length, 2, 'cached results must not repeat platform requests');
    const n = (await state()).notes.find((n) => n.id === 'live-one')!;
    assert.equal(n.source, 'live');
    const d = await json<Draft>('/api/drafts', {
      noteId: n.id,
      title: '真实流程测试',
      body: 'test',
      images: n.images,
      tags: [],
      visibility: 'public',
      accountId: 'live-account',
    });
    const result = await json<Draft>('/api/drafts/' + d.id + '/publish', {});
    assert.equal(result.status, 'published');
    assert.equal(result.receipt, 'https://www.xiaohongshu.com/explore/published-test');
    assert.equal(publications, 1);
    await json(
      '/api/settings',
      { ...(await state()).settings, providerUrl: 'http://127.0.0.1:1' },
      'PUT',
    );
    await new Promise((r) => setTimeout(r, 15000));
    const broken = await json<Job>('/api/jobs', { ...search, mode: 'live' });
    assert.equal((await waitJob(broken.id)).status, 'failed');
  } finally {
    await new Promise<void>((r) => ms.close(() => r()));
  }
});
