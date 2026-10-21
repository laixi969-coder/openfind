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
    { revision: lead.revision || 0, memo: '下周跟进', status: 'qualified' },
    'PATCH',
  );
  assert.equal((await state()).leads.find((l) => l.id === lead.id)?.status, 'qualified');
});
test('draft validation and ZIP export remain available while platform publishing is disabled', async () => {
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
  for (const action of ['publish', 'prepare', 'reconcile']) {
    assert.equal((await request(`/api/drafts/${d.id}/${action}`, {})).status, 410);
  }
  assert.equal((await state()).drafts.find((x) => x.id === d.id)?.status, 'draft');
  const updated = await json<Draft>('/api/drafts', {
    ...input,
    id: d.id,
    revision: d.revision,
    title: '修改后保存',
  });
  assert.equal(updated.id, d.id);
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
  assert.equal((await request('/api/drafts/' + d.id + '/publish', {})).status, 410);
  assert.ok(!JSON.stringify(await state()).includes('brand-cookie-secret'));
});
test('CSV escapes spreadsheet formulas and unknown exports return an error', async () => {
  const lead = (await state()).leads[0];
  await json(
    '/api/leads/' + encodeURIComponent(lead.id),
    { revision: lead.revision || 0, memo: '=HYPERLINK("bad")' },
    'PATCH',
  );
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
      platform: 'douyin',
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
        platform: 'douyin',
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
      platform: 'douyin',
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
      platform: 'douyin',
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
    assert.equal((await request('/api/drafts/' + d.id + '/publish', {})).status, 410);
    assert.equal(publications, 0);
    await json(
      '/api/settings',
      { ...(await state()).settings, providerUrl: 'http://127.0.0.1:1' },
      'PUT',
    );
    await new Promise((r) => setTimeout(r, 15000));
    const broken = await json<Job>('/api/jobs', { ...search, platform: 'douyin', mode: 'live' });
    assert.equal((await waitJob(broken.id)).status, 'failed');
  } finally {
    await new Promise<void>((r) => ms.close(() => r()));
  }
});

test('One-click API runs both platforms with isolated data, rejects duplicate starts and persists results', async () => {
  for (const platform of ['xiaohongshu', 'douyin'] as const) {
    const r = await json<import('../shared/types.ts').AcquisitionWorkflow>('/api/workflows', {
      keyword: '流程沙发' + platform,
      platform,
      mode: 'demo',
      searchLimit: 4,
      maxNotes: 1,
      commentLimit: 12,
      supplement: false,
    });
    assert.equal((await request('/api/workflows', { ...r.input })).status, 409);
    assert.equal((await request('/api/jobs', search)).status, 409);
    let done = r;
    for (let i = 0; i < 100; i++) {
      done = (await state()).workflows.find((w) => w.id === r.id)!;
      if (done.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 80));
    }
    assert.equal(done.status, 'completed');
    assert.equal(done.commentIds.length, 12);
    assert.ok(done.leadIds.length > 0);
    const s = await state();
    assert.ok(done.noteIds.every((id) => s.notes.find((n) => n.id === id)?.platform === platform));
    assert.ok(done.leadIds.every((id) => s.leads.find((l) => l.id === id)?.platform === platform));
    assert.equal((await request('/api/workflows/' + done.id + '/resume', {})).status, 409);
  }
  assert.equal(
    (await request('/api/workflows', { keyword: 'HPV治疗', platform: 'douyin', mode: 'demo' }))
      .status,
    400,
  );
});

test('Collection configuration API validates input and returns budgets for each platform', async () => {
  const policy = {
    search: { dailyLimit: 150, intervalMs: 20000 },
    comments: { dailyLimit: 200, intervalMs: 30000 },
  };
  assert.equal(
    (await request('/api/protection/douyin', { ...policy, paused: false }, 'PUT')).status,
    400,
  );
  assert.equal(
    (
      await request(
        '/api/protection/douyin',
        { ...policy, search: { dailyLimit: 0, intervalMs: 20000 } },
        'PUT',
      )
    ).status,
    400,
  );
  const result = await json<import('../shared/types.ts').ProtectionView>(
    '/api/protection/douyin',
    policy,
    'PUT',
  );
  assert.deepEqual(result.policy, policy);
  assert.equal(result.budgets.search.remaining, 150 - result.counts.search);
  const status = await json<{
    platforms: Record<string, import('../shared/types.ts').ProtectionView>;
  }>('/api/protection');
  assert.equal(status.platforms.xiaohongshu.policy.search.dailyLimit, 100);
  assert.deepEqual(status.platforms.douyin.policy, policy);
});

test('Model config never exposes keys and completed workflow reviews route before generic actions', async () => {
  const saved = await json<any>(
    '/api/llm',
    {
      enabled: false,
      baseUrl: 'https://example.com/v1',
      model: 'example-chat',
      apiKey: 'temporary-secret-for-test',
      maxComments: 100,
    },
    'PUT',
  );
  assert.equal(saved.hasApiKey, true);
  assert.ok(!JSON.stringify(saved).includes('temporary-secret-for-test'));
  const read = await json<any>('/api/llm');
  assert.equal(read.model, 'example-chat');
  const flow = (await state()).workflows.find((w) => w.status === 'completed');
  if (flow) {
    const result = await json<any>(`/api/workflows/${flow.id}/review`, {});
    assert.ok(result.qualificationReview);
  }
  assert.equal(
    (await request('/api/llm', { enabled: true, baseUrl: '', model: '', maxComments: 100 }, 'PUT'))
      .status,
    400,
  );
});

test('AI image generation requires configuration before calling any provider', async () => {
  const initial = await json<any>('/api/images');
  assert.equal(initial.baseUrl, '');
  assert.equal(initial.hasApiKey, false);
  assert.equal(initial.mode, 'edit');
  const result = await request('/api/images/variants', {
    images: ['https://example.com/a.png'],
    prompt: '保持构图，替换品牌',
    count: 1,
  });
  assert.equal(result.status, 400);
  assert.match((await result.json()).error, /配置生图服务/);
});

test('Image service settings stay on this machine and never expose the key', async () => {
  assert.equal(
    (
      await request(
        '/api/images',
        { baseUrl: 'http://example.com/v1', model: 'mock', size: '1024x1536', mode: 'edit' },
        'PUT',
      )
    ).status,
    400,
  );
  const saved = await json<any>(
    '/api/images',
    {
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'mock-image',
      apiKey: 'image-secret-for-test',
      size: '1024x1024',
      mode: 'edit',
    },
    'PUT',
  );
  assert.equal(saved.hasApiKey, true);
  assert.equal(saved.size, '1024x1024');
  assert.ok(!JSON.stringify(saved).includes('image-secret-for-test'));
  const read = await json<any>('/api/images');
  assert.equal(read.model, 'mock-image');
  assert.ok((await request('/api/images/check', {})).ok);
});

test('Reference-image generation stores variants locally and they can be published as draft assets', async (t) => {
  const { createServer } = await import('node:http');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5p8AAAAASUVORK5CYII=',
    'base64',
  );
  const provider = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/models') {
        res.end(JSON.stringify({ data: [{ id: 'mock-image' }] }));
        return;
      }
      if (req.url === '/v1/images/edits' && !raw.includes('mock-unsupported')) {
        assert.ok(raw.includes('name="prompt"'), 'edit request must carry the prompt');
        res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
        return;
      }
      if (req.url === '/v1/images/generations') {
        res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { message: 'images/edits not supported' } }));
    });
  });
  provider.listen(0, '127.0.0.1');
  await new Promise<void>((r) => provider.once('listening', r));
  t.after(() => provider.close());
  const port = (provider.address() as { port: number }).port;
  await json(
    '/api/images',
    {
      baseUrl: 'http://127.0.0.1:' + port + '/v1',
      model: 'mock-image',
      apiKey: '',
      size: '1024x1536',
      mode: 'edit',
    },
    'PUT',
  );
  const checked = await json<{ ok: boolean; message: string }>('/api/images/check', {});
  assert.equal(checked.ok, true);
  assert.match(checked.message, /mock-image/);

  const invalid = await request('/api/images/variants', {
    images: ['data:image/png;base64,' + Buffer.from('png-bytes').toString('base64')],
    prompt: '拒绝伪造图片',
    count: 1,
  });
  assert.equal(invalid.status, 502);
  assert.match((await invalid.json()).error, /不是 PNG/);
  const source = png.toString('base64');
  const generated = await json<import('../shared/types.ts').ImageGeneration>(
    '/api/images/variants',
    {
      images: ['data:image/png;base64,' + source],
      prompt: '保留构图与主体，替换为我的品牌',
      count: 1,
    },
  );
  assert.equal(generated.items.length, 1);
  assert.match(generated.items[0].url, /^\/api\/media\/[a-f0-9-]+\.png$/);
  assert.equal(generated.items[0].source, 'data:image/png;base64,' + source);
  const file = await fetch(base + generated.items[0].url);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await file.arrayBuffer()).length, png.length);

  const snapshot = await state();
  const draft = await json<Draft>('/api/drafts', {
    noteId: snapshot.notes[0].id,
    title: 'AI 重绘草稿',
    body: '用生成图替换素材',
    tags: ['测试'],
    images: [generated.items[0].url],
    visibility: 'public',
    accountId: snapshot.accounts[0].id,
    platform: 'xiaohongshu',
    kind: 'image',
    origin: 'clone',
  });
  assert.deepEqual(draft.images, [generated.items[0].url]);

  await json(
    '/api/images',
    {
      baseUrl: 'http://127.0.0.1:' + port + '/v1',
      model: 'mock-unsupported',
      apiKey: '',
      size: '1024x1536',
      mode: 'edit',
    },
    'PUT',
  );
  const unsupported = await request('/api/images/variants', {
    images: ['data:image/png;base64,' + source],
    prompt: '保留构图',
    count: 1,
  });
  assert.equal(unsupported.status, 502);
  assert.match((await unsupported.json()).error, /不支持图生图/);
});

test('Image settings reuse the chat service, sync models and test a real generation', async (t) => {
  const { createServer } = await import('node:http');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5p8AAAAASUVORK5CYII=',
    'base64',
  );
  let generationBody = '';
  const provider = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/models')
        return res.end(JSON.stringify({ data: [{ id: 'mock-image' }, { id: 'mock-image-pro' }] }));
      if (req.url === '/v1/images/generations') generationBody = body;
      if (req.url === '/v1/images/generations' || req.url === '/v1/images/edits')
        return res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { message: 'not found' } }));
    });
  });
  provider.listen(0, '127.0.0.1');
  await new Promise<void>((r) => provider.once('listening', r));
  t.after(() => provider.close());
  const port = (provider.address() as { port: number }).port;
  const llmBase = 'http://127.0.0.1:' + port + '/v1';
  await json(
    '/api/llm',
    {
      enabled: false,
      baseUrl: llmBase,
      model: 'example-chat',
      apiKey: 'reuse-key-for-test',
      maxComments: 100,
    },
    'PUT',
  );

  const reused = await json<{
    settings: import('../shared/types.ts').ImageSettings;
    copiedKey: boolean;
  }>('/api/images/reuse-llm', {});
  assert.equal(reused.settings.baseUrl, llmBase);
  assert.equal(reused.copiedKey, true);
  assert.equal(reused.settings.hasApiKey, true);
  // 对话模型不能当生图模型用，复用只搬地址与 Key
  assert.equal(reused.settings.model, 'mock-unsupported');

  const synced = await json<import('../shared/types.ts').ImageSettings>(
    '/api/images/models/sync',
    {},
  );
  assert.ok(
    ['mock-image', 'mock-image-pro'].every((id) =>
      synced.models.some((m) => m.id === id && !m.custom),
    ),
  );
  assert.ok(synced.modelsSyncedAt);

  await json(
    '/api/images',
    {
      baseUrl: llmBase,
      model: 'mock-unsupported',
      size: '1024x1536',
      mode: 'generate',
      watermark: false,
    },
    'PUT',
  );
  const tested = await json<{ model: string; sample: string; via: string }>('/api/images/test', {});
  assert.equal(tested.via, 'generations');
  assert.match(generationBody, /"watermark_enabled":false/);
  assert.match(tested.sample, /^\/api\/media\/[a-f0-9-]+\.png$/);
  assert.equal((await fetch(base + tested.sample)).status, 200);
});

test('Copy rewrite rewrites instead of copying, and refuses sensitive topics', async (t) => {
  const { createServer } = await import('node:http');
  const answer = {
    titles: ['装修预算别乱花，先看这三处', '装修预算别乱花，先看这三处', '90%的人都把预算花反了'],
    hooks: ['先说结论：预算要先给看不见的地方。', '装修最容易超支的不是材料。'],
    body: '先说结论：预算要先给看不见的地方。\n水电、防水、五金这三处省不得，后面返工更贵。\n你家预算最先砍的是哪一项？',
    tags: ['#装修', '预算', '装修避坑'],
    avoid: ['最', '第一'],
  };
  const provider = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url !== '/v1/chat/completions') {
        res.statusCode = 404;
        return res.end('{}');
      }
      const raw = Buffer.concat(chunks).toString();
      const content = raw.includes('bad-json-model') ? '不是 JSON' : JSON.stringify(answer);
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  provider.listen(0, '127.0.0.1');
  await new Promise<void>((r) => provider.once('listening', r));
  t.after(() => provider.close());
  const port = (provider.address() as { port: number }).port;
  const baseUrl = 'http://127.0.0.1:' + port + '/v1';
  await json(
    '/api/llm',
    {
      enabled: false,
      baseUrl,
      model: 'copy-model',
      apiKey: 'copy-key-for-test',
      maxComments: 100,
    },
    'PUT',
  );

  const note = (await state()).notes.find((n) => n.title && n.body.length > 30)!;
  const result = await json<import('../shared/types.ts').CopyRewrite>('/api/copy/rewrite', {
    noteId: note.id,
    style: 'spoken',
  });
  assert.equal(result.titles.length, 2);
  assert.ok(result.titles.every((title) => title.length <= 20));
  assert.deepEqual(result.tags, ['装修', '预算', '装修避坑']);
  assert.ok(result.body.includes('\n'));
  assert.ok(result.overlap >= 0 && result.overlap <= 1);
  assert.equal(result.model, 'copy-model');
  assert.ok(result.hooks.length >= 2);
  assert.deepEqual(result.avoid, ['最', '第一']);

  const sensitive = {
    ...note,
    id: 'copy-sensitive-note',
    title: 'HPV治疗记录',
    body: '公开健康主题',
  };
  const { put, remove } = await import('../server/store.ts');
  put('notes', sensitive);
  const blocked = await request('/api/copy/rewrite', { noteId: sensitive.id });
  assert.equal(blocked.status, 400);
  assert.match((await blocked.json()).error, /敏感主题/);
  remove('notes', sensitive.id);

  await json(
    '/api/llm',
    {
      enabled: false,
      baseUrl,
      model: 'bad-json-model',
      maxComments: 100,
    },
    'PUT',
  );
  const broken = await request('/api/copy/rewrite', { noteId: note.id });
  assert.equal(broken.status, 502);
});

test('Model libraries accept custom text and image models and expose them for selection', async () => {
  const text = await json<import('../shared/types.ts').LlmSettings>('/api/llm/models', {
    id: 'glm-custom-test',
  });
  const custom = text.models.find((m) => m.id === 'glm-custom-test');
  assert.equal(custom?.custom, true);
  assert.equal(text.model, 'bad-json-model');

  const dup = await json<import('../shared/types.ts').LlmSettings>('/api/llm/models', {
    id: 'glm-custom-test',
  });
  assert.equal(dup.models.filter((m) => m.id === 'glm-custom-test').length, 1);

  assert.equal((await request('/api/llm/models', { id: 'bad model!' })).status, 400);

  const removed = await json<import('../shared/types.ts').LlmSettings>(
    '/api/llm/models/glm-custom-test',
    undefined,
    'DELETE',
  );
  assert.ok(!removed.models.some((m) => m.id === 'glm-custom-test'));

  const image = await json<import('../shared/types.ts').ImageSettings>('/api/images/models', {
    id: 'cogview-4',
  });
  assert.equal(image.models.find((m) => m.id === 'cogview-4')?.custom, true);
  assert.equal(image.model, 'mock-unsupported');
  const imageRemoved = await json<import('../shared/types.ts').ImageSettings>(
    '/api/images/models/cogview-4',
    undefined,
    'DELETE',
  );
  assert.ok(!imageRemoved.models.some((m) => m.id === 'cogview-4'));
});

test('Multiple model services keep separate addresses, keys and models', async () => {
  const before = await json<import('../shared/types.ts').LlmSettings>('/api/llm');
  assert.equal(
    (
      await request('/api/services', {
        kind: 'text',
        name: '',
        baseUrl: 'https://example.com/v1',
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request('/api/services', {
        kind: 'text',
        name: '明文 HTTP',
        baseUrl: 'http://example.com/v1',
      })
    ).status,
    400,
  );

  const created = await json<import('../shared/types.ts').ModelService>('/api/services', {
    kind: 'text',
    name: '备用服务',
    baseUrl: 'https://example.com/v1',
    apiKey: 'second-key',
    model: 'backup-model',
  });
  assert.equal(created.active, true);
  assert.equal(created.hasApiKey, true);
  const switched = await json<import('../shared/types.ts').LlmSettings>('/api/llm');
  assert.equal(switched.baseUrl, 'https://example.com/v1');
  assert.equal(switched.model, 'backup-model');
  assert.equal(switched.hasApiKey, true);
  assert.ok(switched.models.some((m) => m.id === 'backup-model'));

  const list = await json<import('../shared/types.ts').ModelService[]>('/api/services?kind=text');
  assert.ok(list.length >= 2);
  assert.ok(!JSON.stringify(list).includes('second-key'));
  const previous = list.find((s) => !s.active)!;
  await json('/api/services/' + previous.id + '/activate', {});
  const restored = await json<import('../shared/types.ts').LlmSettings>('/api/llm');
  assert.equal(restored.baseUrl, before.baseUrl);
  assert.equal(restored.model, before.model);

  await json('/api/services/' + created.id, undefined, 'DELETE');
  assert.ok(
    !(await json<import('../shared/types.ts').ModelService[]>('/api/services?kind=text')).some(
      (s) => s.id === created.id,
    ),
  );
});

test('video draft bundles contain the original uploaded video bytes', async () => {
  const { writeFileSync } = await import('node:fs');
  const JSZip = (await import('jszip')).default;
  const bytes = Buffer.from('test-video-bytes');
  writeFileSync(join(dir, 'uploads', 'abcdef.mp4'), bytes);
  const draft = await json<Draft>('/api/drafts', {
    noteId: '',
    origin: 'original',
    kind: 'video',
    title: '视频导出测试',
    body: '正文',
    tags: [],
    images: [],
    video: '/api/media/abcdef.mp4',
    visibility: 'private',
    accountId: (await state()).accounts[0].id,
  });
  const response = await request(`/api/drafts/${draft.id}/bundle`);
  assert.equal(response.status, 200);
  const zip = await JSZip.loadAsync(await response.arrayBuffer());
  assert.deepEqual(await zip.file('video.mp4')!.async('nodebuffer'), bytes);
});

test('stale CRM edits are rejected and current manual changes survive', async () => {
  const lead = (await state()).leads[0];
  const path = '/api/leads/' + encodeURIComponent(lead.id);
  const revision = lead.revision || 0;
  assert.equal((await request(path, { revision, memo: '窗口A的记录' }, 'PATCH')).status, 200);
  assert.equal((await request(path, { revision, memo: '窗口B的旧记录' }, 'PATCH')).status, 409);
  assert.equal((await request(path, { memo: '缺少版本' }, 'PATCH')).status, 400);
  assert.equal((await state()).leads.find((l) => l.id === lead.id)?.memo, '窗口A的记录');
});

test('draft optimistic revisions reject stale edits, deleted records and missing local media', async () => {
  const note = (await state()).notes[0];
  const input = {
    noteId: note.id,
    title: '草稿并发',
    body: '',
    tags: [],
    images: note.images,
    visibility: 'private',
    accountId: 'demo-account',
  };
  const d = await json<Draft>('/api/drafts', input);
  const newer = await json<Draft>('/api/drafts', {
    ...input,
    id: d.id,
    revision: d.revision,
    title: '窗口A',
  });
  assert.equal(
    (await request('/api/drafts', { ...input, id: d.id, revision: d.revision, title: '窗口B' }))
      .status,
    409,
  );
  assert.equal((await state()).drafts.find((x) => x.id === d.id)?.title, '窗口A');
  assert.equal(
    (await request('/api/drafts', { ...input, images: ['/api/media/deadbeef.png'] })).status,
    400,
  );
  await request('/api/drafts/' + d.id, undefined, 'DELETE');
  assert.equal(
    (await request('/api/drafts', { ...input, id: d.id, revision: newer.revision })).status,
    404,
  );
});
