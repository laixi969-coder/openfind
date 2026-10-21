import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { mediaUrl, downloadMedia, readLimitedBody } from '../server/remote-media.ts';

const dir = mkdtempSync(join(tmpdir(), 'openfind-audit-'));
process.env.OPENFIND_DATA_DIR = dir;
const { db } = await import('../server/store.ts');
const { createService, activeCredentials, deleteService, listServices, updateServiceResult } =
  await import('../server/services.ts');
const { reuseLlmService, generateVariants } = await import('../server/images.ts');
after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('untrusted media rejects local, private, alternate IP encodings and credentials', async () => {
  for (const value of [
    'http://localhost/a',
    'http://127.1/a',
    'http://2130706433/a',
    'http://0x7f000001/a',
    'http://10.0.0.1/a',
    'http://169.254.169.254/a',
    'http://[::1]/a',
    'http://[::ffff:127.0.0.1]/a',
    'http://100.64.0.1/a',
    'http://192.168.1.1/a',
    'http://172.16.0.1/a',
    'file:///etc/passwd',
    'https://user:secret@example.com/a',
  ]) {
    assert.throws(() => mediaUrl(value), value);
    await assert.rejects(downloadMedia(value, 100));
  }
  assert.equal(mediaUrl('https://cdn.example.com/image.png').hostname, 'cdn.example.com');
});

test('stream limits cancel oversized responses without consuming the rest', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(8));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(readLimitedBody({ headers: new Headers(), body }, 10), /大小限制/);
  assert.ok(cancelled);
  let pulled = false;
  const declared = new ReadableStream<Uint8Array>(
    {
      pull() {
        pulled = true;
      },
    },
    { highWaterMark: 0 },
  );
  await assert.rejects(
    readLimitedBody({ headers: new Headers({ 'content-length': '100' }), body: declared }, 10),
  );
  assert.equal(pulled, false);
  assert.equal((await readLimitedBody(new Response('exact'), 5)).toString(), 'exact');
});

test('reusing a keyless text service clears the old image secret and model cache', () => {
  createService({
    kind: 'image',
    name: 'old',
    baseUrl: 'https://old.example/v1',
    apiKey: 'old-secret',
    model: 'image',
  });
  createService({ kind: 'text', name: 'new', baseUrl: 'https://new.example/v1', model: 'text' });
  reuseLlmService();
  assert.equal(activeCredentials('image').baseUrl, 'https://new.example/v1');
  assert.equal(activeCredentials('image').key, '');
  assert.deepEqual(activeCredentials('image').modelsSyncedAt, '');
});

test('async results belong to their originating service and cannot recreate deleted services', () => {
  const a = createService({
    kind: 'image',
    name: 'A',
    baseUrl: 'https://a.example/v1',
    model: 'image',
  });
  const snapshot = activeCredentials('image');
  const b = createService({
    kind: 'image',
    name: 'B',
    baseUrl: 'https://b.example/v1',
    model: 'image',
  });
  updateServiceResult(snapshot, { testedAt: 'test-A' });
  assert.equal(listServices('image').find((s) => s.id === a.id)?.testedAt, 'test-A');
  assert.equal(listServices('image').find((s) => s.id === b.id)?.testedAt, undefined);
  deleteService(a.id);
  updateServiceResult(snapshot, { testedAt: 'late-A' });
  assert.ok(!listServices('image').some((s) => s.id === a.id));
});

test('switching image services mid-batch cannot send the new key to the old endpoint', async () => {
  const seen: (string | undefined)[] = [];
  let started!: () => void;
  const first = new Promise<void>((r) => {
    started = r;
  });
  let release!: () => void;
  const resume = new Promise<void>((r) => {
    release = r;
  });
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=';
  const server = createServer(async (req, res) => {
    seen.push(req.headers.authorization);
    for await (const _chunk of req) {
      /* drain multipart */
    }
    if (seen.length === 1) {
      started();
      await resume;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ b64_json: png }] }));
  }).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const a = createService({
    kind: 'image',
    name: 'A',
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    apiKey: 'key-A',
    model: 'image',
  });
  const pending = generateVariants({
    images: [`data:image/png;base64,${png}`, `data:image/png;base64,${png}`],
    prompt: 'test',
    count: 1,
    mode: 'edit',
  });
  try {
    await first;
    const b = createService({
      kind: 'image',
      name: 'B',
      baseUrl: 'https://b.example/v1',
      apiKey: 'key-B',
      model: 'image',
    });
    release();
    assert.equal((await pending).items.length, 2);
    assert.deepEqual(seen, ['Bearer key-A', 'Bearer key-A']);
    assert.equal(listServices('image').find((s) => s.id === b.id)?.testedAt, undefined);
    assert.ok(listServices('image').find((s) => s.id === a.id)?.testedAt);
  } finally {
    release();
    await pending.catch(() => {});
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('redirects revalidate destinations before issuing a second request', async () => {
  const { Response } = await import('undici');
  const visited: string[] = [];
  const request: typeof import('undici').fetch = async (url) => {
    visited.push(String(url));
    return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } });
  };
  await assert.rejects(downloadMedia('https://cdn.example.com/image', 100, request), /公网/);
  assert.deepEqual(visited, ['https://cdn.example.com/image']);
  const valid: typeof import('undici').fetch = async (url) =>
    String(url).endsWith('/image')
      ? new Response(null, { status: 302, headers: { location: '/final' } })
      : new Response('image');
  assert.equal(
    (await downloadMedia('https://cdn.example.com/image', 100, valid)).toString(),
    'image',
  );
});

test('image provider errors do not echo API keys or upstream prompts', async () => {
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* drain request */
    }
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'credential-secret private-prompt' } }));
  }).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  createService({
    kind: 'image',
    name: 'errors',
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    apiKey: 'credential-secret',
    model: 'image',
  });
  try {
    await assert.rejects(
      generateVariants({
        images: ['unused'],
        prompt: 'private-prompt',
        count: 1,
        mode: 'generate',
      }),
      (error) => {
        assert.match(String(error), /500/);
        assert.doesNotMatch(String(error), /credential-secret|private-prompt/);
        return true;
      },
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
