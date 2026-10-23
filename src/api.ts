import type { Snapshot } from '../shared/types';
const pendingModelRequests = new Map<string, string>();
const paidPath =
  /\/(copy\/rewrite|llm\/test|images\/(test|variants)|insights\/(breakdown|comments|author|keywords)|workflows\/[^/]+\/review|inbox\/threads\/[^/]+\/suggest)$/;
export function clearPendingModelRequests() {
  pendingModelRequests.clear();
  try {
    for (const key of Object.keys(localStorage))
      if (key.startsWith('openfind:model-request:')) localStorage.removeItem(key);
  } catch {
    /* Storage may be disabled; in-memory identities were still cleared. */
  }
}
export async function api<T = unknown>(path: string, body?: unknown, method?: string): Promise<T> {
  const verb = method || (body !== undefined ? 'POST' : 'GET');
  let pendingKey = '',
    requestId = '';
  if (verb === 'POST' && paidPath.test(path)) {
    const bytes = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(path + JSON.stringify(body)),
    );
    pendingKey =
      'openfind:model-request:' +
      Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
    try {
      requestId = localStorage.getItem(pendingKey) || '';
    } catch {
      /* storage unavailable */
    }
    requestId ||= pendingModelRequests.get(pendingKey) || crypto.randomUUID();
    pendingModelRequests.set(pendingKey, requestId);
    try {
      localStorage.setItem(pendingKey, requestId);
    } catch {
      /* in-memory retry identity remains */
    }
  }
  const r = await fetch('/api' + path, {
    method: verb,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(requestId ? { 'Idempotency-Key': requestId } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  if (pendingKey && (r.ok || [400, 404].includes(r.status))) {
    pendingModelRequests.delete(pendingKey);
    try {
      if (localStorage.getItem(pendingKey) === requestId) localStorage.removeItem(pendingKey);
    } catch {
      /* no persisted key */
    }
  }
  if (!r.ok) throw new Error(data.error || `请求失败 (${r.status})`);
  return data as T;
}
let stateCache: { etag: string; data: Snapshot } | undefined;
let stateFlight: Promise<Snapshot> | undefined;
export function getState(): Promise<Snapshot> {
  if (stateFlight) return stateFlight;
  stateFlight = (async () => {
    const response = await fetch('/api/state', {
      cache: 'no-store',
      headers: stateCache ? { 'If-None-Match': stateCache.etag } : {},
    });
    if (response.status === 304 && stateCache) return stateCache.data;
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '读取工作台失败');
    stateCache = { etag: response.headers.get('etag') || '', data };
    return data as Snapshot;
  })().finally(() => {
    stateFlight = undefined;
  });
  return stateFlight;
}
export const shortNum = (n: number) =>
  n >= 10000 ? (n / 10000).toFixed(1) + '万' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
export function saveFile(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}
export function exportUrl(kind: string, format = 'json', ids?: string[]) {
  return `/api/export/${kind}?format=${format}${ids?.length ? '&ids=' + encodeURIComponent(ids.join(',')) : ''}`;
}
export function safeUrl(url: string) {
  return /^https?:\/\//.test(url) ? url : undefined;
}

export async function downloadExport(kind: string, format: 'json' | 'csv', ids: string[]) {
  const response = await fetch('/api/export/' + kind, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, format }),
  });
  if (!response.ok) throw new Error((await response.json()).error || '导出失败');
  saveFile(await response.blob(), `openfind-${kind}.${format}`);
}
