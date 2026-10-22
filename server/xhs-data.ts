import {
  claimEntity,
  journaledFetch,
  advancePendingPoll,
  UncertainRequestError,
  RequestBudgetError,
  RestoredScopeError,
  ReceiptPersistenceError,
  assertDispatchAllowed,
} from './request-journal.ts';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Comment, Note, SearchInput } from '../shared/types.ts';
import { configGet, configSet, encrypt, decrypt, get, put, transaction } from './store.ts';
import { xhsNotes, platformComments, count, parsePlatformJSON } from './platforms/model.ts';

type Row = Record<string, any>;
export type XhsProvider = 'tikhub' | 'redfox';
export class XhsPendingError extends Error {}
export const xhsConfigSchema = z
  .object({
    provider: z.enum(['tikhub', 'redfox']),
    apiKey: z.string().trim().max(4096).optional(),
    maxRequests: z.number().int().min(1).max(100).default(20),
  })
  .strict();
export function xhsProvider(): XhsProvider {
  return configGet('xhs.provider') === 'redfox' ? 'redfox' : 'tikhub';
}
export function xhsSettings() {
  return {
    provider: xhsProvider(),
    maxRequests: Number(configGet('xhs.maxRequests', '20')),
    hasKeys: { tikhub: !!configGet('xhs.key.tikhub'), redfox: !!configGet('xhs.key.redfox') },
  };
}
export function saveXhsSettings(input: unknown) {
  const v = xhsConfigSchema.parse(input);
  if (v.apiKey !== undefined) configSet('xhs.key.' + v.provider, v.apiKey ? encrypt(v.apiKey) : '');
  configSet('xhs.provider', v.provider);
  configSet('xhs.maxRequests', String(v.maxRequests));
  return xhsSettings();
}
export function xhsFingerprint() {
  return (
    xhsProvider() +
    ':' +
    createHash('sha256')
      .update(decrypt(configGet('xhs.key.' + xhsProvider())))
      .digest('hex')
      .slice(0, 16)
  );
}
export function xhsConfigured() {
  if (!configGet('xhs.key.' + xhsProvider()))
    throw new Error('请在设置 → 小红书 API 数据源填写 ' + xhsProvider() + ' API Key');
}
export function apiDate(value: unknown) {
  if (!value) return '';
  const s = String(value);
  const d = /^\d+$/.test(s)
    ? new Date(Number(s) * (s.length < 13 ? 1000 : 1))
    : new Date(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(s) ? s.replace(' ', 'T') + '+08:00' : s);
  return Number.isFinite(d.getTime()) ? d.toISOString() : '';
}
export function redfoxNotes(rows: Row[]): Note[] {
  return rows.map((r) => {
    if (!r.workId) throw new Error('RedFox 作品数据缺少 workId');
    return {
      id: 'xhs:' + r.workId,
      nativeId: String(r.workId),
      platform: 'xiaohongshu',
      source: 'live',
      title: String(r.workTitle || '未命名作品'),
      body: String(r.workDesc || ''),
      author: String(r.accountNickname || ''),
      authorId: String(r.accountUserid || ''),
      type: r.workType === 'video' ? 'video' : 'image',
      cover: String(r.coverUrl || ''),
      images: r.coverUrl ? [String(r.coverUrl)] : [],
      likes: count(r.workLikedCount),
      comments: count(r.workCommentsCount),
      commentCountKnown: r.workCommentsCount != null,
      saves: count(r.workCollectedCount),
      publishedAt: apiDate(r.workPublishTime),
      tags: [],
      url: String(r.workUrl || 'https://www.xiaohongshu.com/explore/' + r.workId),
      detailState: 'summary',
    };
  });
}
export function unwrap(provider: XhsProvider, payload: Row): Row {
  if (Number(payload.code) !== (provider === 'tikhub' ? 200 : 2000))
    throw new Error(
      `${provider} API 错误（${String(payload.code || '未知状态')}），请核对密钥、余额及接口权限`,
    );
  let data = payload.data;
  if (!data || typeof data !== 'object') throw new Error(provider + ' 返回空数据或无效结构');
  if (provider === 'tikhub') {
    if (
      data.success === false ||
      (data.code !== undefined && ![0, 200].includes(Number(data.code)))
    )
      throw new Error('TikHub 上游数据请求未成功');
    if (data.data && typeof data.data === 'object') data = data.data;
  }
  return data;
}
function list(data: Row, ...names: string[]): Row[] {
  for (const name of names) if (Array.isArray(data[name])) return data[name];
  throw new Error('API 响应缺少数据列表，已停止，避免误报采集成功');
}
function more(data: Row) {
  return [true, 1, '1', 'true'].includes(data.has_more ?? data.hasMore);
}
function tikNotes(rows: Row[]) {
  const notes = xhsNotes({
    data: {
      items: rows.map((r) => ({
        ...r,
        id: r.id || r.note_id || r.note?.id,
        note_card: r.note_card || r.note || r,
      })),
    },
  });
  if (rows.length && !notes.length) throw new Error('TikHub 作品字段无法识别');
  return notes;
}
interface RedTask {
  id: string;
  taskId?: string;
  visibleAfterTime?: string;
  state: string;
  createdAt: string;
  result?: Comment[];
}
export function xhsClient(
  signal?: AbortSignal,
  transport: typeof fetch = fetch,
  requestScope?: string,
) {
  const provider = xhsProvider();
  const fingerprint = xhsFingerprint();
  const key = decrypt(configGet('xhs.key.' + provider));
  const budget = xhsSettings().maxRequests;
  let requests = 0;
  function checkRequest() {
    assertDispatchAllowed(requestScope);
    if (!key) throw new Error('请先在设置中填写 ' + provider + ' API Key');
    signal?.throwIfAborted();
    if (requests >= budget)
      throw new RequestBudgetError(
        `已达到本任务 API 请求上限 ${budget}，已保存现有结果；可在设置调整`,
      );
  }
  function requestFor(scope: string | undefined, replayOnly = false, polling = false) {
    return journaledFetch(
      scope,
      async (url, init) => {
        requests++;
        return transport(url, init);
      },
      checkRequest,
      replayOnly,
      polling,
    );
  }
  async function call(
    path: string,
    params: Row,
    query = false,
    scope = requestScope,
    replayOnly = false,
  ): Promise<Row> {
    if (!key) throw new Error('请先在设置中填写 ' + provider + ' API Key');
    signal?.throwIfAborted();
    const url = new URL(
      path,
      provider === 'tikhub' ? 'https://api.tikhub.io' : 'https://redfox.hk',
    );
    if (provider === 'tikhub' || query)
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const init: RequestInit = {
      method: provider === 'tikhub' ? 'GET' : 'POST',
      headers:
        provider === 'tikhub'
          ? { Authorization: 'Bearer ' + key }
          : { REDFOX_API_KEY: key, 'Content-Type': 'application/json' },
      body: provider === 'redfox' && !query ? JSON.stringify(params) : undefined,
      redirect: 'error',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(45000)])
        : AbortSignal.timeout(45000),
    };
    const response = await requestFor(
      scope,
      replayOnly,
      query,
    )(url, init).catch((error) => {
      if (
        error instanceof UncertainRequestError ||
        error instanceof RequestBudgetError ||
        error instanceof RestoredScopeError ||
        error instanceof ReceiptPersistenceError
      )
        throw error;
      signal?.throwIfAborted();
      throw new Error(provider + ' 请求超时或网络不可用，未自动重试；请求可能已计费');
    });
    if (!response.ok)
      throw new Error(
        `${provider} HTTP ${response.status}，请检查密钥、余额或服务状态；未自动重试`,
      );
    const data = unwrap(provider, parsePlatformJSON(await response.text()));
    // A definitive pending poll can be polled again. A lost poll response cannot.
    if (query && ['pending', 'processing'].includes(data.status)) advancePendingPoll(response);
    return data;
  }
  const tik = (name: string, params: Row) => call('/api/v1/xiaohongshu/app_v2/' + name, params);
  return {
    provider,
    fingerprint,
    get requests() {
      return requests;
    },
    async search(input: SearchInput, cursor: string | null) {
      const state = cursor ? JSON.parse(cursor) : { page: 1, offset: 0 };
      if (provider === 'redfox') {
        const d = await call('/story/api/xhsUser/searchArticle', {
          keyword: input.keyword,
          offset: state.offset,
          sortType: { general: '_0', latest: '_2', popular: '_4' }[input.sort],
          exactMatch: false,
        });
        const items = redfoxNotes(list(d, 'list')).filter(
          (n) => input.noteType === 'all' || n.type === input.noteType,
        );
        return {
          items,
          nextCursor: more(d) ? JSON.stringify({ offset: state.offset + 20 }) : null,
        };
      }
      const d = await tik('search_notes', {
        keyword: input.keyword,
        page: state.page,
        sort_type: {
          general: 'general',
          latest: 'time_descending',
          popular: 'popularity_descending',
        }[input.sort],
        note_type: { all: '不限', image: '普通笔记', video: '视频笔记' }[input.noteType],
        time_filter: '不限',
        search_id: state.search_id || '',
        search_session_id: state.search_session_id || '',
      });
      const items = tikNotes(list(d, 'items', 'notes'));
      return {
        items,
        nextCursor: more(d)
          ? JSON.stringify({
              page: state.page + 1,
              search_id: d.search_id || state.search_id,
              search_session_id: d.search_session_id || state.search_session_id,
            })
          : null,
      };
    },
    async comments(note: Note, limit: number, cursor: string | null) {
      const native = note.nativeId || note.id.replace(/^xhs:/, '');
      if (provider === 'redfox') {
        const id = fingerprint + ':' + native + ':' + limit;
        let task = get<RedTask>('xhs-api-tasks', id);
        let claimed = false;
        if (!task) {
          checkRequest();
          task = { id, state: 'submitting', createdAt: new Date().toISOString() };
          claimed = claimEntity('xhs-api-tasks', task);
          if (!claimed)
            throw new XhsPendingError('RedFox 任务已由另一个进程占用，请稍后继续；未重复提交');
        }
        if (!task.taskId) {
          let d: Row;
          try {
            // Task-scoped receipt also survives a crash before taskId is saved.
            // Existing uncertain tasks may only replay, never create a submission.
            d = await call(
              '/story/api/xhs/commentSubmit',
              { opusId: native, dataNum: limit },
              false,
              'redfox-submit:' + id,
              !claimed,
            );
          } catch (error) {
            if (error instanceof UncertainRequestError)
              throw new XhsPendingError(
                'RedFox 提交结果不确定，已阻止重复扣费。请在设置中填入供应商后台任务编号后继续。记录：' +
                  id,
              );
            throw error;
          }
          if (!d.taskId) throw new Error('RedFox 未返回任务编号，请在供应商后台核对，避免重复计费');
          task = transaction(() => {
            const current = get<RedTask>('xhs-api-tasks', id)!;
            // Another process may already have recovered and completed this task.
            if (current.taskId) return current;
            const updated = {
              ...current,
              taskId: String(d.taskId),
              visibleAfterTime: String(d.visibleAfterTime || ''),
              state: 'pending',
            };
            put('xhs-api-tasks', updated);
            return updated;
          });
          throw new XhsPendingError(
            `RedFox 评论任务已提交（${task.taskId}），预计 ${task.visibleAfterTime || '24 小时后'} 可查询。稍后继续流程或重新采集同一作品、相同条数，将复用任务而不会重复提交。`,
          );
        }
        if (task.result) return { items: task.result, nextCursor: null };
        const d = await call('/story/api/xhs/commentResult', { taskId: task.taskId }, true);
        if (['pending', 'processing'].includes(d.status))
          throw new XhsPendingError(
            `RedFox 评论任务 ${task.taskId} 等待完成，预计 ${task.visibleAfterTime || '提交后24小时'} 可见；请稍后继续。`,
          );
        if (d.status !== 'completed')
          throw new Error('RedFox 评论任务状态异常，请在供应商后台检查：' + task.taskId);
        const items: Comment[] = list(d, 'commentList').map((r) => {
          if (!r.commentId) throw new Error('RedFox 评论缺少 commentId');
          return {
            id: 'xhs:' + r.commentId,
            noteId: note.id,
            parentId: null,
            author: String(r.nickname || ''),
            authorId: String(r.commenterId || ''),
            body: String(r.content || ''),
            region: String(r.ipLocation || ''),
            createdAt: apiDate(r.createTime),
            likes: count(r.likeNum),
            source: 'live',
            platform: 'xiaohongshu',
          };
        });
        put('xhs-api-tasks', { ...task, state: 'completed', result: items });
        return { items, nextCursor: null };
      }
      const state = cursor ? JSON.parse(cursor) : { cursor: '', index: 0, pageArea: 'UNFOLDED' };
      const d = await tik('get_note_comments', {
        note_id: native,
        cursor: state.cursor,
        index: state.index,
        pageArea: state.pageArea,
        sort_strategy: 'latest_v2',
      });
      list(d, 'comments');
      const items = platformComments('xiaohongshu', { data: d }, note.id);
      if (more(d) && (!d.cursor || d.cursor === state.cursor))
        throw new Error('TikHub 评论分页游标无效，已停止请求');
      return {
        items,
        nextCursor: more(d)
          ? JSON.stringify({
              cursor: d.cursor,
              index: d.index ?? state.index + 1,
              pageArea: d.pageArea || state.pageArea,
            })
          : null,
      };
    },
    async detail(noteOrUrl: Note | string): Promise<Note> {
      const note = typeof noteOrUrl === 'string' ? undefined : noteOrUrl;
      const url = typeof noteOrUrl === 'string' ? noteOrUrl : noteOrUrl.url;
      if (provider === 'redfox') {
        const d = await call('/story/api/xhsUser/queryWorkDetail', { workLink: url });
        return redfoxNotes([d])[0];
      }
      const d = await tik(
        note?.type === 'video' ? 'get_video_note_detail' : 'get_image_note_detail',
        { share_text: url },
      );
      const rows = Array.isArray(d) ? d : d.items || d.notes || [d.note || d];
      const result = tikNotes(rows)[0];
      if (!result) throw new Error('TikHub 未返回作品详情');
      return result;
    },
  };
}
