import { douyinFingerprint } from './douyin-data.ts';
import { xhsFingerprint } from './xhs-data.ts';
import type { Job, SearchInput } from '../shared/types.ts';
import { all, get, configGet } from './store.ts';

// Both the orchestrator and the executor must agree on cache eligibility. Local
// reads remain available when the platform's network quota has been exhausted.
export function cachedJob(job: Job, input: SearchInput): Job | undefined {
  if (job.source !== 'live' || input.forceRefresh) return;
  const browser =
    configGet('connectionType', configGet('providerUrl') ? 'http' : 'browser') === 'browser';
  return all<Job>('jobs').find(
    (j) =>
      j.id !== job.id &&
      j.source === 'live' &&
      j.status === 'completed' &&
      j.dataProvider ===
        (input.platform === 'xiaohongshu' ? xhsFingerprint() : douyinFingerprint()) &&
      j.type === job.type &&
      j.platform === job.platform &&
      j.keyword === job.keyword &&
      j.noteId === job.noteId &&
      j.query?.sort === input.sort &&
      j.query?.noteType === input.noteType &&
      !(
        browser &&
        input.platform === 'xiaohongshu' &&
        !j.dataProvider &&
        job.type === 'search' &&
        j.searchEvidence?.sortType !==
          (input.sort === 'latest'
            ? 'time_descending'
            : input.sort === 'popular'
              ? 'popularity_descending'
              : 'general')
      ) &&
      j.count >= input.limit &&
      Date.now() - Date.parse(j.dataFetchedAt || j.finishedAt || '') < 300000 &&
      j.resultIds.every((id) => get(job.type === 'search' ? 'notes' : 'comments', id)),
  );
}
