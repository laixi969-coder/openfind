import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acquisitionPriority } from '../server/domain.ts';
import { demoNotes, demoComments } from '../server/demo.ts';
const now = Date.parse('2026-10-17T12:00:00Z');
const when = (days: number) => new Date(now - days * 86400000).toISOString();
const note = { ...demoNotes('家居', 1)[0], publishedAt: when(100), comments: 100, likes: 100000 };
const comment = {
  ...demoComments(note.id, 1)[0],
  authorId: 'buyer',
  body: '求链接',
  createdAt: when(1),
};
test('Old works with recent explicit demand outrank new viral works and unverified comment volume', () => {
  const demand = acquisitionPriority(note, [comment], now);
  const newViral = acquisitionPriority(
    { ...note, id: 'new', publishedAt: when(0), likes: 1000000 },
    [],
    now,
  );
  assert.ok(demand.tier > newViral.tier);
  assert.match(demand.reason, /1 位近7天/);
  assert.equal(acquisitionPriority({ ...note, comments: 0 }, [], now).tier, 0);
  assert.equal(
    acquisitionPriority(note, [], now).weight,
    acquisitionPriority({ ...note, likes: 0 }, [], now).weight,
  );
});
test('Recent activity is distinguished from demand; old dates, author replies and resolved needs cannot qualify', () => {
  assert.equal(acquisitionPriority(note, [{ ...comment, body: '很好看' }], now).tier, 2);
  for (const c of [
    { ...comment, createdAt: when(90) },
    { ...comment, createdAt: '' },
    { ...comment, body: '已经买了' },
    { ...comment, authorId: note.authorId },
  ])
    assert.equal(acquisitionPriority(note, [c], now).tier, 1);
  const duplicate = { ...comment, id: 'another-comment' };
  assert.equal(acquisitionPriority(note, [comment, duplicate], now).weight, 1);
});
test('Sampling priority does not cross note/source boundaries or build sensitive profiles', () => {
  assert.equal(acquisitionPriority(note, [{ ...comment, noteId: 'other' }], now).tier, 1);
  assert.equal(acquisitionPriority(note, [{ ...comment, source: 'live' }], now).tier, 1);
  assert.equal(acquisitionPriority({ ...note, title: 'HPV治疗' }, [comment], now).tier, -1);
});
