import { checkpointDigest, hashIdentity, migrateRequestGuards } from './collection-integrity.ts';
export { checkpointDigest } from './collection-integrity.ts';
import type { Job, Note, Comment } from '../shared/types.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import {
  db,
  get,
  put,
  remove,
  transaction,
  assertOutsideTransaction,
  assertTransactionUsable,
} from './store.ts';

// The unique SQLite key arbitrates across processes, not only JS callers.
export function claimEntity<T extends { id: string }>(kind: string, item: T) {
  assertTransactionUsable();
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
migrateRequestGuards(db);
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
      guard.id !== ref.id ||
      !receipt?.response ||
      receipt.id !== ref.id ||
      receipt.state !== 'received' ||
      receipt.scopeHash !== guard.scopeHash ||
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
export class RestoredScopeError extends Error {
  constructor() {
    super(
      '此任务来自备份快照，无法确认快照之后的计费；仅允许重放已保存响应。请核对供应商记录后新建任务',
    );
  }
}
export function assertDispatchAllowed(scope?: string) {
  if (scope && get('restore-scopes', hashIdentity(scope))) throw new RestoredScopeError();
}
export function inheritRestoredScope(parent: string, child: string) {
  assertOutsideTransaction();
  if (get('restore-scopes', hashIdentity(parent)))
    claimEntity('restore-scopes', { id: hashIdentity(child) });
}
export class RequestBudgetError extends Error {}
export class ResponseCapacityError extends RequestBudgetError {
  constructor() {
    super('存在待保存响应或并发名额已满，尚未发送新请求；请先继续原任务保存暂存响应');
  }
}
export class UncertainRequestError extends Error {
  constructor() {
    super(
      '请求仍在执行或结果不确定，可能已计费；已阻止自动重发。请先在供应商后台核对，确认后再新建任务',
    );
  }
}
export class ReceiptPersistenceError extends Error {
  constructor(retained: boolean) {
    super(
      retained
        ? '响应已收到但尚未写入数据库；本进程暂存了响应，请排除存储故障后继续原任务，仅重试保存，不重新请求。重启将丢失暂存响应'
        : '响应已收到但无法持久化，暂存容量不足；已保留防重发标记，请核对供应商记录，不会自动重发',
    );
  }
}
// A failed SQLite commit must not discard a response that is still recoverable
// in this process. Bound memory; never evict an older response to authorize a send.
const unsaved = new Map<string, Receipt>();
const maxUnsavedBytes = 64 * 1024 * 1024;
const maxResponseSlots = 32;
const responseSlots = new Set<string>();
function unsavedBytes() {
  return [...unsaved.values()].reduce((sum, r) => sum + (r.response?.body.length || 0) * 2, 0);
}
// A failed save blocks fresh paid work until existing responses are recovered.
// Reserve slots before dispatch so concurrent arrivals cannot exhaust the count.
function reserveResponseSlot(id: string) {
  if (responseSlots.has(id) || unsaved.size > 0 || responseSlots.size >= maxResponseSlots)
    throw new ResponseCapacityError();
  responseSlots.add(id);
}
function retainResponse(receipt: Receipt) {
  responseSlots.delete(receipt.id);
  if (
    unsaved.size < maxResponseSlots &&
    unsavedBytes() + receipt.response!.body.length * 2 <= maxUnsavedBytes
  )
    unsaved.set(receipt.id, receipt);
}
function persistResponse(completed: Receipt) {
  assertOutsideTransaction();
  try {
    transaction(() => {
      const current = get<Guard>(guards, completed.id);
      const receipt = get<Receipt>('request-receipts', completed.id);
      if (
        current?.id !== completed.id ||
        current.attempt !== completed.attempt ||
        current.scopeHash !== completed.scopeHash ||
        receipt?.id !== completed.id ||
        receipt.attempt !== completed.attempt ||
        receipt.scopeHash !== completed.scopeHash ||
        receipt.polling !== completed.polling ||
        receipt.createdAt !== completed.createdAt
      )
        throw new UncertainRequestError();
      const responseHash = digest(JSON.stringify(completed.response));
      if (
        receipt.state === 'received' &&
        current.responseHash === responseHash &&
        digest(JSON.stringify(receipt.response)) === responseHash &&
        ['received', 'consumed', 'poll-ready'].includes(current.state)
      )
        return;
      if (
        current.state !== 'pending' ||
        current.responseHash !== undefined ||
        current.consumedBy !== undefined ||
        receipt.state !== 'pending' ||
        receipt.response !== undefined
      )
        throw new UncertainRequestError();
      put('request-receipts', completed);
      put(guards, {
        ...current,
        state: 'received',
        responseHash: digest(JSON.stringify(completed.response)),
      });
    });
  } catch (error) {
    if (error instanceof UncertainRequestError) throw error;
    throw new ReceiptPersistenceError(unsaved.has(completed.id));
  }
  unsaved.delete(completed.id);
  return completed;
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
      assertOutsideTransaction();
      beforeDispatch?.();
      assertOutsideTransaction();
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
        existing?.id === id &&
        existing.state === 'received' &&
        existing.response &&
        guard?.id === id &&
        guard.scopeHash === existing.scopeHash &&
        (!guard.scopeHash || guard.scopeHash === digest(scope)) &&
        guard.attempt === existing.attempt &&
        (guard.state === 'received' || guard.state === 'consumed') &&
        guard.responseHash === digest(JSON.stringify(existing.response))
      ) {
        const retained = unsaved.get(id);
        if (
          retained &&
          (retained.attempt !== existing.attempt ||
            retained.scopeHash !== existing.scopeHash ||
            digest(JSON.stringify(retained.response)) !== guard.responseHash)
        )
          throw new UncertainRequestError();
        unsaved.delete(id);
        return replay(existing);
      }
      const retained = unsaved.get(id);
      if (retained) return replay(persistResponse(retained));
      if ((!nextPoll && guard) || replayOnly) throw new UncertainRequestError();
      assertOutsideTransaction();
      assertDispatchAllowed(scope);
      reserveResponseSlot(id);
      try {
        beforeDispatch?.();
        assertOutsideTransaction();
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
          retainResponse(completed);
          return persistResponse(completed);
        })();
        flights.set(id, flight);
      } catch (error) {
        responseSlots.delete(id);
        throw error;
      }
    }
    try {
      return replay(await flight);
    } finally {
      if (flights.get(id) === flight) {
        flights.delete(id);
        responseSlots.delete(id);
      }
    }
  };
}
