import { test } from 'node:test';
import assert from 'node:assert/strict';
import { intentScore } from '../server/domain.ts';
const now = Date.parse('2026-10-17T12:00:00Z');
const when = (days: number) => new Date(now - days * 86400000).toISOString();
test('Recent explicit needs outrank stale needs without assuming they have bought', () => {
  const recent = intentScore('想买，多少钱，求链接', when(1), '', now);
  const old = intentScore('想买，多少钱，求链接', when(120), '', now);
  assert.equal(recent.recommended, true);
  assert.equal(old.recommended, false);
  assert.ok(recent.score > old.score);
  assert.notEqual(old.stage, 'resolved');
  assert.ok(old.reason.includes('人工确认'));
});
test('Completed purchases, promotions and generic engagement do not qualify', () => {
  for (const body of ['已经买了，谢谢推荐', '我家有，厂家直销，私我报价', '真好看，谢谢分享'])
    assert.equal(intentScore(body, when(0), '', now).recommended, false);
  assert.equal(intentScore('已经买了，哪里买配件', when(0), '', now).stage, 'resolved');
  assert.equal(intentScore('还没买，求链接', when(0), '', now).recommended, true);
});
test('Missing and future dates never inherit the collection time', () => {
  for (const date of ['', 'bad-date', when(-10)]) {
    const assessment = intentScore('想买求链接多少钱', date, '', now);
    assert.equal(assessment.ageDays, null);
    assert.equal(assessment.recommended, false);
  }
});
test('Sensitive context prevents individual marketing profiles even for neutral comments', () => {
  const a = intentScore('多少钱，怎么预约', when(1), 'HPV治疗', now);
  assert.equal(a.stage, 'restricted');
  assert.equal(a.recommended, false);
  assert.equal(a.score, 0);
  assert.ok(a.exclusions.length);
});

test('Colloquial purchase questions qualify while denials and seller answers do not', () => {
  for (const body of ['地毯有链接吗', '紫色四件套有链接嘛', '沙发好看，在哪买的'])
    assert.equal(intentScore(body, when(0), '', now).recommended, true, body);
  for (const body of ['不想买，只是看看', '有的亲，关注我，发给你链接哈', ''])
    assert.equal(intentScore(body, when(0), '', now).recommended, false, body);
});

test('Creator replies are not classified as prospective buyers', async () => {
  const { assessComment } = await import('../server/domain.ts');
  const { demoNotes, demoComments } = await import('../server/demo.ts');
  const note = demoNotes('家居', 1)[0];
  const c = {
    ...demoComments(note.id, 1)[0],
    body: '求链接',
    authorId: note.authorId,
    createdAt: new Date().toISOString(),
  };
  const assessment = assessComment(c, note);
  assert.equal(assessment.score, 0);
  assert.equal(assessment.recommended, false);
  assert.match(assessment.reason, /作者/);
});

test('Real comment phrasing for link requests and short price questions has explicit evidence', () => {
  for (const text of ['花瓶链接给一个', '礼貌问价', '这颗多少价啊', '什么价？'])
    assert.equal(intentScore(text, new Date().toISOString()).recommended, true, text);
  for (const text of ['不要链接了', '不用给我链接', '不问价'])
    assert.equal(intentScore(text, new Date().toISOString()).recommended, false, text);
});

test('Review separates historic cost comparison, actual product requests and service interest', () => {
  const budget = intentScore('硬装+软装10w吗', when(0), '装修客厅', now);
  assert.equal(budget.recommended, false);
  assert.equal(budget.intentType, 'interest');
  assert.match(budget.evidence.at(-1)!.label, /既有装修成本/);
  for (const body of [
    '头箍链接分享一下',
    '请问静电消除器可以分享一下吗？',
    '瑜伽袜链接',
    '蹲个🔗',
    '客厅主灯线上还是线下买的呀！什么牌子的麻烦推荐一下',
  ]) {
    const a = intentScore(body, when(0), '普通居家好物', now);
    assert.equal(a.recommended, true, body);
    assert.equal(a.intentType, 'purchase');
    assert.ok(a.evidence.some((e) => e.excerpt === body));
  }
  for (const body of ['能帮我设计下吗？', '给我设计一下', '求改。']) {
    const a = intentScore(body, when(0), '软装搭配思路', now);
    assert.equal(a.intentType, 'service');
    assert.equal(a.recommended, true);
    assert.ok(a.limitations!.some((l) => l.includes('免费建议')));
  }
  for (const body of [
    'AI的吗？有没有实物图呢',
    '这种适合什么风格',
    '这种怎么改',
    '好些个都是我很需要的',
  ])
    assert.equal(intentScore(body, when(0), '软装', now).recommended, false, body);
  assert.equal(intentScore('第七个我买了，怎么那么好看', when(0), '', now).stage, 'resolved');
});
test('Thread evidence resolves co-requests while preserving authors, scope and sensitive exclusions', async () => {
  const { assessComment } = await import('../server/domain.ts');
  const { demoNotes, demoComments } = await import('../server/demo.ts');
  const note = { ...demoNotes('家居', 1)[0], title: '软装搭配', body: '', tags: [] };
  const root = {
    ...demoComments(note.id, 1)[0],
    id: 'root',
    body: '门楣可以给个链接吗？',
    authorId: 'buyer-a',
    createdAt: when(1),
  };
  const reply = {
    ...root,
    id: 'reply',
    parentId: 'root',
    body: '我也想要',
    authorId: 'buyer-b',
    createdAt: when(0),
  };
  const a = assessComment(reply, note, now, [root, reply]);
  assert.equal(a.recommended, true);
  assert.equal(a.threadEvidence![0].commentId, 'root');
  assert.equal(
    assessComment(reply, note, now, [{ ...root, noteId: 'other' }, reply]).recommended,
    false,
  );
  assert.equal(
    assessComment(reply, note, now, [
      { ...root, source: root.source === 'live' ? 'demo' : 'live' },
      reply,
    ]).recommended,
    false,
  );
  assert.equal(
    assessComment({ ...reply, authorId: note.authorId }, note, now, [root, reply]).recommended,
    false,
  );
  const health = { ...root, body: '头皮精华推荐一下' };
  const answer = {
    ...root,
    id: 'answer',
    parentId: 'root',
    authorId: note.authorId,
    body: '脱发用的是米诺',
    createdAt: when(0),
  };
  assert.equal(assessComment(health, note, now, [health, answer]).stage, 'restricted');
  const service = { ...root, body: '求改。' };
  const suggestion = { ...answer, body: '可以把黑色的家具换成浅色' };
  const thanks = {
    ...root,
    id: 'thanks',
    parentId: 'root',
    body: '好的，谢谢',
    createdAt: when(0),
  };
  const reviewed = assessComment(service, note, now, [service, suggestion, thanks]);
  assert.equal(reviewed.recommended, false);
  assert.ok(reviewed.threadEvidence!.some((x) => x.commentId === 'thanks'));
  const purchase = assessComment(root, note, now, [root, { ...answer, body: '实体店买的' }]);
  assert.equal(purchase.recommended, true);
  assert.notEqual(purchase.stage, 'resolved');
});
test('Seven-day workflow window is exact and not rounded to nearly eight days', () => {
  assert.equal(
    intentScore('求链接', new Date(now - 7 * 86400000).toISOString(), '', now).withinSevenDays,
    true,
  );
  assert.equal(
    intentScore('求链接', new Date(now - 7 * 86400000 - 1).toISOString(), '', now).withinSevenDays,
    false,
  );
});

test('Explicit planned shopping is recognized without treating an old statement as a fresh lead', () => {
  const body = '要去市场照着你的花束买花去了';
  const recent = intentScore(body, when(0), '插花', now);
  assert.equal(recent.intentType, 'purchase');
  assert.equal(recent.recommended, true);
  assert.ok(recent.evidence.some((e) => e.label.includes('前往采购')));
  assert.equal(intentScore(body, when(20), '插花', now).withinSevenDays, false);
  for (const text of [
    '如果要去市场买花就好了',
    '朋友说要去市场买花',
    '我不打算去市场买花',
    '我在许愿，希望博主出假花版',
    '好漂亮！',
  ])
    assert.equal(intentScore(text, when(0), '插花', now).recommended, false, text);
});
