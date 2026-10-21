import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { NativeInbox, ReplyDraft, InboxMessage } from '../shared/messages.ts';
const dir = mkdtempSync(join(tmpdir(), 'openfind-inbox-'));
process.env.OPENFIND_DATA_DIR = dir;
process.env.NODE_ENV = 'test';
const { app } = await import('../server/index.ts');
const { db, get, put, all } = await import('../server/store.ts');
const { mergeNative, inboxTransport, pollInbox } = await import('../server/inbox.ts');
const { transcriptHash } = await import('../server/message-hash.ts');
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((r) => server.once('listening', r));
const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/api';
async function req(path: string, body?: unknown, method?: string) {
  return fetch(base + path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
}
const msg = (id: string, text = '需要一个蓝色花瓶'): InboxMessage => ({
  nativeId: id,
  direction: 'incoming',
  text,
  timeLabel: '刚刚',
  kind: 'text',
});
const native = (accountId = 'me', messages = [msg('peer.me.1')]): NativeInbox => ({
  platform: 'xiaohongshu',
  accountId,
  accountName: '操作账号',
  threads: [
    { nativeId: 'peer', name: '同名用户', preview: messages.at(-1)?.text || '', timeLabel: '刚刚' },
  ],
  selected: { nativeId: 'peer', messages },
});
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
test('Message sync isolates accounts, preserves official IDs and ignores relative time changes', () => {
  const t = mergeNative(native())[0];
  const duplicate = mergeNative(native())[0];
  assert.equal(t.id, duplicate.id);
  assert.equal(t.revision, duplicate.revision);
  assert.equal(duplicate.messages.length, 1);
  assert.notEqual(mergeNative(native('another'))[0].id, t.id);
  assert.equal(
    transcriptHash([msg('1')]),
    transcriptHash([{ ...msg('1'), timeLabel: '10分钟前' }]),
  );
});
test('Private conversation binding rejects a nickname match without exact platform user identity', async () => {
  const t = mergeNative(native())[0];
  put('leads', {
    id: 'wrong',
    source: 'live',
    platform: 'xiaohongshu',
    authorId: 'different',
    name: '同名用户',
  });
  const r = await req(
    '/inbox/threads/' + t.id,
    { revision: t.revision, watching: false, autoSuggest: false, stopped: false, leadId: 'wrong' },
    'PUT',
  );
  assert.equal(r.status, 500);
  assert.match((await r.json()).error, /用户标识/);
});
test('New incoming messages invalidate a pending draft and prevent an external send', async () => {
  const t = mergeNative(native())[0];
  const d = await (
    await req('/inbox/threads/' + t.id + '/drafts', {
      revision: t.revision,
      text: '您想要多大尺寸？',
    })
  ).json();
  mergeNative(native('me', [msg('peer.me.1'), msg('peer.me.2', '已经买好了')]));
  let called = 0;
  inboxTransport.call = async () => {
    called++;
    return native();
  };
  const r = await req('/inbox/drafts/' + d.id + '/send', {
    confirmed: true,
    text: d.text,
    contextHash: d.contextHash,
  });
  assert.equal(r.status, 410);
  assert.equal(called, 0);
  assert.equal(get<ReplyDraft>('replyDrafts', d.id)?.status, 'stale');
});
test('System mutual-follow greeting does not trigger a model reply', async () => {
  const t = mergeNative(
    native('greeting', [msg('peer.greeting.1', '我们已相互关注，开始聊天吧')]),
  )[0];
  const r = await req('/inbox/threads/' + t.id + '/suggest', { confirmContextToModel: true });
  assert.equal(r.status, 500);
  assert.match((await r.json()).error, /真实来信/);
});
test('Customer opt-out blocks manual drafts even for an unbound conversation', async () => {
  const t = mergeNative(native('optout', [msg('peer.optout.1', '别再联系我了')]))[0];
  assert.equal(t.stopped, true);
  const r = await req('/inbox/threads/' + t.id + '/drafts', {
    revision: t.revision,
    text: '再看看吧',
  });
  assert.equal(r.status, 500);
  assert.match((await r.json()).error, /停止联系/);
});
test('Sending is disabled even with exact confirmation; drafts remain copyable', async () => {
  const t = mergeNative(native('manual-only'))[0];
  const d = await (
    await req('/inbox/threads/' + t.id + '/drafts', {
      revision: t.revision,
      text: '请手动发送这条草稿',
    })
  ).json();
  let calls = 0;
  inboxTransport.call = async () => {
    calls++;
    return native();
  };
  for (let i = 0; i < 2; i++) {
    const r = await req('/inbox/drafts/' + d.id + '/send', {
      confirmed: true,
      text: d.text,
      contextHash: d.contextHash,
    });
    assert.equal(r.status, 410);
  }
  assert.equal(calls, 0);
  assert.equal(get<ReplyDraft>('replyDrafts', d.id)?.status, 'pending');
});
test('Legacy watching cannot poll or re-enable account hosting', async () => {
  const t = mergeNative(native('legacy-watch'))[0];
  put('inboxThreads', { ...t, watching: true, autoSuggest: true });
  let calls = 0;
  inboxTransport.call = async () => {
    calls++;
    return native();
  };
  await pollInbox();
  await pollInbox();
  assert.equal(calls, 0);
  const r = await req(
    '/inbox/threads/' + t.id,
    { revision: t.revision, watching: true, autoSuggest: true, stopped: false },
    'PUT',
  );
  assert.equal(r.status, 410);
  const merged = mergeNative(native('legacy-watch'))[0];
  assert.equal(merged.watching, false);
  assert.equal(merged.autoSuggest, false);
});

test('XHS uses the same participant prefix for both directions; official bubble markers decide sender', async () => {
  const { xhsMessageDirection } = await import('../server/platforms/message-identity.ts');
  assert.equal(xhsMessageDirection('peer.me.101', 'me', 'peer', false, true), 'incoming');
  assert.equal(xhsMessageDirection('peer.me.102', 'me', 'peer', true, false), 'outgoing');
  assert.throws(
    () => xhsMessageDirection('peer.me.103', 'other-account', 'peer', true, false),
    /当前账号/,
  );
  assert.throws(() => xhsMessageDirection('peer.me.104', 'me', 'peer', true, true), /消息方向/);
});
test('Unknown sends can be reconciled by fresh official read without a second submit', async () => {
  const t = mergeNative(native('recover'))[0];
  const d = await (
    await req('/inbox/threads/' + t.id + '/drafts', { revision: t.revision, text: '唯一测试消息' })
  ).json();
  let sends = 0,
    reads = 0;
  inboxTransport.call = async (body: unknown) => {
    const b = body as any;
    if (b.operation === 'send') {
      sends++;
      throw new Error('lost receipt');
    }
    reads++;
    assert.equal(b.refresh, true);
    return native('recover', [
      msg('peer.me.1'),
      { ...msg('peer.recover.2', d.text), direction: 'outgoing' },
    ]);
  };
  const body = { confirmed: true, text: d.text, contextHash: d.contextHash };
  put('replyDrafts', {
    ...d,
    status: 'unknown',
    beforeMessageIds: t.messages.map((m) => m.nativeId),
  });
  assert.equal((await req('/inbox/drafts/' + d.id + '/send', body)).status, 410);
  assert.equal((await req('/inbox/drafts/' + d.id + '/reconcile', {})).status, 200);
  assert.equal(sends, 0);
  assert.equal(reads, 1);
  assert.equal(get<ReplyDraft>('replyDrafts', d.id)?.status, 'sent');
});

test('Explicit model review uses chat context, redacts contacts and never receives platform identities', async () => {
  const http = await import('node:http');
  let payload: any;
  const model = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    payload = JSON.parse(raw);
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                text: '已收到测试回复，谢谢配合。',
                rationale: '根据最后一条测试回复致谢，不判断购买意向。',
              }),
            },
          },
        ],
      }),
    );
  });
  model.listen(0, '127.0.0.1');
  await new Promise<void>((r) => model.once('listening', r));
  const { saveLlmSettings } = await import('../server/llm.ts');
  saveLlmSettings({
    enabled: false,
    baseUrl: 'http://127.0.0.1:' + (model.address() as any).port,
    model: 'test-model',
    maxComments: 100,
    apiKey: 'test-key',
  });
  try {
    const t = mergeNative(
      native('MODEL_ACCOUNT_ID_PRIVATE', [
        msg('peer.MODEL_ACCOUNT_ID_PRIVATE.1', '测试收到，请联系 test@example.com 13800138000'),
      ]),
    )[0];
    const r = await req('/inbox/threads/' + t.id + '/suggest', { confirmContextToModel: true });
    assert.equal(r.status, 200);
    const draft = await r.json();
    assert.equal(draft.status, 'pending');
    assert.equal(draft.text, '已收到测试回复，谢谢配合。');
    const sent = payload.messages.find((m: any) => m.role === 'user').content;
    assert.doesNotMatch(sent, /13800138000|test@example.com|MODEL_ACCOUNT_ID_PRIVATE/);
    assert.match(sent, /测试收到/);
    assert.equal(payload.store, false);
  } finally {
    await new Promise<void>((r) => model.close(() => r()));
  }
});
test('Medical topics are withheld from the model and a suggestion error does not pause inbox sync', async () => {
  const t = mergeNative(
    native('sensitive', [msg('peer.sensitive.1', '我确诊了HPV，想咨询治疗')]),
  )[0];
  const r = await req('/inbox/threads/' + t.id + '/suggest', { confirmContextToModel: true });
  assert.equal(r.status, 500);
  assert.match((await r.json()).error, /敏感主题/);
  assert.equal(get<any>('inboxThreads', t.id).error, '');
  assert.match(get<any>('inboxThreads', t.id).suggestionError, /敏感/);
});
test('Exact identity binding can be removed explicitly', async () => {
  const t = mergeNative(native('binding'))[0];
  put('leads', {
    id: 'exact',
    source: 'live',
    platform: 'xiaohongshu',
    authorId: 'peer',
    name: '同名用户',
  });
  const first = await req(
    '/inbox/threads/' + t.id,
    { revision: t.revision, watching: false, autoSuggest: false, stopped: false, leadId: 'exact' },
    'PUT',
  );
  assert.equal(first.status, 200);
  const linked = await first.json();
  const second = await req(
    '/inbox/threads/' + t.id,
    { revision: linked.revision, watching: false, autoSuggest: false, stopped: false, leadId: '' },
    'PUT',
  );
  assert.equal(second.status, 200);
  assert.equal((await second.json()).leadId, undefined);
});

test('Douyin identities require a direct conversation, current account, server ID and matching sender marker', async () => {
  const { douyinPeer, douyinMessageDirection } =
    await import('../server/platforms/message-identity.ts');
  const id = '0:1:123:456';
  assert.equal(douyinPeer(id, '123'), '456');
  assert.equal(douyinPeer(id, '456'), '123');
  assert.throws(() => douyinPeer(id, '789'));
  assert.throws(() => douyinPeer('0:2:123:456', '123'));
  assert.equal(
    douyinMessageDirection(id, '123', id, '456', false, '9999999999999999999'),
    'incoming',
  );
  assert.equal(
    douyinMessageDirection(id, '123', id, '123', true, '9999999999999999998'),
    'outgoing',
  );
  assert.throws(() => douyinMessageDirection(id, '123', id, '456', true, '99'));
  assert.throws(() => douyinMessageDirection(id, '123', id, '123', true, '0'));
  assert.throws(() => douyinMessageDirection(id, '123', '0:1:123:789', '123', true, '99'));
});
test('Douyin binds a lead using public peer identity, never conversation ID or nickname', async () => {
  const data: NativeInbox = {
    platform: 'douyin',
    accountId: '123',
    accountName: 'operator',
    threads: [
      {
        nativeId: '0:1:123:456',
        peerId: 'sec-peer',
        name: 'same name',
        preview: 'test',
        timeLabel: '',
      },
    ],
  };
  const t = mergeNative(data)[0];
  put('leads', { id: 'douyin-exact', source: 'live', platform: 'douyin', authorId: 'sec-peer' });
  const r = await req(
    '/inbox/threads/' + t.id,
    {
      revision: t.revision,
      watching: false,
      autoSuggest: false,
      stopped: false,
      leadId: 'douyin-exact',
    },
    'PUT',
  );
  assert.equal(r.status, 200);
  assert.equal((await r.json()).leadId, 'douyin-exact');
});
test('Douyin mutual-follow notice is not a real customer reply', async () => {
  const t = mergeNative(
    native('dy-greeting', [msg('greeting', '我们已互相关注，可以开始聊天了')]),
  )[0];
  const r = await req('/inbox/threads/' + t.id + '/suggest', { confirmContextToModel: true });
  assert.match((await r.json()).error, /真实来信/);
});

test('Native entry points cannot send, fill or publish even when called directly', async () => {
  const { messaging } = await import('../server/platforms/messages.ts');
  const { preparePublish, publishNative } = await import('../server/platforms/publish.ts');
  for (const platform of ['xiaohongshu', 'douyin']) {
    await assert.rejects(
      messaging({
        platform,
        operation: 'send',
        accountId: 'a',
        nativeId: 'b',
        text: 'blocked',
        expectedHash: 'hash',
      }),
      /发送已取消/,
    );
  }
  for (const action of [preparePublish, publishNative]) {
    await assert.rejects(action({} as any), /代发与代填已取消/);
  }
});
