import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
export const dataDir = resolve(process.env.OPENFIND_DATA_DIR || 'data');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const keyPath = join(dataDir, '.credential-key');
if (existsSync(join(dataDir, 'openfind.sqlite')) && !existsSync(keyPath))
  throw new Error('数据库已存在但凭证密钥缺失，请从同一备份恢复 .credential-key；未生成替代密钥');
try {
  writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
}
chmodSync(keyPath, 0o600);
const key = readFileSync(keyPath);
if (key.length !== 32) throw new Error('凭证密钥损坏，必须恢复原始 32 字节密钥');
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

// Acquire the write lock before reading: a deferred WAL snapshot can fail to
// upgrade after a different process writes, losing a just-received response.
const commitCallbacks: (() => void)[][] = [];
const transactionContext = new AsyncLocalStorage<boolean>();
export class UncommittedRequestError extends Error {
  constructor() {
    super('数据库事务尚未提交，已阻止发送请求，避免回滚防重发记录后重复计费');
  }
}
export function assertOutsideTransaction() {
  // isTransaction is available on Node 24+; the stack also supports Node 22.
  if (transactionContext.getStore() || commitCallbacks.length || db.isTransaction)
    throw new UncommittedRequestError();
}
export function afterCommit(callback: () => void) {
  const pending = commitCallbacks.at(-1);
  if (pending) pending.push(callback);
  else callback();
}
export function transaction<T>(work: () => T): T {
  const outer = commitCallbacks.length === 0;
  const savepoint = 'openfind_write_' + commitCallbacks.length;
  db.exec(outer ? 'BEGIN IMMEDIATE' : 'SAVEPOINT ' + savepoint);
  const callbacks: (() => void)[] = [];
  commitCallbacks.push(callbacks);
  let result: T;
  try {
    result = transactionContext.run(true, work);
    if (result && typeof (result as any).then === 'function') {
      // Prevent an unhandled rejection from an accidentally async callback.
      void Promise.resolve(result).catch(() => {});
      throw new Error('数据库事务回调必须同步完成');
    }
    db.exec(outer ? 'COMMIT' : 'RELEASE SAVEPOINT ' + savepoint);
  } catch (error) {
    db.exec(
      outer
        ? 'ROLLBACK'
        : 'ROLLBACK TO SAVEPOINT ' + savepoint + '; RELEASE SAVEPOINT ' + savepoint,
    );
    throw error;
  } finally {
    commitCallbacks.pop();
  }
  const parent = commitCallbacks.at(-1);
  if (parent) parent.push(...callbacks);
  else for (const callback of callbacks) callback();
  return result;
}
