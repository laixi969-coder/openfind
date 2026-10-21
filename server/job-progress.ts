import {
  checkpointDigest,
  acknowledgeReceipts,
  validateReceiptRefs,
  type ReceiptRef,
} from './request-journal.ts';
import type { Job, Note, Comment, SearchInput } from '../shared/types.ts';
import { get, put, transaction } from './store.ts';

export function commitJobPage(
  job: Job,
  input: SearchInput,
  items: (Note | Comment)[],
  checkpoint?: Job['checkpoint'],
  receipts: ReceiptRef[] = [],
) {
  const kind = job.type === 'search' ? 'notes' : 'comments';
  // Validate the whole response before overwriting any existing entity.
  for (const item of items) {
    if (
      !item.id ||
      item.source !== job.source ||
      (item.platform && item.platform !== job.platform) ||
      (job.type === 'comments' && (item as Comment).noteId !== job.noteId)
    )
      throw new Error('采集结果与任务平台或作品不一致，已拒绝保存');
    const old = get<Note | Comment>(kind, item.id);
    if (
      old &&
      (old.source !== item.source ||
        (old.platform && item.platform && old.platform !== item.platform) ||
        (job.type === 'comments' && (old as Comment).noteId !== (item as Comment).noteId))
    )
      throw new Error('采集结果 ID 与已有数据身份冲突，已拒绝覆盖');
  }
  const next = structuredClone(job);
  const seen = new Set(next.resultIds);
  const accepted: (Note | Comment)[] = [];
  let truncated = false;
  for (const item of items) {
    if (seen.has(item.id)) continue;
    if (job.type === 'search' && input.noteType !== 'all' && (item as Note).type !== input.noteType)
      continue;
    if (input.limit && seen.size >= input.limit) {
      truncated = true;
      break;
    }
    seen.add(item.id);
    next.resultIds.push(item.id);
    accepted.push(item);
  }
  next.count = next.resultIds.length;
  next.pages++;
  next.checkpoint = checkpoint
    ? {
        ...checkpoint,
        ...(receipts.length ? { requestReceipts: receipts } : {}),
        exhausted: checkpoint.nextCursor === null && !truncated,
      }
    : undefined;
  next.dataFetchedAt = new Date().toISOString();
  transaction(() => {
    for (const item of accepted) put(kind, { ...item, platform: job.platform });
    if (job.type === 'search' && input.sort === 'latest')
      next.resultIds.sort((a, b) =>
        (get<Note>('notes', b)?.publishedAt || '').localeCompare(
          get<Note>('notes', a)?.publishedAt || '',
        ),
      );
    acknowledgeReceipts(job.id, next.pages, receipts);
    put('jobs', next);
    put('job-pages', { id: job.id + ':' + next.pages, digest: checkpointDigest(next), receipts });
  });
  Object.assign(job, next);
}

export function validateJobCheckpoint(job: Job) {
  const marker = get<{ digest: string; receipts: ReceiptRef[] }>(
    'job-pages',
    job.id + ':' + job.pages,
  );
  if (!marker) {
    if (job.checkpoint?.requestReceipts?.length)
      throw new Error('分页提交记录缺失，已阻止继续请求');
    return; // Legacy checkpoints have no receipt link.
  }
  if (marker.digest !== checkpointDigest(job))
    throw new Error('分页检查点与已提交结果不一致，已阻止继续请求');
  validateReceiptRefs(job.id, job.pages, marker.receipts);
  for (const id of job.resultIds) {
    const item = get<Note | Comment>(job.type === 'search' ? 'notes' : 'comments', id);
    if (
      !item ||
      item.source !== job.source ||
      item.platform !== job.platform ||
      (job.type === 'comments' && (item as Comment).noteId !== job.noteId)
    )
      throw new Error('分页检查点引用的结果缺失或身份不一致，已阻止继续请求');
  }
}
