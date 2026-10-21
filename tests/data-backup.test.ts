import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createBackup, restoreBackup } from '../server/data-backup.ts';
const root = mkdtempSync(join(tmpdir(), 'openfind-backup-'));
const source = join(root, 'source');
process.env.OPENFIND_DATA_DIR = source;
const { db, put, configSet, encrypt } = await import('../server/store.ts');
after(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('backup captures WAL data, configuration, secrets and media; restore starts with original credentials', () => {
  mkdirSync(join(source, 'uploads'));
  writeFileSync(join(source, 'uploads', 'abcdef.png'), 'image bytes');
  put('drafts', { id: 'old-draft', images: ['/api/media/abcdef.png'], title: '旧数据' });
  configSet('token', encrypt('test-secret'));
  configSet('custom-setting', 'preserved');
  const backup = join(root, 'backup'),
    restored = join(root, 'restored');
  createBackup(source, backup);
  restoreBackup(backup, restored);
  const output = execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
    const s = await import('./server/store.ts');
    if(s.decrypt(s.configGet('token')) !== 'test-secret') throw Error('lost credential');
    if(s.configGet('custom-setting') !== 'preserved') throw Error('lost config');
    if(s.get('drafts','old-draft').title !== '旧数据') throw Error('lost row');
    s.db.close();
  `,
    ],
    { env: { ...process.env, OPENFIND_DATA_DIR: restored } },
  );
  assert.equal(output.length, 0);
  assert.equal(readFileSync(join(restored, 'uploads', 'abcdef.png'), 'utf8'), 'image bytes');
  assert.throws(() => restoreBackup(backup, restored), /已存在/);
  writeFileSync(join(backup, 'uploads', 'abcdef.png'), 'tampered');
  assert.throws(() => restoreBackup(backup, join(root, 'bad-restore')), /校验失败/);
  assert.equal(existsSync(join(root, 'bad-restore')), false);
});

test('missing referenced media fails backup without publishing a partial directory', () => {
  put('drafts', { id: 'missing', images: ['/api/media/deadbeef.png'] });
  assert.throws(() => createBackup(source, join(root, 'incomplete')));
  assert.equal(existsSync(join(root, 'incomplete')), false);
  db.prepare("DELETE FROM entities WHERE id='missing'").run();
});

test('existing database without key stops before generating a replacement', () => {
  const damaged = join(root, 'damaged');
  mkdirSync(damaged);
  const empty = new DatabaseSync(join(damaged, 'openfind.sqlite'));
  empty.close();
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', "await import('./server/store.ts')"],
    { env: { ...process.env, OPENFIND_DATA_DIR: damaged }, encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /凭证密钥缺失/);
  assert.equal(existsSync(join(damaged, '.credential-key')), false);
});

test('partial legacy service migration preserves each kind and does not resurrect deleted services', async () => {
  put('model-services', {
    id: 'existing-text',
    kind: 'text',
    name: 'text',
    baseUrl: 'https://example.com',
    model: 'text',
    key: '',
    synced: [],
    custom: [],
    createdAt: '',
  });
  configSet('image:baseUrl', 'https://example.com/v1');
  configSet('image:model', 'legacy-image');
  configSet('image:key', encrypt('image-secret'));
  const { migrateServices } = await import('../server/services.ts');
  const { get, decrypt, configGet, remove } = await import('../server/store.ts');
  migrateServices();
  const image = get<{ key: string; model: string }>('model-services', 'service-image-default')!;
  assert.equal(image.model, 'legacy-image');
  assert.equal(decrypt(image.key), 'image-secret');
  assert.equal(configGet('image:serviceId'), 'service-image-default');
  remove('model-services', 'service-image-default');
  migrateServices();
  assert.equal(get('model-services', 'service-image-default'), undefined);
});
