import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createBackup, restoreBackup } from '../server/data-backup.ts';
import {
  migrateRequestGuards,
  guardMigrationKey,
  validateCollectionState,
} from '../server/collection-integrity.ts';
const root = mkdtempSync(join(tmpdir(), 'openfind-restore-safety-'));
const source = join(root, 'source');
process.env.OPENFIND_DATA_DIR = source;
const { db, put } = await import('../server/store.ts');
const { journaledFetch, captureRequestReceipts, compactConsumedReceipt } =
  await import('../server/request-journal.ts');
const { commitJobPage } = await import('../server/job-progress.ts');
after(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});
const query = {
  keyword: 'restore',
  mode: 'live' as const,
  platform: 'douyin' as const,
  limit: 10,
  sort: 'latest' as const,
  noteType: 'all' as const,
  interval: 250,
};
const job = (id: string) => ({
  id,
  type: 'search' as const,
  status: 'running' as const,
  keyword: 'restore',
  query,
  platform: 'douyin' as const,
  source: 'live' as const,
  pages: 0,
  count: 0,
  resultIds: [],
  logs: [],
  elapsed: 0,
  createdAt: '',
});
function run(directory: string, code: string) {
  return execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    env: { ...process.env, OPENFIND_DATA_DIR: directory },
    encoding: 'utf8',
  });
}
test('restored snapshot permits receipt replay but fences unseen old requests and inherited workflow children', async () => {
  put('jobs', job('old-job'));
  put('workflows', { id: 'old-workflow' });
  await journaledFetch(
    'old-job',
    (async () => new Response('saved response')) as typeof fetch,
  )('https://vendor.example/saved');
  const snapshot = join(root, 'snapshot');
  createBackup(source, snapshot);
  // A charge after the backup is invisible in the restored copy.
  await journaledFetch(
    'old-job',
    (async () => new Response('later charge')) as typeof fetch,
  )('https://vendor.example/later');
  const restored = join(root, 'restored');
  restoreBackup(snapshot, restored);
  run(
    restored,
    `
    import assert from 'node:assert/strict';
    const { journaledFetch, inheritRestoredScope, RestoredScopeError } = await import('./server/request-journal.ts');
    let calls = 0;
    const transport = async () => { calls++; return new Response('new'); };
    assert.equal(await (await journaledFetch('old-job', transport)('https://vendor.example/saved')).text(), 'saved response');
    await assert.rejects(journaledFetch('old-job', transport)('https://vendor.example/later'), RestoredScopeError);
    inheritRestoredScope('workflow:old-workflow', 'new-child');
    await assert.rejects(journaledFetch('new-child', transport)('https://vendor.example/new'), RestoredScopeError);
    const { xhsClient, saveXhsSettings } = await import('./server/xhs-data.ts');
    saveXhsSettings({ provider: 'redfox', apiKey: 'test-key', maxRequests: 5 });
    await assert.rejects(xhsClient(undefined, transport, 'old-job').comments({ id: 'xhs:restored', nativeId: 'restored' }, 10, null), RestoredScopeError);
    assert.equal((await import('./server/store.ts')).all('xhs-api-tasks').length, 0);
    assert.equal(calls, 0);
    await journaledFetch('explicit-new-task', transport)('https://vendor.example/new');
    assert.equal(calls, 1);
    (await import('./server/store.ts')).db.close();
  `,
  );
});
test('compacted receipts retain their guard and checkpoint across backup and restore', async () => {
  const j = job('compacted');
  put('jobs', j);
  const captured = await captureRequestReceipts(() =>
    journaledFetch(
      j.id,
      (async () => new Response('[]')) as typeof fetch,
    )('https://vendor.example/page'),
  );
  commitJobPage(j, query, [], { nextCursor: null, visitedCursors: [] }, captured.receipts);
  assert.equal(compactConsumedReceipt(captured.receipts[0]), true);
  validateCollectionState(db);
  const snapshot = join(root, 'compacted-snapshot'),
    restored = join(root, 'compacted-restored');
  createBackup(source, snapshot);
  restoreBackup(snapshot, restored);
  run(
    restored,
    `
    import assert from 'node:assert/strict';
    const { get, db } = await import('./server/store.ts');
    const { validateJobCheckpoint } = await import('./server/job-progress.ts');
    const { journaledFetch, UncertainRequestError } = await import('./server/request-journal.ts');
    validateJobCheckpoint(get('jobs', 'compacted'));
    await assert.rejects(journaledFetch('compacted', async () => { throw Error('must not dispatch'); })('https://vendor.example/page'), UncertainRequestError);
    db.close();
  `,
  );
  // Even a correctly hashed, structurally valid SQLite file must fail semantic validation.
  const damaged = new DatabaseSync(join(snapshot, 'openfind.sqlite'));
  damaged
    .prepare("DELETE FROM entities WHERE kind='request-guards' AND id=?")
    .run(captured.receipts[0].id);
  damaged.close();
  const manifestPath = join(snapshot, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.files['openfind.sqlite'] = createHash('sha256')
    .update(readFileSync(join(snapshot, 'openfind.sqlite')))
    .digest('hex');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => restoreBackup(snapshot, join(root, 'rejected')), /不一致/);
});
test('legacy guard migration is atomic and never recreates deleted modern guards', () => {
  const legacy = new DatabaseSync(':memory:');
  legacy.exec(
    'CREATE TABLE entities(kind TEXT,id TEXT,value TEXT,PRIMARY KEY(kind,id)); CREATE TABLE config(key TEXT PRIMARY KEY,value TEXT);',
  );
  const insert = legacy.prepare('INSERT INTO entities VALUES(?,?,?)');
  for (const id of ['a', 'b'])
    insert.run('request-receipts', id, JSON.stringify({ id, attempt: id, state: 'pending' }));
  legacy.exec(
    "CREATE TRIGGER fail_migration BEFORE INSERT ON entities WHEN NEW.kind='request-guards' AND NEW.id='b' BEGIN SELECT RAISE(ABORT, 'disk failure'); END;",
  );
  assert.throws(() => migrateRequestGuards(legacy), /disk failure/);
  assert.equal(
    legacy.prepare("SELECT count(*) AS n FROM entities WHERE kind='request-guards'").get()!.n,
    0,
  );
  assert.equal(
    legacy.prepare('SELECT value FROM config WHERE key=?').get(guardMigrationKey),
    undefined,
  );
  legacy.exec('DROP TRIGGER fail_migration');
  migrateRequestGuards(legacy);
  assert.equal(
    legacy.prepare("SELECT count(*) AS n FROM entities WHERE kind='request-guards'").get()!.n,
    2,
  );
  legacy.exec("DELETE FROM entities WHERE kind='request-guards' AND id='a'");
  migrateRequestGuards(legacy);
  assert.equal(
    legacy.prepare("SELECT count(*) AS n FROM entities WHERE kind='request-guards'").get()!.n,
    1,
  );
  assert.throws(() => validateCollectionState(legacy), /不一致/);
  legacy.close();
});
