import { journaledFetch } from './request-journal.ts';
import { z } from 'zod';
import { configGet, decrypt } from './store.ts';
const noteSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  body: z.string(),
  author: z.string(),
  authorId: z.string(),
  platform: z.enum(['xiaohongshu', 'douyin']),
  type: z.enum(['image', 'video']),
  images: z.array(z.string()),
  cover: z.string(),
  likes: z.number().nonnegative(),
  comments: z.number().nonnegative(),
  saves: z.number().nonnegative(),
  publishedAt: z.string(),
  tags: z.array(z.string()),
  url: z.string(),
});
const commentSchema = z.object({
  id: z.string(),
  noteId: z.string(),
  parentId: z.string().nullable(),
  author: z.string(),
  authorId: z.string(),
  body: z.string(),
  region: z.string(),
  createdAt: z.string(),
  likes: z.number(),
});
export const schemas = {
  search: z.object({ items: z.array(noteSchema), nextCursor: z.string().nullable() }),
  comments: z.object({ items: z.array(commentSchema), nextCursor: z.string().nullable() }),
  health: z.object({
    ok: z.literal(true),
    accountId: z.string().optional(),
    accountName: z.string().optional(),
  }),
  publish: z.object({
    id: z.string().min(1),
    url: z.url().refine((value) => /^https?:\/\//.test(value), '发布回执必须是 HTTP(S) URL'),
  }),
};
const sessionCookies = new Map<string, string>();
export const setSessionCookie = (value: string, id = configGet('accountId', 'demo-account')) => {
  if (value) sessionCookies.set(id, value);
  else sessionCookies.delete(id);
};
export const hasCookie = (id = configGet('accountId', 'demo-account')) =>
  !!(sessionCookies.get(id) || configGet('cookie:' + id));
export const getCookie = (id = configGet('accountId', 'demo-account')) =>
  sessionCookies.get(id) || decrypt(configGet('cookie:' + id));
export async function providerCall<T>(
  path: string,
  body: unknown,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
  requestScope?: string,
  beforeDispatch?: () => void,
): Promise<T> {
  const base = configGet('providerUrl');
  if (!base) throw new Error('请先在连接设置中配置真实数据服务地址');
  const token = decrypt(configGet('token'));
  const accountId =
    (body as { accountId?: string })?.accountId || configGet('accountId', 'demo-account');
  const cookie = getCookie(accountId);
  const response = await journaledFetch(
    requestScope,
    fetch,
    beforeDispatch,
  )(`${base.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ ...(body as object), ...(cookie ? { cookie } : {}) }),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`数据服务返回 HTTP ${response.status}，请检查连接与账号状态`);
  return schema.parse(await response.json());
}
