import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AcquisitionInput, AcquisitionWorkflow, Comment, Note } from '../shared/types.ts';
const dir = mkdtempSync(join(tmpdir(), 'openfind-workflow-'));
process.env.OPENFIND_DATA_DIR = dir;
const { all, get, put, db, configSet } = await import('../server/store.ts');
const { createWorkflow, runWorkflow, workflowRuns, recoverWorkflows } =
  await import('../server/workflows.ts');
const { freshProtection } = await import('../server/protection.ts');
const { demoNotes, demoComments } = await import('../server/demo.ts');
after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
const input: AcquisitionInput = {
  keyword: '测试沙发',
  platform: 'douyin',
  mode: 'demo',
  searchLimit: 10,
  maxNotes: 2,
  commentLimit: 10,
  supplement: true,
};
function note(id: string): Note {
  return { ...demoNotes('沙发', 1)[0], id, platform: 'douyin', comments: 12 };
}
function comment(n: Note, id: string, body = '多少钱，哪里买'): Comment {
  return {
    ...demoComments(n.id, 1)[0],
    id,
    noteId: n.id,
    platform: n.platform,
    authorId: 'buyer-' + id,
    body,
    createdAt: new Date().toISOString(),
  };
}

test('Pipeline supplements latest, samples, qualifies, persists and keeps CRM edits on repeat', async () => {
  const calls: string[] = [];
  const a = note('flow-a'),
    b = note('flow-b');
  const w = createWorkflow(input);
  await runWorkflow(w, async (j, q) => {
    calls.push(j.type + ':' + q.sort);
    if (j.type === 'search') {
      const n = q.sort === 'latest' ? a : b;
      put('notes', n);
      j.resultIds = [n.id];
    } else {
      const n = get<Note>('notes', j.noteId!)!;
      const c = comment(n, 'comment-' + n.id);
      put('comments', c);
      const old = { ...comment(n, 'old-' + n.id), createdAt: '2020-01-01T00:00:00Z' };
      put('comments', old);
      const wrong = { ...c, id: 'wrong-' + n.id, noteId: 'unrelated' };
      put('comments', wrong);
      j.resultIds = [c.id, old.id, wrong.id];
    }
    j.status = 'completed';
    j.count = j.resultIds.length;
    put('jobs', j);
  });
  assert.deepEqual(calls, [
    'search:latest',
    'search:general',
    'comments:general',
    'comments:general',
  ]);
  assert.equal(w.status, 'completed');
  assert.equal(w.leadIds.length, 2);
  assert.equal(w.commentIds.length, 4);
  assert.equal(get<AcquisitionWorkflow>('workflows', w.id)?.stage, 'done');
  const lead = get<any>('leads', w.leadIds[0]);
  put('leads', { ...lead, status: 'qualified', memo: '不要覆盖', outreach: '我的草稿' });
  w.status = 'paused';
  w.stage = 'assess';
  await runWorkflow(w, async () => assert.fail('assessment must not call platforms'));
  assert.equal(all('leads').length, 2);
  assert.equal(get<any>('leads', lead.id).memo, '不要覆盖');
});

test('Failed comment step preserves partial evidence, resumes checkpoint without repeating completed works', async () => {
  const w = createWorkflow({ ...input, keyword: '恢复测试', supplement: false });
  const a = note('resume-a'),
    b = note('resume-b');
  let fail = true;
  const seen: string[] = [];
  const execute: Parameters<typeof runWorkflow>[1] = async (j) => {
    if (j.type === 'search') {
      put('notes', a);
      put('notes', b);
      j.resultIds = [a.id, b.id];
    } else {
      seen.push(j.noteId!);
      const n = get<Note>('notes', j.noteId!)!;
      const c = comment(n, 'r-' + n.id);
      put('comments', c);
      j.resultIds = [c.id];
      if (n.id === b.id && fail) {
        j.status = 'failed';
        j.error = '请完成验证';
        put('jobs', j);
        return;
      }
    }
    j.status = 'completed';
    put('jobs', j);
  };
  await runWorkflow(w, execute);
  assert.equal(w.status, 'paused');
  assert.match(w.message, /验证/);
  assert.equal(w.completedNoteIds.length, 1);
  assert.equal(w.leadIds.length, 2);
  fail = false;
  await runWorkflow(w, execute);
  assert.equal(w.status, 'completed');
  assert.deepEqual(seen, [a.id, b.id, b.id]);
  assert.equal(w.commentIds.length, 2);
});

test('User pause cancels the child and restart recovery leaves a resumable record', async () => {
  const w = createWorkflow({ ...input, keyword: '暂停测试' });
  await runWorkflow(w, async (j, _q, signal) => {
    workflowRuns.get(w.id)!.abort();
    assert.ok(signal?.aborted);
    j.status = 'stopped';
  });
  assert.equal(w.status, 'paused');
  assert.equal(workflowRuns.size, 0);
  w.status = 'running';
  put('workflows', w);
  recoverWorkflows();
  assert.equal(get<AcquisitionWorkflow>('workflows', w.id)?.status, 'paused');
  assert.match(get<AcquisitionWorkflow>('workflows', w.id)!.message, /服务重启/);
});

test('Real quota or verification pause blocks dispatch without clearing protections', async () => {
  for (const paused of [false, true]) {
    const w = createWorkflow({ ...input, mode: 'live', keyword: '额度' + paused });
    configSet(
      'protection:douyin',
      JSON.stringify({
        ...freshProtection(),
        paused,
        reason: '本人验证',
        counts: { search: 100, comments: 0, publish: 0, prepare: 0 },
      }),
    );
    await runWorkflow(w, async () => assert.fail('blocked platform must not be contacted'));
    assert.equal(w.status, 'paused');
    assert.match(w.message, paused ? /本人验证/ : /上限/);
  }
});

test('Sensitive topics and cross-platform/source works cannot create candidates; no matches still completes', async () => {
  assert.throws(() => createWorkflow({ ...input, keyword: 'HPV治疗' }), /敏感/);
  const w = createWorkflow({ ...input, keyword: '隔离测试', supplement: false });
  await runWorkflow(w, async (j) => {
    assert.equal(j.type, 'search');
    const mixed = [
      { ...note('sensitive'), title: 'HPV治疗' },
      { ...note('wrong-platform'), platform: 'xiaohongshu' as const },
      { ...note('wrong-source'), source: 'live' as const },
      { ...note('no-comments'), comments: 0 },
    ];
    mixed.forEach((n) => put('notes', n));
    j.resultIds = mixed.map((n) => n.id);
    j.status = 'completed';
  });
  assert.equal(w.status, 'completed');
  assert.ok(!w.noteIds.includes('wrong-platform') && !w.noteIds.includes('wrong-source'));
  assert.equal(w.selectedNoteIds.length, 0);
  assert.equal(w.leadIds.length, 0);
  assert.match(w.message, /没有符合/);
});

test('Latest unknown-count work receives a sample alongside historical discussion', async () => {
  const w = createWorkflow({ ...input, keyword: '新作品覆盖', supplement: false });
  const old = note('history-discussion'),
    fresh = { ...note('new-unknown'), comments: 0, commentCountKnown: false };
  put('notes', old);
  put('jobs', {
    id: 'known-search',
    type: 'search',
    status: 'completed',
    platform: 'douyin',
    source: 'demo',
    keyword: w.input.keyword,
    resultIds: [old.id],
    query: { sort: 'general' },
  });
  const selected: string[] = [];
  await runWorkflow(w, async (j) => {
    if (j.type === 'search') {
      put('notes', fresh);
      j.resultIds = [fresh.id];
    } else selected.push(j.noteId!);
    j.status = 'completed';
    put('jobs', j);
  });
  assert.equal(w.status, 'completed');
  assert.ok(selected.includes(fresh.id));
});

test('Exhausted network quota still permits eligible local cache without extending freshness', async () => {
  const { cachedJob } = await import('../server/jobs-cache.ts');
  const { protectionStatus } = await import('../server/protection.ts');
  const n = { ...note('cached-only'), source: 'live' as const, comments: 0 };
  put('notes', n);
  const query = {
    keyword: '缓存额度',
    platform: 'douyin' as const,
    mode: 'live' as const,
    limit: 1,
    sort: 'latest' as const,
    noteType: 'all' as const,
    interval: 15000,
  };
  const timestamp = new Date(Date.now() - 60000).toISOString();
  put('jobs', {
    id: 'cached-search',
    type: 'search',
    status: 'completed',
    source: 'live',
    platform: 'douyin',
    keyword: query.keyword,
    query,
    count: 1,
    resultIds: [n.id],
    finishedAt: timestamp,
    dataFetchedAt: timestamp,
  });
  configSet(
    'protection:douyin',
    JSON.stringify({
      ...freshProtection(),
      counts: { search: 100, comments: 0, publish: 0, prepare: 0 },
    }),
  );
  const w = createWorkflow({
    ...input,
    keyword: query.keyword,
    mode: 'live',
    searchLimit: 1,
    supplement: false,
  });
  await runWorkflow(w, async (j, q) => {
    const cached = cachedJob(j, q);
    assert.ok(cached, 'network must not be necessary');
    j.resultIds = cached.resultIds;
    j.dataFetchedAt = cached.dataFetchedAt;
    j.count = 1;
    j.status = 'completed';
    put('jobs', j);
  });
  assert.equal(w.status, 'completed');
  assert.equal(protectionStatus('douyin').counts.search, 100);
  assert.equal(get<any>('jobs', w.searchJobIds[0]).dataFetchedAt, timestamp);
});

test('Re-review preserves original candidates and CRM notes, demotes budget comparisons and recovers contextual requests', async () => {
  const { reviewWorkflowQualification } = await import('../server/workflows.ts');
  const { toLead } = await import('../server/domain.ts');
  const n = { ...note('audit-note'), title: '装修与软装设计', body: '', tags: [] };
  put('notes', n);
  const budget = comment(n, 'budget', '硬装+软装10w吗');
  const root = comment(n, 'root', '门楣给个链接吗');
  const reply = { ...comment(n, 'reply', '我也想要'), parentId: root.id };
  for (const c of [budget, root, reply]) put('comments', c);
  const original = { ...toLead(budget, n), memo: '原始跟进备注', status: 'contacted' as const };
  put('leads', original);
  const w = createWorkflow({ ...input, mode: 'demo' });
  w.status = 'completed';
  w.stage = 'done';
  w.selectedNoteIds = [n.id];
  w.commentIds = [budget.id, root.id, reply.id];
  w.leadIds = [original.id];
  await reviewWorkflowQualification(w);
  assert.equal(w.leadIds.length, 2);
  assert.deepEqual(w.qualificationReview!.removedCommentIds, [budget.id]);
  assert.equal(w.qualificationReview!.addedCommentIds.length, 2);
  assert.equal(get<any>('leads', original.id).memo, '原始跟进备注');
  await reviewWorkflowQualification(w);
  assert.deepEqual(w.qualificationReview!.originalCommentIds, [budget.id]);
});

test('Restart marks interrupted manual model reviews as stopped without losing completed workflow data', () => {
  const w = createWorkflow({ ...input, keyword: 'manual-review-recovery' });
  w.status = 'completed';
  w.stage = 'done';
  w.commentIds = ['kept-comment'];
  w.reviewProgress = {
    status: 'running',
    total: 10,
    eligible: 8,
    excluded: 2,
    reviewed: 5,
    pending: 3,
    message: 'running',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  put('workflows', w);
  recoverWorkflows();
  const restored = get<AcquisitionWorkflow>('workflows', w.id)!;
  assert.equal(restored.status, 'completed');
  assert.equal(restored.reviewProgress!.status, 'failed');
  assert.equal(restored.reviewProgress!.reviewed, 5);
  assert.deepEqual(restored.commentIds, ['kept-comment']);
});

const linkedInput: AcquisitionInput = {
  ...input,
  keyword: '指定链接',
  mode: 'live',
  platform: 'douyin',
  links: [
    'https://www.douyin.com/video/7654321098765432101',
    'https://www.douyin.com/video/7654321098765432102',
  ],
};
function linkedNote(url: string): Note {
  const id = url.split('/').at(-1)!;
  return {
    ...note('dy:' + id),
    nativeId: id,
    url,
    source: 'live',
    title: '桌面花瓶',
    body: '花瓶款式',
    comments: 0,
    commentCountKnown: true,
  };
}
test('Link pipeline reads only specified works including zero-count works and performs no keyword search', async () => {
  configSet('protection:douyin', JSON.stringify(freshProtection()));
  const w = createWorkflow(linkedInput);
  const calls: string[] = [];
  await runWorkflow(
    w,
    async (j) => {
      assert.equal(j.type, 'comments');
      calls.push(j.noteId!);
      const n = get<Note>('notes', j.noteId!)!;
      const c = { ...comment(n, 'linked-' + n.nativeId), source: 'live' as const };
      put('comments', c);
      j.resultIds = [c.id];
      j.status = 'completed';
      put('jobs', j);
    },
    async (url) => linkedNote(url),
  );
  assert.equal(w.status, 'completed');
  assert.deepEqual(
    calls,
    linkedInput.links!.map((u) => linkedNote(u).id),
  );
  assert.equal(w.searchJobIds.length, 0);
  assert.equal(w.noteIds.length, 2);
  assert.equal(w.leadIds.length, 2);
});
test('Link resolution resumes its checkpoint without rereading completed works', async () => {
  const w = createWorkflow(linkedInput);
  const read: string[] = [];
  let fail = true;
  const resolve = async (url: string) => {
    read.push(url);
    if (url === linkedInput.links![1] && fail) throw Error('平台要求本人安全验证');
    return linkedNote(url);
  };
  const execute: Parameters<typeof runWorkflow>[1] = async (j) => {
    j.status = 'completed';
    put('jobs', j);
  };
  await runWorkflow(w, execute, resolve);
  assert.equal(w.status, 'paused');
  assert.equal(Object.keys(w.linkNoteIds!).length, 1);
  fail = false;
  await runWorkflow(w, execute, resolve);
  assert.equal(w.status, 'completed');
  assert.deepEqual(read, [linkedInput.links![0], linkedInput.links![1], linkedInput.links![1]]);
});
test('Mismatched work identity and sensitive target pages stop before comments or lead creation', async () => {
  for (const sensitive of [false, true]) {
    const w = createWorkflow({ ...linkedInput, links: linkedInput.links!.slice(0, 1) });
    let comments = 0;
    await runWorkflow(
      w,
      async () => {
        comments++;
      },
      async (url) =>
        sensitive ? { ...linkedNote(url), title: 'HPV治疗' } : linkedNote(linkedInput.links![1]),
    );
    assert.equal(w.status, 'paused');
    assert.equal(comments, 0);
    assert.equal(w.leadIds.length, 0);
    assert.match(w.message, sensitive ? /敏感主题/ : /身份不一致/);
  }
});

test('Expanded workflow collects more than five works and popular search honors requested size', async () => {
  const w = createWorkflow({
    ...input,
    keyword: '大批量回归',
    searchLimit: 80,
    maxNotes: 12,
    commentLimit: 100,
  });
  const seen: number[] = [];
  await runWorkflow(w, async (j, q) => {
    if (j.type === 'search') {
      assert.equal(q.limit, 80);
      if (q.sort === 'popular') {
        const notes = Array.from({ length: 12 }, (_, i) => note('large-' + i));
        for (const n of notes) put('notes', n);
        j.resultIds = notes.map((n) => n.id);
      }
    } else {
      seen.push(q.limit);
    }
    j.status = 'completed';
    put('jobs', j);
  });
  assert.equal(w.status, 'completed');
  assert.equal(w.completedNoteIds.length, 12);
  assert.deepEqual(seen, Array(12).fill(100));
});
