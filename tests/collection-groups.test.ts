import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectionTopics } from '../shared/collection-groups.ts';
import type { Note, Job, AcquisitionWorkflow } from '../shared/types.ts';

test('Historical collection topics preserve multiple memberships and unclassified works', () => {
  const notes = ['a', 'b', 'c'].map((id) => ({ id }) as Note);
  const jobs = [
    { type: 'search', keyword: '家具', resultIds: ['a'] },
    { type: 'search', keyword: '装修', resultIds: ['a'] },
    { type: 'comments', keyword: '不应作为主题', resultIds: ['b'] },
  ] as Job[];
  const flows = [
    { input: { links: ['https://example.com'], keyword: '链接标题' }, noteIds: ['b'] },
  ] as AcquisitionWorkflow[];
  const topics = collectionTopics(notes, jobs, flows);
  assert.deepEqual([...topics.get('a')!], ['家具', '装修']);
  assert.deepEqual([...topics.get('b')!], ['指定链接']);
  assert.deepEqual([...topics.get('c')!], ['未分类']);
});
