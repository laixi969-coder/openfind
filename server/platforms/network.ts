import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { fetch as dnsFetch, EnvHttpProxyAgent } from 'undici';

// Resolve public platform/CDN names without the system's synthetic DNS addresses.
// HTTPS stays encrypted end to end. The ephemeral loopback listener only forwards
// CONNECT to public hosts requested by the platform browser on port 443; it cannot access local services.
// User credentials and application RPC remain outside this transport layer.
const dnsAgent = new EnvHttpProxyAgent();
const cache = new Map<string, { ips: string[]; expires: number }>();
const sockets = new Set<Duplex>();
let proxy: http.Server | undefined;
let starting: Promise<{ server: string }> | undefined;

const requestedHosts = new Set<string>();
const hostWaiters = new Map<string, Set<(allowed: boolean) => void>>();
export function allowNetworkRequest(url: string) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || (u.port && u.port !== '443')) return;
    requestedHosts.add(u.hostname);
    for (const resolve of hostWaiters.get(u.hostname) || []) resolve(true);
    hostWaiters.delete(u.hostname);
  } catch {}
}
function requestedHost(host: string) {
  if (requestedHosts.has(host)) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const waiting = hostWaiters.get(host) || new Set();
    const finish = (allowed: boolean) => {
      clearTimeout(timer);
      waiting.delete(finish);
      if (!waiting.size) hostWaiters.delete(host);
      resolve(allowed);
    };
    const timer = setTimeout(() => finish(false), 1500);
    waiting.add(finish);
    hostWaiters.set(host, waiting);
  });
}

function publicIPv4(ip: string) {
  if (net.isIP(ip) !== 4) return false;
  const [a, b] = ip.split('.').map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

export async function resolvePublicHost(host: string) {
  const known = cache.get(host);
  if (known && known.expires > Date.now()) return known.ips;
  if (net.isIP(host)) {
    if (!publicIPv4(host)) throw new Error('仅允许连接公网地址');
    return [host];
  }
  if (!/^[a-zA-Z0-9.-]+$/.test(host) || !host.includes('.')) throw new Error('无效的平台域名');
  const r = await dnsFetch(`https://dns.google/resolve?name=${encodeURIComponent(host)}&type=A`, {
    dispatcher: dnsAgent,
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error('公共 DNS 暂时不可用');
  const d = (await r.json()) as { Answer?: { type: number; data: string; TTL: number }[] };
  const answers = (d.Answer || []).filter((a) => a.type === 1 && publicIPv4(a.data));
  const ips = [...new Set(answers.map((a) => a.data))];
  if (!ips.length) throw new Error('未取得平台公网地址');
  const ttl = Math.min(1800, Math.max(30, ...answers.map((a) => a.TTL || 60)));
  cache.set(host, { ips, expires: Date.now() + ttl * 1000 });
  return ips;
}

async function connect(host: string, port: number): Promise<net.Socket> {
  const ips = await resolvePublicHost(host);
  let last: unknown;
  for (const ip of ips.slice(0, 4)) {
    try {
      return await new Promise<net.Socket>((resolve, reject) => {
        const socket = net.connect({ host: ip, port });
        socket.on('error', () => {});
        const timer = setTimeout(() => socket.destroy(new Error('平台连接超时')), 5000);
        socket.once('error', reject);
        socket.once('connect', () => {
          clearTimeout(timer);
          socket.removeListener('error', reject);
          sockets.add(socket);
          socket.once('close', () => sockets.delete(socket));
          resolve(socket);
        });
        socket.once('close', () => clearTimeout(timer));
      });
    } catch (e) {
      last = e;
    }
  }
  throw last || new Error('平台连接失败');
}

export function directProxy() {
  if (starting) return starting;
  starting = (async () => {
    proxy = http.createServer((req, res) => {
      // All official platform entry points use HTTPS. Do not proxy arbitrary HTTP requests.
      res.writeHead(400);
      res.end('Use HTTPS');
    });
    proxy.on('clientError', (_error, socket) => socket.destroy());
    proxy.on('connect', (req, socket, head) => {
      socket.on('error', () => socket.destroy());
      let target: URL;
      try {
        target = new URL('https://' + req.url);
      } catch {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        return;
      }
      if (target.port && target.port !== '443') {
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      void requestedHost(target.hostname)
        .then((allowed) => {
          if (!allowed) throw new Error('不是平台浏览器发起的连接');
          return connect(target.hostname, 443);
        })
        .then((upstream) => {
          if (socket.destroyed) {
            upstream.destroy();
            return;
          }
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head.length) upstream.write(head);
          socket.pipe(upstream);
          upstream.pipe(socket);
          socket.on('error', () => upstream.destroy());
          upstream.on('error', () => socket.destroy());
          socket.once('close', () => upstream.destroy());
          upstream.once('close', () => socket.destroy());
        })
        .catch(() => socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
    });
    await new Promise<void>((resolve, reject) => {
      proxy!.once('error', reject);
      proxy!.listen(0, '127.0.0.1', resolve);
    });
    const address = proxy.address() as net.AddressInfo;
    return { server: `http://127.0.0.1:${address.port}` };
  })();
  return starting;
}

export async function closeNetwork() {
  for (const socket of sockets) socket.destroy();
  if (proxy) await new Promise<void>((resolve) => proxy!.close(() => resolve()));
  await dnsAgent.close();
}
