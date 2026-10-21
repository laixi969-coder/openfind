import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDir, get, put } from './store.ts';
import { downloadMedia } from './remote-media.ts';
import { imageMime } from './images.ts';

const directory = join(dataDir, 'uploads');
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const pending = new Map<string, Promise<string>>();
interface Backup {
  id: string;
  url: string;
  digest: string;
}

// Commit bytes before recording the reference. Temporary files are never served.
async function storeBytes(bytes: Buffer) {
  const mime = imageMime(bytes);
  const digest = hash(bytes);
  const name = `${digest}.${mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1]}`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, name);
  try {
    if (hash(await readFile(target)) === digest) return { url: '/api/media/' + name, digest };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temp = join(directory, `${randomUUID()}.tmp`);
  try {
    const file = await open(temp, 'wx', 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, target);
    const folder = await open(directory, 'r');
    try {
      await folder.sync();
    } finally {
      await folder.close();
    }
  } finally {
    await unlink(temp).catch(() => {});
  }
  return { url: '/api/media/' + name, digest };
}

export async function backupDraftImage(source: string, download = downloadMedia): Promise<string> {
  if (!/^https?:\/\//.test(source) && !source.startsWith('data:image/')) return source;
  const id = hash(source);
  const existing = pending.get(id);
  if (existing) return existing;
  const task = (async () => {
    const cached = get<Backup>('draft-media', id);
    if (cached) {
      try {
        const bytes = await readFile(join(directory, cached.url.split('/').at(-1)!));
        if (hash(bytes) === cached.digest) return cached.url;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const bytes = source.startsWith('data:image/')
      ? Buffer.from(source.slice(source.indexOf(',') + 1), 'base64')
      : await download(source, 10 * 1024 * 1024);
    if (bytes.length > 10 * 1024 * 1024) throw new Error('图片超过 10 MB 上限');
    const saved = await storeBytes(bytes);
    put('draft-media', { id, ...saved });
    return saved.url;
  })();
  pending.set(id, task);
  try {
    return await task;
  } finally {
    pending.delete(id);
  }
}

export async function backupDraftImages(images: string[], download = downloadMedia) {
  const saved: string[] = [];
  for (const [index, source] of images.entries()) {
    try {
      saved.push(await backupDraftImage(source, download));
    } catch (error) {
      throw new Error(`第 ${index + 1} 张图片备份失败，草稿未保存：${(error as Error).message}`);
    }
  }
  return saved;
}
