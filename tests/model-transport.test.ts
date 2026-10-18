import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LookupFunction } from 'node:net';
import { createModelLookup } from '../server/model-transport.ts';
const resolve = (lookup: LookupFunction, hostname: string, all = false) =>
  new Promise((resolve, reject) =>
    lookup(hostname, { all }, (error, address, family) =>
      error ? reject(error) : resolve({ address, family }),
    ),
  );
test('Only synthetic proxy DNS is resolved publicly, retaining the exact requested hostname', async () => {
  const requested: string[] = [];
  const lookup = createModelLookup(
    async () => [{ address: '198.18.0.84', family: 4 }],
    async (host) => {
      requested.push(host);
      return ['203.0.113.10'];
    },
  );
  assert.deepEqual(await resolve(lookup, 'model.example', true), {
    address: [{ address: '203.0.113.10', family: 4 }],
    family: undefined,
  });
  assert.deepEqual(requested, ['model.example']);
});
test('Normal DNS and local model services are not redirected or disclosed to public DNS', async () => {
  for (const address of ['127.0.0.1', '10.0.0.3', '8.8.8.8', '::1']) {
    let calls = 0;
    const lookup = createModelLookup(
      async () => [{ address, family: address.includes(':') ? 6 : 4 }],
      async () => {
        calls++;
        throw Error('must not run');
      },
    );
    assert.deepEqual(await resolve(lookup, 'user-configured-host'), {
      address,
      family: address.includes(':') ? 6 : 4,
    });
    assert.equal(calls, 0);
  }
});
test('Resolver errors stop the connection without trying another service or weakening TLS', async () => {
  const lookup = createModelLookup(
    async () => [{ address: '198.19.0.1', family: 4 }],
    async () => {
      throw Error('DNS unavailable');
    },
  );
  await assert.rejects(() => resolve(lookup, 'model.example'), /DNS unavailable/);
});
