import type { Job, Note, Comment } from '../shared/types.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { all, db, get, put, remove, transaction } from './store.ts';

// The unique SQLite key arbitrates across processes, not only JS callers.
export function claimEntity<T extends { id: string }>(kind: string, item: T) {
  return (
    db
      .prepare('INSERT OR IGNORE INTO entities(kind,id,value) VALUES(?,?,?)')
      .run(kind, item.id, JSON.stringify(item)).changes === 1
  );
}
interface Receipt {
  id: string;
  state: 'pending' | 'received';
  createdAt: string;
  attempt: string;
  response?: { status: number; body: string };
  scopeHash?: string;
  polling?: boolean;
}
export interface ReceiptRef {
  id: string;
  attempt: string;
}
interface Guard extends ReceiptRef {
  state: 'pending' | 'received' | 'poll-ready' | 'consumed';
  scopeHash?: string;
  responseHash?: string;
  consumedBy?: { jobId: string; page: number };
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const guards = 'request-guards';
// Upgrade old receipts before any cleanup can remove their only dispatch evidence.
for (const receipt of all<Receipt>('request-receipts'))
  claimEntity(guards, {
    id: receipt.id,
    attempt: receipt.attempt,
    state: receipt.state,
    scopeHash: receipt.scopeHash,
    responseHash: receipt.response ? digest(JSON.stringify(receipt.response)) : undefined,
  });
const captured = new AsyncLocalStorage<ReceiptRef[]>();
export async function captureRequestReceipts<T>(work: () => Promise<T>) {
  const receipts: ReceiptRef[] = [];
  const result = await captured.run(receipts, work);
  return { result, receipts };
}
export function acknowledgeReceipts(jobId: string, page: number, receipts: ReceiptRef[]) {
  for (const ref of receipts) {
    const guard = get<Guard>(guards, ref.id);
    const receipt = get<Receipt>('request-receipts', ref.id);
    if (
      !guard ||
      guard.attempt !== ref.attempt ||
      !receipt?.response ||
      receipt.attempt !== ref.attempt ||
      guard.responseHash !== digest(JSON.stringify(receipt.response)) ||
      (guard.scopeHash && guard.scopeHash !== digest(jobId)) ||
      (guard.state !== 'received' &&
        !(
          guard.state === 'consumed' &&
          guard.consumedBy?.jobId === jobId &&
          guard.consumedBy.page === page
        ))
    )
      throw new Error('请求记录与分页检查点不一致，已停止保存');
    put(guards, { ...guard, state: 'consumed', consumedBy: { jobId, page } });
  }
}
export function validateReceiptRefs(jobId: string, page: number, refs: ReceiptRef[]) {
  for (const ref of refs) {
    const guard = get<Guard>(guards, ref.id);
    if (
      guard?.attempt !== ref.attempt ||
      guard.state !== 'consumed' ||
      guard.consumedBy?.jobId !== jobId ||
      guard.consumedBy.page !== page
    )
      throw new Error('请求记录与分页检查点不一致，已阻止继续请求');
  }
}
// Only an atomically committed page may relinquish its response body. The guard
// remains forever: absence of a body must never authorize a second dispatch.
export function checkpointDigest(job: Job) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        pages: job.pages,
        count: job.count,
        resultIds: job.resultIds,
        checkpoint: job.checkpoint,
        dataProvider: job.dataProvider,
        source: job.source,
        platform: job.platform,
        query: job.query,
      }),
    )
    .digest('hex');
}
export function compactConsumedReceipt(ref: ReceiptRef) {
  return transaction(() => {
    const guard = get<Guard>(guards, ref.id);
    if (guard?.attempt !== ref.attempt || guard.state !== 'consumed' || !guard.consumedBy)
      return false;
    const { jobId, page } = guard.consumedBy;
    const marker = get<{ receipts: ReceiptRef[] }>('job-pages', jobId + ':' + page);
    if (!marker?.receipts.some((r) => r.id === ref.id && r.attempt === ref.attempt)) return false;
    const job = get<Job>('jobs', jobId);
    if (
      !job ||
      job.pages < page ||
      job.resultIds.some((id) => {
        const item = get<Note | Comment>(job.type === 'search' ? 'notes' : 'comments', id);
        return (
          !item ||
          item.source !== job.source ||
          item.platform !== job.platform ||
          (job.type === 'comments' && (item as Comment).noteId !== job.noteId)
        );
      })
    )
      return false;
    const latest = get<{ digest: string; receipts: ReceiptRef[] }>(
      'job-pages',
      jobId + ':' + job.pages,
    );
    if (!latest || latest.digest !== checkpointDigest(job)) return false;
    try {
      validateReceiptRefs(jobId, job.pages, latest.receipts);
    } catch {
      return false;
    }
    remove('request-receipts', ref.id);
    return true;
  });
}
export class RequestBudgetError extends Error {}
export class UncertainRequestError extends Error {
  constructor() {
    super(
      '请求仍在执行或结果不确定，可能已计费；已阻止自动重发。请先在供应商后台核对，确认后再新建任务',
    );
  }
}
const flights = new Map<string, Promise<Receipt>>();
function requestId(scope: string, url: string | URL | Request, init?: RequestInit) {
  // Persist only a digest of identity, never URLs, authorization headers or cookies.
  return createHash('sha256')
    .update(
      JSON.stringify([
        scope,
        String(url),
        init?.method || 'GET',
        [...new Headers(init?.headers)].sort(),
        init?.body || '',
      ]),
    )
    .digest('hex');
}
const responseReceipts = new WeakMap<Response, Receipt>();
function replay(receipt: Receipt) {
  const r = receipt.response!;
  const response = new Response([204, 205, 304].includes(r.status) ? null : r.body, {
    status: r.status,
  });
  responseReceipts.set(response, receipt);
  captured.getStore()?.push({ id: receipt.id, attempt: receipt.attempt });
  return response;
}
export function advancePendingPoll(response: Response) {
  const receipt = responseReceipts.get(response);
  if (!receipt?.polling || receipt.response?.status !== 200) return false;
  let payload: any;
  try {
    payload = JSON.parse(receipt.response.body);
  } catch {
    return false;
  }
  if (Number(payload.code) !== 2000 || !['pending', 'processing'].includes(payload.data?.status))
    return false;
  return transaction(() => {
    const guard = get<Guard>(guards, receipt.id);
    if (guard?.attempt !== receipt.attempt || guard.state !== 'received') return false;
    // Preserve a tombstone, never turn a paid poll into an unseen request.
    put(guards, { ...guard, state: 'poll-ready' });
    return true;
  });
}
export function journaledFetch(
  scope: string | undefined,
  transport: typeof fetch = fetch,
  beforeDispatch?: () => void,
  replayOnly = false,
  polling = false,
): typeof fetch {
  if (!scope)
    return async (url, init) => {
      init?.signal?.throwIfAborted();
      beforeDispatch?.();
      return transport(url, init);
    };
  return async (url, init) => {
    init?.signal?.throwIfAborted();
    const id = requestId(scope, url, init);
    let flight = flights.get(id);
    if (!flight) {
      const existing = get<Receipt>('request-receipts', id);
      const guard = get<Guard>(guards, id);
      if (existing && !guard) throw new UncertainRequestError();
      const nextPoll = polling && guard?.state === 'poll-ready';
      if (
        !nextPoll &&
        existing?.state === 'received' &&
        guard?.attempt === existing.attempt &&
        (guard.state === 'received' || guard.state === 'consumed') &&
        guard.responseHash === digest(JSON.stringify(existing.response))
      )
        return replay(existing);
      if ((!nextPoll && guard) || replayOnly) throw new UncertainRequestError();
      beforeDispatch?.();
      const receipt: Receipt = {
        id,
        state: 'pending',
        createdAt: new Date().toISOString(),
        attempt: randomUUID(),
        scopeHash: digest(scope),
        polling,
      };
      transaction(() => {
        const current = get<Guard>(guards, id);
        if (nextPoll) {
          if (current?.state !== 'poll-ready' || current.attempt !== guard!.attempt)
            throw new UncertainRequestError();
          put(guards, {
            id,
            attempt: receipt.attempt,
            state: 'pending',
            scopeHash: receipt.scopeHash,
          });
        } else if (
          !claimEntity(guards, {
            id,
            attempt: receipt.attempt,
            state: 'pending',
            scopeHash: receipt.scopeHash,
          })
        ) {
          throw new UncertainRequestError();
        }
        put('request-receipts', receipt);
      });
      flight = (async () => {
        // The durable claim precedes dispatch. Failure at any later boundary must
        // leave it in place: a timeout cannot tell us whether the vendor charged.
        const response = await transport(url, init);
        const result = { status: response.status, body: await response.text() };
        const completed: Receipt = { ...receipt, state: 'received', response: result };
        transaction(() => {
          const current = get<Guard>(guards, id);
          if (current?.attempt !== receipt.attempt || current.state !== 'pending')
            throw new UncertainRequestError();
          put('request-receipts', completed);
          put(guards, {
            ...current,
            state: 'received',
            responseHash: digest(JSON.stringify(result)),
          });
        });
        return completed;
      })();
      flights.set(id, flight);
    }
    try {
      return replay(await flight);
    } finally {
      if (flights.get(id) === flight) flights.delete(id);
    }
  };
}
