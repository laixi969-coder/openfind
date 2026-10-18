import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'openfind-llm-'));
process.env.OPENFIND_DATA_DIR = dir;
const { db, configGet, get, all } = await import('../server/store.ts');
const {
  saveLlmSettings,
  llmSettings,
  syncModels,
  testLlm,
  reviewSemantics,
  semanticFor,
  semanticInput,
} = await import('../server/llm.ts');
const { demoNotes, demoComments } = await import('../server/demo.ts');
let mode = 'ok';
const requests: { url: string; body: any; authorization?: string }[] = [];
const server = createServer(async (req, res) => {
  let text = '';
  for await (const data of req) text += data;
  const body = text ? JSON.parse(text) : undefined;
  requests.push({ url: req.url!, body, authorization: req.headers.authorization });
  res.setHeader('Content-Type', 'application/json');
  if (mode === 'slow') await new Promise((r) => setTimeout(r, 80));
  if (mode === 'redirect') {
    res.writeHead(302, { Location: 'http://127.0.0.1:1/leak' });
    res.end();
    return;
  }
  if (mode === 'fail') {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: 'secret-key-do-not-echo' }));
    return;
  }
  if (req.url === '/v1/models') {
    res.end(
      JSON.stringify({
        data: [
          { id: 'chat-old', created: 1 },
          { id: 'chat-new', created: 2 },
          { id: 'chat-old', created: 1 },
        ],
      }),
    );
    return;
  }
  if (body.messages[0].content.includes('Connection test')) {
    res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
    return;
  }
  const input = JSON.parse(body.messages[1].content).untrustedComments;
  const items = input.map((x: any) => ({
    id: x.id,
    verdict: mode === 'resolved' ? 'resolved' : 'purchase',
    reason: '明确咨询购买路径，尚未下单',
    quotes: [
      mode === 'bad-quote'
        ? '并不存在的购买承诺'
        : mode === 'parent-only'
          ? x.thread[0].text
          : x.comment,
    ],
    limitations: ['还需本人确认需求'],
  }));
  if (mode === 'duplicate' && items.length > 1) items[1].id = items[0].id;
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items }) } }] }));
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1';
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
test('Model settings encrypt secrets; sync lists actual available models without selecting an upgrade; test generates JSON', async () => {
  const policy = { enabled: false, baseUrl: base, model: 'chat-old', maxComments: 100 };
  saveLlmSettings({ ...policy, apiKey: 'secret-key-do-not-echo' });
  assert.equal(llmSettings().hasApiKey, true);
  assert.ok(!configGet('llm:key').includes('secret-key-do-not-echo'));
  assert.ok(!JSON.stringify(llmSettings()).includes('secret-key-do-not-echo'));
  const synced = await syncModels();
  assert.deepEqual(
    synced.models.map((m) => m.id),
    ['chat-new', 'chat-old'],
  );
  assert.equal(synced.model, 'chat-old');
  assert.ok(synced.modelsSyncedAt);
  const result = await testLlm();
  assert.equal(result.ok, true);
  assert.equal(result.model, 'chat-old');
  assert.ok(requests.at(-1)!.body.messages[1].content.includes('synthetic'));
  assert.equal(requests.at(-1)!.authorization, 'Bearer secret-key-do-not-echo');
  assert.throws(() => saveLlmSettings({ ...policy, baseUrl: base + '/changed' }), /重新输入/);
  assert.throws(() => saveLlmSettings({ ...policy, baseUrl: 'https://user:password@example.com' }));
  assert.throws(() => saveLlmSettings({ ...policy, baseUrl: 'http://example.com/v1' }));
  mode = 'fail';
  await assert.rejects(
    testLlm(),
    (e) =>
      (e as Error).message.includes('HTTP 401') && !(e as Error).message.includes('secret-key'),
  );
  mode = 'redirect';
  await assert.rejects(testLlm(), /连接失败/);
  mode = 'ok';
});
test('Semantic review is optional, bounded, redacted, quoted, cached and fails without weakening rule decisions', async () => {
  const note = { ...demoNotes('家居', 1)[0], title: '家居好物', body: '', tags: [] };
  const c = {
    ...demoComments(note.id, 1)[0],
    id: 'good',
    body: '洗手刷求链接，联系 test@example.com 电话13812345678',
    author: 'private-name',
    authorId: 'private-id',
    createdAt: new Date().toISOString(),
  };
  const sensitive = { ...c, id: 'sensitive', body: '确诊治疗多少钱' };
  const creator = { ...c, id: 'creator', authorId: note.authorId };
  const other = { ...c, id: 'limit', body: '有链接吗' };
  const comments = [c, sensitive, creator, other];
  let count = requests.length;
  assert.match(await reviewSemantics(comments, [note]), /未启用/);
  assert.equal(requests.length, count);
  saveLlmSettings({ enabled: true, baseUrl: base, model: 'chat-old', maxComments: 1 });
  const status = await reviewSemantics(comments, [note]);
  assert.match(status, /本次1条/);
  assert.match(status, /未处理1条/);
  assert.equal(semanticFor(sensitive, note, comments), undefined);
  assert.equal(semanticFor(creator, note, comments), undefined);
  assert.ok(semanticFor(c, note, comments));
  const prompt = JSON.stringify(requests.at(-1)!.body);
  for (const secret of [
    'private-name',
    'private-id',
    'test@example.com',
    '13812345678',
    '确诊治疗',
  ])
    assert.ok(!prompt.includes(secret), secret);
  count = requests.length;
  await reviewSemantics([c, sensitive, creator], [note], undefined, comments);
  assert.equal(requests.length, count);
  mode = 'bad-quote';
  const bad = { ...other, id: 'bad' };
  assert.match(await reviewSemantics([bad], [note]), /引用无法/);
  assert.equal(semanticFor(bad, note, [bad]), undefined);
  mode = 'fail';
  const failure = await reviewSemantics([other], [note]);
  assert.match(failure, /HTTP 401/);
  assert.ok(!failure.includes('secret-key'));
  mode = 'ok';
  const { assessComment } = await import('../server/domain.ts');
  assert.equal(assessComment(sensitive, note).recommended, false);
  saveLlmSettings({ enabled: true, baseUrl: base, model: 'chat-old', maxComments: 2 });
  mode = 'duplicate';
  const duplicates = [
    { ...other, id: 'duplicate-a' },
    { ...other, id: 'duplicate-b' },
  ];
  assert.match(await reviewSemantics(duplicates, [note]), /编号重复/);
  assert.equal(semanticFor(duplicates[0], note, duplicates), undefined);
  mode = 'ok';
  saveLlmSettings({ enabled: true, baseUrl: base, model: 'chat-new', maxComments: 1 });
  assert.equal(semanticFor(c, note, comments), undefined);
  const cancel = new AbortController();
  cancel.abort();
  await assert.rejects(() => reviewSemantics([other], [note], cancel.signal));
});

test('One-off model review works with automatic review disabled and reports every saved batch', async () => {
  mode = 'ok';
  saveLlmSettings({ enabled: false, baseUrl: base, model: 'chat-old', maxComments: 100 });
  const note = { ...demoNotes('家居', 1)[0], title: '家居好物', body: '', tags: [] };
  const comments = Array.from({ length: 6 }, (_, i) => ({
    ...demoComments(note.id, 1)[0],
    id: 'one-off-' + i,
    authorId: 'reader-' + i,
    body: '洗手刷有链接吗',
    createdAt: new Date().toISOString(),
  }));
  const updates: number[] = [];
  const result = await reviewSemantics(comments, [note], undefined, comments, true, (p) =>
    updates.push(p.reviewed),
  );
  assert.match(result, /本次6条/);
  assert.equal(llmSettings().enabled, false);
  assert.deepEqual(updates, [0, 5, 6]);
  const { compareQualifications } = await import('../server/qualification-comparison.ts');
  const enriched = comments.map((c) => ({ ...c, semantic: semanticFor(c, note, comments) }));
  const comparison = compareQualifications(enriched, [note], enriched);
  assert.equal(comparison.reviewed, 6);
  assert.equal(comparison.agreed, 6);
});

test('Thread ownership is explicit and parent-only citations are rejected; previous model evidence is retained', async () => {
  saveLlmSettings({ enabled: false, baseUrl: base, model: 'chat-old', maxComments: 100 });
  const note = { ...demoNotes('家居', 1)[0], title: '花瓶', body: '', tags: [] };
  const root = {
    ...demoComments(note.id, 1)[0],
    id: 'ownership-root',
    authorId: 'reader-a',
    body: '花瓶有链接吗',
    createdAt: new Date().toISOString(),
  };
  const reply = {
    ...root,
    id: 'ownership-reply',
    authorId: 'reader-b',
    parentId: root.id,
    body: '好漂亮',
  };
  const context = [root, reply];
  assert.equal(semanticInput(reply, note, context).thread[0].role, 'other_commenter');
  assert.equal(
    semanticInput({ ...reply, authorId: root.authorId }, note, context).thread[0].role,
    'same_commenter',
  );
  const creatorAnswer = {
    ...root,
    id: 'ownership-answer',
    parentId: root.id,
    authorId: note.authorId,
    body: '换浅色家具',
  };
  const thanks = { ...root, id: 'ownership-thanks', parentId: root.id, body: '好的，谢谢' };
  const thread = semanticInput(root, note, [...context, creatorAnswer, thanks]).thread;
  assert.ok(thread.some((x) => x.role === 'creator' && x.text === creatorAnswer.body));
  assert.ok(thread.some((x) => x.role === 'same_commenter' && x.text === thanks.body));
  assert.ok(!thread.some((x) => x.text === root.body));
  mode = 'parent-only';
  assert.match(await reviewSemantics([reply], [note], undefined, context, true), /引用无法/);
  assert.equal(semanticFor(reply, note, context), undefined);
  mode = 'ok';
  await reviewSemantics([root], [note], undefined, context, true);
  const previous = get<any>('semanticReviews', root.id);
  const changed = { ...root, body: '花瓶在哪里买' };
  await reviewSemantics([changed], [note], undefined, [changed, reply], true);
  assert.ok(
    all<any>('semanticReviewHistory').some(
      (x) => x.inputHash === previous.inputHash && x.reviewedAt === previous.reviewedAt,
    ),
  );
  assert.notEqual(semanticFor(changed, note, [changed, reply])?.inputHash, previous.inputHash);
});

test('A creator purchase cannot establish that the reader has bought; raw model evidence stays intact', async () => {
  mode = 'resolved';
  saveLlmSettings({ enabled: false, baseUrl: base, model: 'chat-old', maxComments: 100 });
  const note = { ...demoNotes('家居', 1)[0], title: '电视', body: '', tags: [] };
  const root = {
    ...demoComments(note.id, 1)[0],
    id: 'resolved-reader',
    authorId: 'reader',
    body: '电视小了点',
    createdAt: new Date().toISOString(),
  };
  const creator = {
    ...root,
    id: 'resolved-creator',
    parentId: root.id,
    authorId: note.authorId,
    body: '我买了85寸又换了75寸',
  };
  await reviewSemantics([root], [note], undefined, [root, creator], true);
  const reviewed = semanticFor(root, note, [root, creator]);
  assert.equal(reviewed?.verdict, 'interest');
  assert.match(reviewed!.validationWarning!, /未见本人/);
  assert.equal(get<any>('semanticReviews', root.id).verdict, 'resolved');
  mode = 'ok';
});

test('Timeout defaults are 120/900 seconds, configurable, validated and preserved for old clients', () => {
  const p = { enabled: false, baseUrl: base, model: 'chat-old', maxComments: 100 };
  assert.equal(llmSettings().requestTimeoutSeconds, 120);
  assert.equal(llmSettings().reviewTimeoutSeconds, 900);
  saveLlmSettings({ ...p, requestTimeoutSeconds: 180, reviewTimeoutSeconds: 1200 });
  saveLlmSettings(p);
  assert.equal(llmSettings().requestTimeoutSeconds, 180);
  assert.equal(llmSettings().reviewTimeoutSeconds, 1200);
  assert.throws(() => saveLlmSettings({ ...p, requestTimeoutSeconds: 301 }));
  assert.throws(() =>
    saveLlmSettings({ ...p, requestTimeoutSeconds: 120, reviewTimeoutSeconds: 60 }),
  );
  assert.equal(llmSettings().requestTimeoutSeconds, 180);
});

test('The configured request deadline is applied to the real HTTP request', async (t) => {
  mode = 'slow';
  const original = AbortSignal.timeout;
  const deadlines: number[] = [];
  t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    deadlines.push(ms);
    return original(5);
  });
  await assert.rejects(testLlm(), /180秒/);
  assert.deepEqual(deadlines, [180000]);
  mode = 'ok';
});
