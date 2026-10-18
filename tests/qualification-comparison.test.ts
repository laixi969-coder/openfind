import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Comment, SemanticReview } from '../shared/types.ts';
import { demoNotes, demoComments } from '../server/demo.ts';
import { compareQualifications } from '../server/qualification-comparison.ts';
const now = Date.parse('2026-10-17T12:00:00Z');
const note = { ...demoNotes('家居', 1)[0], title: '家居好物与装修', body: '', tags: [] };
const base = {
  ...demoComments(note.id, 1)[0],
  authorId: 'reader',
  createdAt: new Date(now - 1000).toISOString(),
};
const semantic = (verdict: SemanticReview['verdict']): SemanticReview => ({
  verdict,
  reason: '模型对照样本',
  quotes: ['原文'],
  limitations: [],
  model: 'fixture-chat',
  reviewedAt: new Date(now).toISOString(),
  inputHash: 'fixture',
});
const comment = (id: string, body: string, model?: SemanticReview['verdict']): Comment => ({
  ...base,
  id,
  body,
  semantic: model ? semantic(model) : undefined,
});
test('Comparison distinguishes candidate disagreements, type differences, blocked and pending coverage', () => {
  const comments = [
    comment('agree', '求链接', 'purchase'),
    comment('rule-only', '求链接', 'interest'),
    comment('model-only', '这种怎么改', 'service'),
    comment('type', '帮我设计一下', 'purchase'),
    comment('blocked', '确诊治疗多少钱', 'purchase'),
    comment('pending', '好看'),
  ];
  const r = compareQualifications(comments, [note], comments, now);
  assert.deepEqual(
    {
      total: r.total,
      reviewed: r.reviewed,
      excluded: r.excluded,
      pending: r.pending,
      agreed: r.agreed,
      ruleOnly: r.ruleOnly,
      modelOnly: r.modelOnly,
      type: r.typeDifferences,
    },
    {
      total: 6,
      reviewed: 4,
      excluded: 1,
      pending: 1,
      agreed: 1,
      ruleOnly: 1,
      modelOnly: 1,
      type: 1,
    },
  );
  assert.equal(r.rows.find((x) => x.commentId === 'blocked')!.status, 'excluded');
});
test('Old purchase language cannot become a recent candidate solely because the model says purchase', () => {
  const c = {
    ...comment('old', '求链接', 'purchase'),
    createdAt: new Date(now - 9 * 86400000).toISOString(),
  };
  const r = compareQualifications([c], [note], [c], now);
  assert.equal(r.rows[0].ruleAccepted, false);
  assert.equal(r.rows[0].modelAccepted, false);
  assert.equal(r.modelOnly, 0);
});
