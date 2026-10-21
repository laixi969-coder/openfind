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
