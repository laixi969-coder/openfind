import type { Comment, Note, Platform } from '../../shared/types.ts';
// These normalizers are independent of any third-party crawler implementation.
type R = Record<string, any>;
export function parsePlatformJSON(text: string): any {
  // Platform IDs can be JSON integers larger than Number.MAX_SAFE_INTEGER.
  // Node's JSON source context preserves their original decimal representation.
  return JSON.parse(text, (_key, value, context?: { source?: string }) =>
    typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)
      ? context?.source || String(value)
      : value,
  );
}
// Douyin's search stream contains UTF-8 byte-length-prefixed JSON frames.
// ack=-1 invalidates the speculative cached first screen; only subsequent
// frames belong to the current search. A truncated stream must never succeed.
export function parseDouyinSearch(text: string): any {
  if (text.trimStart().startsWith('{')) return parsePlatformJSON(text);
  const bytes = Buffer.from(text);
  const frames: R[] = [];
  let offset = 0;
  let ended = false;
  while (offset < bytes.length) {
    const end = bytes.indexOf(10, offset);
    if (end < 0) throw new Error('搜索流缺少长度行');
    const sizeText = bytes.subarray(offset, end).toString().trim();
    if (!/^[\da-f]+$/i.test(sizeText)) throw new Error('搜索流长度无效');
    const size = parseInt(sizeText, 16);
    offset = end + 1;
    if (!size) {
      ended = true;
      break;
    }
    if (offset + size > bytes.length) throw new Error('搜索流被截断');
    const frame = parsePlatformJSON(bytes.subarray(offset, offset + size).toString());
    offset += size;
    if (bytes[offset] === 13) offset++;
    if (bytes[offset] !== 10) throw new Error('搜索流分隔符无效');
    offset++;
    if (frame.ack === -1) frames.length = 0;
    if (frame.status_code !== undefined || Array.isArray(frame.data)) frames.push(frame);
  }
  if (!ended || !frames.length) throw new Error('搜索流未完整结束');
  const failure = frames.find((f) => f.status_code && f.status_code !== 0);
  return failure || { ...frames.at(-1), data: frames.flatMap((f) => f.data || []) };
}

export function matchesDouyinSort(url: string, sort: 'general' | 'latest' | 'popular') {
  const params = new URL(url).searchParams;
  let filter: R = {};
  try {
    filter = JSON.parse(params.get('filter_selected') || '{}');
  } catch {
    return false;
  }
  const actual = String(filter.sort_type ?? params.get('sort_type') ?? '0');
  return actual === { general: '0', latest: '2', popular: '1' }[sort];
}
const obj = (x: unknown): R => (x && typeof x === 'object' ? (x as R) : {});
export function count(x: unknown): number {
  const s = String(x ?? '0').replaceAll(',', '');
  const n = parseFloat(s);
  return Number.isFinite(n)
    ? Math.round(n * (s.includes('万') ? 10000 : s.includes('亿') ? 100000000 : 1))
    : 0;
}
function date(x: unknown) {
  const n = Number(x);
  return n > 0 ? new Date(n < 1e12 ? n * 1000 : n).toISOString() : '';
}
function image(x: unknown): string {
  const v = obj(x);
  const list = v.url_list || v.urlList || [];
  return String(
    v.url_default ||
      v.urlDefault ||
      v.url ||
      list[0] ||
      v.info_list?.[0]?.url ||
      v.infoList?.[0]?.url ||
      '',
  );
}
export function xhsNotes(payload: unknown): Note[] {
  const root = obj(payload);
  const d = obj(root.data);
  const arr = d.items || d.notes || [];
  return arr.flatMap((item: R) => {
    const n = obj(item.note_card || item.noteCard || item);
    const id = String(item.id || n.note_id || n.noteId || '');
    if (!id || (item.model_type && item.model_type !== 'note')) return [];
    const user = obj(n.user);
    const info = obj(n.interact_info || n.interactInfo);
    const token = String(item.xsec_token || item.xsecToken || '');
    const imgs = (n.image_list || n.imageList || []).map(image).filter(Boolean);
    const cover = image(n.cover) || imgs[0] || '';
    return [
      {
        id: 'xhs:' + id,
        nativeId: id,
        platform: 'xiaohongshu',
        title: String(
          n.display_title || n.displayTitle || n.title || n.desc?.slice(0, 60) || '未命名作品',
        ),
        body: String(n.desc || ''),
        author: String(user.nickname || user.nick_name || user.nickName || ''),
        authorId: String(user.user_id || user.userId || ''),
        type: n.type === 'video' ? 'video' : 'image',
        images: imgs.length ? imgs : n.type === 'video' ? [] : cover ? [cover] : [],
        cover,
        likes: count(info.liked_count || info.likedCount),
        comments: count(info.comment_count || info.commentCount),
        commentCountKnown: info.comment_count != null || info.commentCount != null,
        saves: count(info.collected_count || info.collectedCount),
        publishedAt: date(n.time),
        tags: (n.tag_list || []).map((t: R) => String(t.name)),
        url: `https://www.xiaohongshu.com/explore/${encodeURIComponent(id)}${token ? '?xsec_token=' + encodeURIComponent(token) + '&xsec_source=pc_search' : ''}`,
        source: 'live',
        detailState: n.desc ? 'complete' : 'summary',
      } as Note,
    ];
  });
}
export function douyinNotes(payload: unknown): Note[] {
  const root = obj(payload);
  const arr = root.data || root.aweme_list || [];
  return arr.flatMap((item: R) => {
    const n = obj(item.aweme_info || item.aweme || item);
    const id = String(n.aweme_id || '');
    if (!id) return [];
    const user = obj(n.author),
      info = obj(n.statistics);
    const imgs = (n.images || n.image_post_info?.images || []).map(image).filter(Boolean);
    const cover = image(n.video?.cover) || image(n.video?.origin_cover) || imgs[0] || '';
    const desc = String(n.desc || '');
    return [
      {
        id: 'dy:' + id,
        nativeId: id,
        platform: 'douyin',
        title: desc.slice(0, 80) || '抖音作品',
        body: desc,
        author: String(user.nickname || ''),
        authorId: String(user.sec_uid || user.uid || ''),
        type: imgs.length ? 'image' : 'video',
        images: imgs,
        cover,
        videoUrl: image(n.video?.play_addr) || undefined,
        likes: count(info.digg_count),
        comments: count(info.comment_count),
        saves: count(info.collect_count),
        publishedAt: date(n.create_time),
        tags: (n.text_extra || []).map((t: R) => String(t.hashtag_name || '')).filter(Boolean),
        url: `https://www.douyin.com/${imgs.length ? 'note' : 'video'}/${encodeURIComponent(id)}`,
        source: 'live',
        detailState: 'complete',
      } as Note,
    ];
  });
}
export function platformComments(
  platform: Platform,
  payload: unknown,
  noteId: string,
  parentId: string | null = null,
): Comment[] {
  const root = obj(payload);
  const data = platform === 'xiaohongshu' ? obj(root.data) : root;
  const list = data.comments || [];
  const prefix = platform === 'xiaohongshu' ? 'xhs:' : 'dy:';
  const result: Comment[] = [];
  for (const c of list) {
    const user = obj(c.user_info || c.user);
    const native = String(c.id || c.cid || '');
    if (!native) continue;
    const id = prefix + native;
    result.push({
      id,
      noteId,
      parentId: parentId || (c.reply_id && c.reply_id !== '0' ? prefix + c.reply_id : null),
      author: String(user.nickname || user.nick_name || ''),
      authorId: String(user.user_id || user.sec_uid || user.uid || ''),
      body: String(c.content || c.text || ''),
      region: String(c.ip_location || c.ip_label || ''),
      createdAt: date(c.create_time),
      likes: count(c.like_count || c.digg_count),
      source: 'live',
      platform,
    });
    for (const child of c.sub_comments || c.reply_comment || []) {
      result.push(
        ...platformComments(
          platform,
          platform === 'xiaohongshu' ? { data: { comments: [child] } } : { comments: [child] },
          noteId,
          id,
        ),
      );
    }
  }
  return result;
}
export function responseMore(platform: Platform, payload: unknown): boolean | undefined {
  const r = obj(payload);
  const d = platform === 'xiaohongshu' ? obj(r.data) : r;
  const v = d.has_more ?? d.hasMore;
  if (v === undefined) return undefined;
  return !!v;
}

/** XHS v2 places the active sort in filters while the legacy top-level sort stays general. */
export function xhsRequestSort(body: unknown): string | null {
  const data = obj(body);
  if (Array.isArray(data.filters)) {
    const selected = data.filters.find((f: any) => f?.type === 'sort_type');
    if (selected)
      return Array.isArray(selected.tags) && typeof selected.tags[0] === 'string'
        ? selected.tags[0]
        : null;
  }
  return typeof data.sort === 'string' ? data.sort : null;
}
