import dns from 'node:dns';
import type { LookupFunction } from 'node:net';
import { Agent } from 'undici';
import { resolvePublicHost } from './platforms/network.ts';
// Proxy DNS can return benchmark-range synthetic addresses. Resolve only this
// case through the existing public resolver before connecting to the SAME host.
// TLS still validates the original hostname; keys never go to DNS or a new URL.
export function createModelLookup(
  lookupAll: (host: string) => Promise<dns.LookupAddress[]> = (host) =>
    dns.promises.lookup(host, { all: true }),
  publicLookup: (host: string) => Promise<string[]> = resolvePublicHost,
): LookupFunction {
  return (hostname, options, callback) => {
    void lookupAll(hostname)
      .then(async (addresses) => {
        if (!addresses.length) throw new Error('模型服务域名没有可用地址');
        const rows = addresses.every((a) => /^198\.(18|19)\./.test(a.address))
          ? (await publicLookup(hostname)).map((address) => ({ address, family: 4 }))
          : addresses;
        if (!rows.length) throw new Error('模型服务没有可用公网地址');
        if (options.all) callback(null, rows);
        else callback(null, rows[0].address, rows[0].family);
      })
      .catch((error) => callback(error, '', 4));
  };
}
export const modelDispatcher = new Agent({ connect: { lookup: createModelLookup() } });
