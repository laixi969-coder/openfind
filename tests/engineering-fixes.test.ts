import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Draft, Comment, Job, Lead } from '../shared/types.ts';

const root = mkdtempSync(join(tmpdir(), 'openfind-engineering-'));
process.env.NODE_ENV = 'test';
process.env.OPENFIND_DATA_DIR = join(root, 'data');
const { app } = await import('../server/index.ts');
const { db, put, get, all, remove, configSet, configGet, encrypt, decrypt, transaction } =
  await import('../server/store.ts');
const { providerCall, schemas } = await import('../server/provider.ts');
const { journaledFetch, UncertainRequestError, captureRequestReceipts } =
  await import('../server/request-journal.ts');
const { createService } = await import('../server/services.ts');
const { completion, reviewSemantics, semanticFor, saveLlmSettings } =
  await import('../server/llm.ts');
const { modelBudget, modelPolicy, saveModelPolicy, withModelOperation } =
  await import('../server/model-safety.ts');
const { demoNotes, demoComments } = await import('../server/demo.ts');
const { toLead } = await import('../server/domain.ts');
const { cleanupPlan, executeCleanup, forgetPlan, forgetCustomer } =
  await import('../server/data-maintenance.ts');
const { runAutomaticBackup, backupStatus, managedBackups, withBackupLease } =
  await import('../server/auto-backup.ts');
const { validateCollectionState } = await import('../server/collection-integrity.ts');
const { commitJobPage } = await import('../server/job-progress.ts');
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((r) => server.once('listening', r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const originalFetch = globalThis.fetch;
const request = (
  path: string,
  body?: unknown,
  method?: string,
  headers: Record<string, string> = {},
) =>
  originalFetch(base + '/api' + path, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const setting = {
  mode: 'live',
  providerUrl: 'https://old.example/v1',
  token: 'fake-token',
  cookie: 'fake-cookie',
  rememberCookie: true,
  accountName: 'test',
  accountId: 'audit-account',
  connectionType: 'http',
};
after(async () => {
  globalThis.fetch = originalFetch;
  await new Promise<void>((r) => server.close(() => r()));
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('adapter changes reject omitted credentials before mutation and refuse insecure saved URLs at dispatch', async () => {
  assert.equal((await request('/settings', setting, 'PUT')).status, 200);
  const { token: _token, cookie: _cookie, ...change } = setting;
  assert.equal(
    (await request('/settings', { ...change, providerUrl: 'https://new.example/v1' }, 'PUT'))
      .status,
    400,
  );
  assert.equal(configGet('providerUrl'), setting.providerUrl);
  assert.equal(decrypt(configGet('token')), setting.token);
  assert.equal(
    (
      await request('/accounts', {
        id: 'second-account',
        name: 'second',
        platform: 'douyin',
        cookie: 'other-cookie',
        rememberCookie: true,
      })
    ).status,
    201,
  );
  for (const providerUrl of [
    'http://external.example/v1',
    'https://user:pass@example.com',
    'https://example.com/?secret=1',
  ])
    assert.equal((await request('/settings', { ...setting, providerUrl }, 'PUT')).status, 400);
  assert.equal(
    (
      await request(
        '/settings',
        { ...setting, providerUrl: 'https://new.example/v1', token: '', cookie: '' },
        'PUT',
      )
    ).status,
    200,
  );
  assert.equal(configGet('token'), '');
  assert.equal(configGet('cookie:audit-account'), '');
  await assert.rejects(
    providerCall('/health', { accountId: 'second-account' }, schemas.health),
    /其他适配器/,
  );
  configSet('providerUrl', 'http://legacy-insecure.example');
  await assert.rejects(providerCall('/health', {}, schemas.health), /HTTPS/);
  configSet('providerUrl', '');
});

test('result refresh rejects edits and deletion that happen while awaiting the provider', async () => {
  configSet('xhs.provider', 'redfox');
  configSet('xhs.key.redfox', encrypt('fake'));
  const draft: Draft = {
    id: 'race',
    revision: 1,
    noteId: '',
    origin: 'original',
    title: 'initial',
    body: '',
    tags: [],
    images: ['/assets/cover-1.svg'],
    platform: 'xiaohongshu',
    kind: 'image',
    visibility: 'private',
    accountId: 'audit-account',
    knowledgeIds: [],
    status: 'draft',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  for (const action of ['edit', 'delete']) {
    put('drafts', draft);
    let started!: () => void, release!: () => void;
    const gate = new Promise<void>((r) => {
        release = r;
      }),
      pending = new Promise<void>((r) => {
        started = r;
      });
    globalThis.fetch = (async (url, init) => {
      if (String(url).startsWith('https://redfox.hk/')) {
        started();
        await gate;
        return new Response(
          JSON.stringify({ code: 2000, data: { workId: 'fake', workTitle: 'result' } }),
        );
      }
      return originalFetch(url, init);
    }) as typeof fetch;
    const saving = request('/drafts/race/result', {
      url: 'https://www.xiaohongshu.com/explore/fake',
    });
    try {
      await pending;
      assert.equal((await request('/maintenance/cleanup', {})).status, 409);
      assert.equal(
        (
          await request(
            '/drafts' + (action === 'delete' ? '/race' : ''),
            action === 'delete' ? undefined : { ...draft, title: 'new title' },
            action === 'delete' ? 'DELETE' : 'POST',
          )
        ).status,
        action === 'delete' ? 200 : 201,
      );
      release();
      assert.equal((await saving).status, 409);
      assert.equal(
        get<Draft>('drafts', draft.id)?.title,
        action === 'delete' ? undefined : 'new title',
      );
    } finally {
      release();
      await saving;
      globalThis.fetch = originalFetch;
    }
  }
});

test('stream byte cap cancels during receipt ingestion and preserves the uncertain anti-replay guard', async () => {
  let calls = 0,
    cancelled = false;
  const call = journaledFetch(
    'oversized-stream',
    (async () => {
      calls++;
      return new Response(
        new ReadableStream({
          pull(c) {
            c.enqueue(new Uint8Array(9));
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    }) as typeof fetch,
    undefined,
    false,
    false,
    16,
  );
  await assert.rejects(call('https://synthetic.example'), /大小限制/);
  assert.ok(cancelled);
  await assert.rejects(call('https://synthetic.example'), UncertainRequestError);
  assert.equal(calls, 1);
});

test('workspace conditional requests reuse the snapshot, compress it and invalidate after SQLite writes', async () => {
  const first = await request('/state');
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('content-encoding'), 'gzip');
  const etag = first.headers.get('etag')!;
  await first.json();
  const cached = await request('/state', undefined, 'GET', { 'if-none-match': etag });
  assert.equal(cached.status, 304);
  assert.equal(await cached.text(), '');
  put('drafts', { id: 'etag-test', title: 'changed' });
  const changed = await request('/state', undefined, 'GET', { 'if-none-match': etag });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get('etag'), etag);
  assert.ok((await changed.json()).drafts.some((d: Draft) => d.id === 'etag-test'));
  remove('drafts', 'etag-test');
});

test('model retries replay once, enforce output and daily caps, and redact every outbound string', async () => {
  const seen: any[] = [];
  const model = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    seen.push(JSON.parse(raw));
    res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
  });
  await new Promise<void>((r) => model.listen(0, '127.0.0.1', r));
  const policy = modelPolicy();
  try {
    createService({
      kind: 'text',
      name: 'safe-test',
      baseUrl: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`,
      model: 'test',
    });
    saveModelPolicy({ ...policy, textRequests: 1, maxOutputTokens: 256 });
    const operation = randomUUID();
    const messages = [
      {
        role: 'user' as const,
        content: JSON.stringify({
          text: 'test@example.com 电话13812345678',
          untouched: 12345678901,
        }),
      },
    ];
    assert.deepEqual(await withModelOperation(operation, () => completion(messages)), { ok: true });
    assert.deepEqual(await withModelOperation(operation, () => completion(messages)), { ok: true });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].max_tokens, 256);
    assert.equal(JSON.parse(seen[0].messages[0].content).untouched, 12345678901);
    assert.ok(!JSON.stringify(seen[0]).includes('test@example.com'));
    assert.ok(!JSON.stringify(seen[0]).includes('13812345678'));
    await assert.rejects(
      withModelOperation(randomUUID(), () => completion(messages)),
      /预算/,
    );
    assert.equal(seen.length, 1);
    assert.equal(modelBudget().usage.textRequests, 1);
  } finally {
    saveModelPolicy(policy);
    await new Promise<void>((r) => model.close(() => r()));
  }
});

test('same-name model services have separate semantic caches and an in-progress review pins its service', async () => {
  const seen: (string | undefined)[] = [];
  let started!: () => void, release!: () => void;
  const first = new Promise<void>((r) => {
      started = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    });
  const model = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    seen.push(req.headers.authorization);
    if (seen.length === 1) {
      started();
      await gate;
    }
    const inputs = JSON.parse(JSON.parse(raw).messages[1].content).untrustedComments;
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                items: inputs.map((i: any) => ({
                  id: i.id,
                  verdict: 'interest',
                  reason: 'test',
                  quotes: [i.comment],
                  limitations: [],
                })),
              }),
            },
          },
        ],
      }),
    );
  });
  await new Promise<void>((r) => model.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`;
  try {
    createService({ kind: 'text', name: 'A', baseUrl, apiKey: 'key-A', model: 'same' });
    saveLlmSettings({ enabled: true, baseUrl, model: 'same', maxComments: 100 });
    const note = { ...demoNotes('家居', 1)[0], title: '家居', body: '', tags: [] };
    const comments = Array.from({ length: 6 }, (_, i) => ({
      ...demoComments(note.id, 1)[0],
      id: 'semantic-' + i,
      authorId: 'customer-' + i,
      body: '这个柜子在哪里可以买',
      createdAt: new Date().toISOString(),
    }));
    const review = reviewSemantics(comments, [note]);
    await first;
    createService({
      kind: 'text',
      name: 'B',
      baseUrl: 'https://other.example/v1',
      apiKey: 'key-B',
      model: 'same',
    });
    release();
    await review;
    assert.deepEqual(seen, ['Bearer key-A', 'Bearer key-A']);
    assert.equal(semanticFor(comments[0], note, comments), undefined);
  } finally {
    release();
    await new Promise<void>((r) => model.close(() => r()));
  }
});

test('cleanup previews protect referenced media and reject changed plans', () => {
  const directory = join(root, 'data', 'uploads');
  mkdirSync(directory, { recursive: true });
  const old = new Date(Date.now() - 90 * 86400000);
  const modelReceipt = all<any>('request-receipts').find((r) => r.category === 'model');
  assert.ok(modelReceipt);
  put('request-receipts', { ...modelReceipt, createdAt: old.toISOString() });
  for (const name of ['aabb.png', 'ccdd.png', 'eeff.tmp']) {
    writeFileSync(join(directory, name), 'test');
    utimesSync(join(directory, name), old, old);
  }
  put('drafts', { id: 'protected', images: ['/api/media/ccdd.png'] });
  const plan = cleanupPlan();
  assert.ok(plan.files.some((f) => f.name === 'aabb.png'));
  assert.ok(!plan.files.some((f) => f.name === 'ccdd.png'));
  put('drafts', { id: 'new-reference', images: ['/api/media/aabb.png'] });
  assert.throws(() => executeCleanup(plan.token), /变化/);
  remove('drafts', 'new-reference');
  executeCleanup(cleanupPlan().token);
  assert.ok(existsSync(join(directory, 'ccdd.png')));
  assert.ok(!existsSync(join(directory, 'aabb.png')));
  assert.ok(!existsSync(join(directory, 'eeff.tmp')));
  assert.equal(get('request-receipts', modelReceipt.id), undefined);
  assert.equal(get<any>('request-guards', modelReceipt.id).state, 'pending');
  validateCollectionState(db);
});

test('customer erasure cascades through checkpoints without deleting a different customer with the same text', async () => {
  const note = {
    ...demoNotes('家居', 1)[0],
    id: 'privacy-note',
    platform: 'douyin' as const,
    source: 'live' as const,
  };
  put('notes', note);
  const c: Comment = {
    ...demoComments(note.id, 1)[0],
    id: 'private-comment',
    noteId: note.id,
    platform: 'douyin',
    source: 'live',
    authorId: 'private-person',
    body: '这个柜子在哪里可以买',
    createdAt: new Date().toISOString(),
  };
  const job: Job = {
    id: 'private-job',
    type: 'comments',
    status: 'completed',
    keyword: '',
    noteId: note.id,
    count: 0,
    pages: 0,
    resultIds: [],
    logs: [],
    source: 'live',
    platform: 'douyin',
    createdAt: new Date().toISOString(),
    elapsed: 0,
  };
  put('jobs', job);
  const receipt = await captureRequestReceipts(() =>
    journaledFetch(
      job.id,
      (async () => new Response(JSON.stringify([c]))) as typeof fetch,
    )('https://fake.example/comments'),
  );
  commitJobPage(
    job,
    {
      keyword: '',
      limit: 10,
      sort: 'general',
      noteType: 'all',
      interval: 1000,
      mode: 'live',
      platform: 'douyin',
    },
    [c],
    undefined,
    receipt.receipts,
  );
  const lead = toLead(c, note, [c]);
  put('leads', lead);
  const other = { ...c, id: 'other-comment', authorId: 'unrelated-person' };
  put('comments', other);
  const otherLead = toLead(other, note, [other]);
  put('leads', otherLead);
  put('salesCases', { id: lead.id, events: [{ content: 'private conversation' }] });
  put('semanticReviewHistory', { id: c.id + ':history', quotes: [c.body] });
  const preview = forgetPlan(lead.id);
  assert.ok(preview.counts['job-pages']);
  forgetCustomer(lead.id, preview.token, false);
  assert.equal(get('leads', lead.id), undefined);
  assert.equal(get('comments', c.id), undefined);
  assert.equal(get('salesCases', lead.id), undefined);
  assert.equal(get('semanticReviewHistory', c.id + ':history'), undefined);
  assert.equal(get('jobs', job.id), undefined);
  assert.ok(get('comments', other.id));
  assert.ok(get('leads', otherLead.id));
  validateCollectionState(db);
  await assert.rejects(
    journaledFetch(job.id, (async () => {
      throw Error('must not dispatch');
    }) as typeof fetch)('https://fake.example/comments'),
    UncertainRequestError,
  );
});

test('automatic backup runs a checked snapshot, reports freshness, and excludes overlapping maintenance', async () => {
  const { backupDirectory } = await import('../server/auto-backup.ts');
  assert.throws(() => backupDirectory(join(root, 'data', '..hidden')), /之外/);
  const { createBackup } = await import('../server/data-backup.ts');
  assert.throws(
    () => createBackup(join(root, 'data'), join(root, 'data', '..hidden')),
    /源数据目录/,
  );
  await runAutomaticBackup();
  assert.ok(backupStatus().lastSuccess);
  assert.equal(backupStatus().stale, false);
  assert.equal(managedBackups().length, 1);
  assert.ok(existsSync(join(managedBackups()[0], '.credential-key')));
  await withBackupLease(async () => {
    await assert.rejects(
      withBackupLease(async () => {}),
      /正在进行/,
    );
  });
});
