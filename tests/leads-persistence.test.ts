import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Lead } from '../shared/types.ts';
const dir = mkdtempSync(join(tmpdir(), 'openfind-leads-'));
process.env.OPENFIND_DATA_DIR = dir;
const { db, all, put, get } = await import('../server/store.ts');
const { saveCollectedLead } = await import('../server/leads.ts');
const { toLead } = await import('../server/domain.ts');
const { demoNotes, demoComments } = await import('../server/demo.ts');
after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
const n = { ...demoNotes('家居', 1)[0], platform: 'douyin' as const };
const c = {
  ...demoComments(n.id, 1)[0],
  platform: n.platform,
  authorId: 'buyer',
  body: '求链接',
  createdAt: '2026-10-20T12:00:00Z',
};

test('collection is order-independent, keeps newest evidence, and preserves all manual fields', () => {
  const newest = { ...c, id: 'new', body: '沙发多少钱，求链接', createdAt: '2026-10-20T13:00:00Z' };
  const initial = saveCollectedLead(newest, n, [c, newest]).lead;
  put('leads', {
    ...initial,
    memo: '人工备注',
    outreach: '人工话术',
    status: 'archived',
    revision: 4,
  });
  saveCollectedLead(c, n, [c, newest]);
  saveCollectedLead({ ...newest, body: '更新的原文' }, n, [c, newest]);
  const saved = get<Lead>('leads', initial.id)!;
  assert.equal(saved.commentId, 'new');
  assert.equal(saved.content, '更新的原文');
  assert.equal(saved.memo, '人工备注');
  assert.equal(saved.outreach, '人工话术');
  assert.equal(saved.status, 'archived');
  assert.equal(saved.revision, 4);
  assert.equal(all('leads').length, 1);
});

test('legacy lead IDs and linked sales records survive recollection', () => {
  const original = {
    ...toLead({ ...c, authorId: 'legacy-person' }, n),
    id: 'legacy-record',
    memo: '保留',
    revision: 2,
  };
  put('leads', original);
  put('salesCases', { id: original.id, need: '真实需求' });
  const saved = saveCollectedLead(
    { ...c, id: 'legacy-new', authorId: 'legacy-person', createdAt: '2026-10-21T00:00:00Z' },
    n,
    [],
  ).lead;
  assert.equal(saved.id, original.id);
  assert.equal(saved.memo, '保留');
  assert.equal(get<any>('salesCases', saved.id).need, '真实需求');
});

test('identity distinguishes platform, source, delimiter placement and anonymous comment IDs', () => {
  assert.notEqual(toLead(c, n).id, toLead({ ...c, platform: 'xiaohongshu' }, n).id);
  assert.notEqual(toLead(c, n).id, toLead({ ...c, source: 'live' }, n).id);
  assert.notEqual(
    toLead({ ...c, authorId: 'x:y', noteId: 'z' }, n).id,
    toLead({ ...c, authorId: 'x', noteId: 'y:z' }, n).id,
  );
  assert.notEqual(
    toLead({ ...c, authorId: '', id: 'x' }, n).id,
    toLead({ ...c, authorId: 'x' }, n).id,
  );
  assert.equal(toLead({ ...c, platform: undefined }, n).platform, 'douyin');
});
