import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { emptySalesCase, communicationPlan, emptySalesProfile } from '../shared/sales.ts';
import type { Lead } from '../shared/types.ts';
const dir = mkdtempSync(join(tmpdir(), 'openfind-sales-'));
process.env.OPENFIND_DATA_DIR = dir;
process.env.NODE_ENV = 'test';
const { app } = await import('../server/index.ts');
const { db, put } = await import('../server/store.ts');
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((r) => server.once('listening', r));
const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
const lead: Lead = {
  id: 'buyer',
  name: '读者',
  authorId: 'a',
  content: '花瓶求链接',
  commentId: 'c',
  noteId: 'n',
  region: '',
  score: 85,
  reason: '购买渠道咨询',
  status: 'new',
  memo: '',
  outreach: '',
  source: 'live',
  createdAt: new Date().toISOString(),
};
put('leads', lead);
async function req(path: string, body?: unknown, method?: string) {
  return fetch(base + '/api' + path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
}
let path = '/leads/buyer/sales';
async function add(kind: string, content = '实际发生的交流', id = randomUUID()) {
  return req(path + '/events', { id, kind, channel: 'message', content });
}
async function save(patch: Record<string, unknown> = {}) {
  const c = await (await req(path)).json();
  const { id, events, updatedAt, stopped, ...fields } = c;
  return req(path, { ...fields, ...patch }, 'PUT');
}
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
test('Communication drafts require a real offer, wait for replies and stop after refusal', () => {
  const c = emptySalesCase(lead.id);
  assert.equal(communicationPlan(lead, emptySalesProfile, c).blocked, true);
  const p = {
    ...emptySalesProfile,
    identity: '家居顾问',
    offering: '花瓶选型',
    value: '可以提供真实材质与尺寸说明',
  };
  assert.match(communicationPlan(lead, p, c).draft, /花瓶求链接/);
  c.events.push({
    id: 'e',
    kind: 'outgoing',
    channel: 'message',
    content: '首句',
    createdAt: new Date().toISOString(),
  });
  assert.equal(communicationPlan(lead, p, c).blocked, true);
  c.events.push({ ...c.events[0], id: 'reply', kind: 'incoming', content: '还需要' });
  assert.equal(communicationPlan(lead, p, c).blocked, false);
  c.stopped = true;
  assert.equal(communicationPlan(lead, p, c).draft, '');
});
test('Sales stages require actual reply, qualification, quote and order evidence; records survive reload', async () => {
  assert.equal((await req('/leads/missing/sales')).status, 404);
  assert.equal(
    (await save({ stage: 'won', amount: 100, orderReference: 'test-order' })).status,
    400,
  );
  const id = randomUUID();
  await add('outgoing', '确认需求是否仍存在', id);
  await add('outgoing', '确认需求是否仍存在', id);
  assert.equal((await add('outgoing', '变更后的内容', id)).status, 409);
  let c = await (await req(path)).json();
  assert.equal(c.events.length, 1);
  assert.equal(
    (await save({ stage: 'qualified', need: '适配桌面尺寸', timing: '本周' })).status,
    400,
  );
  await add('incoming', '想选适配桌面的花瓶，本周需要');
  assert.equal((await save({ stage: 'qualified', need: '桌面花瓶', timing: '本周' })).status, 200);
  assert.equal(
    (await save({ stage: 'won', amount: 100, orderReference: 'test-order' })).status,
    400,
  );
  await add('quote', '方案A，含尺寸材质和价格条件');
  await add('order', '客户确认订单，编号test-order');
  assert.equal(
    (await save({ stage: 'won', amount: 100, orderReference: 'test-order' })).status,
    200,
  );
  c = await (await req(path)).json();
  assert.equal(c.stage, 'won');
  assert.equal(c.events.length, 4);
  const { id: _, events, updatedAt, stopped, ...fields } = c;
  assert.equal((await req(path, { ...fields, revision: 0 }, 'PUT')).status, 409);
  const summary = await (await req('/sales/summary')).json();
  assert.equal(summary.find((x: any) => x.source === 'live').amount, 100);
  assert.equal(summary.find((x: any) => x.source === 'demo').amount, 0);
  await add('optout', '购买后不再接受主动联系');
  assert.equal((await (await req(path)).json()).stage, 'won');
  const exported = await (await req('/sales/export')).json();
  assert.ok(
    exported.cases.some((c: any) => c.orderReference === 'test-order' && c.stage === 'won'),
  );
  assert.ok(!JSON.stringify(exported).includes('llm:key'));
});
test('Explicit refusal persists, clears follow-up and prevents further outbound steps', async () => {
  put('leads', { ...lead, id: 'refused', authorId: 'refused-person' });
  path = '/leads/refused/sales';
  await add('optout', '不需要了，不要再联系');
  const c = await (await req(path)).json();
  assert.equal(c.stopped, true);
  assert.equal(c.nextFollowUp, '');
  assert.equal(c.stage, 'lost');
  assert.equal((await add('outgoing')).status, 400);
  assert.equal((await save({ stage: 'qualified' })).status, 400);
  assert.equal((await add('note', '仅保留内部记录')).status, 200);
  put('leads', {
    ...lead,
    id: 'duplicate-person',
    authorId: 'refused-person',
    noteId: 'other-note',
  });
  const duplicate = await (await req('/leads/duplicate-person/sales')).json();
  assert.equal(duplicate.stopped, true);
  assert.equal(
    (
      await req('/leads/duplicate-person/sales/events', {
        id: randomUUID(),
        kind: 'outgoing',
        channel: 'message',
        content: '重复联系',
      })
    ).status,
    400,
  );
});
