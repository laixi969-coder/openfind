import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type RequestListener } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = mkdtempSync(join(tmpdir(), 'openfind-regressions-'));
process.env.NODE_ENV = 'test';
process.env.OPENFIND_DATA_DIR = join(root, 'data');
const { app } = await import('../server/index.ts');
const { db, put, get, all, configGet, configSet } = await import('../server/store.ts');
const { providerCall, schemas, setSessionCookie } = await import('../server/provider.ts');
const { createService } = await import('../server/services.ts');
const { modelPolicy, saveModelPolicy, withModelOperation, ModelOperationConflict } =
  await import('../server/model-safety.ts');
const { completion, reviewSemantics, saveLlmSettings } = await import('../server/llm.ts');
const { forgetPlan, forgetCustomer } = await import('../server/data-maintenance.ts');
const { journaledFetch, UncertainRequestError } = await import('../server/request-journal.ts');
const { createInsight, digestComments, adoptCandidates } = await import('../server/insights.ts');
const { demoNotes, demoComments } = await import('../server/demo.ts');
const { toLead, withCommentIndex, commentThread, assessComment } =
  await import('../server/domain.ts');
const { validateCollectionState } = await import('../server/collection-integrity.ts');
const apiServer = app.listen(0, '127.0.0.1');
await new Promise<void>((r) => apiServer.once('listening', r));
const apiBase = `http://127.0.0.1:${(apiServer.address() as { port: number }).port}`;
async function request(path: string, body: unknown, method = 'POST', id?: string) {
  return fetch(apiBase + '/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(id ? { 'Idempotency-Key': id } : {}) },
    body: JSON.stringify(body),
  });
}
async function serve(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}
const close = (s: ReturnType<typeof createServer>) => new Promise<void>((r) => s.close(() => r()));
after(async () => {
  await close(apiServer);
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('saving another old account cannot rebind its Cookie, but explicit replacement and clearing work', async () => {
  let calls = 0;
  const target = await serve(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    assert.equal(JSON.parse(body).cookie, 'new-cookie');
    calls++;
    res.end(JSON.stringify({ ok: true }));
  });
  try {
    const initial = {
      mode: 'live',
      connectionType: 'http',
      providerUrl: 'https://old.invalid',
      token: '',
      cookie: 'first-cookie',
      rememberCookie: true,
      accountId: 'cookie-first',
      accountName: 'first',
    };
    assert.equal((await request('/settings', initial, 'PUT')).status, 200);
    assert.equal(
      (
        await request('/accounts', {
          id: 'cookie-second',
          name: 'second',
          cookie: 'old-cookie',
          rememberCookie: true,
        })
      ).status,
      201,
    );
    assert.equal(
      (await request('/settings', { ...initial, providerUrl: target.base, cookie: '' }, 'PUT'))
        .status,
      200,
    );
    const { cookie, token, ...omitted } = initial;
    const second = {
      ...omitted,
      providerUrl: target.base,
      accountId: 'cookie-second',
      accountName: 'second',
    };
    const binding = configGet('cookieProvider:cookie-second');
    // This is the exact body sent when switching accounts in SettingsPage.
    assert.equal((await request('/settings', second, 'PUT')).status, 400);
    assert.equal(configGet('accountId'), 'cookie-first');
    assert.equal(configGet('cookieProvider:cookie-second'), binding);
    // The persisted binding also protects a remembered Cookie after process-memory loss.
    setSessionCookie('', 'cookie-second');
    assert.equal((await request('/settings', second, 'PUT')).status, 400);
    await assert.rejects(
      providerCall('/health', { accountId: 'cookie-second' }, schemas.health),
      /其他适配器/,
    );
    assert.equal(calls, 0);
    assert.equal(
      (await request('/settings', { ...second, cookie: 'new-cookie' }, 'PUT')).status,
      200,
    );
    await providerCall('/health', { accountId: 'cookie-second' }, schemas.health);
    assert.equal(calls, 1);
    assert.equal(
      (await request('/settings', { ...second, cookie: '', rememberCookie: false }, 'PUT')).status,
      200,
    );
    assert.equal(configGet('cookie:cookie-second'), '');
  } finally {
    await close(target.server);
  }
});

test('uncertain model retries cannot change output limit, provider, key or referenced input under the same operation', async () => {
  let calls = 0;
  const target = await serve(async (req) => {
    for await (const _ of req) {
      /* consume before simulating a lost response */
    }
    calls++;
    req.socket.destroy();
  });
  const policy = modelPolicy();
  try {
    createService({
      kind: 'text',
      name: 'retry',
      baseUrl: target.base,
      model: 'fake',
      apiKey: 'old-key',
    });
    saveModelPolicy({ ...policy, maxOutputTokens: 256 });
    const id = randomUUID();
    assert.equal((await request('/llm/test', {}, 'POST', id)).status, 500);
    assert.equal((await request('/llm/test', {}, 'POST', id)).status, 500);
    assert.equal(calls, 1);
    saveModelPolicy({ ...policy, maxOutputTokens: 512 });
    assert.equal((await request('/llm/test', {}, 'POST', id)).status, 409);
    createService({
      kind: 'text',
      name: 'replacement',
      baseUrl: target.base + '/v1',
      model: 'fake',
      apiKey: 'new-key',
    });
    assert.equal((await request('/llm/test', {}, 'POST', id)).status, 409);
    assert.equal(calls, 1);

    const operation = randomUUID();
    const original = [{ role: 'user' as const, content: 'initial referenced note' }];
    await assert.rejects(withModelOperation(operation, () => completion(original)));
    assert.equal(calls, 2);
    await assert.rejects(
      withModelOperation(operation, () =>
        completion([{ role: 'user', content: 'edited referenced note' }]),
      ),
      ModelOperationConflict,
    );
    assert.equal(calls, 2);
    // A new process must observe the same durable binding before making any call.
    const child = await promisify(execFile)(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `
      const { withModelOperation } = await import('./server/model-safety.ts');
      const { completion } = await import('./server/llm.ts');
      try { await withModelOperation(${JSON.stringify(operation)}, () => completion([{role:'user',content:'edited after restart'}])); process.exitCode = 1; }
      catch (e) { if (e.statusCode !== 409) throw e; }
    `,
      ],
      { env: process.env },
    );
    assert.equal(child.stdout, '');
    assert.equal(calls, 2);
    // Optional keyword enrichment must not disguise an uncertain paid call as HTTP 200.
    const keywordId = randomUUID();
    const keywords = { platform: 'douyin', seed: '柜子', limit: 20 };
    assert.equal((await request('/insights/keywords', keywords, 'POST', keywordId)).status, 502);
    assert.equal(calls, 3);
    saveModelPolicy({ ...policy, maxOutputTokens: 768 });
    assert.equal((await request('/insights/keywords', keywords, 'POST', keywordId)).status, 409);
    assert.equal(calls, 3);
  } finally {
    saveModelPolicy(policy);
    await close(target.server);
  }
});

test('pre-upgrade HTTP operation identities are fenced instead of silently creating new paid calls', async () => {
  const id = randomUUID();
  const hash = createHash('sha256').update('POST/llm/test{}').digest('hex');
  put('model-operations', { id, hash });
  assert.equal((await request('/llm/test', {}, 'POST', id)).status, 409);
});

test('semantic review retries preserve batch membership and do not charge again after an uncertain later batch', async () => {
  let calls = 0;
  const target = await serve(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    calls++;
    if (calls === 2) {
      req.socket.destroy();
      return;
    }
    const inputs = JSON.parse(JSON.parse(body).messages[1].content).untrustedComments;
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                items: inputs.map((c: any) => ({
                  id: c.id,
                  verdict: 'interest',
                  reason: 'test',
                  quotes: [c.comment],
                  limitations: [],
                })),
              }),
            },
          },
        ],
      }),
    );
  });
  try {
    createService({ kind: 'text', name: 'batches', baseUrl: target.base, model: 'fake' });
    saveLlmSettings({ enabled: true, baseUrl: target.base, model: 'fake', maxComments: 100 });
    const note = {
      ...demoNotes('家居', 1)[0],
      id: 'batch-note',
      title: '柜子',
      body: '',
      tags: [],
    };
    const comments = Array.from({ length: 6 }, (_, i) => ({
      ...demoComments(note.id, 1)[0],
      id: `batch-comment-${i}`,
      parentId: null,
      authorId: `person-${i}`,
      body: '这个柜子怎么买',
      createdAt: new Date().toISOString(),
    }));
    const id = randomUUID();
    await assert.rejects(
      withModelOperation(id, () => reviewSemantics(comments, [note])),
      UncertainRequestError,
    );
    assert.equal(calls, 2);
    assert.equal(
      all<any>('semanticReviews').filter((c) => c.id.startsWith('batch-comment-')).length,
      5,
    );
    await assert.rejects(
      withModelOperation(id, () => reviewSemantics(comments, [note])),
      UncertainRequestError,
    );
    assert.equal(calls, 2);
    // Recovering a partially persisted successful batch must replay the original full batch.
    db.prepare("DELETE FROM entities WHERE kind='semanticReviews' AND id='batch-comment-0'").run();
    await assert.rejects(
      withModelOperation(id, () => reviewSemantics(comments, [note])),
      UncertainRequestError,
    );
    assert.ok(get('semanticReviews', 'batch-comment-0'));
    assert.equal(calls, 2);
  } finally {
    await close(target.server);
  }
});

test('erasure removes redacted model outputs by provenance and preserves equal-text unrelated cards and receipts', async () => {
  const note = {
    ...demoNotes('家居', 1)[0],
    id: 'erase-note',
    source: 'live' as const,
    platform: 'douyin' as const,
  };
  put('notes', note);
  const c = {
    ...demoComments(note.id, 1)[0],
    id: 'erase-comment',
    noteId: note.id,
    source: 'live' as const,
    platform: 'douyin' as const,
    authorId: 'erase-person',
    body: '这个柜子在哪里可以买',
    createdAt: new Date().toISOString(),
  };
  put('comments', c);
  const lead = toLead(c, note, [c]);
  put('leads', lead);
  const unrelated = createInsight({
    platform: 'xiaohongshu',
    source: 'manual',
    sourceNoteId: 'different-note',
    kind: 'pain',
    title: '其他作品问题',
    body: '常见问题',
    evidence: [c.body],
  });
  const related = createInsight({
    platform: 'douyin',
    source: 'comments',
    kind: 'pain',
    title: '本客户问题',
    body: '派生改写内容',
    sources: [{ kind: 'comments', id: c.id }],
    evidence: [],
  });
  const derivedCard = createInsight({
    platform: 'douyin',
    source: 'comments',
    kind: 'pain',
    title: '二次归纳',
    body: '进一步改写',
    sources: [{ kind: 'insights', id: related.id }],
  });
  const collect = async (
    scope: string,
    sources: { kind: 'comments' | 'insights' | 'notes'; id: string }[],
    body: string,
  ) => {
    await journaledFetch(
      scope,
      (async () => new Response(body)) as typeof fetch,
      undefined,
      false,
      false,
      2000000,
      'model',
      sources,
    )('https://fake.invalid', { method: 'POST' });
    return all<any>('request-receipts').find((r) => r.response?.body === body)!.id;
  };
  const relatedReceipt = await collect(
    'erase-related',
    [{ kind: 'comments', id: c.id }],
    '{"quote":"测试小区三栋联系[号码已隐藏]"}',
  );
  const derivedReceipt = await collect(
    'erase-derived',
    [{ kind: 'insights', id: derivedCard.id }],
    '{"body":"已经完全改写的客户分析"}',
  );
  const unrelatedReceipt = await collect(
    'erase-unrelated',
    [{ kind: 'comments', id: 'different-customer' }],
    JSON.stringify({ quote: c.body }),
  );
  const sameIdOtherKind = await collect(
    'erase-same-id-other-kind',
    [{ kind: 'notes', id: c.id }],
    JSON.stringify({ quote: c.id }),
  );
  const plan = forgetPlan(lead.id);
  assert.equal(plan.legacyModelReceipts.length, 0);
  forgetCustomer(lead.id, plan.token, false);
  assert.equal(get('comments', c.id), undefined);
  assert.equal(get('insights', related.id), undefined);
  assert.equal(get('insights', derivedCard.id), undefined);
  assert.ok(get('insights', unrelated.id));
  assert.ok(get('request-receipts', unrelatedReceipt));
  assert.ok(get('request-receipts', sameIdOtherKind));
  assert.equal(get('request-receipts', relatedReceipt), undefined);
  assert.equal(get('request-receipts', derivedReceipt), undefined);
  assert.equal(get<any>('request-guards', relatedReceipt).state, 'pending');
  validateCollectionState(db);
  await assert.rejects(
    journaledFetch('erase-related', (async () => {
      throw Error('must not dispatch');
    }) as typeof fetch)('https://fake.invalid', { method: 'POST' }),
    UncertainRequestError,
  );
});

test('legacy unattributed model responses require explicit consent and leave opaque anti-replay guards', async () => {
  const note = { ...demoNotes('家居', 1)[0], id: 'legacy-erase-note' };
  put('notes', note);
  const c = {
    ...demoComments(note.id, 1)[0],
    id: 'legacy-erase-comment',
    body: '电话联系13812345678，测试小区三栋',
  };
  put('comments', c);
  const lead = toLead(c, note, [c]);
  put('leads', lead);
  await journaledFetch(
    'legacy-erasure',
    (async () => new Response('{"quote":"测试小区三栋[号码已隐藏]"}')) as typeof fetch,
    undefined,
    false,
    false,
    2000000,
    'model',
  )('https://fake.invalid');
  const plan = forgetPlan(lead.id);
  assert.equal(plan.legacyModelReceipts.length, 1);
  assert.throws(() => forgetCustomer(lead.id, plan.token, false), /旧版模型回执/);
  assert.ok(get('leads', lead.id));
  const response = await request('/maintenance/forget', {
    leadId: lead.id,
    token: plan.token,
    confirm: true,
    includeLegacyModelReceipts: true,
  });
  assert.equal(response.status, 200);
  assert.equal(get('request-receipts', plan.legacyModelReceipts[0]), undefined);
  assert.equal(get<any>('request-guards', plan.legacyModelReceipts[0]).state, 'pending');
  validateCollectionState(db);
});

test('comment-derived cards retain actual model input sources through candidate adoption', async () => {
  const target = await serve(async (req, res) => {
    for await (const _ of req) {
      /* synthetic request */
    }
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                cards: [
                  {
                    kind: 'pain',
                    title: '找不到购买渠道',
                    body: '说明购买方式',
                    tags: [],
                    evidence: ['这个柜子在哪里可以买'],
                  },
                ],
              }),
            },
          },
        ],
      }),
    );
  });
  try {
    createService({ kind: 'text', name: 'card-sources', baseUrl: target.base, model: 'fake' });
    const note = { ...demoNotes('家居', 1)[0], id: 'card-note', platform: 'douyin' as const };
    put('notes', note);
    const comments = Array.from({ length: 5 }, (_, i) => ({
      ...demoComments(note.id, 1)[0],
      id: `card-comment-${i}`,
      noteId: note.id,
      platform: 'douyin' as const,
      body: '这个柜子在哪里可以买',
      createdAt: new Date().toISOString(),
    }));
    comments.forEach((c) => put('comments', c));
    const digest = await digestComments({ platform: 'douyin', noteIds: [note.id], limit: 5 });
    const saved = adoptCandidates({ platform: 'douyin', source: 'comments', cards: digest.cards });
    assert.deepEqual(
      new Set(saved[0].sources?.map((r) => r.id)),
      new Set(comments.map((c) => c.id)),
    );
    const receipt = all<any>('request-receipts').find((r) =>
      r.sources?.some((s: any) => s.id === comments[0].id),
    );
    assert.ok(receipt);
    const lead = toLead(comments[0], note, comments);
    put('leads', lead);
    const plan = forgetPlan(lead.id);
    forgetCustomer(lead.id, plan.token, false);
    assert.equal(get('insights', saved[0].id), undefined);
    assert.equal(get('request-receipts', receipt.id), undefined);
  } finally {
    await close(target.server);
  }
});

test('indexed comment threads preserve scoped, nested, missing-parent and cyclic assessments', () => {
  const note = { ...demoNotes('家居', 1)[0], authorId: 'creator' };
  const seed = demoComments(note.id, 1)[0];
  const comments = Array.from({ length: 18 }, (_, i) => ({
    ...seed,
    id: `index-${i}`,
    parentId: i ? `index-${i - 1}` : null,
    source: 'live' as const,
    platform: i % 4 === 0 ? undefined : ('douyin' as const),
    authorId: i % 3 ? 'customer' : 'creator',
    body: i % 3 ? '我也想要' : '这个柜子在哪里买',
    createdAt: new Date().toISOString(),
  }));
  comments.push({ ...comments[0], id: 'missing', parentId: 'does-not-exist' });
  comments.push({ ...comments[0], id: 'cycle-a', parentId: 'cycle-b' });
  comments.push({ ...comments[0], id: 'cycle-b', parentId: 'cycle-a' });
  comments.push({ ...comments[0], id: 'other-note', noteId: 'unrelated' });
  const now = Date.now();
  const expected = comments.map((c) => ({
    thread: commentThread(c, comments),
    assessment: assessComment(c, note, now, comments),
  }));
  const actual = withCommentIndex(comments, () =>
    comments.map((c) => ({
      thread: commentThread(c, comments),
      assessment: assessComment(c, note, now, comments),
    })),
  );
  assert.deepEqual(actual, expected);
  comments.push({ ...comments[0], id: 'new-after-snapshot', parentId: 'index-0' });
  assert.ok(
    withCommentIndex(comments, () => commentThread(comments[0], comments)).replies.some(
      (c) => c.id === 'new-after-snapshot',
    ),
  );
});

test('a hot work builds thread indexes once instead of rescanning all comments for every lead', () => {
  let reads = 0;
  const count = 20000;
  const note = demoNotes('家居', 1)[0];
  const seed = demoComments(note.id, 1)[0];
  const comments = Array.from(
    { length: count },
    (_, i) =>
      new Proxy(
        {
          ...seed,
          id: `hot-${i}`,
          parentId: null as string | null,
          body: '这个柜子怎么买',
          authorId: `person-${i}`,
          createdAt: new Date().toISOString(),
        },
        {
          get(target, key, receiver) {
            if (['noteId', 'source', 'parentId', 'id'].includes(String(key))) reads++;
            return Reflect.get(target, key, receiver);
          },
        },
      ),
  );
  const now = Date.now();
  withCommentIndex(comments, () => {
    for (let i = 0; i < 2000; i++)
      assert.equal(assessComment(comments[i], note, now, comments).exclusions.length, 0);
  });
  // A work-size bound, independent of wall-clock speed and CI machine load.
  assert.ok(reads < count * 15, `too many indexed field reads: ${reads}`);
  for (let i = 1; i < count; i++) comments[i].parentId = comments[0].id;
  reads = 0;
  withCommentIndex(comments, () => {
    for (let i = 1; i <= 2000; i++)
      assert.equal(assessComment(comments[i], note, now, comments).exclusions.length, 0);
  });
  assert.ok(reads < count * 20, `too many reads for a single hot root: ${reads}`);
});
