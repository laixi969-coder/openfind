import type { Note, Job, AcquisitionWorkflow } from './types';

export function collectionTopics(notes: Note[], jobs: Job[], workflows: AcquisitionWorkflow[]) {
  const topics = new Map<string, Set<string>>(notes.map((n) => [n.id, new Set()]));
  for (const job of jobs) {
    if (job.type !== 'search' || !job.keyword.trim()) continue;
    for (const id of job.resultIds) topics.get(id)?.add(job.keyword.trim());
  }
  for (const w of workflows) {
    const label = w.input.links ? '指定链接' : w.input.keyword.trim();
    for (const id of w.noteIds) if (label) topics.get(id)?.add(label);
  }
  for (const values of topics.values()) if (!values.size) values.add('未分类');
  return topics;
}
