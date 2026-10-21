import { journaledFetch, UncertainRequestError, RequestBudgetError } from './request-journal.ts';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Note, SearchInput } from '../shared/types.ts';
import { configGet, configSet, encrypt, decrypt } from './store.ts';
import { douyinNotes, platformComments, count, parsePlatformJSON } from './platforms/model.ts';
import { getCookie } from './provider.ts';
import { apiDate } from './xhs-data.ts';

type Row = Record<string, any>;
export type DouyinProvider = 'browser' | 'http' | 'tikhub' | 'redfox';
const providers = z.enum(['browser', 'http', 'tikhub', 'redfox']);
export const redfoxCommentNotice =
  'RedFox 当前接入仅支持抖音作品搜索和详情，公开文档未提供可核实的评论接口。请在设置主动切换到 TikHub 或现有浏览器后再采集评论；不会自动切换或产生评论费用。';
export function douyinProvider(): DouyinProvider {
  const selected = providers.safeParse(configGet('douyin.provider'));
  return selected.success
    ? selected.data
    : configGet('connectionType', configGet('providerUrl') ? 'http' : 'browser') === 'http'
      ? 'http'
      : 'browser';
}
export function douyinUsesApi() {
  return ['tikhub', 'redfox'].includes(douyinProvider());
}
export function douyinSettings() {
  return {
    provider: douyinProvider(),
    maxRequests: Number(configGet('douyin.maxRequests', '20')),
    hasKeys: { tikhub: !!configGet('douyin.key.tikhub'), redfox: !!configGet('douyin.key.redfox') },
    commentsSupported: douyinProvider() !== 'redfox',
  };
}
export function saveDouyinSettings(input: unknown) {
  const v = z
    .object({
      provider: providers,
      apiKey: z.string().trim().max(4096).optional(),
      maxRequests: z.number().int().min(1).max(100).default(20),
    })
    .strict()
    .parse(input);
  if (v.apiKey !== undefined) {
    if (!['tikhub', 'redfox'].includes(v.provider))
      throw new Error('浏览器及高级 HTTP 模式不使用供应商 API Key');
    configSet('douyin.key.' + v.provider, v.apiKey ? encrypt(v.apiKey) : '');
  }
  configSet('douyin.provider', v.provider);
  configSet('douyin.maxRequests', String(v.maxRequests));
  return douyinSettings();
}
export function douyinFingerprint() {
  const p = douyinProvider();
  const identity =
    p === 'http'
      ? JSON.stringify([
          configGet('providerUrl'),
          decrypt(configGet('token')),
          configGet('accountId', 'demo-account'),
          getCookie(),
        ])
      : douyinUsesApi()
        ? decrypt(configGet('douyin.key.' + p))
        : '';
  return 'douyin:' + p + ':' + createHash('sha256').update(identity).digest('hex').slice(0, 16);
}
export function requireDouyinComments(platform: string | undefined, mode: string) {
  if (platform === 'douyin' && mode === 'live' && douyinProvider() === 'redfox')
    throw new Error(redfoxCommentNotice);
}
export function normalizeRedfoxDouyin(rows: Row[]): Note[] {
  return rows.map((r) => {
    if (!r.workId) throw new Error('RedFox 抖音作品缺少 workId');
    const image = ['图文', 'image', 'normal', '68'].includes(String(r.workType));
    return {
      id: 'dy:' + r.workId,
      nativeId: String(r.workId),
      platform: 'douyin',
      source: 'live',
      title: String(r.title || r.content || '抖音作品').slice(0, 80),
      body: String(r.content || ''),
      author: String(r.accountName || ''),
      authorId: String(r.authorId || r.accountId || ''),
      type: image ? 'image' : 'video',
      images: image && r.coverUrl ? [String(r.coverUrl)] : [],
      cover: String(r.coverUrl || ''),
      likes: count(r.likeCount),
      comments: count(r.commentCount),
      commentCountKnown: r.commentCount != null,
      saves: count(r.collectCount),
      publishedAt: apiDate(r.publishTime),
      tags: [],
      url: String(r.workUrl || 'https://www.douyin.com/' + (image ? 'note/' : 'video/') + r.workId),
      detailState: 'summary',
    };
  });
}
function rows(d: Row, ...names: string[]): Row[] {
  for (const n of names) if (Array.isArray(d[n])) return d[n];
  throw new Error('抖音 API 缺少结果列表，已停止以避免误报采集成功');
}
function hasMore(d: Row) {
  return [true, 1, '1', 'true'].includes(d.has_more ?? d.hasMore);
}
function nextPage(d: Row, previous: unknown) {
  if (!hasMore(d)) return null;
  if (d.cursor == null || String(d.cursor) === String(previous))
    throw new Error('抖音 API 返回无效或重复分页游标');
  return d.cursor;
}
export function douyinClient(
  signal?: AbortSignal,
  transport: typeof fetch = fetch,
  requestScope?: string,
) {
  const provider = douyinProvider();
  if (provider !== 'tikhub' && provider !== 'redfox')
    throw new Error('当前抖音数据源不是供应商 API');
  const key = decrypt(configGet('douyin.key.' + provider));
  const budget = douyinSettings().maxRequests;
  let requests = 0;
  const request = journaledFetch(
    requestScope,
    async (url, init) => {
      requests++;
      return transport(url, init);
    },
    () => {
      if (requests >= budget)
        throw new RequestBudgetError(`已达到本步骤 API 请求上限 ${budget}；已保存已有结果`);
    },
  );
  async function call(path: string, params: Row, method: 'GET' | 'POST' = 'POST'): Promise<Row> {
    signal?.throwIfAborted();
    if (!key) throw new Error('请在设置 → 抖音数据源填写 ' + provider + ' API Key');
    const url = new URL(
      path,
      provider === 'tikhub' ? 'https://api.tikhub.io' : 'https://redfox.hk',
    );
    if (method === 'GET')
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const response = await request(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(provider === 'tikhub' ? { Authorization: 'Bearer ' + key } : { REDFOX_API_KEY: key }),
      },
      body: method === 'POST' ? JSON.stringify(params) : undefined,
      redirect: 'error',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(45000)])
        : AbortSignal.timeout(45000),
    }).catch((error) => {
      if (error instanceof UncertainRequestError || error instanceof RequestBudgetError)
        throw error;
      signal?.throwIfAborted();
      throw new Error(provider + ' 请求超时或网络不可用；未自动重试，请求可能已计费');
    });
    if (!response.ok)
      throw new Error(
        `${provider} HTTP ${response.status}，请检查接口权限、密钥和余额；未自动重试`,
      );
    const root = parsePlatformJSON(await response.text());
    if (Number(root?.code) !== (provider === 'tikhub' ? 200 : 2000))
      throw new Error(
        `${provider} API 错误（${String(root?.code ?? '未知')}），请检查接口权限、密钥和余额`,
      );
    let d = root.data;
    if (!d || typeof d !== 'object' || Array.isArray(d))
      throw new Error('抖音 API 返回空数据或无效结构');
    if (provider === 'tikhub') {
      if (d.status_code != null && Number(d.status_code) !== 0)
        throw new Error('TikHub 抖音上游请求失败');
      // Preserve data arrays and sibling cursor/search_id; only unwrap nested objects.
      if (d.data && !Array.isArray(d.data) && typeof d.data === 'object') d = d.data;
      if (d.status_code != null && Number(d.status_code) !== 0)
        throw new Error('TikHub 抖音上游请求失败');
    }
    return d;
  }
  return {
    provider,
    fingerprint: douyinFingerprint(),
    get requests() {
      return requests;
    },
    async search(input: SearchInput, cursor: string | null) {
      const state = cursor
        ? JSON.parse(cursor)
        : { cursor: 0, offset: 0, search_id: '', backtrace: '' };
      if (provider === 'redfox') {
        const d = await call('/story/api/dyData/searchArticle', {
          keyword: input.keyword,
          offset: state.offset,
          sortType: { general: '_0', latest: '_2', popular: '_4' }[input.sort],
        });
        return {
          items: normalizeRedfoxDouyin(rows(d, 'list')).filter(
            (n) => input.noteType === 'all' || n.type === input.noteType,
          ),
          nextCursor: hasMore(d) ? JSON.stringify({ offset: state.offset + 20 }) : null,
        };
      }
      const d = await call('/api/v1/douyin/search/fetch_general_search_v1', {
        keyword: input.keyword,
        cursor: state.cursor,
        sort_type: { general: '0', popular: '1', latest: '2' }[input.sort],
        publish_time: '0',
        filter_duration: '0',
        content_type: { all: '0', video: '1', image: '2' }[input.noteType],
        search_id: state.search_id,
        backtrace: state.backtrace,
      });
      const data = rows(d, 'data', 'aweme_list');
      const items = douyinNotes({ data });
      if (data.length && !items.length) throw new Error('TikHub 抖音结果中没有可识别的作品');
      const next = nextPage(d, state.cursor);
      return {
        items: items.filter((n) => input.noteType === 'all' || n.type === input.noteType),
        nextCursor:
          next == null
            ? null
            : JSON.stringify({
                cursor: next,
                search_id: d.search_id || d.log_pb?.impr_id || state.search_id,
                backtrace: d.backtrace ?? state.backtrace,
              }),
      };
    },
    async comments(note: Note, _limit: number, cursor: string | null) {
      if (provider === 'redfox') throw new Error(redfoxCommentNotice);
      const previous = cursor ? JSON.parse(cursor).cursor : 0;
      const d = await call(
        '/api/v1/douyin/app/v3/fetch_video_comments',
        { aweme_id: note.nativeId || note.id.replace(/^dy:/, ''), cursor: previous, count: 20 },
        'GET',
      );
      const comments = rows(d, 'comments');
      const items = platformComments('douyin', d, note.id);
      if (comments.length && !items.length) throw new Error('TikHub 抖音评论字段无法识别');
      const next = nextPage(d, previous);
      return { items, nextCursor: next == null ? null : JSON.stringify({ cursor: next }) };
    },
    async detail(noteOrUrl: Note | string): Promise<Note> {
      const url = typeof noteOrUrl === 'string' ? noteOrUrl : noteOrUrl.url;
      if (provider === 'redfox')
        return normalizeRedfoxDouyin([
          await call('/story/api/dyData/queryWork', { workUrl: url }),
        ])[0];
      const d = await call(
        '/api/v1/douyin/app/v3/fetch_one_video_by_share_url',
        { share_url: url },
        'GET',
      );
      const list = d.aweme_list || [d.aweme_detail || d];
      const note = douyinNotes({ data: list })[0];
      if (!note)
        throw new Error(
          'TikHub 未返回可访问的抖音作品，可能已删除、私密或存在地区限制；不会自动回退浏览器',
        );
      return note;
    },
  };
}
