import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Job, SearchInput } from '../shared/types.ts';
const dir = mkdtempSync(join(tmpdir(), 'openfind-progress-'));
process.env.OPENFIND_DATA_DIR = dir;
const { db, put, get, transaction } = await import('../server/store.ts');
const { commitJobPage } = await import('../server/job-progress.ts');
const { demoNotes } = await import('../server/demo.ts');
const { cachedJob } = await import('../server/jobs-cache.ts');
const { douyinFingerprint } = await import('../server/douyin-data.ts');
after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
const query: SearchInput = {
  keyword: '沙发',
  mode: 'live',
  platform: 'douyin',
  limit: 10,
  sort: 'latest',
  noteType: 'all',
  interval: 250,
};
const makeJob = (id: string): Job => ({
  id,
  type: 'search',
  status: 'running',
  keyword: query.keyword,
  query,
  platform: 'douyin',
  source: 'live',
  resultIds: [],
  count: 0,
  pages: 0,
  elapsed: 0,
  logs: [],
  createdAt: new Date().toISOString(),
  dataProvider: douyinFingerprint(),
});
const makeNote = (id: string) => ({
  ...demoNotes('沙发', 1)[0],
  id,
  platform: 'douyin' as const,
  source: 'live' as const,
});

test('page records and checkpoint roll back together on persistence failure', () => {
  const j = makeJob('atomic-job');
  put('jobs', j);
  db.exec(
    `CREATE TRIGGER fail_progress BEFORE UPDATE ON entities WHEN NEW.kind = 'jobs' AND NEW.id = 'atomic-job' BEGIN SELECT RAISE(ABORT, 'disk failure simulation'); END`,
  );
  try {
    assert.throws(
      () =>
        commitJobPage(j, query, [makeNote('atomic-note')], {
          nextCursor: 'next',
          visitedCursors: [],
        }),
      /disk failure/,
    );
    assert.equal(get('notes', 'atomic-note'), undefined);
    assert.equal(j.count, 0);
    assert.equal(get<Job>('jobs', j.id)?.checkpoint, undefined);
  } finally {
    db.exec('DROP TRIGGER fail_progress');
  }
  commitJobPage(j, query, [makeNote('atomic-note')], { nextCursor: 'next', visitedCursors: [] });
  assert.equal(get<Job>('jobs', j.id)?.checkpoint?.nextCursor, 'next');
  assert.ok(get('notes', 'atomic-note'));
});

test('foreign platform results cannot overwrite persisted entities or advance progress', () => {
  const j = makeJob('scope-job');
  put('notes', makeNote('identity-note'));
  assert.throws(
    () => commitJobPage(j, query, [{ ...makeNote('identity-note'), platform: 'xiaohongshu' }]),
    /不一致/,
  );
  assert.equal(j.pages, 0);
  assert.equal(get<any>('notes', 'identity-note').platform, 'douyin');
  const c = { ...j, id: 'comment-job', type: 'comments' as const, noteId: 'expected' };
  assert.throws(
    () =>
      commitJobPage(c, query, [
        { id: 'bad-comment', noteId: 'other', platform: 'douyin', source: 'live' } as any,
      ]),
    /不一致/,
  );
  assert.equal(get('comments', 'bad-comment'), undefined);
});

test('exhausted short and empty pages are reusable without another billed request', () => {
  for (const count of [0, 1]) {
    const j = makeJob('exhausted-' + count);
    commitJobPage(j, query, count ? [makeNote('short-note')] : [], {
      nextCursor: null,
      visitedCursors: [],
    });
    j.status = 'completed';
    put('jobs', j);
    assert.ok(cachedJob(makeJob('new-' + count), query));
  }
});

test('nested transactions preserve the outer rollback boundary', () => {
  assert.throws(() =>
    transaction(() => {
      put('test', { id: 'outer' });
      transaction(() => put('test', { id: 'inner' }));
      throw new Error('rollback');
    }),
  );
  assert.equal(get('test', 'outer'), undefined);
  assert.equal(get('test', 'inner'), undefined);
});

test('cache rejects count corruption and cross-source replacement of stored results', () => {
  const q = { ...query, keyword: 'cache-corruption', limit: 1 };
  const j = { ...makeJob('cache-corrupt'), keyword: q.keyword, query: q };
  commitJobPage(j, q, [makeNote('cache-owned')], { nextCursor: null, visitedCursors: [] });
  j.status = 'completed';
  put('jobs', j);
  const candidate = { ...j, id: 'cache-candidate' };
  assert.ok(cachedJob(candidate, q));
  put('jobs', { ...j, count: 2 });
  assert.equal(cachedJob(candidate, q), undefined);
  put('jobs', j);
  put('notes', { ...makeNote('cache-owned'), source: 'demo' });
  assert.equal(cachedJob(candidate, q), undefined);
});

test('a truncated last page cannot masquerade as an exhausted larger-query cache', () => {
  const q = { ...query, keyword: 'truncated-page', limit: 1 };
  const j = { ...makeJob('truncated-cache'), keyword: q.keyword, query: q };
  commitJobPage(j, q, [makeNote('truncated-a'), makeNote('truncated-b')], {
    nextCursor: null,
    visitedCursors: [],
  });
  j.status = 'completed';
  put('jobs', j);
  assert.equal(j.checkpoint?.exhausted, false);
  assert.ok(cachedJob({ ...j, id: 'one' }, q));
  assert.equal(cachedJob({ ...j, id: 'two' }, { ...q, limit: 2 }), undefined);
});

test('receipt acknowledgement and page marker commit atomically; only consumed bodies can be compacted', async () => {
  const { journaledFetch, captureRequestReceipts, compactConsumedReceipt, UncertainRequestError } =
    await import('../server/request-journal.ts');
  const { validateJobCheckpoint } = await import('../server/job-progress.ts');
  const j = makeJob('receipt-atomic');
  put('jobs', j);
  let calls = 0;
  const request = journaledFetch(j.id, (async () => {
    calls++;
    return Response.json({ result: 'paid' });
  }) as typeof fetch);
  const captured = await captureRequestReceipts(() => request('https://vendor.example/atomic'));
  const ref = captured.receipts[0];
  assert.equal(compactConsumedReceipt(ref), false);
  db.exec(
    "CREATE TRIGGER fail_receipt_page BEFORE UPDATE ON entities WHEN NEW.kind='jobs' AND NEW.id='receipt-atomic' BEGIN SELECT RAISE(ABORT, 'checkpoint failure'); END",
  );
  try {
    assert.throws(
      () =>
        commitJobPage(
          j,
          query,
          [makeNote('receipt-note')],
          { nextCursor: null, visitedCursors: [] },
          captured.receipts,
        ),
      /checkpoint failure/,
    );
    assert.equal(get<any>('request-guards', ref.id).state, 'received');
    assert.equal(get('job-pages', j.id + ':1'), undefined);
    assert.equal(get('notes', 'receipt-note'), undefined);
    assert.equal(compactConsumedReceipt(ref), false);
  } finally {
    db.exec('DROP TRIGGER fail_receipt_page');
  }
  commitJobPage(
    j,
    query,
    [makeNote('receipt-note')],
    { nextCursor: null, visitedCursors: [] },
    captured.receipts,
  );
  validateJobCheckpoint(j);
  assert.equal(get<any>('request-guards', ref.id).state, 'consumed');
  put('jobs', { ...j, count: 999 });
  assert.equal(compactConsumedReceipt(ref), false);
  put('jobs', j);
  assert.equal(compactConsumedReceipt(ref), true);
  assert.equal(get('request-receipts', ref.id), undefined);
  validateJobCheckpoint(get<Job>('jobs', j.id)!);
  await assert.rejects(request('https://vendor.example/atomic'), UncertainRequestError);
  assert.equal(calls, 1);
  assert.throws(
    () =>
      validateJobCheckpoint({ ...j, checkpoint: { ...j.checkpoint!, nextCursor: 'fabricated' } }),
    /不一致/,
  );
});

test('a response from a different task cannot acknowledge or advance this page', async () => {
  const { journaledFetch, captureRequestReceipts } = await import('../server/request-journal.ts');
  const j = makeJob('wrong-receipt-owner');
  put('jobs', j);
  const captured = await captureRequestReceipts(() =>
    journaledFetch(
      'other-task',
      (async () => new Response('other')) as typeof fetch,
    )('https://vendor.example/other'),
  );
  assert.throws(
    () =>
      commitJobPage(
        j,
        query,
        [makeNote('wrong-owner-note')],
        { nextCursor: null, visitedCursors: [] },
        captured.receipts,
      ),
    /不一致/,
  );
  assert.equal(get('notes', 'wrong-owner-note'), undefined);
  assert.equal(get<Job>('jobs', j.id)!.pages, 0);
});
