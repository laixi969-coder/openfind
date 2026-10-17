import type { Snapshot } from '../shared/types';
export async function api<T = unknown>(path: string, body?: unknown, method?: string): Promise<T> {
  const r = await fetch('/api' + path, {
    method: method || (body !== undefined ? 'POST' : 'GET'),
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || `请求失败 (${r.status})`);
  return data as T;
}
export const getState = () => api<Snapshot>('/state');
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
