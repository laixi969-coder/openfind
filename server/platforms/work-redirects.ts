import { allowedWorkNavigation, parseWorkLink, type WorkLink } from '../../shared/work-links.ts';
export async function resolveWorkRedirects(
  link: WorkLink,
  get: (url: string) => Promise<{ status: number; location?: string }>,
  signal?: AbortSignal,
): Promise<WorkLink> {
  if (!link.short) return link;
  let url = link.url;
  const seen = new Set<string>();
  for (let i = 0; i < 5; i++) {
    signal?.throwIfAborted();
    if (!allowedWorkNavigation(link.platform, url))
      throw Error('分享链接跳转到了非平台官方地址，已停止读取');
    if (seen.has(url)) throw Error('分享短链接循环跳转，请复制完整作品链接');
    seen.add(url);
    const response = await get(url);
    signal?.throwIfAborted();
    if ([403, 429].includes(response.status))
      throw Error(`平台限制短链接读取（${response.status}），请使用完整作品链接或检查官方窗口`);
    if (response.status >= 300 && response.status < 400 && response.location) {
      const next = new URL(response.location, url).href;
      if (!allowedWorkNavigation(link.platform, next))
        throw Error('分享链接跳转到了非平台官方地址，已停止读取');
      try {
        const target = parseWorkLink(next);
        if (!target.short && target.platform === link.platform) return target;
      } catch {}
      url = next;
    } else throw Error('分享短链接未返回有效作品地址，可能已过期；请复制带完整签名的作品链接');
  }
  throw Error('分享短链接跳转过多，请复制完整作品链接');
}
