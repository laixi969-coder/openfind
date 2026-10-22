import { validateCollectionState, fenceRestoredScopes } from './collection-integrity.ts';
import { DatabaseSync } from 'node:sqlite';
import { createHash, createDecipheriv } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  lstatSync,
  copyFileSync,
  chmodSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const allowed = (name: string) =>
  ['openfind.sqlite', '.credential-key'].includes(name) ||
  /^uploads\/[a-f0-9-]+\.(png|jpe?g|webp|mp4|mov|webm)$/.test(name);
function regular(path: string) {
  if (!lstatSync(path).isFile()) throw new Error(`不是普通文件：${path}`);
}
function validate(dir: string) {
  const key = readFileSync(join(dir, '.credential-key'));
  if (key.length !== 32) throw new Error('备份缺少有效凭证密钥');
  const db = new DatabaseSync(join(dir, 'openfind.sqlite'), { readOnly: true });
  try {
    if (Object.values(db.prepare('PRAGMA integrity_check').get()!)[0] !== 'ok')
      throw new Error('数据库完整性检查失败');
    if (Number(db.prepare('PRAGMA user_version').get()!.user_version) > 0)
      throw new Error('不支持此数据库版本，请使用匹配的应用版本');
    validateCollectionState(db);
    const checkSecret = (value: unknown) => {
      if (!value) return;
      const bytes = Buffer.from(String(value), 'base64');
      const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(-16));
      cipher.update(bytes.subarray(12, -16));
      cipher.final();
    };
    for (const row of db.prepare('SELECT key, value FROM config').all()) {
      if (
        /^(token$|browserServiceToken$|cookie:|xhs\.key\.|douyin\.key\.|llm:key$|image:key$)/.test(
          String(row.key),
        )
      )
        checkSecret(row.value);
    }
    for (const row of db.prepare("SELECT value FROM entities WHERE kind='model-services'").all())
      checkSecret(JSON.parse(String(row.value)).key);
    for (const row of db.prepare('SELECT value FROM entities').all()) {
      const visit = (value: unknown): void => {
        if (typeof value === 'string' && value.startsWith('/api/media/')) {
          const name = 'uploads/' + value.slice('/api/media/'.length);
          if (!allowed(name)) throw new Error('数据库含无效素材路径');
          regular(join(dir, name));
        } else if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === 'object') Object.values(value).forEach(visit);
      };
      visit(JSON.parse(String(row.value)));
    }
  } finally {
    db.close();
  }
}
function stageFor(destination: string) {
  if (existsSync(destination))
    throw new Error('目标目录已存在，请使用新目录，避免覆盖运行中的数据');
  mkdirSync(dirname(destination), { recursive: true });
  return mkdtempSync(join(dirname(destination), '.openfind-backup-'));
}
export function createBackup(source: string, destination: string) {
  source = resolve(source);
  destination = resolve(destination);
  const rel = relative(source, destination);
  if (!rel.startsWith('..') && !rel.startsWith('/'))
    throw new Error('备份目录不能放在源数据目录内');
  regular(join(source, 'openfind.sqlite'));
  regular(join(source, '.credential-key'));
  const stage = stageFor(destination);
  try {
    const db = new DatabaseSync(join(source, 'openfind.sqlite'), { readOnly: true });
    try {
      db.exec(`VACUUM INTO '${join(stage, 'openfind.sqlite').replaceAll("'", "''")}'`);
    } finally {
      db.close();
    }
    copyFileSync(join(source, '.credential-key'), join(stage, '.credential-key'));
    mkdirSync(join(stage, 'uploads'), { mode: 0o700 });
    const uploads = join(source, 'uploads');
    if (existsSync(uploads)) {
      if (!lstatSync(uploads).isDirectory() || lstatSync(uploads).isSymbolicLink())
        throw new Error('素材目录不能是符号链接');
      for (const name of readdirSync(uploads)) {
        if (name.endsWith('.tmp')) continue;
        if (!allowed('uploads/' + name)) throw new Error(`不支持的素材文件：${name}`);
        regular(join(uploads, name));
        copyFileSync(join(uploads, name), join(stage, 'uploads', name));
      }
    }
    validate(stage);
    const files = [
      'openfind.sqlite',
      '.credential-key',
      ...readdirSync(join(stage, 'uploads')).map((n) => 'uploads/' + n),
    ];
    const hashes: Record<string, string> = {};
    for (const name of files) {
      chmodSync(join(stage, name), 0o600);
      hashes[name] = digest(readFileSync(join(stage, name)));
    }
    writeFileSync(
      join(stage, 'manifest.json'),
      JSON.stringify({ format: 1, createdAt: new Date().toISOString(), files: hashes }, null, 2),
      { mode: 0o600 },
    );
    renameSync(stage, destination);
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}
export function restoreBackup(source: string, destination: string) {
  source = resolve(source);
  destination = resolve(destination);
  regular(join(source, 'manifest.json'));
  const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'));
  if (
    manifest.format !== 1 ||
    !manifest.files ||
    !manifest.files['openfind.sqlite'] ||
    !manifest.files['.credential-key']
  )
    throw new Error('备份格式不支持或缺少数据库/密钥');
  const stage = stageFor(destination);
  try {
    mkdirSync(join(stage, 'uploads'), { mode: 0o700 });
    for (const [name, expected] of Object.entries(manifest.files)) {
      if (!allowed(name) || typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected))
        throw new Error('备份清单无效');
      regular(join(source, name));
      const bytes = readFileSync(join(source, name));
      if (digest(bytes) !== expected) throw new Error(`备份校验失败：${name}`);
      writeFileSync(join(stage, name), bytes, { mode: 0o600 });
    }
    validate(stage);
    const restored = new DatabaseSync(join(stage, 'openfind.sqlite'));
    try {
      fenceRestoredScopes(restored);
    } finally {
      restored.close();
    }
    renameSync(stage, destination);
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [action, source, destination] = process.argv.slice(2);
  try {
    if (!source || !destination || !['backup', 'restore'].includes(action))
      throw new Error('用法：tsx server/data-backup.ts backup|restore 源目录 新目标目录');
    (action === 'backup' ? createBackup : restoreBackup)(source, destination);
    console.log('完成：' + resolve(destination));
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
