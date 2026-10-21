import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
const dir = mkdtempSync(join(tmpdir(), 'openfind-backups-'));
process.env.OPENFIND_DATA_DIR = dir;
process.env.NODE_ENV = 'test';
const { backupDraftImage, backupDraftImages } = await import('../server/draft-media.ts');
const { db } = await import('../server/store.ts');
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=',
  'base64',
);
const offline = async (): Promise<Buffer> => {
  throw new Error('expired');
};
after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('concurrent and repeated saves reuse durable bytes, including after a fresh process starts', async () => {
  let calls = 0;
  const source = 'https://example.com/signed.png?token=one';
  const download = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 10));
    return png;
  };
  const [a, b] = await Promise.all([
    backupDraftImage(source, download),
    backupDraftImage(source, download),
  ]);
  assert.equal(a, b);
  assert.equal(calls, 1);
  assert.equal(await backupDraftImage(source, offline), a);
  assert.equal(await backupDraftImage('data:image/png;base64,' + png.toString('base64')), a);
  assert.deepEqual(readFileSync(join(dir, 'uploads', a.split('/').at(-1)!)), png);
  assert.equal(readdirSync(join(dir, 'uploads')).length, 1);
  const result = execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
    const { backupDraftImage } = await import('./server/draft-media.ts');
    console.log(await backupDraftImage(${JSON.stringify(source)}, async () => { throw new Error('expired'); }));
  `,
    ],
    { cwd: process.cwd(), env: { ...process.env, OPENFIND_DATA_DIR: dir }, encoding: 'utf8' },
  );
  assert.equal(result.trim(), a);
});

test('partial failure retains completed backups and permits retry without redownloading them', async () => {
  let calls = 0;
  const sources = ['https://example.com/first', 'https://example.com/second'];
  await assert.rejects(
    backupDraftImages(sources, async (url) => {
      calls++;
      if (url === sources[1]) throw new Error('HTTP 503');
      return png;
    }),
    /第 2 张图片备份失败/,
  );
  assert.equal(calls, 2);
  const result = await backupDraftImages(sources, async (url) => {
    assert.equal(url, sources[1]);
    return png;
  });
  assert.equal(result[0], result[1]);
});

test('missing or corrupted cache files are repaired; invalid bytes never become backups', async () => {
  const source = 'https://example.com/repair';
  const local = await backupDraftImage(source, async () => png);
  const path = join(dir, 'uploads', local.split('/').at(-1)!);
  unlinkSync(path);
  await assert.rejects(backupDraftImage(source, offline), /expired/);
  assert.equal(await backupDraftImage(source, async () => png), local);
  writeFileSync(path, 'broken');
  assert.equal(await backupDraftImage(source, async () => png), local);
  assert.deepEqual(readFileSync(path), png);
  await assert.rejects(
    backupDraftImage('https://example.com/html', async () => Buffer.from('<html>error</html>')),
    /不是/,
  );
  assert.ok(readdirSync(join(dir, 'uploads')).every((name) => !name.endsWith('.tmp')));
});

test('draft API commits local references and does not overwrite a draft changed during backup', async () => {
  const { app } = await import('../server/index.ts');
  const { get, put } = await import('../server/store.ts');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (body: unknown) =>
    fetch(base + '/api/drafts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  try {
    const source = 'https://example.com/already-expired';
    const local = await backupDraftImage(source, async () => png);
    const input = {
      noteId: '',
      title: '本地备份',
      body: '',
      tags: [],
      images: [source],
      origin: 'original',
      visibility: 'private',
      accountId: 'test',
    };
    const response = await post(input);
    assert.equal(response.status, 201);
    const draft = await response.json();
    assert.deepEqual(draft.images, [local]);
    assert.equal((await fetch(base + local)).status, 200);
    assert.equal((await fetch(base + `/api/drafts/${draft.id}/bundle`)).status, 200);
    const failed = await post({
      ...input,
      id: draft.id,
      revision: draft.revision,
      images: ['data:image/png;base64,YmFk'],
    });
    assert.equal(failed.ok, false);
    assert.deepEqual(get('drafts', draft.id), draft);

    // Keep the remote backup pending while a newer editor commits its change.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const delayedSource = 'https://example.com/delayed';
    const pending = backupDraftImage(delayedSource, async () => {
      await gate;
      return png;
    });
    const saving = post({
      ...input,
      id: draft.id,
      revision: draft.revision,
      images: [delayedSource],
    });
    await new Promise((r) => setTimeout(r, 50));
    put('drafts', { ...draft, revision: draft.revision + 1, title: '较新的修改' });
    release();
    await pending;
    const conflict = await saving;
    assert.equal(conflict.status, 409);
    assert.match((await conflict.json()).error, /素材备份期间/);
    assert.equal(get<{ title: string }>('drafts', draft.id)?.title, '较新的修改');
  } finally {
    await new Promise<void>((r, reject) => server.close((error) => (error ? reject(error) : r())));
  }
});
