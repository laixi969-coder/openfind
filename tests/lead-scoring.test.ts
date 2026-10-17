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
  for (const body of ['地毯有链接吗', '沙发好看，在哪买的', '硬装+软装10w吗'])
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
