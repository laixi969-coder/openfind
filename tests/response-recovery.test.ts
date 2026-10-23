import { test, after } from 'node:test';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'openfind-response-recovery-'));
process.env.OPENFIND_DATA_DIR = dir;
const { db, all, get, put } = await import('../server/store.ts');
const { journaledFetch, ReceiptPersistenceError, ResponseCapacityError, UncertainRequestError } =
  await import('../server/request-journal.ts');
after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
const url = 'https://vendor.example/capacity';
function failGuardWrite() {
  db.exec(
    "CREATE TRIGGER fail_recovered_guard BEFORE UPDATE ON entities WHEN NEW.kind='request-guards' AND json_extract(NEW.value,'$.state')='received' BEGIN SELECT RAISE(ABORT, 'guard write failed'); END",
  );
}
function allowWrites() {
  db.exec('DROP TRIGGER fail_recovered_guard');
}

test('in-flight requests reserve all 32 slots; repeated recovery failures neither evict responses nor publish partial receipts', async () => {
  let calls = 0,
    preflights = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const requests = Array.from({ length: 33 }, (_, i) =>
    journaledFetch(
      'slot-' + i,
      (async () => {
        calls++;
        await gate;
        return new Response('response-' + i);
      }) as typeof fetch,
      () => {
        preflights++;
      },
    ),
  );
  failGuardWrite();
  try {
    const pending = requests
      .slice(0, 32)
      .map((r) => assert.rejects(r(url), ReceiptPersistenceError));
    await assert.rejects(requests[32](url), ResponseCapacityError);
    assert.equal(calls, 32);
    assert.equal(preflights, 32);
    assert.equal(all('request-receipts').length, 32);
    release();
    await Promise.all(pending);
    const retryFailures = await Promise.allSettled(
      requests.slice(0, 32).flatMap((r) => [r(url), r(url)]),
    );
    for (const result of retryFailures) {
      assert.equal(result.status, 'rejected');
      if (result.status === 'rejected') assert.ok(result.reason instanceof ReceiptPersistenceError);
    }
    await assert.rejects(requests[32](url), ResponseCapacityError);
    for (const receipt of all<any>('request-receipts')) {
      assert.equal(receipt.state, 'pending');
      assert.equal(receipt.response, undefined);
      assert.equal(get<any>('request-guards', receipt.id).state, 'pending');
    }
  } finally {
    release();
    allowWrites();
  }
  for (let i = 0; i < 32; i++) {
    const responses = await Promise.all([requests[i](url), requests[i](url)]);
    for (const response of responses) assert.equal(await response.text(), 'response-' + i);
  }
  assert.equal(calls, 32);
  assert.equal(preflights, 32);
  assert.equal(await (await requests[32](url)).text(), 'response-32');
  assert.equal(calls, 33);
});

test('the byte limit blocks new dispatch without blocking persistence of the response at the limit', async () => {
  let calls = 0;
  const body = 'x'.repeat(32 * 1024 * 1024);
  const request = journaledFetch(
    'byte-limit',
    (async () => {
      calls++;
      return new Response(body);
    }) as typeof fetch,
    undefined,
    false,
    false,
    40 * 1024 * 1024,
  );
  const other = journaledFetch('after-byte-limit', (async () => {
    calls++;
    return new Response('new');
  }) as typeof fetch);
  failGuardWrite();
  try {
    await assert.rejects(request(url), ReceiptPersistenceError);
    await assert.rejects(other(url), ResponseCapacityError);
    await assert.rejects(request(url), ReceiptPersistenceError);
    assert.equal(calls, 1);
  } finally {
    allowWrites();
  }
  const response = await request(url);
  assert.equal((await response.text()).length, body.length);
  await other(url);
  assert.equal(calls, 2);
});

test('retained responses cannot overwrite changed receipt identity, scope or an existing received result', async () => {
  for (const field of ['attempt', 'scopeHash', 'state', 'id']) {
    let calls = 0;
    const scope = 'identity-' + field;
    const request = journaledFetch(scope, (async () => {
      calls++;
      return new Response('original-' + field);
    }) as typeof fetch);
    failGuardWrite();
    try {
      await assert.rejects(request(url), ReceiptPersistenceError);
    } finally {
      allowWrites();
    }
    const original = all<any>('request-receipts').find(
      (r) => r.scopeHash && r.state === 'pending',
    )!;
    // The earlier tests leave no pending rows; this loop restores each one before continuing.
    const changed = { ...original, [field]: field === 'state' ? 'received' : 'foreign-' + field };
    db.prepare("UPDATE entities SET value=? WHERE kind='request-receipts' AND id=?").run(
      JSON.stringify(changed),
      original.id,
    );
    await assert.rejects(request(url), UncertainRequestError);
    assert.deepEqual(get('request-receipts', original.id), changed);
    put('request-receipts', original);
    assert.equal(await (await request(url)).text(), 'original-' + field);
    assert.equal(calls, 1);
  }
});

test(
  'a concurrent recovery commit is accepted only for the exact retained attempt and body',
  { timeout: 15000 },
  async () => {
    const { fork } = await import('node:child_process');
    const { hashIdentity } = await import('../server/collection-integrity.ts');
    for (const conflicting of [false, true]) {
      const scope = 'concurrent-persist-' + conflicting;
      let calls = 0;
      const request = journaledFetch(scope, (async () => {
        calls++;
        return new Response('owner response');
      }) as typeof fetch);
      failGuardWrite();
      try {
        await assert.rejects(request(url), ReceiptPersistenceError);
      } finally {
        allowWrites();
      }
      const original = all<any>('request-receipts').find(
        (r) => r.scopeHash === hashIdentity(scope),
      )!;
      const guard = get<any>('request-guards', original.id);
      const child = fork(
        new URL('./fixtures/publish-recovery-worker.ts', import.meta.url),
        [original.id, conflicting ? 'conflicting response' : 'owner response'],
        {
          execArgv: ['--import', 'tsx'],
          stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
          env: { ...process.env, OPENFIND_DATA_DIR: dir },
        },
      );
      try {
        await once(child, 'message');
        const exited = once(child, 'exit');
        child.send('publish');
        if (conflicting) {
          await assert.rejects(request(url), UncertainRequestError);
          assert.equal(
            get<any>('request-receipts', original.id).response.body,
            'conflicting response',
          );
        } else assert.equal(await (await request(url)).text(), 'owner response');
        await exited;
      } finally {
        child.kill();
      }
      if (conflicting) {
        await assert.rejects(request(url), UncertainRequestError);
        put('request-receipts', original);
        put('request-guards', guard);
        assert.equal(await (await request(url)).text(), 'owner response');
      }
      assert.equal(calls, 1);
    }
  },
);

test('failed preflight, failed claims and failed transports release reserved slots', async () => {
  for (let i = 0; i < 40; i++) {
    await assert.rejects(
      journaledFetch('slot-preflight-' + i, fetch, () => {
        throw Error('local preflight');
      })(url),
      /local preflight/,
    );
  }
  db.exec(
    "CREATE TRIGGER fail_admission BEFORE INSERT ON entities WHEN NEW.kind='request-receipts' BEGIN SELECT RAISE(ABORT, 'claim write failure'); END",
  );
  try {
    for (let i = 0; i < 40; i++)
      await assert.rejects(journaledFetch('slot-claim-' + i)(url), /claim write failure/);
  } finally {
    db.exec('DROP TRIGGER fail_admission');
  }
  for (let i = 0; i < 40; i++)
    await assert.rejects(
      journaledFetch('slot-transport-' + i, (async () => {
        throw Error('transport failure');
      }) as typeof fetch)(url),
      /transport failure/,
    );
  assert.equal(
    await (
      await journaledFetch(
        'after-slot-release',
        (async () => new Response('available')) as typeof fetch,
      )(url)
    ).text(),
    'available',
  );
});

test('a single unsaved response applies backpressure before its remaining byte capacity can be exceeded', async () => {
  let calls = 0;
  const retained = journaledFetch('backpressure-original', (async () => {
    calls++;
    return new Response('small unsaved response');
  }) as typeof fetch);
  const fresh = journaledFetch('backpressure-new', (async () => {
    calls++;
    return new Response('new paid request');
  }) as typeof fetch);
  failGuardWrite();
  try {
    await assert.rejects(retained(url), ReceiptPersistenceError);
    await assert.rejects(fresh(url), ResponseCapacityError);
    assert.equal(calls, 1);
  } finally {
    allowWrites();
  }
  await retained(url);
  await fresh(url);
  assert.equal(calls, 2);
});

test('an already dispatched response larger than the memory budget fails explicitly and cannot be resent or treated as saved', async () => {
  const { hashIdentity } = await import('../server/collection-integrity.ts');
  const scope = 'oversized-response';
  let calls = 0;
  const request = journaledFetch(
    scope,
    (async () => {
      calls++;
      return new Response('x'.repeat(32 * 1024 * 1024 + 1));
    }) as typeof fetch,
    undefined,
    false,
    false,
    40 * 1024 * 1024,
  );
  failGuardWrite();
  try {
    await assert.rejects(
      request(url),
      (error: unknown) =>
        error instanceof ReceiptPersistenceError && /暂存容量不足/.test(error.message),
    );
  } finally {
    allowWrites();
  }
  await assert.rejects(request(url), UncertainRequestError);
  const receipt = all<any>('request-receipts').find((r) => r.scopeHash === hashIdentity(scope))!;
  assert.equal(receipt.state, 'pending');
  assert.equal(receipt.response, undefined);
  assert.equal(get<any>('request-guards', receipt.id).state, 'pending');
  assert.equal(calls, 1);
});
