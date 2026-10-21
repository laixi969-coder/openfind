import { createHash, randomUUID } from 'node:crypto';
import { db, get, put } from './store.ts';

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
  return response;
}
export function forgetReceivedRequest(response: Response) {
  const receipt = responseReceipts.get(response);
  if (!receipt) return;
  // A late consumer of an old poll must never delete a newer poll's receipt.
  db.prepare('DELETE FROM entities WHERE kind=? AND id=? AND value=?').run(
    'request-receipts',
    receipt.id,
    JSON.stringify(receipt),
  );
}
export function journaledFetch(
  scope: string | undefined,
  transport: typeof fetch = fetch,
  beforeDispatch?: () => void,
  replayOnly = false,
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
      if (existing?.state === 'received') return replay(existing);
      if (existing || replayOnly) throw new UncertainRequestError();
      beforeDispatch?.();
      const receipt: Receipt = {
        id,
        state: 'pending',
        createdAt: new Date().toISOString(),
        attempt: randomUUID(),
      };
      if (!claimEntity('request-receipts', receipt)) throw new UncertainRequestError();
      flight = (async () => {
        // The durable claim precedes dispatch. Failure at any later boundary must
        // leave it in place: a timeout cannot tell us whether the vendor charged.
        const response = await transport(url, init);
        const result = { status: response.status, body: await response.text() };
        const completed: Receipt = { ...receipt, state: 'received', response: result };
        put('request-receipts', completed);
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
