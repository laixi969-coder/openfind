import type { Platform } from './types.ts';
export const maxWorkLinks = 5;
export interface WorkLink {
  platform: Platform;
  url: string;
  nativeId?: string;
  short: boolean;
}
const xhsHosts = new Set(['www.xiaohongshu.com', 'xiaohongshu.com']);
const dyHosts = new Set(['www.douyin.com', 'douyin.com']);
export function parseWorkLink(raw: string): WorkLink {
  if (raw.length > 2048) throw new Error('单条作品链接过长，请重新复制官方分享链接');
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('作品链接格式无效，请粘贴完整 HTTP(S) 分享链接');
  }
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.port)
    throw new Error('只接受平台官方 HTTP(S) 作品链接，不能包含账号密码或自定义端口');
  const host = u.hostname.toLowerCase();
  u.protocol = 'https:';
  u.hash = '';
  if (host === 'xhslink.com' || host === 'v.douyin.com') {
    if (!/^\/[A-Za-z0-9_/-]+\/?$/.test(u.pathname) || u.pathname === '/' || u.pathname.length > 200)
      throw new Error('分享短链接格式无效');
    return {
      platform: host === 'xhslink.com' ? 'xiaohongshu' : 'douyin',
      url: u.href,
      short: true,
    };
  }
  if (xhsHosts.has(host)) {
    const id = u.pathname.match(
      /^\/(?:explore|discovery\/item|search_result)\/([a-f0-9]{24})\/?$/i,
    )?.[1];
    if (!id) throw new Error('请粘贴小红书具体笔记链接，主页和搜索页不支持链接获客');
    u.hostname = 'www.xiaohongshu.com';
    u.pathname = '/explore/' + id.toLowerCase();
    for (const name of [...u.searchParams.keys()])
      if (!['xsec_token', 'xsec_source'].includes(name)) u.searchParams.delete(name);
    return { platform: 'xiaohongshu', url: u.href, nativeId: id.toLowerCase(), short: false };
  }
  if (dyHosts.has(host) || host === 'www.iesdouyin.com' || host === 'iesdouyin.com') {
    const id =
      u.pathname.match(/^\/(?:video|note|share\/video|share\/note)\/(\d{10,30})\/?$/)?.[1] ||
      (dyHosts.has(host) && ['/', '/jingxuan', '/jingxuan/'].includes(u.pathname)
        ? u.searchParams.get('modal_id')
        : '');
    if (!id || !/^\d{10,30}$/.test(id))
      throw new Error('请粘贴抖音具体作品链接，主页、直播间和搜索页不支持链接获客');
    const kind = u.pathname.includes('/note/') ? 'note' : 'video';
    return {
      platform: 'douyin',
      url: `https://www.douyin.com/${kind}/${id}`,
      nativeId: id,
      short: false,
    };
  }
  throw new Error('仅支持小红书、抖音官方作品或分享短链接');
}
export function parseWorkLinks(text: string): WorkLink[] {
  if (text.length > 12000) throw new Error('分享文案过长，请分批粘贴');
  const urls = text.match(/https?:\/\/[^\s<>"'，。；！？、（）【】《》]+/gi) || [];
  if (!urls.length) throw new Error('没有找到作品链接，请粘贴完整链接或 App 分享文案');
  const found: WorkLink[] = [];
  const keys = new Set<string>();
  for (const raw of urls) {
    const link = parseWorkLink(raw.replace(/[.,;!?)\]}]+$/g, ''));
    const key = link.platform + ':' + (link.nativeId || link.url);
    if (!keys.has(key)) {
      keys.add(key);
      found.push(link);
    }
  }
  if (found.length > maxWorkLinks)
    throw new Error(`一次最多 ${maxWorkLinks} 条作品链接，请分批执行`);
  if (new Set(found.map((l) => l.platform)).size !== 1)
    throw new Error('请将小红书与抖音链接分开执行，每批只选择一个平台');
  return found;
}
export function allowedWorkNavigation(platform: Platform, url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      !u.port &&
      (platform === 'xiaohongshu'
        ? [...xhsHosts, 'xhslink.com']
        : [...dyHosts, 'v.douyin.com', 'www.iesdouyin.com', 'iesdouyin.com']
      ).includes(u.hostname)
    );
  } catch {
    return false;
  }
}
