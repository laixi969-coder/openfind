import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  lstatSync,
  readdirSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { configGet, configSet, dataDir } from './store.ts';

const execute = promisify(execFile);
const backupName = /^backup-\d{13}-[a-f0-9-]{36}$/;
export function backupDirectory(value = configGet('backup:directory', dataDir + '-backups')) {
  const directory = resolve(value);
  const rel = relative(dataDir, directory);
  if (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
    throw new Error('自动备份目录必须位于数据目录之外');
  if (
    existsSync(directory) &&
    (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())
  )
    throw new Error('备份目录必须为普通目录');
  return directory;
}
export function backupStatus() {
  const lastSuccess = configGet('backup:lastSuccess');
  return {
    enabled: configGet('backup:enabled', 'true') !== 'false',
    directory: backupDirectory(),
    lastSuccess,
    lastError: configGet('backup:lastError'),
    running,
    stale: !lastSuccess || Date.now() - Date.parse(lastSuccess) > 26 * 3600000,
    localCopyOnly: true,
    retainedSnapshots: 7,
  };
}
export function saveBackupSettings(input: { enabled: boolean; directory: string }) {
  const directory = backupDirectory(input.directory);
  if (directory !== backupDirectory()) {
    configSet('backup:lastSuccess', '');
    configSet('backup:lastError', '');
  }
  configSet('backup:directory', directory);
  configSet('backup:enabled', String(input.enabled));
  return backupStatus();
}
let running = false;
export const backupRunning = () => running;
// A filesystem lease also arbitrates multiple API processes using the same destination.
export async function withBackupLease<T>(work: () => Promise<T>): Promise<T> {
  const directory = backupDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, '.openfind-lock');
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const reclaim = lock + '.reclaim';
    try {
      mkdirSync(reclaim, { mode: 0o700 });
    } catch {
      throw new Error('其他进程正在检查备份锁，请稍后重试');
    }
    let dead = false;
    try {
      try {
        const owner = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8'));
        if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error('invalid owner');
        try {
          process.kill(owner.pid, 0);
        } catch (e) {
          dead = (e as NodeJS.ErrnoException).code === 'ESRCH';
        }
      } catch {
        /* Unknown owner: fail closed rather than removing an active lock. */
      }
      if (!dead) throw new Error('备份或资料维护正在进行，请稍后重试；异常锁需核对进程后处理');
      rmSync(lock, { recursive: true });
      mkdirSync(lock, { mode: 0o700 });
    } finally {
      rmSync(reclaim, { recursive: true });
    }
  }
  const owner = randomUUID();
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, owner }), {
    mode: 0o600,
  });
  try {
    return await work();
  } finally {
    if (JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')).owner === owner)
      rmSync(lock, { recursive: true });
  }
}
export function managedBackups() {
  const directory = backupDirectory();
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter(
      (name) =>
        backupName.test(name) &&
        lstatSync(join(directory, name)).isDirectory() &&
        !lstatSync(join(directory, name)).isSymbolicLink(),
    )
    .sort()
    .map((name) => join(directory, name));
}
export async function runAutomaticBackup() {
  if (running) throw new Error('备份正在进行');
  running = true;
  try {
    return await withBackupLease(async () => {
      const directory = backupDirectory();
      const target = join(directory, `backup-${Date.now()}-${randomUUID()}`);
      // Keep VACUUM, copying and checksums off the API event loop.
      await execute(
        process.execPath,
        [
          '--import',
          'tsx',
          fileURLToPath(new URL('./data-backup.ts', import.meta.url)),
          'backup',
          dataDir,
          target,
        ],
        {
          cwd: dirname(fileURLToPath(new URL('../package.json', import.meta.url))),
          timeout: 3600000,
          maxBuffer: 65536,
        },
      );
      configSet('backup:lastSuccess', new Date().toISOString());
      configSet('backup:lastError', '');
      for (const obsolete of managedBackups().slice(0, -7)) rmSync(obsolete, { recursive: true });
      return backupStatus();
    });
  } catch (error) {
    configSet(
      'backup:lastError',
      error instanceof Error ? error.message.slice(0, 1000) : '备份失败',
    );
    throw error;
  } finally {
    running = false;
  }
}
export function startAutomaticBackups(busy: () => boolean) {
  if (process.env.NODE_ENV === 'test' || process.env.OPENFIND_DEMO === '1') return;
  const tick = async () => {
    if (busy() || running) return;
    const state = backupStatus();
    if (
      state.enabled &&
      (!state.lastSuccess || Date.now() - Date.parse(state.lastSuccess) >= 86400000)
    ) {
      try {
        await runAutomaticBackup();
      } catch {
        /* persisted and shown in settings */
      }
    }
  };
  const timer = setInterval(() => void tick().catch(() => {}), 60000);
  timer.unref();
  const initial = setTimeout(() => void tick().catch(() => {}), 30000);
  initial.unref();
}
