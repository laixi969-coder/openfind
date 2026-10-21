import { validateJobCheckpoint } from './job-progress.ts';
import { saveCollectedLead } from './leads.ts';
import { douyinUsesApi, requireDouyinComments } from './douyin-data.ts';
import { workflowErrorMessage } from './workflow-errors.ts';
import { reviewSemantics, semanticFor, llmSettings } from './llm.ts';
import { compareQualifications } from './qualification-comparison.ts';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  AcquisitionInput,
  AcquisitionWorkflow,
  Job,
  Note,
  Comment,
  Lead,
  SearchInput,
} from '../shared/types.ts';
import { all, get, put, transaction } from './store.ts';
import { cachedJob } from './jobs-cache.ts';
import { acquisitionPriority, assessComment, intentScore, qualificationVersion } from './domain.ts';
import { evaluateBudget, readInterval, protectionStatus } from './protection.ts';
import { parseWorkLink, parseWorkLinks } from '../shared/work-links.ts';

export const workflowRuns = new Map<string, AbortController>();
export type JobExecutor = (
  job: Job,
  input: SearchInput & { forceRefresh: boolean; platform: AcquisitionInput['platform'] },
  signal?: AbortSignal,
) => Promise<void>;
export function saveWorkflow(w: AcquisitionWorkflow, message?: string) {
  if (message) {
    w.message = message;
    w.logs.push({
      at: new Date().toISOString(),
      level: w.status === 'paused' ? 'WARN' : 'INFO',
      message,
    });
    w.logs = w.logs.slice(-300);
  }
  w.updatedAt = new Date().toISOString();
  put('workflows', w);
}
export function createWorkflow(input: AcquisitionInput): AcquisitionWorkflow {
  if (input.links) {
    const links = parseWorkLinks(input.links.join('\n'));
    if (input.mode !== 'live' || links[0].platform !== input.platform)
      throw new Error('链接获客必须使用对应平台的真实模式');
    input = { ...input, links: links.map((l) => l.url), maxNotes: links.length, supplement: false };
  }
  if (intentScore('', '', input.keyword).stage === 'restricted')
    throw new Error('此关键词涉及敏感主题，请使用发现作品进行内容研究，不执行个人营销线索流程');
  const w: AcquisitionWorkflow = {
    id: randomUUID(),
    input,
    status: 'running',
    stage: input.links ? 'resolve' : 'search',
    ...(input.links ? { linkNoteIds: {} } : {}),
    searchIndex: 0,
    searchJobIds: [],
    noteIds: [],
    selectedNoteIds: [],
    completedNoteIds: [],
    commentIds: [],
    leadIds: [],
    logs: [],
    message: '正在准备最新作品搜索',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  saveWorkflow(
    w,
    input.links
      ? `链接流程开始：读取 ${input.links.length} 篇指定作品 → 评论采集 → 近7天需求判断 → 保存候选`
      : '一键流程开始：最新作品 → 活跃评论选样 → 近7天需求判断 → 保存候选',
  );
  return w;
}
export function recoverWorkflows() {
  for (const w of all<AcquisitionWorkflow>('workflows')) {
    if (w.reviewProgress?.status === 'running') {
      w.reviewProgress.status = 'failed';
      w.reviewProgress.message = '服务重启，模型复核已中断，已保存结果可继续复核';
      saveWorkflow(w);
    }
    if (w.status === 'running') {
      w.status = 'paused';
      saveWorkflow(w, '服务重启，已保留检查点；点击继续流程，已完成步骤不会重跑');
    }
  }
}
const unique = (ids: string[]) => [...new Set(ids)];
function scopedNotes(w: AcquisitionWorkflow, ids: string[]) {
  return unique(ids).filter((id) => {
    const note = get<Note>('notes', id);
    return note?.platform === w.input.platform && note.source === w.input.mode;
  });
}
function rankedNotes(w: AcquisitionWorkflow) {
  const comments = all<Comment>('comments');
  return w.noteIds
    .map((id) => get<Note>('notes', id))
    .filter((n): n is Note => !!n && n.platform === w.input.platform && n.source === w.input.mode)
    .map((note) => ({ note, priority: acquisitionPriority(note, comments) }))
    .filter((x) => x.priority.tier > 0)
    .sort(
      (a, b) =>
        b.priority.tier - a.priority.tier ||
        b.priority.weight - a.priority.weight ||
        b.note.publishedAt.localeCompare(a.note.publishedAt),
    );
}
export function qualify(w: AcquisitionWorkflow) {
  const candidates = w.commentIds
    .map((id) => get<Comment>('comments', id))
    .filter(
      (c): c is Comment => !!c && c.source === w.input.mode && w.selectedNoteIds.includes(c.noteId),
    )
    .map((c) => ({ c, note: get<Note>('notes', c.noteId) }))
    .filter(({ note }) => note?.platform === w.input.platform)
    .map(({ c, note }) => ({
      c,
      note,
      assessment: assessComment(c, note, Date.now(), all<Comment>('comments')),
    }))
    .filter((x) => x.assessment.recommended && x.assessment.withinSevenDays === true)
    .sort(
      (a, b) =>
        b.assessment.score - a.assessment.score || b.c.createdAt.localeCompare(a.c.createdAt),
    );
  const ids = new Set<string>();
  for (const { c, note } of candidates) {
    const { lead } = saveCollectedLead(c, note, all<Comment>('comments'));
    if (lead.assessment?.recommended && lead.assessment.withinSevenDays === true) ids.add(lead.id);
  }
  w.leadIds = [...ids];
  saveWorkflow(w);
}
export async function reviewWorkflowQualification(
  w: AcquisitionWorkflow,
  signal?: AbortSignal,
  useModel = false,
) {
  const original =
    w.qualificationReview?.originalCommentIds ||
    w.leadIds.map((id) => get<Lead>('leads', id)?.commentId).filter((id): id is string => !!id);
  const notes = all<Note>('notes');
  const comments = w.commentIds
    .map((id) => get<Comment>('comments', id))
    .filter(
      (c): c is Comment =>
        !!c &&
        c.source === w.input.mode &&
        w.selectedNoteIds.includes(c.noteId) &&
        notes.some((n) => n.id === c.noteId && n.platform === w.input.platform),
    );
  const modelActive = useModel || llmSettings().enabled;
  let semanticStatus: string;
  try {
    semanticStatus = await reviewSemantics(
      comments,
      notes,
      signal,
      all<Comment>('comments'),
      useModel,
      (progress) => {
        const now = new Date().toISOString();
        w.reviewProgress = {
          ...progress,
          status: 'running',
          message: `模型复核：${progress.reviewed}/${progress.eligible}条已完成，本地排除${progress.excluded}条`,
          startedAt: w.reviewProgress?.status === 'running' ? w.reviewProgress.startedAt : now,
          updatedAt: now,
        };
        saveWorkflow(w);
      },
    );
  } catch (error) {
    if (modelActive && w.reviewProgress) {
      w.reviewProgress.status = 'failed';
      w.reviewProgress.message = '模型复核已中断，已完成结果保留，可继续复核';
      saveWorkflow(w);
    }
    throw error;
  }
  if (modelActive && w.reviewProgress) {
    w.reviewProgress.status = w.reviewProgress.pending === 0 ? 'completed' : 'failed';
    w.reviewProgress.message = semanticStatus;
    w.reviewProgress.updatedAt = new Date().toISOString();
  }

  signal?.throwIfAborted();
  qualify(w);
  const current = w.leadIds.map((id) => get<Lead>('leads', id)!.commentId);
  w.qualificationReview = {
    version: qualificationVersion,
    reviewedAt: new Date().toISOString(),
    originalCommentIds: original,
    addedCommentIds: current.filter((id) => !original.includes(id)),
    removedCommentIds: original.filter((id) => !current.includes(id)),
    reviewedCommentCount: comments.length,
    semanticStatus,
    comparison: compareQualifications(
      comments.map((c) => ({
        ...c,
        semantic: semanticFor(
          c,
          notes.find((n) => n.id === c.noteId),
          all<Comment>('comments'),
        ),
      })),
      notes,
      all<Comment>('comments'),
    ),
  };
  saveWorkflow(w);
  return w.qualificationReview;
}
async function waitForPlatform(
  w: AcquisitionWorkflow,
  action: 'search' | 'comments',
  signal: AbortSignal,
) {
  if (w.input.mode === 'demo' || w.input.platform === 'xiaohongshu' || douyinUsesApi()) return;
  const state = protectionStatus(w.input.platform);
  // Evaluate non-timing guards first. Waiting never clears a platform pause or a quota.
  const error = evaluateBudget({ ...state, lastReadAt: undefined }, action);
  if (error) throw new Error(error);
  const ms = Math.max(0, readInterval(state, action) - (Date.now() - (state.lastReadAt || 0)));
  if (ms) {
    saveWorkflow(
      w,
      `等待采集间隔 ${Math.ceil(ms / 1000)} 秒，随后继续${action === 'search' ? '搜索' : '评论采集'}`,
    );
    await delay(ms, undefined, { signal });
  }
}
export type WorkResolver = (
  url: string,
  platform: AcquisitionInput['platform'],
  signal: AbortSignal,
  requestScope?: string,
) => Promise<Note>;
export async function runWorkflow(
  w: AcquisitionWorkflow,
  execute: JobExecutor,
  resolve?: WorkResolver,
) {
  if (workflowRuns.has(w.id)) return;
  const abort = new AbortController();
  workflowRuns.set(w.id, abort);
  w.status = 'running';
  saveWorkflow(w);
  async function child(type: Job['type'], sort: SearchInput['sort'], note?: Note) {
    abort.signal.throwIfAborted();
    const query = {
      keyword: note?.title || w.input.keyword,
      limit: note ? w.input.commentLimit : w.input.searchLimit,
      sort,
      noteType: 'all' as const,
      mode: w.input.mode,
      platform: w.input.platform,
      interval: 250,
      forceRefresh: false,
    };
    const previous = w.currentJobId ? get<Job>('jobs', w.currentJobId) : undefined;
    const reusable =
      previous &&
      previous.type === type &&
      previous.noteId === note?.id &&
      previous.source === w.input.mode &&
      previous.platform === w.input.platform &&
      previous.query?.sort === sort &&
      previous.query?.keyword === query.keyword &&
      previous.query?.limit === query.limit &&
      (previous.status === 'completed' || previous.checkpoint || previous.dataProvider);
    if (w.currentJobId && !previous)
      throw new Error('恢复所需子任务记录缺失，已阻止新建任务和重复计费');
    if (previous && (previous.dataProvider || previous.checkpoint) && !reusable)
      throw new Error('恢复参数与原子任务不一致，已阻止新建任务和重复计费');
    const j: Job = reusable
      ? previous
      : {
          id: randomUUID(),
          type,
          status: 'running',
          keyword: query.keyword,
          noteId: note?.id,
          count: 0,
          pages: 0,
          elapsed: 0,
          resultIds: [],
          logs: [],
          source: w.input.mode,
          platform: w.input.platform,
          query,
          createdAt: new Date().toISOString(),
        };
    validateJobCheckpoint(j);
    const locallyComplete =
      j.status === 'completed' ||
      (j.checkpoint && (j.checkpoint.nextCursor === null || j.count >= query.limit));
    if (!locallyComplete && !cachedJob(j, query)) await waitForPlatform(w, type, abort.signal);
    abort.signal.throwIfAborted();
    w.currentJobId = j.id;
    if (type === 'search' && !w.searchJobIds.includes(j.id)) w.searchJobIds.push(j.id);
    put('jobs', j);
    saveWorkflow(
      w,
      note
        ? `正在采集评论：${note.title}（最多${w.input.commentLimit}条，含回复）`
        : `正在${sort === 'latest' ? '最新发布' : sort === 'general' ? '相关作品' : '高互动'}搜索：${w.input.keyword}`,
    );
    let executionError: unknown;
    if (j.status !== 'completed') {
      j.status = 'running';
      delete j.error;
      put('jobs', j);
      try {
        await execute(j, query, abort.signal);
      } catch (error) {
        executionError = error;
        j.status = abort.signal.aborted ? 'stopped' : 'failed';
        j.error = error instanceof Error ? error.message : '子任务执行失败';
        put('jobs', j);
      }
    }
    if (type === 'search') w.noteIds = scopedNotes(w, [...w.noteIds, ...j.resultIds]);
    else {
      const matching = j.resultIds.filter((id) => {
        const c = get<Comment>('comments', id);
        return (
          c?.noteId === note?.id &&
          c?.source === w.input.mode &&
          (!c.platform || c.platform === w.input.platform)
        );
      });
      w.commentIds = unique([...w.commentIds, ...matching]);
      qualify(w); // Partial results stay visible even when verification interrupts a later page.
    }
    saveWorkflow(w);
    abort.signal.throwIfAborted();
    if (executionError) throw executionError;
    if (j.status !== 'completed')
      throw new Error(j.error || '采集已停止；已保存结果，点击继续可重试当前步骤');
  }
  try {
    requireDouyinComments(w.input.platform, w.input.mode);
    if (w.stage === 'resolve') {
      if (!resolve || !w.input.links?.length)
        throw new Error('链接读取服务不可用，请检查内置浏览器连接');
      w.linkNoteIds ||= {};
      for (const url of w.input.links) {
        abort.signal.throwIfAborted();
        const saved = w.linkNoteIds[url] && get<Note>('notes', w.linkNoteIds[url]);
        if (saved && saved.platform === w.input.platform && saved.source === 'live') continue;
        await waitForPlatform(w, 'search', abort.signal);
        saveWorkflow(
          w,
          `正在读取指定作品 ${Object.keys(w.linkNoteIds).length + 1}/${w.input.links.length}`,
        );
        const link = parseWorkLink(url);
        const note = await resolve(url, w.input.platform, abort.signal, 'workflow:' + w.id);
        abort.signal.throwIfAborted();
        const actual = parseWorkLink(note.url);
        if (
          note.source !== 'live' ||
          note.platform !== w.input.platform ||
          !note.nativeId ||
          note.id !== (note.platform === 'douyin' ? 'dy:' : 'xhs:') + note.nativeId ||
          actual.platform !== w.input.platform ||
          actual.nativeId !== note.nativeId ||
          (link.nativeId && link.nativeId !== note.nativeId)
        )
          throw new Error('指定链接与返回作品身份不一致，已停止采集');
        if (intentScore('', '', note.title + '\n' + note.body).stage === 'restricted')
          throw new Error('该作品涉及敏感主题，不执行个人营销线索流程；可在发现作品中进行内容研究');
        const next = structuredClone(w);
        transaction(() => {
          put('notes', note);
          next.linkNoteIds![url] = note.id;
          next.noteIds = scopedNotes(next, [...next.noteIds, note.id]);
          saveWorkflow(next, `已确认指定作品：${note.title}`);
        });
        Object.assign(w, next);
      }
      w.selectedNoteIds = [...w.noteIds];
      w.stage = 'comments';
      saveWorkflow(
        w,
        `已确认 ${w.selectedNoteIds.length} 篇指定作品，开始逐篇采集评论，不执行关键词搜索或历史补充`,
      );
    }
    if (w.stage === 'search') {
      const sorts = ['latest', 'general', 'popular'] as const;
      while (w.searchIndex < sorts.length) {
        abort.signal.throwIfAborted();
        if (w.searchIndex > 0) {
          if (!w.input.supplement || rankedNotes(w).length >= w.input.maxNotes) break;
          const guard =
            w.input.mode === 'live' && w.input.platform !== 'xiaohongshu' && !douyinUsesApi()
              ? protectionStatus(w.input.platform)
              : null;
          if (guard) {
            const blocked = evaluateBudget({ ...guard, lastReadAt: undefined }, 'search');
            if (blocked) {
              if (guard.paused) throw new Error(blocked);
              saveWorkflow(w, `补充搜索未执行：${blocked}；继续处理已经取得的作品`);
              break;
            }
          }
        }
        await child('search', sorts[w.searchIndex]);
        w.searchIndex++;
        w.currentJobId = undefined;
        // Previously found works for this exact topic may have new comments despite an older publication date.
        const known = all<Job>('jobs').filter(
          (j) =>
            j.type === 'search' &&
            j.status === 'completed' &&
            j.keyword === w.input.keyword &&
            j.platform === w.input.platform &&
            j.source === w.input.mode,
        );
        w.noteIds = scopedNotes(w, [...w.noteIds, ...known.flatMap((j) => j.resultIds)]);
        saveWorkflow(w);
      }
      const ranked = rankedNotes(w);
      w.selectedNoteIds = ranked.slice(0, w.input.maxNotes).map((x) => x.note.id);
      const latest = w.searchJobIds
        .map((id) => get<Job>('jobs', id))
        .find((j) => j?.status === 'completed' && j.query?.sort === 'latest');
      const freshCandidate = latest?.resultIds.find((id) => ranked.some((x) => x.note.id === id));
      // Keep one new discovery in the sample so a large history never crowds out
      // the latest search. Confirmed recent demand still wins a single-work run.
      if (
        freshCandidate &&
        !w.selectedNoteIds.some((id) => latest?.resultIds.includes(id)) &&
        (w.input.maxNotes > 1 || ranked[0]?.priority.tier < 3)
      ) {
        w.selectedNoteIds[w.selectedNoteIds.length - 1] = freshCandidate;
      }
      w.stage = 'comments';
      saveWorkflow(
        w,
        `已选出 ${w.selectedNoteIds.length} 篇有评论信号的作品；优先近期明确需求，其次活跃讨论`,
      );
    }
    if (w.stage === 'comments') {
      for (const id of w.selectedNoteIds) {
        abort.signal.throwIfAborted();
        if (w.completedNoteIds.includes(id)) continue;
        const note = get<Note>('notes', id);
        if (!note) throw new Error('选定作品已不存在，请重新开始流程');
        await child('comments', 'general', note);
        w.completedNoteIds.push(id);
        w.currentJobId = undefined;
        saveWorkflow(w);
      }
      w.stage = 'assess';
      saveWorkflow(w, '正在复核评论日期、明确需求和排除条件，并去重保存候选');
    }
    abort.signal.throwIfAborted();
    await reviewWorkflowQualification(w, abort.signal);
    w.stage = 'done';
    w.status = 'completed';
    w.finishedAt = new Date().toISOString();
    saveWorkflow(
      w,
      `流程完成：${w.noteIds.length} 篇候选作品，${w.completedNoteIds.length} 篇已采样，${w.commentIds.length} 条评论，${w.leadIds.length} 条待人工核对的候选线索${w.leadIds.length ? '' : '；没有符合近7天明确需求的评论，不代表采集失败'}`,
    );
  } catch (e) {
    w.status = 'paused';
    saveWorkflow(
      w,
      abort.signal.aborted
        ? '已暂停，保留全部结果与检查点；点击继续流程从当前步骤重试'
        : workflowErrorMessage(e),
    );
  } finally {
    workflowRuns.delete(w.id);
  }
}
