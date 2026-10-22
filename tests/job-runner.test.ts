import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { Job } from '../shared/types.ts';
const dir = mkdtempSync(join(tmpdir(), 'openfind-runner-'));
process.env.OPENFIND_DATA_DIR = dir;
process.env.NODE_ENV = 'test';
const { runJob } = await import('../server/index.ts');
const { db, put, get, configSet } = await import('../server/store.ts');
const { freshProtection, saveCollectionPolicy } = await import('../server/protection.ts');
const { demoNotes } = await import('../server/demo.ts');
const query = {
  keyword: 'runner-test',
  mode: 'live' as const,
  platform: 'douyin' as const,
  limit: 10,
  sort: 'latest' as const,
  noteType: 'all' as const,
  interval: 250,
  forceRefresh: true,
};
const job = (id: string): Job => ({
  id,
  type: 'search',
  status: 'running',
  query,
  keyword: query.keyword,
  source: 'live',
  platform: 'douyin',
  resultIds: [],
  count: 0,
  pages: 0,
  elapsed: 0,
  logs: [],
  createdAt: new Date().toISOString(),
});
let mode = 'normal';
const cursors: (string | null)[] = [];
let release!: () => void;
let received!: () => void;
let requestReceived: Promise<void>;
let responseRelease: Promise<void>;
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  const body = JSON.parse(raw);
  cursors.push(body.cursor);
  if (mode === 'late') {
    received();
    await responseRelease;
  }
  const id = 'runner-' + (body.cursor || 'first');
  res.setHeader('content-type', 'application/json');
  res.end(
    JSON.stringify({
      items: [{ ...demoNotes('沙发', 1)[0], id, platform: 'douyin', source: 'live' }],
      nextCursor:
        mode === 'cycle' ? (body.cursor === 'A' ? 'B' : 'A') : body.cursor ? null : 'second',
    }),
  );
}).listen(0, '127.0.0.1');
await new Promise<void>((r) => server.once('listening', r));
configSet('providerUrl', `http://127.0.0.1:${(server.address() as { port: number }).port}`);
configSet('douyin.provider', 'http');
saveCollectionPolicy('douyin', {
  search: { dailyLimit: 100, intervalMs: 1000 },
  comments: { dailyLimit: 100, intervalMs: 1000 },
});
const reset = () => {
  cursors.length = 0;
  configSet('protection:douyin', JSON.stringify(freshProtection()));
};
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('real runner resumes from persisted next page without replaying page one', async () => {
  reset();
  mode = 'normal';
  const j = job('resume-real');
  put('jobs', j);
  const abort = new AbortController();
  const running = runJob(j, query, abort.signal);
  for (let i = 0; i < 200 && !get<Job>('jobs', j.id)?.pages; i++)
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(get<Job>('jobs', j.id)?.pages, 1);
  abort.abort();
  await running;
  assert.equal(j.status, 'stopped');
  const restored = get<Job>('jobs', j.id)!;
  restored.status = 'running';
  await runJob(restored, query);
  assert.equal(restored.status, 'completed');
  assert.deepEqual(cursors, [null, 'second']);
  assert.equal(restored.count, 2);
  assert.equal(restored.pages, 2);
});

test('cyclic cursors stop after saving the response instead of repeatedly billing', async () => {
  reset();
  mode = 'cycle';
  const j = job('cycle-real');
  await runJob(j, query);
  assert.equal(j.status, 'failed');
  assert.match(j.error!, /循环/);
  assert.deepEqual(cursors, [null, 'A', 'B']);
  assert.equal(j.count, 3);
  assert.ok(get('notes', 'runner-B'));
  const restored = get<Job>('jobs', j.id)!;
  await runJob(restored, query);
  assert.equal(restored.status, 'failed');
  assert.match(restored.error!, /循环/);
  assert.deepEqual(cursors, [null, 'A', 'B']);
});

test('a response arriving after cancellation cannot append results', async () => {
  reset();
  mode = 'late';
  requestReceived = new Promise((r) => {
    received = r;
  });
  responseRelease = new Promise((r) => {
    release = r;
  });
  const j = job('late-real');
  const abort = new AbortController();
  const running = runJob(j, query, abort.signal);
  await requestReceived;
  abort.abort();
  release();
  await running;
  assert.equal(j.status, 'stopped');
  assert.equal(j.pages, 0);
  assert.deepEqual(j.resultIds, []);
  await runJob(get<Job>('jobs', j.id)!, query);
  const restored = get<Job>('jobs', j.id)!;
  assert.equal(restored.status, 'failed');
  assert.match(restored.error!, /阻止自动重发/);
  assert.deepEqual(cursors, [null]);
});

test('changing provider identity blocks resume before contacting the new provider', async () => {
  reset();
  mode = 'normal';
  const j = job('changed-provider');
  j.checkpoint = { nextCursor: 'second', visitedCursors: [] };
  j.dataProvider = 'different-account';
  await runJob(j, query);
  assert.equal(j.status, 'failed');
  assert.match(j.error!, /数据源或账号已改变/);
  assert.deepEqual(cursors, []);
});

test('terminal persisted page completes without network or provider revalidation', async () => {
  reset();
  const j = job('terminal-real');
  j.dataProvider = 'original-provider';
  j.pages = 1;
  j.checkpoint = { nextCursor: null, visitedCursors: [] };
  await runJob(j, query);
  assert.equal(j.status, 'completed');
  assert.equal(j.dataProvider, 'original-provider');
  assert.deepEqual(cursors, []);
});

test('provider changes also block a job interrupted before its first checkpoint', async () => {
  reset();
  const j = job('pending-provider');
  j.dataProvider = 'original-paid-provider';
  await runJob(j, query);
  assert.equal(j.status, 'failed');
  assert.match(j.error!, /数据源或账号已改变/);
  assert.deepEqual(cursors, []);
});

test('same job cannot execute concurrently or overwrite the active controller', async () => {
  reset();
  mode = 'late';
  requestReceived = new Promise((r) => {
    received = r;
  });
  responseRelease = new Promise((r) => {
    release = r;
  });
  const j = job('concurrent-runner');
  const first = runJob(j, { ...query, limit: 1 });
  await requestReceived;
  await runJob(structuredClone(j), { ...query, limit: 1 });
  release();
  await first;
  assert.equal(j.status, 'completed');
  assert.equal(j.pages, 1);
  assert.deepEqual(cursors, [null]);
});

test('failed page commit recovers its persisted response without another request', async () => {
  reset();
  mode = 'normal';
  const j = job('failed-page-commit');
  db.exec(
    "CREATE TRIGGER reject_page BEFORE INSERT ON entities WHEN NEW.kind='notes' BEGIN SELECT RAISE(ABORT, 'disk simulation'); END",
  );
  try {
    await runJob(j, { ...query, limit: 1 });
    assert.equal(j.status, 'failed');
    assert.equal(j.pages, 0);
    assert.deepEqual(cursors, [null]);
  } finally {
    db.exec('DROP TRIGGER reject_page');
  }
  // No reset of platform quota: recovery must not reserve a second action.
  await runJob(get<Job>('jobs', j.id)!, { ...query, limit: 1 });
  const restored = get<Job>('jobs', j.id)!;
  assert.equal(restored.status, 'completed');
  assert.equal(restored.count, 1);
  assert.equal(restored.pages, 1);
  assert.deepEqual(cursors, [null]);
});

test('resume rejects changed request parameters and corrupted terminal checkpoints without dispatch', async () => {
  reset();
  mode = 'normal';
  const j = job('bound-checkpoint');
  await runJob(j, { ...query, limit: 1 });
  assert.equal(j.status, 'completed');
  assert.equal(j.checkpoint?.requestReceipts?.length, 1);
  await runJob(j, { ...query, limit: 2 });
  assert.equal(j.status, 'failed');
  assert.match(j.error!, /恢复参数/);
  assert.deepEqual(cursors, [null]);
  put('jobs', { ...j, count: 99 });
  await runJob(j, { ...query, limit: 1 });
  assert.equal(j.status, 'failed');
  assert.match(j.error!, /检查点/);
  assert.deepEqual(cursors, [null]);
});

test('restoring a stale job object uses the durable checkpoint after response compaction', async () => {
  reset();
  mode = 'normal';
  const { compactConsumedReceipt } = await import('../server/request-journal.ts');
  const j = job('stale-after-compaction');
  const stale = structuredClone(j);
  await runJob(j, { ...query, limit: 1 });
  assert.equal(compactConsumedReceipt(j.checkpoint!.requestReceipts![0]), true);
  await runJob(stale, { ...query, limit: 1 });
  assert.equal(stale.status, 'completed');
  assert.equal(stale.count, 1);
  assert.deepEqual(cursors, [null]);
});

test('another completed cache cannot conceal an uncertain first-page request', async () => {
  reset();
  mode = 'late';
  requestReceived = new Promise((r) => {
    received = r;
  });
  responseRelease = new Promise((r) => {
    release = r;
  });
  const j = job('uncertain-not-cacheable');
  const abort = new AbortController();
  const pending = runJob(j, query, abort.signal);
  await requestReceived;
  abort.abort();
  release();
  await pending;
  put('jobs', {
    ...j,
    id: 'unrelated-cache',
    status: 'completed',
    checkpoint: { nextCursor: null, visitedCursors: [], exhausted: true },
    dataFetchedAt: new Date().toISOString(),
  });
  await runJob(j, { ...query, forceRefresh: false });
  assert.equal(j.status, 'failed');
  assert.match(j.error!, /阻止自动重发/);
  assert.deepEqual(cursors, [null]);
});

test('restored first-page task cannot bypass the fence by changing to the browser data source', async () => {
  const { hashIdentity } = await import('../server/collection-integrity.ts');
  const j = job('restored-before-first-page');
  put('jobs', j);
  put('restore-scopes', { id: hashIdentity(j.id) });
  configSet('douyin.provider', 'browser');
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    throw Error('unexpected network');
  }) as typeof fetch;
  try {
    await runJob(j, query);
    assert.match(j.error || '', /备份快照/);
    assert.equal(calls, 0);
    assert.equal(j.pages, 0);
  } finally {
    globalThis.fetch = original;
    configSet('douyin.provider', 'http');
  }
});

test('response write and failure-status write errors preserve the page and release the runner for safe resume', async () => {
  reset();
  mode = 'normal';
  const j = job('response-and-status-failure');
  db.exec(
    "CREATE TRIGGER fail_body BEFORE UPDATE ON entities WHEN NEW.kind='request-receipts' AND json_extract(NEW.value,'$.state')='received' BEGIN SELECT RAISE(ABORT, 'response disk failure'); END",
  );
  db.exec(
    "CREATE TRIGGER fail_status BEFORE UPDATE ON entities WHEN NEW.kind='jobs' AND json_extract(NEW.value,'$.status')='failed' BEGIN SELECT RAISE(ABORT, 'status disk failure'); END",
  );
  try {
    await assert.rejects(runJob(j, { ...query, limit: 1 }), /status disk failure/);
    assert.equal(get<Job>('jobs', j.id)!.pages, 0);
    assert.equal(get<Job>('jobs', j.id)!.count, 0);
    assert.deepEqual(cursors, [null]);
  } finally {
    db.exec('DROP TRIGGER fail_body; DROP TRIGGER fail_status');
  }
  const resumed = get<Job>('jobs', j.id)!;
  await runJob(resumed, { ...query, limit: 1 });
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.pages, 1);
  assert.equal(resumed.count, 1);
  assert.deepEqual(cursors, [null]);
});

test('concurrent resumes through repeated receipt and page failures never advance an unsaved page', async () => {
  reset();
  mode = 'normal';
  const j = job('repeated-recovery-failure');
  db.exec(
    "CREATE TRIGGER repeat_guard_failure BEFORE UPDATE ON entities WHEN NEW.kind='request-guards' AND json_extract(NEW.value,'$.state')='received' BEGIN SELECT RAISE(ABORT, 'guard save failed'); END",
  );
  try {
    await runJob(j, { ...query, limit: 1 });
    await Promise.all([
      runJob({ ...j }, { ...query, limit: 1 }),
      runJob({ ...j }, { ...query, limit: 1 }),
    ]);
    assert.equal(get<Job>('jobs', j.id)!.pages, 0);
    assert.equal(get('job-pages', j.id + ':1'), undefined);
    assert.deepEqual(cursors, [null]);
  } finally {
    db.exec('DROP TRIGGER repeat_guard_failure');
  }
  db.exec(
    "CREATE TRIGGER repeat_page_failure BEFORE INSERT ON entities WHEN NEW.kind='notes' BEGIN SELECT RAISE(ABORT, 'page save failed'); END",
  );
  try {
    await runJob(get<Job>('jobs', j.id)!, { ...query, limit: 1 });
    assert.equal(get<Job>('jobs', j.id)!.pages, 0);
    assert.equal(get<Job>('jobs', j.id)!.count, 0);
    assert.equal(get('job-pages', j.id + ':1'), undefined);
  } finally {
    db.exec('DROP TRIGGER repeat_page_failure');
  }
  const resumed = get<Job>('jobs', j.id)!;
  await runJob(resumed, { ...query, limit: 1 });
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.pages, 1);
  assert.equal(resumed.count, 1);
  assert.deepEqual(cursors, [null]);
});
