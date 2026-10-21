import { isIP } from 'node:net';
import { Agent, fetch } from 'undici';
import { resolvePublicHost } from './platforms/network.ts';

// Untrusted media URLs must never share the model transport, which intentionally
// permits user-configured local model servers. Validate DNS at connection time.
export function mediaUrl(value: string) {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('图片地址必须为不含凭证的 HTTP(S) 地址');
  if (isIP(host)) {
    if (isIP(host) !== 4 || !isPublicMediaIPv4(host)) throw new Error('图片仅允许公网地址');
  } else if (!host.includes('.') || host.endsWith('.localhost')) {
    throw new Error('图片仅允许公网地址');
  }
  return url;
}
export function isPublicMediaIPv4(ip: string) {
  if (isIP(ip) !== 4) return false;
  const [a, b, c] = ip.split('.').map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0 || (b === 2 && c === 0))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}
const mediaDispatcher = new Agent({
  connect: {
    lookup(host, options, callback) {
      void resolvePublicHost(host)
        .then((ips) => {
          const rows = ips.filter(isPublicMediaIPv4).map((address) => ({ address, family: 4 }));
          if (!rows.length) throw new Error('图片仅允许公网地址');
          if (options.all) callback(null, rows);
          else callback(null, rows[0].address, 4);
        })
        .catch((error) => callback(error, '', 4));
    },
  },
});

export async function readLimitedBody(
  response: {
    headers: { get(name: string): string | null };
    body: {
      cancel(): Promise<void>;
      getReader(): {
        read(): Promise<{ done: boolean; value?: Uint8Array }>;
        cancel(): Promise<void>;
        releaseLock(): void;
      };
    } | null;
  },
  maxBytes: number,
): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new Error('响应超过大小限制');
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('响应超过大小限制');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function downloadMedia(
  value: string,
  maxBytes: number,
  request: typeof fetch = fetch,
) {
  let url = mediaUrl(value);
  const signal = AbortSignal.timeout(60000);
  for (let hops = 0; hops <= 5; hops++) {
    const response = await request(url, {
      dispatcher: mediaDispatcher,
      redirect: 'manual',
      signal,
      headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://www.xiaohongshu.com/' },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) throw new Error('图片重定向缺少地址');
      url = mediaUrl(new URL(location, url).href);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`图片下载失败（HTTP ${response.status}）`);
    }
    return readLimitedBody(response, maxBytes);
  }
  throw new Error('图片重定向次数过多');
}
