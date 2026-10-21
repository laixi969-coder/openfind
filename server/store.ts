import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
export const dataDir = resolve(process.env.OPENFIND_DATA_DIR || 'data');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const keyPath = join(dataDir, '.credential-key');
try {
  writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
}
chmodSync(keyPath, 0o600);
const key = readFileSync(keyPath);
export const db = new DatabaseSync(join(dataDir, 'openfind.sqlite'));
db.exec(
  'PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS entities(kind TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(kind,id)); CREATE TABLE IF NOT EXISTS config(key TEXT PRIMARY KEY,value TEXT NOT NULL);',
);
export const all = <T>(kind: string): T[] =>
  db
    .prepare('SELECT value FROM entities WHERE kind=? ORDER BY rowid DESC')
    .all(kind)
    .map((r) => JSON.parse(r.value as string));
export const get = <T>(kind: string, id: string): T | undefined => {
  const r = db.prepare('SELECT value FROM entities WHERE kind=? AND id=?').get(kind, id);
  return r ? JSON.parse(r.value as string) : undefined;
};
export const put = <T extends { id: string }>(kind: string, item: T) =>
  db
    .prepare(
      'INSERT INTO entities(kind,id,value) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value',
    )
    .run(kind, item.id, JSON.stringify(item));
export const remove = (kind: string, id: string) =>
  db.prepare('DELETE FROM entities WHERE kind=? AND id=?').run(kind, id);
export const configGet = (name: string, fallback = ''): string =>
  (db.prepare('SELECT value FROM config WHERE key=?').get(name)?.value as string) || fallback;
export const configSet = (name: string, value: string) =>
  db
    .prepare('INSERT INTO config VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(name, value);
export function encrypt(value: string) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  return Buffer.concat([iv, c.update(value), c.final(), c.getAuthTag()]).toString('base64');
}
export function decrypt(value: string) {
  if (!value) return '';
  const b = Buffer.from(value, 'base64');
  const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(-16));
  return Buffer.concat([d.update(b.subarray(12, -16)), d.final()]).toString();
}

// Keep related records and their progress marker in one durable commit.
export function transaction<T>(work: () => T): T {
  db.exec('SAVEPOINT openfind_write');
  try {
    const result = work();
    db.exec('RELEASE SAVEPOINT openfind_write');
    return result;
  } catch (error) {
    db.exec('ROLLBACK TO SAVEPOINT openfind_write; RELEASE SAVEPOINT openfind_write');
    throw error;
  }
}
