import { DatabaseSync } from 'node:sqlite';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
const dir = mkdtempSync(join(tmpdir(), 'openfind-request-journal-'));
process.env.OPENFIND_DATA_DIR = dir;
const { db, all } = await import('../server/store.ts');
const { journaledFetch, UncertainRequestError } = await import('../server/request-journal.ts');
after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
const url = 'https://vendor.example/paid';

test('concurrent callers share dispatch and receive independent bodies; recreation replays durably', async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const transport = (async () => {
    calls++;
    await gate;
    return Response.json({ items: ['paid-result'] });
  }) as typeof fetch;
  const a = journaledFetch('concurrent', transport)(url);
  const b = journaledFetch('concurrent', transport)(url);
  release();
  const responses = await Promise.all([a, b]);
  assert.deepEqual(await responses[0].json(), await responses[1].json());
  assert.equal(calls, 1);
  const replay = await journaledFetch('concurrent', transport)(url);
  assert.deepEqual(await replay.json(), { items: ['paid-result'] });
  assert.equal(calls, 1);
});

test('body timeout leaves an uncertain receipt and cannot dispatch on retry', async () => {
  let calls = 0;
  const controller = new AbortController();
  const transport = (async () => {
    calls++;
    return new Response(
      new ReadableStream({
        start(c) {
          controller.signal.addEventListener('abort', () => c.error(Error('body timeout')));
        },
      }),
    );
  }) as typeof fetch;
  const pending = journaledFetch('body-timeout', transport)(url, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /body timeout/);
  await assert.rejects(journaledFetch('body-timeout', transport)(url), UncertainRequestError);
  assert.equal(calls, 1);
});

test('local preflight rejection does not claim a billable request; credentials are not stored', async () => {
  let calls = 0;
  const transport = (async () => {
    calls++;
    return new Response('ok');
  }) as typeof fetch;
  const init = {
    headers: { Authorization: 'Bearer secret-token' },
    body: 'private-cookie',
    method: 'POST',
  };
  await assert.rejects(
    journaledFetch('preflight', transport, () => {
      throw Error('budget');
    })(url, init),
    /budget/,
  );
  assert.equal(calls, 0);
  await journaledFetch('preflight', transport)(url, init);
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(all('request-receipts')).includes('secret-token'));
  assert.ok(!JSON.stringify(all('request-receipts')).includes('private-cookie'));
});

function worker(scope: string, target: string, dataDirectory = dir) {
  return fork(new URL('./fixtures/request-worker.ts', import.meta.url), [scope, target], {
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    env: { ...process.env, OPENFIND_DATA_DIR: dataDirectory },
  });
}
function message(child: ChildProcess) {
  return new Promise<{ result?: string; error?: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('worker timed out')), 10000);
    child.once('message', (m) => {
      clearTimeout(timer);
      resolve(m as any);
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(Error('worker exited before response'));
    });
    child.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  child.kill('SIGKILL');
  await exited;
}

test('cross-process contention and SIGKILL after dispatch never issue a second paid request', async () => {
  let calls = 0;
  let arrived!: () => void;
  const received = new Promise<void>((r) => {
    arrived = r;
  });
  const server = createServer((_req, _res) => {
    calls++;
    arrived();
  }).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const target = `http://127.0.0.1:${(server.address() as { port: number }).port}/paid`;
  const first = worker('killed', target);
  let second: ChildProcess | undefined;
  try {
    await received;
    second = worker('killed', target);
    assert.match((await message(second)).error!, /阻止自动重发/);
    await stop(first);
    await assert.rejects(journaledFetch('killed')(target), UncertainRequestError);
    assert.equal(calls, 1);
  } finally {
    if (first.exitCode === null && first.signalCode === null) await stop(first);
    if (second) await stop(second);
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('SIGKILL after receipt persistence replays the paid result without the vendor', async () => {
  let calls = 0;
  const server = createServer((_req, res) => {
    calls++;
    res.end('durable-result');
  }).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const target = `http://127.0.0.1:${(server.address() as { port: number }).port}/paid`;
  const child = worker('received-before-crash', target);
  try {
    assert.equal((await message(child)).result, 'durable-result');
    await stop(child);
    assert.equal(
      await (await journaledFetch('received-before-crash')(target)).text(),
      'durable-result',
    );
    assert.equal(calls, 1);
  } finally {
    if (child.exitCode === null && child.signalCode === null) await stop(child);
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('a late pending poll consumer cannot delete the newer completed receipt', async () => {
  const { advancePendingPoll } = await import('../server/request-journal.ts');
  let calls = 0;
  const transport = (async () =>
    Response.json({
      code: 2000,
      data: { status: ++calls === 1 ? 'processing' : 'completed' },
    })) as typeof fetch;
  const request = journaledFetch('poll-generation', transport, undefined, false, true);
  const first = await request(url);
  const lateConsumer = await request(url);
  advancePendingPoll(first);
  const completed = await request(url);
  assert.equal((await completed.json()).data.status, 'completed');
  advancePendingPoll(lateConsumer);
  assert.equal((await (await request(url)).json()).data.status, 'completed');
  assert.equal(calls, 2);
});

test('removing received or uncertain response records cannot reopen dispatch', async () => {
  const { remove } = await import('../server/store.ts');
  for (const fail of [false, true]) {
    let calls = 0;
    const request = journaledFetch('removed-' + fail, (async () => {
      calls++;
      if (fail) throw Error('lost response');
      return new Response('saved');
    }) as typeof fetch);
    const previous = new Set(all<any>('request-receipts').map((r) => r.id));
    await request(url).catch(() => {});
    const receipt = all<any>('request-receipts').find((r) => !previous.has(r.id))!;
    remove('request-receipts', receipt.id);
    await assert.rejects(request(url), UncertainRequestError);
    assert.equal(calls, 1);
  }
});

test('poll advancement cannot release a successful paid response or unmarked request', async () => {
  const { advancePendingPoll, compactConsumedReceipt, captureRequestReceipts } =
    await import('../server/request-journal.ts');
  let calls = 0;
  const request = journaledFetch('not-a-poll', (async () => {
    calls++;
    return Response.json({ code: 2000, data: { status: 'processing' } });
  }) as typeof fetch);
  const captured = await captureRequestReceipts(() => request(url));
  assert.equal(advancePendingPoll(captured.result), false);
  assert.equal(compactConsumedReceipt(captured.receipts[0]), false);
  await request(url);
  assert.equal(calls, 1);
  const success = journaledFetch(
    'completed-poll',
    (async () => {
      calls++;
      return Response.json({ code: 2000, data: { status: 'completed' } });
    }) as typeof fetch,
    undefined,
    false,
    true,
  );
  assert.equal(advancePendingPoll(await success(url)), false);
  await success(url);
  assert.equal(calls, 2);
});

test('concurrent process startups migrate legacy receipts once and replay without dispatch', async () => {
  const { captureRequestReceipts } = await import('../server/request-journal.ts');
  const captured = await captureRequestReceipts(() =>
    journaledFetch(
      'legacy-upgrade',
      (async () => new Response('legacy-data')) as typeof fetch,
    )(url),
  );
  const ref = captured.receipts[0];
  const isolated = mkdtempSync(join(tmpdir(), 'openfind-legacy-'));
  copyFileSync(join(dir, '.credential-key'), join(isolated, '.credential-key'));
  const oldDb = new DatabaseSync(join(isolated, 'openfind.sqlite'));
  oldDb.exec(
    'CREATE TABLE entities(kind TEXT,id TEXT,value TEXT,PRIMARY KEY(kind,id)); CREATE TABLE config(key TEXT PRIMARY KEY,value TEXT);',
  );
  const receipt = all<any>('request-receipts').find((r) => r.id === ref.id)!;
  oldDb
    .prepare('INSERT INTO entities VALUES(?,?,?)')
    .run('request-receipts', ref.id, JSON.stringify(receipt));
  oldDb.exec('BEGIN IMMEDIATE');
  const children = [
    worker('legacy-upgrade', url, isolated),
    worker('legacy-upgrade', url, isolated),
  ];
  try {
    const repliesPromise = Promise.all(children.map(message));
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    oldDb.exec('COMMIT');
    oldDb.close();
    const replies = await repliesPromise;
    for (const reply of replies) assert.equal(reply.result, 'legacy-data');
    const restored = new DatabaseSync(join(isolated, 'openfind.sqlite'));
    assert.ok(
      restored
        .prepare('SELECT value FROM entities WHERE kind=? AND id=?')
        .get('request-guards', ref.id),
    );
    restored.close();
  } finally {
    await Promise.all(children.map(stop));
    if (oldDb.isOpen) oldDb.close();
    rmSync(isolated, { recursive: true, force: true });
  }
});

test('mismatched persisted response and guard are rejected instead of replayed or resent', async () => {
  const { put } = await import('../server/store.ts');
  const { captureRequestReceipts } = await import('../server/request-journal.ts');
  let calls = 0;
  const request = journaledFetch('response-integrity', (async () => {
    calls++;
    return new Response('original');
  }) as typeof fetch);
  const captured = await captureRequestReceipts(() => request(url));
  const row = all<any>('request-receipts').find((r) => r.id === captured.receipts[0].id)!;
  put('request-receipts', { ...row, response: { ...row.response, body: 'different-response' } });
  await assert.rejects(request(url), UncertainRequestError);
  assert.equal(calls, 1);
});

test('outer rollback cannot erase a claim after dispatch; scoped and unscoped sends wait for durable boundaries', async () => {
  const { transaction, UncommittedRequestError } = await import('../server/store.ts');
  let calls = 0;
  const transport = (async () => {
    calls++;
    return new Response('paid');
  }) as typeof fetch;
  for (const scope of ['outer-rollback', undefined]) {
    let pending!: Promise<Response>;
    assert.throws(
      () =>
        transaction(() => {
          pending = journaledFetch(scope, transport)(url);
          throw new Error('outer rollback');
        }),
      /outer rollback/,
    );
    await assert.rejects(pending, UncommittedRequestError);
  }
  assert.equal(calls, 0);
  await journaledFetch('outer-rollback', transport)(url);
  await journaledFetch('outer-rollback', transport)(url);
  assert.equal(calls, 1);
  assert.throws(
    () =>
      transaction(async () => {
        await journaledFetch('async-transaction', transport)(url);
      }),
    /同步/,
  );
  assert.equal(calls, 1);
});

test('an async transaction continuation remains unable to dispatch after the synchronous rollback', async () => {
  const { transaction, UncommittedRequestError } = await import('../server/store.ts');
  let calls = 0;
  let observed: unknown;
  assert.throws(
    () =>
      transaction(async () => {
        await Promise.resolve();
        try {
          await journaledFetch('late-transaction', (async () => {
            calls++;
            return new Response('paid');
          }) as typeof fetch)(url);
        } catch (error) {
          observed = error;
        }
      }),
    /同步/,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(observed instanceof UncommittedRequestError);
  assert.equal(calls, 0);
});

test('a lock timeout after response arrival retries only persistence, including concurrent resumes', async () => {
  const { ReceiptPersistenceError } = await import('../server/request-journal.ts');
  let child: ChildProcess | undefined;
  let calls = 0;
  const request = journaledFetch('locked-response', (async () => {
    calls++;
    child = fork(new URL('./fixtures/lock-worker.ts', import.meta.url), [], {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      env: { ...process.env, OPENFIND_DATA_DIR: dir },
    });
    await message(child);
    return new Response('response retained through lock timeout');
  }) as typeof fetch);
  db.exec('PRAGMA busy_timeout=30');
  try {
    await assert.rejects(request(url), ReceiptPersistenceError);
    const unlocked = message(child!);
    child!.send('release');
    await unlocked;
    const results = await Promise.all([request(url), request(url)]);
    for (const result of results)
      assert.equal(await result.text(), 'response retained through lock timeout');
    assert.equal(calls, 1);
  } finally {
    db.exec('PRAGMA busy_timeout=5000');
    if (child) await stop(child);
  }
});

test('SIGKILL after a received body fails to persist keeps pending guards and forbids resend', async () => {
  let calls = 0;
  const server = createServer((_req, res) => {
    calls++;
    res.end('paid but not durable');
  }).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const target = `http://127.0.0.1:${(server.address() as { port: number }).port}/paid`;
  const child = fork(
    new URL('./fixtures/response-failure-worker.ts', import.meta.url),
    ['failed-before-crash', target],
    {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      env: { ...process.env, OPENFIND_DATA_DIR: dir },
    },
  );
  try {
    assert.match((await message(child)).error!, /尚未写入数据库/);
    await stop(child);
    db.exec('DROP TRIGGER fail_received');
    await assert.rejects(journaledFetch('failed-before-crash')(target), UncertainRequestError);
    assert.equal(calls, 1);
  } finally {
    await stop(child);
    db.exec('DROP TRIGGER IF EXISTS fail_received');
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
