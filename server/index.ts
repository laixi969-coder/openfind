import { backupDraftImages } from './draft-media.ts';
import { downloadMedia } from './remote-media.ts';
import { saveCollectedLead } from './leads.ts';
import {
  douyinClient,
  douyinProvider,
  douyinUsesApi,
  douyinSettings,
  saveDouyinSettings,
  douyinFingerprint,
  redfoxCommentNotice,
} from './douyin-data.ts';
import { xhsClient, xhsSettings, saveXhsSettings, XhsPendingError } from './xhs-data.ts';
import { acquisitionLimits } from '../shared/collection-limits.ts';
import inboxRouter, { inboxBusy } from './inbox.ts';
import { maintenanceRouter, maintenanceBusy } from './maintenance-router.ts';
import salesRouter from './sales.ts';
import { llmSettings, saveLlmSettings, syncModels, testLlm, semanticFor } from './llm.ts';
import {
  imageMime,
  generationHistory,
  imageSettings,
  saveImageSettings,
  checkImageService,
  generateVariants,
  reuseLlmService,
  syncImageModels,
  testImageGeneration,
  variantsSchema,
} from './images.ts';
import { rewriteCopy, rewriteInputSchema } from './copy.ts';
import {
  adoptCandidates,
  attribution,
  authorBreakdown,
  breakdownNote,
  createInsight,
  deleteInsight,
  digestComments,
  draftOutcomes,
  listInsights,
  suggestKeywords,
  updateInsight,
} from './insights.ts';
import { buildTopicPool } from './topics.ts';
import {
  addServiceModel,
  removeServiceModel,
  listServices,
  createService,
  activateService,
  deleteService,
  serviceBaseUrl,
} from './services.ts';
import express from 'express';
import { randomUUID, createHash } from 'node:crypto';
import { withModelOperation, modelBudget, saveModelPolicy } from './model-safety.ts';
import { workspaceState } from './workspace-state.ts';
import { resolve } from 'node:path';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import multer from 'multer';
import { dataDir } from './store.ts';
import {
  captureRequestReceipts,
  assertDispatchAllowed,
  type ReceiptRef,
} from './request-journal.ts';
import {
  commitJobPage,
  validateJobCheckpoint,
  saveJobState,
  ConcurrentJobUpdateError,
} from './job-progress.ts';
import { cachedJob } from './jobs-cache.ts';
import { setTimeout as delay } from 'node:timers/promises';
import JSZip from 'jszip';
import { z } from 'zod';
import { all, get, put, remove, configGet, configSet, encrypt, transaction } from './store.ts';
import { demoNotes, demoComments } from './demo.ts';
import { parseIntent, toLead, assessComment, intentScore } from './domain.ts';
import {
  providerCall,
  schemas,
  setSessionCookie,
  hasCookie,
  getCookie,
  bindLegacyProviderCredentials,
} from './provider.ts';
import { browserCall, browserScreenshot } from './platforms/client.ts';
import { parseWorkLinks } from '../shared/work-links.ts';
import {
  reservePlatformAction,
  recordPlatformFailure,
  recordPlatformSuccess,
  protectionStatus,
  resumePlatform,
  protectionView,
  saveCollectionPolicy,
  readInterval,
  ProtectionError,
} from './protection.ts';
import {
  createWorkflow,
  saveWorkflow,
  runWorkflow,
  recoverWorkflows,
  workflowRuns,
  reviewWorkflowQualification,
} from './workflows.ts';
import type {
  AcquisitionWorkflow,
  Note,
  Comment,
  Lead,
  Draft,
  DraftResult,
  Job,
  Settings,
  Account,
} from '../shared/types.ts';
export const app = express();
let writeRequests = 0;
app.disable('x-powered-by');
app.use(express.json({ limit: '30mb' }));
app.use('/api', (req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && maintenanceBusy()) {
    res.status(409).json({ error: '资料维护正在进行，请稍后重试' });
    return;
  }
  const host = req.hostname;
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
    res.status(403).json({ error: '仅允许本机访问' });
    return;
  }
  const origin = req.get('origin');
  if (
    origin &&
    ![
      'http://127.0.0.1:5173',
      'http://localhost:5173',
      'http://127.0.0.1:5178',
      'http://localhost:5178',
      `http://127.0.0.1:${process.env.PORT || 8791}`,
      `http://localhost:${process.env.PORT || 8791}`,
    ].includes(origin)
  ) {
    res.status(403).json({ error: '不允许的请求来源' });
    return;
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.path.startsWith('/maintenance')) {
    writeRequests++;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        writeRequests--;
      }
    };
    res.once('finish', release);
    res.once('close', release);
  }
  next();
});
app.use('/api', (req, res, next) => {
  if (
    req.method !== 'POST' ||
    !/\/(copy\/rewrite|llm\/test|images\/(test|variants)|insights\/(breakdown|comments|author|keywords)|workflows\/[^/]+\/review|inbox\/threads\/[^/]+\/suggest)$/.test(
      req.path,
    )
  )
    return next();
  const hash = createHash('sha256')
    .update(req.method + req.path + JSON.stringify(req.body))
    .digest('hex');
  const key = req.get('idempotency-key');
  if (key && !z.uuid().safeParse(key).success) {
    res.status(400).json({ error: '请求编号必须为 UUID' });
    return;
  }
  const id = key || hash;
  const accepted = transaction(() => {
    const previous = get<{ id: string; hash: string }>('model-operations', id);
    if (previous && previous.hash !== hash) return false;
    if (!previous) put('model-operations', { id, hash });
    return true;
  });
  if (!accepted) {
    res.status(409).json({ error: '请求编号已用于其他内容，请核对后新建请求' });
    return;
  }
  withModelOperation(id, next);
});
app.get('/api/model-budget', (_req, res) => res.json(modelBudget()));
app.put('/api/model-budget', (req, res) => res.json(saveModelPolicy(req.body)));
const settings = (): Settings => ({
  mode: configGet(
    'mode',
    process.env.NODE_ENV === 'test' || process.env.OPENFIND_DEMO === '1' ? 'demo' : 'live',
  ) as 'demo' | 'live',
  platform: configGet('platform', 'xiaohongshu') as 'xiaohongshu' | 'douyin',
  connectionType: configGet('connectionType', configGet('providerUrl') ? 'http' : 'browser') as
    'browser' | 'http',
  providerUrl: configGet('providerUrl'),
  hasToken: !!configGet('token'),
  hasCookie: hasCookie(),
  rememberCookie: configGet('rememberCookie:' + configGet('accountId', 'demo-account')) === 'true',
  accountName: configGet('accountName', '本地演示账号'),
  accountId: configGet('accountId', 'demo-account'),
});
const accounts = (): Account[] =>
  all<Account>('accounts').map((a) => ({
    ...a,
    hasCookie: hasCookie(a.id),
    rememberCookie: configGet('rememberCookie:' + a.id) === 'true',
  }));
if (!all('accounts').length)
  put('accounts', {
    id: configGet('accountId', 'demo-account'),
    name: configGet('accountName', '本地演示账号'),
    createdAt: new Date().toISOString(),
  });
// An interrupted process must never leave a job looking as if it is still running.
for (const j of all<Job>('jobs'))
  if (j.status === 'running') {
    j.status = 'stopped';
    j.logs.push({
      at: new Date().toISOString(),
      level: 'WARN',
      message: '服务重启，任务已中止，可重新发起',
    });
    saveJobState(j);
  }
if (
  !configGet('initialized') &&
  (process.env.NODE_ENV === 'test' || process.env.OPENFIND_DEMO === '1')
) {
  const notes = demoNotes('家居', 24);
  notes.forEach((n) => put('notes', n));
  put('jobs', {
    id: 'demo-welcome',
    type: 'search',
    status: 'completed',
    keyword: '家居',
    count: 24,
    pages: 2,
    elapsed: 3,
    resultIds: notes.map((n) => n.id),
    logs: [
      {
        at: new Date().toISOString(),
        level: 'INFO',
        message: '已载入 24 篇本地演示作品，可立即体验完整流程',
      },
    ],
    source: 'demo',
    createdAt: new Date().toISOString(),
  } as Job);
  configSet('initialized', 'true');
}
const running = new Map<string, AbortController>();
function backgroundFailure() {
  console.error('后台任务未能保存状态，已停止执行；请排除存储故障后继续原任务，勿直接重建付费任务');
}
const searchSchema = z.object({
  forceRefresh: z.boolean().default(false),
  keyword: z.string().trim().min(1, '请输入关键词').max(100),
  limit: z.number().int().min(0).max(500),
  sort: z.enum(['general', 'latest', 'popular']),
  noteType: z.enum(['all', 'image', 'video']),
  interval: z.number().int().min(250).max(60000),
  mode: z.enum(['demo', 'live']),
  platform: z.enum(['xiaohongshu', 'douyin']).default('xiaohongshu'),
});
function log(j: Job, level: Job['logs'][number]['level'], message: string) {
  j.logs.push({ at: new Date().toISOString(), level, message });
  j.logs = j.logs.slice(-1000);
  return saveJobState(j);
}
recoverWorkflows();
const qualificationRuns = new Set<string>();
const active = () => running.size > 0 || workflowRuns.size > 0 || qualificationRuns.size > 0;
app.use(
  '/api',
  maintenanceRouter(() => active() || inboxBusy() || writeRequests > 0),
);
function currentLead(lead: Lead, comments = all<Comment>('comments')): Lead {
  const c = get<Comment>('comments', lead.commentId);
  const note = get<Note>('notes', lead.noteId);
  const assessment = c
    ? {
        ...assessComment(c, note, Date.now(), comments),
        semantic: semanticFor(c, note, comments),
      }
    : intentScore(
        lead.content,
        lead.commentCreatedAt || '',
        note ? [note.title, note.body, ...note.tags].join('\n') : '',
      );
  return {
    ...lead,
    score: assessment.score,
    reason: assessment.reason,
    assessment,
    commentCreatedAt: c?.createdAt || lead.commentCreatedAt || '',
  };
}
export async function runJob(
  job: Job,
  input: z.infer<typeof searchSchema>,
  parentSignal?: AbortSignal,
) {
  if (running.has(job.id)) return;
  const saved = get<Job>('jobs', job.id);
  if (saved)
    Object.assign(job, { checkpoint: undefined, dataProvider: undefined, query: undefined }, saved);
  const abort = new AbortController();
  const cancel = () => abort.abort();
  parentSignal?.addEventListener('abort', cancel, { once: true });
  if (parentSignal?.aborted) abort.abort();
  running.set(job.id, abort);
  const started = Date.now();
  let collector: ReturnType<typeof xhsClient> | ReturnType<typeof douyinClient> | null = null;
  let cursor: string | null = job.checkpoint?.nextCursor || null;
  let readId: string | null = null;
  const visitedCursors = new Set(job.checkpoint?.visitedCursors || []);
  try {
    abort.signal.throwIfAborted();
    validateJobCheckpoint(job);
    const resuming = !!job.dataProvider;
    if (
      resuming &&
      job.query &&
      ['keyword', 'limit', 'sort', 'noteType', 'mode', 'platform'].some(
        (key) => job.query![key as keyof typeof input] !== input[key as keyof typeof input],
      )
    )
      throw new Error('恢复参数与原任务不一致，已阻止重新计费；请使用原参数继续');
    if (!resuming) job.query = { ...input };
    if (job.checkpoint && (!cursor || (input.limit > 0 && job.count >= input.limit))) {
      job.status = 'completed';
      return;
    }

    collector =
      job.source !== 'live'
        ? null
        : input.platform === 'xiaohongshu'
          ? xhsClient(abort.signal, fetch, job.id)
          : douyinUsesApi()
            ? douyinClient(abort.signal, fetch, job.id)
            : null;
    const fingerprint =
      job.source === 'live' ? collector?.fingerprint || douyinFingerprint() : undefined;

    if ((job.checkpoint || job.dataProvider) && job.dataProvider !== fingerprint)
      throw new Error('数据源或账号已改变，不能继续旧分页；请恢复原配置或新建流程');
    job.dataProvider = fingerprint;
    if (
      !log(
        job,
        'INFO',
        `${job.source === 'demo' ? '演示任务' : '真实任务'}开始：${job.type === 'search' ? input.keyword : job.noteId}`,
      )
    )
      return;
    if (job.source === 'live' && !resuming && !job.checkpoint && !input.forceRefresh) {
      const cached = cachedJob(job, input);
      if (cached) {
        job.resultIds = cached.resultIds.slice(0, input.limit);
        job.count = job.resultIds.length;
        job.dataFetchedAt = cached.dataFetchedAt || cached.finishedAt;
        job.searchEvidence = cached.searchEvidence;
        job.status = 'completed';
        log(
          job,
          'SUCCESS',
          `复用5分钟内的已保存结果 ${job.count} 条，未向平台重复采集；评论原始日期保持不变`,
        );
        return;
      }
    }
    let sample: Note[] | Comment[] =
      job.type === 'search'
        ? demoNotes(input.keyword, input.limit || 100)
        : demoComments(job.noteId!, input.limit || 60);
    if (job.source === 'demo') {
      sample =
        job.type === 'search'
          ? (sample as Note[]).map((n) => ({
              ...n,
              id: input.platform === 'douyin' ? 'demo-dy:' + n.id : n.id,
              platform: input.platform,
            }))
          : (sample as Comment[]).map((c) => ({ ...c, platform: input.platform }));
    }
    if (job.type === 'search') {
      sample = (sample as Note[]).filter(
        (n) => input.noteType === 'all' || n.type === input.noteType,
      );
      if (input.sort === 'popular') sample.sort((a, b) => (b as Note).likes - (a as Note).likes);
      if (input.sort === 'latest')
        sample.sort((a, b) => (b as Note).publishedAt.localeCompare((a as Note).publishedAt));
    }
    if (cursor && visitedCursors.has(cursor))
      throw new Error('数据服务返回循环分页游标，已阻止恢复时重复请求；请新建任务');
    if (job.checkpoint && job.pages >= 200)
      throw new Error('已达到分页保护上限，请新建较小范围的任务');
    for (let page = job.checkpoint ? job.pages : 0; page < 200; page++) {
      let repeatedCursor = false;
      let receipts: ReceiptRef[] = [];
      abort.signal.throwIfAborted();
      let items: (Note | Comment)[] = [];
      if (job.source === 'demo') {
        await delay(420, undefined, { signal: abort.signal });
        items = sample.slice(page * 12, (page + 1) * 12);
        cursor = (page + 1) * 12 < sample.length ? String(page + 1) : null;
      } else {
        if (page)
          await delay(
            Math.max(
              collector ? 1000 : readInterval(protectionStatus(input.platform), job.type),
              input.interval,
            ),
            undefined,
            {
              signal: abort.signal,
            },
          );
        if (!collector && douyinProvider() === 'browser') {
          assertDispatchAllowed(job.id);
          reservePlatformAction(input.platform, job.type);
        }
        const captured: {
          result: {
            items: (Omit<Note, 'source'> | Omit<Comment, 'source'>)[];
            nextCursor: string | null;
            readId?: string;
            evidence?: { path: string; filterSelected: string | null; sortType: string | null };
          };
          receipts: ReceiptRef[];
        } = await captureRequestReceipts(async () =>
          collector
            ? job.type === 'search'
              ? await collector.search(input, cursor)
              : await collector.comments(get<Note>('notes', job.noteId!)!, input.limit, cursor)
            : douyinProvider() === 'browser'
              ? await browserCall<{ items: (Note | Comment)[]; nextCursor: string | null }>(
                  job.type === 'search' ? '/search' : '/comments',
                  job.type === 'search'
                    ? { ...input, cursor }
                    : { note: get<Note>('notes', job.noteId!), cursor },
                  abort.signal,
                )
              : job.type === 'search'
                ? await providerCall(
                    '/search',
                    {
                      keyword: input.keyword,
                      platform: input.platform,
                      limit: input.limit,
                      sort: input.sort,
                      noteType: input.noteType,
                      cursor,
                    },
                    schemas.search,
                    abort.signal,
                    job.id,
                    () => reservePlatformAction(input.platform, job.type),
                  )
                : await providerCall(
                    '/comments',
                    { noteId: job.noteId, includeReplies: true, cursor, platform: input.platform },
                    schemas.comments,
                    abort.signal,
                    job.id,
                    () => reservePlatformAction(input.platform, job.type),
                  ),
        );
        const result = captured.result;
        receipts = captured.receipts;
        readId = result.readId || readId;
        if (job.type === 'search' && result.evidence) {
          job.searchEvidence = { ...result.evidence, sort: input.sort };
          if (!job.pages)
            log(
              job,
              'INFO',
              `已核对平台排序：${input.sort === 'latest' ? '最新发布' : input.sort === 'popular' ? '最多点赞' : '综合'}，响应 ${result.evidence.path}`,
            );
        }
        if (!collector) recordPlatformSuccess(input.platform);
        items = result.items.map((x) => ({ ...x, source: 'live' })) as (Note | Comment)[];
        const next: string | null = result.nextCursor;
        if (cursor) visitedCursors.add(cursor);
        repeatedCursor = !!next && visitedCursors.has(next);
        cursor = next;
      }
      abort.signal.throwIfAborted();
      const resumable = job.source === 'demo' || !!collector || douyinProvider() === 'http';
      commitJobPage(
        job,
        input,
        items,
        resumable ? { nextCursor: cursor, visitedCursors: [...visitedCursors] } : undefined,
        receipts,
      );
      job.elapsed = Math.round((Date.now() - started) / 1000);
      if (
        !log(
          job,
          'SUCCESS',
          `${job.type === 'search' ? '作品' : '评论'}第 ${job.pages} 页完成，累计 ${job.count} 条（已去重）`,
        )
      )
        return;
      if (!cursor || (input.limit > 0 && job.count >= input.limit)) break;
      if (repeatedCursor) throw new Error('数据服务返回循环分页游标，已保存本页并停止以防重复请求');
      if (page === 199)
        throw new Error('达到本地分页保护上限 200 页，已保存当前结果；请缩小范围后重试');
    }
    job.status = 'completed';
    log(
      job,
      'SUCCESS',
      `任务完成，共保存 ${job.count} 条${job.source === 'demo' ? '演示数据' : ''}`,
    );
  } catch (e) {
    if (e instanceof ConcurrentJobUpdateError) {
      Object.assign(job, get<Job>('jobs', job.id));
      return;
    }
    if (abort.signal.aborted) {
      job.status = 'stopped';
      log(job, 'WARN', '任务已停止，已采集结果保留');
    } else {
      job.status = e instanceof XhsPendingError ? 'stopped' : 'failed';
      job.error = e instanceof Error ? e.message : '任务失败';
      if (job.source === 'live' && !collector && !(e instanceof ProtectionError))
        recordPlatformFailure(input.platform, job.error);
      log(job, e instanceof XhsPendingError ? 'WARN' : 'ERROR', job.error);
    }
  } finally {
    try {
      if (collector)
        log(
          job,
          'INFO',
          `数据源 ${collector.provider}，本次 API 请求 ${collector.requests} 次；计费以供应商账单为准`,
        );
      if (readId)
        await browserCall('/close-read', { cursor: readId }, AbortSignal.timeout(3000)).catch(
          () => {},
        );
      job.elapsed = Math.round((Date.now() - started) / 1000);
      if (job.status === 'completed') {
        job.finishedAt = new Date().toISOString();
        job.dataFetchedAt ||= job.finishedAt;
      }
      saveJobState(job);
    } finally {
      running.delete(job.id);
      parentSignal?.removeEventListener('abort', cancel);
    }
  }
}
app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'openfind' }));
app.get('/api/state', async (req, res) => {
  const snapshot = workspaceState(settings, accounts);
  res.set({ ETag: snapshot.etag, 'Cache-Control': 'private, no-cache', Vary: 'Accept-Encoding' });
  if (req.get('if-none-match') === snapshot.etag) {
    res.status(304).end();
    return;
  }
  res.type('json');
  if (req.acceptsEncodings('gzip')) res.set('Content-Encoding', 'gzip').send(await snapshot.gzip);
  else res.send(snapshot.json);
});
const acquisitionSchema = z.object({
  keyword: z.string().trim().min(1).max(100),
  platform: z.enum(['xiaohongshu', 'douyin']),
  mode: z.enum(['demo', 'live']),
  searchLimit: z.number().int().min(1).max(acquisitionLimits.search).default(20),
  maxNotes: z.number().int().min(1).max(acquisitionLimits.notes).default(3),
  commentLimit: z.number().int().min(1).max(acquisitionLimits.comments).default(20),
  supplement: z.boolean().default(true),
});
async function resolveWorkflowWork(
  url: string,
  platform: 'xiaohongshu' | 'douyin',
  signal: AbortSignal,
  requestScope?: string,
) {
  if (platform === 'xiaohongshu') return xhsClient(signal, fetch, requestScope).detail(url);
  if (douyinUsesApi()) return douyinClient(signal, fetch, requestScope).detail(url);
  assertDispatchAllowed(requestScope);
  reservePlatformAction(platform, 'search');
  try {
    const note = await browserCall<Note>('/resolve-work', { url, platform }, signal);
    recordPlatformSuccess(platform);
    return note;
  } catch (e) {
    if (!signal.aborted && !(e instanceof ProtectionError))
      recordPlatformFailure(platform, (e as Error).message);
    throw e;
  }
}
app.post('/api/workflows/links', (req, res) => {
  const input = z
    .object({
      content: z.string().trim().min(1).max(12000),
      commentLimit: z.number().int().min(1).max(acquisitionLimits.comments).default(20),
    })
    .strict()
    .parse(req.body);
  let links: ReturnType<typeof parseWorkLinks>;
  try {
    links = parseWorkLinks(input.content);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
    return;
  }
  if (active()) {
    res.status(409).json({ error: '已有任务运行，请先暂停或等待完成' });
    return;
  }
  if (links.some((l) => l.platform === 'douyin') && douyinProvider() === 'http') {
    res.status(400).json({ error: '链接获客需要内置平台浏览器，请在连接设置切换连接方式' });
    return;
  }
  if (rejectCommentSource(res, links[0].platform, 'live')) return;
  const w = createWorkflow({
    keyword: `指定链接（${links.length}篇）`,
    links: links.map((l) => l.url),
    platform: links[0].platform,
    mode: 'live',
    searchLimit: 1,
    maxNotes: links.length,
    commentLimit: input.commentLimit,
    supplement: false,
  });
  void runWorkflow(w, runJob, resolveWorkflowWork).catch(backgroundFailure);
  res.status(201).json(w);
});
app.post('/api/workflows', (req, res) => {
  const input = acquisitionSchema.parse(req.body);
  if (active()) {
    res.status(409).json({ error: '已有任务运行，请先暂停或等待完成' });
    return;
  }
  if (intentScore('', '', input.keyword).stage === 'restricted') {
    res
      .status(400)
      .json({ error: '此关键词涉及敏感主题，请使用发现作品进行内容研究，不执行个人营销线索流程' });
    return;
  }
  if (rejectCommentSource(res, input.platform, input.mode)) return;
  const w = createWorkflow(input);
  void runWorkflow(w, runJob).catch(backgroundFailure);
  res.status(201).json(w);
});
app.post('/api/workflows/:id/review', async (req, res) => {
  const { useModel } = z
    .object({ useModel: z.boolean().default(false) })
    .strict()
    .parse(req.body || {});
  const w = get<AcquisitionWorkflow>('workflows', String(req.params.id));
  if (!w) {
    res.status(404).json({ error: '流程不存在' });
    return;
  }
  if (active() || w.status !== 'completed') {
    res.status(409).json({ error: '请等待当前任务结束，再复核已完成流程' });
    return;
  }
  qualificationRuns.add(w.id);
  try {
    await reviewWorkflowQualification(w, undefined, useModel);
    w.message = `复核完成：${w.commentIds.length}条原始评论，${w.leadIds.length}条候选；原候选降级${w.qualificationReview!.removedCommentIds.length}条，补入${w.qualificationReview!.addedCommentIds.length}条`;
    saveWorkflow(w);
    res.json(w);
  } finally {
    qualificationRuns.delete(w.id);
  }
});
app.post('/api/workflows/:id/:action', (req, res) => {
  const w = get<AcquisitionWorkflow>('workflows', String(req.params.id));
  if (!w) {
    res.status(404).json({ error: '流程不存在' });
    return;
  }
  if (req.params.action === 'pause') {
    const controller = workflowRuns.get(w.id);
    if (!controller) {
      res.status(409).json({ error: '流程已结束或暂停' });
      return;
    }
    controller.abort();
  } else if (req.params.action === 'resume') {
    if (w.status !== 'paused' || active()) {
      res.status(409).json({ error: '请等待当前任务结束；只有暂停的流程可以继续' });
      return;
    }
    if (rejectCommentSource(res, w.input.platform, w.input.mode)) return;
    void runWorkflow(w, runJob, resolveWorkflowWork).catch(backgroundFailure);
  } else {
    res.status(404).json({ error: '未知操作' });
    return;
  }
  res.json(w);
});
app.post('/api/intent', (req, res) => {
  const { text } = z.object({ text: z.string().trim().min(1).max(2000) }).parse(req.body);
  res.json(parseIntent(text));
});
app.post('/api/jobs', (req, res) => {
  const input = searchSchema.parse(req.body);
  if (input.mode === 'live' && (input.limit === 0 || input.limit > 100)) {
    res.status(400).json({ error: '真实采集每次请选择 1–100 条；不限数量仅用于演示' });
    return;
  }
  if (active()) {
    res.status(409).json({ error: '已有采集任务运行，请先停止或等待完成' });
    return;
  }
  if (
    input.mode === 'live' &&
    input.platform !== 'xiaohongshu' &&
    douyinProvider() === 'http' &&
    !configGet('providerUrl')
  ) {
    res.status(400).json({ error: '尚未配置真实数据服务，请在连接设置中完成配置' });
    return;
  }
  const j: Job = {
    id: randomUUID(),
    type: 'search',
    status: 'running',
    keyword: input.keyword,
    count: 0,
    pages: 0,
    elapsed: 0,
    resultIds: [],
    logs: [],
    source: input.mode,
    platform: input.platform,
    query: input,
    createdAt: new Date().toISOString(),
  };
  put('jobs', j);
  void runJob(j, input).catch(backgroundFailure);
  res.status(201).json(j);
});
app.post('/api/jobs/:id/stop', (req, res) => {
  const controller = running.get(String(req.params.id));
  if (!controller) {
    res.status(409).json({ error: '任务已结束' });
    return;
  }
  for (const w of all<AcquisitionWorkflow>('workflows'))
    if (w.currentJobId === req.params.id) workflowRuns.get(w.id)?.abort();
  controller.abort();
  res.json({ ok: true });
});
app.post('/api/comments/collect', (req, res) => {
  const input = z
    .object({
      noteId: z.string().min(1),
      limit: z.number().int().min(0).max(500).default(60),
      interval: z.number().int().min(250).max(60000).default(1000),
    })
    .parse(req.body);
  const note = get<Note>('notes', input.noteId);
  if (!note) {
    res.status(404).json({ error: '作品不存在' });
    return;
  }
  if (rejectCommentSource(res, note.platform, note.source)) return;
  if (note.source === 'live' && (input.limit === 0 || input.limit > 100)) {
    res.status(400).json({ error: '真实评论采集每次请选择 1–100 条' });
    return;
  }
  if (active()) {
    res.status(409).json({ error: '请先等待当前采集结束' });
    return;
  }
  const j: Job = {
    id: randomUUID(),
    type: 'comments',
    status: 'running',
    keyword: note.title,
    noteId: note.id,
    count: 0,
    pages: 0,
    elapsed: 0,
    resultIds: [],
    logs: [],
    source: note.source,
    platform: note.platform,
    query: {
      keyword: note.title,
      limit: input.limit,
      sort: 'general',
      noteType: 'all',
      interval: input.interval,
      mode: note.source,
      platform: note.platform,
    },
    createdAt: new Date().toISOString(),
  };
  put('jobs', j);
  void runJob(j, {
    forceRefresh: false,
    keyword: note.title,
    limit: input.limit,
    sort: 'general',
    noteType: 'all',
    mode: note.source,
    platform: note.platform,
    interval: input.interval,
  }).catch(backgroundFailure);
  res.status(201).json(j);
});
app.post('/api/leads/collect', (req, res) => {
  const { commentIds } = z
    .object({ commentIds: z.array(z.string()).min(1).max(500) })
    .parse(req.body);
  let added = 0,
    restricted = 0;
  for (const id of commentIds) {
    const c = get<Comment>('comments', id);
    if (c) {
      const lead = toLead(c, get<Note>('notes', c.noteId), all<Comment>('comments'));
      if (lead.assessment?.stage === 'restricted') {
        restricted++;
        continue;
      }
      if (saveCollectedLead(c, get<Note>('notes', c.noteId), all<Comment>('comments')).added)
        added++;
    }
  }
  res.json({ added, restricted });
});
app.use('/api', salesRouter);
app.use('/api', inboxRouter);
app.patch('/api/leads/:id', (req, res) => {
  const lead = get<Lead>('leads', String(req.params.id));
  if (!lead) {
    res.status(404).json({ error: '客户不存在' });
    return;
  }
  const patch = z
    .object({
      revision: z.number().int().min(0),
      status: z.enum(['new', 'contacted', 'qualified', 'archived']).optional(),
      memo: z.string().max(3000).optional(),
      outreach: z.string().max(3000).optional(),
    })
    .strict()
    .parse(req.body);
  if (patch.revision !== (lead.revision || 0)) {
    res.status(409).json({ error: '客户记录已被修改，请重新打开核对；本次修改未覆盖已有记录' });
    return;
  }
  const updated = { ...lead, ...patch, revision: (lead.revision || 0) + 1 };
  put('leads', updated);
  res.json(updated);
});
const image = z
  .string()
  .max(12_000_000)
  .refine(
    (s) =>
      /^\/assets\/[\w.-]+$/.test(s) ||
      /^\/api\/media\/[a-f0-9-]+\.(png|jpe?g|webp)$/.test(s) ||
      /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(s) ||
      /^https?:\/\//.test(s),
    '不支持的图片格式',
  );
const draftSchema = z.object({
  noteId: z.string(),
  title: z.string().trim().min(1).max(20),
  body: z.string().max(1000),
  tags: z.array(z.string().max(30)).max(20),
  images: z.array(image).max(18),
  platform: z.enum(['xiaohongshu', 'douyin']).optional(),
  kind: z.enum(['image', 'video']).default('image'),
  video: z.string().optional(),
  origin: z.enum(['original', 'clone']).default('clone'),
  visibility: z.enum(['public', 'private']),
  accountId: z.string().min(1),
  knowledgeIds: z.array(z.string().max(64)).max(12).default([]),
});
app.post('/api/drafts', async (req, res) => {
  const input = draftSchema.parse(req.body);
  let id = req.body.id ? z.string().parse(req.body.id) : randomUUID();
  const previous = get<Draft>('drafts', id);
  if (req.body.id && !previous) {
    res.status(404).json({ error: '草稿已删除，不能用旧窗口重新覆盖；请新建草稿' });
    return;
  }
  if (previous && req.body.revision !== (previous.revision || 0)) {
    res.status(409).json({ error: '草稿已更新，请保留当前编辑内容，重新打开核对后再保存' });
    return;
  }
  if (previous && previous.status !== 'draft') id = randomUUID();
  if (input.origin !== 'original' && !get<Note>('notes', input.noteId)) {
    res.status(404).json({ error: '来源作品不存在，请重新选择作品' });
    return;
  }
  if (input.kind === 'image' && !input.images.length) {
    res.status(400).json({ error: '图文至少需要一张图片' });
    return;
  }
  if (
    input.kind === 'video' &&
    (!input.video || !/^\/api\/media\/[a-f0-9-]+\.(mp4|webm|mov)$/.test(input.video))
  ) {
    res.status(400).json({ error: '请上传本地视频' });
    return;
  }
  for (const url of [...input.images, ...(input.video ? [input.video] : [])]) {
    const path = url.startsWith('/api/media/')
      ? join(dataDir, 'uploads', url.split('/').at(-1)!)
      : /^\/assets\/[\w.-]+$/.test(url)
        ? resolve('public' + url)
        : null;
    if (path && (!existsSync(path) || !statSync(path).isFile())) {
      res.status(400).json({ error: '素材文件不存在，请重新上传后保存' });
      return;
    }
  }
  input.images = await backupDraftImages(input.images);
  // A disconnected editor may finish its download after maintenance has begun.
  // Revalidate local files immediately before the synchronous database commit.
  for (const url of [...input.images, ...(input.video ? [input.video] : [])]) {
    if (url.startsWith('/api/media/')) {
      const path = join(dataDir, 'uploads', url.split('/').at(-1)!);
      if (!existsSync(path) || !statSync(path).isFile()) {
        res.status(409).json({ error: '保存期间素材已清理，请重新上传后保存；草稿未写入' });
        return;
      }
    }
  }
  // Downloads yield: re-read before committing so concurrent edits/deletion win.
  if (previous) {
    const current = get<Draft>('drafts', previous.id);
    if (!current || (current.revision || 0) !== (previous.revision || 0)) {
      res.status(409).json({ error: '草稿在素材备份期间已修改或删除，本次保存未覆盖已有记录' });
      return;
    }
  }
  const source = get<Note>('notes', input.noteId);
  const d: Draft = {
    ...input,
    platform: input.platform || source?.platform || 'xiaohongshu',
    id,
    status: 'draft',
    revision: id === previous?.id ? (previous.revision || 0) + 1 : 1,
    createdAt: previous?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  put('drafts', d);
  res.status(201).json(d);
});
for (const action of ['publish', 'prepare', 'reconcile']) {
  app.post(`/api/drafts/:id/${action}`, (_req, res) =>
    res
      .status(410)
      .json({ error: '平台代发与代填已取消，请下载素材包、复制文案后自行到官方平台发布。' }),
  );
}
// 手动发布后回填作品链接：只记录真实数据，不代发、不推断结果。
app.post('/api/drafts/:id/result', async (req, res) => {
  const draft = get<Draft>('drafts', String(req.params.id));
  if (!draft) {
    res.status(404).json({ error: '草稿不存在或已删除' });
    return;
  }
  const { url } = z.object({ url: z.string().trim().min(1).max(2000) }).parse(req.body);
  if (!/^https?:\/\//.test(url)) {
    res.status(400).json({ error: '请填写完整的作品链接（以 http 开头）' });
    return;
  }
  const platform = draft.platform || 'xiaohongshu';
  if (platform === 'douyin' && !douyinUsesApi()) {
    res.status(400).json({
      error: '抖音当前使用浏览器数据源，回填作品数据需要先在「抖音数据源」切换 TikHub / RedFox',
    });
    return;
  }
  let note: Note;
  try {
    note = await (platform === 'xiaohongshu' ? xhsClient() : douyinClient()).detail(url);
  } catch (error) {
    res.status(502).json({
      error: '拉取作品数据失败：' + (error instanceof Error ? error.message : '数据源不可用'),
    });
    return;
  }
  const now = new Date().toISOString();
  const result: DraftResult = {
    url,
    platform,
    noteId: note.nativeId || note.id,
    title: note.title,
    likes: note.likes,
    comments: note.comments,
    saves: note.saves,
    publishedAt: note.publishedAt,
    checkedAt: now,
  };
  const next = transaction(() => {
    const current = get<Draft>('drafts', draft.id);
    if (!current || (current.revision || 0) !== (draft.revision || 0)) return null;
    const saved = { ...current, result, revision: (current.revision || 0) + 1, updatedAt: now };
    put('drafts', saved);
    return saved;
  });
  if (!next) {
    res.status(409).json({ error: '拉取期间草稿已修改或删除，本次回填未覆盖记录，请重新核对' });
    return;
  }
  res.json(next);
});
const uploads = join(dataDir, 'uploads');
mkdirSync(uploads, { recursive: true, mode: 0o700 });
const upload = multer({
  storage: multer.diskStorage({
    destination: uploads,
    filename: (_req, file, callback) => {
      const ext =
        file.mimetype === 'video/webm'
          ? 'webm'
          : file.mimetype === 'video/quicktime'
            ? 'mov'
            : 'mp4';
      callback(null, randomUUID() + '.' + ext);
    },
  }),
  limits: { fileSize: 500 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!['video/mp4', 'video/webm', 'video/quicktime'].includes(file.mimetype))
      cb(new Error('仅支持 MP4、WebM、MOV 视频'));
    else cb(null, true);
  },
});
app.post('/api/media/video', upload.single('file'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: '请选择视频' });
    return;
  }
  const { open, unlink, chmod } = await import('node:fs/promises');
  const handle = await open(req.file.path, 'r');
  const bytes = Buffer.alloc(16);
  await handle.read(bytes, 0, 16, 0);
  await handle.close();
  const valid =
    bytes.toString('ascii', 4, 8) === 'ftyp' ||
    bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (!valid) {
    await unlink(req.file.path);
    res.status(400).json({ error: '文件内容不是支持的视频格式' });
    return;
  }
  await chmod(req.file.path, 0o600);
  res.status(201).json({
    url: '/api/media/' + req.file.filename,
    name: req.file.originalname,
    size: req.file.size,
  });
});
app.get('/api/media/:file', (req, res) => {
  const name = String(req.params.file);
  if (!/^[a-f0-9-]+\.(mp4|webm|mov|png|jpe?g|webp)$/.test(name)) {
    res.status(400).json({ error: '无效素材' });
    return;
  }
  res.sendFile(join(uploads, name));
});
app.delete('/api/drafts/:id', (req, res) => {
  remove('drafts', String(req.params.id));
  res.json({ ok: true });
});
app.get('/api/llm', (_req, res) => res.json(llmSettings()));
app.put('/api/llm', (req, res) => {
  if (active()) {
    res.status(409).json({ error: '请在任务或复核结束后修改模型配置' });
    return;
  }
  res.json(saveLlmSettings(req.body));
});
app.post('/api/llm/models/sync', async (_req, res) => res.json(await syncModels()));
app.post('/api/llm/models', (req, res) => {
  addServiceModel('text', req.body);
  res.status(201).json(llmSettings());
});
app.delete('/api/llm/models/:id', (req, res) => {
  removeServiceModel('text', String(req.params.id));
  res.json(llmSettings());
});
app.post('/api/llm/test', async (_req, res) => res.json(await testLlm()));
app.get('/api/images/generations', (_req, res) => res.json(generationHistory()));
app.get('/api/images', (_req, res) => res.json(imageSettings()));
app.put('/api/images', (req, res) => {
  res.json(saveImageSettings(req.body));
});
app.post('/api/images/check', async (_req, res) => {
  res.json(await checkImageService());
});
app.post('/api/images/reuse-llm', (_req, res) => {
  try {
    res.json(reuseLlmService());
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : '无法复用大模型服务' });
  }
});
app.post('/api/images/models', (req, res) => {
  addServiceModel('image', req.body);
  res.status(201).json(imageSettings());
});
app.delete('/api/images/models/:id', (req, res) => {
  removeServiceModel('image', String(req.params.id));
  res.json(imageSettings());
});
app.post('/api/images/models/sync', async (_req, res) => {
  try {
    res.json(await syncImageModels());
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : '同步模型失败' });
  }
});
app.post('/api/images/test', async (_req, res) => {
  try {
    res.json(await testImageGeneration());
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : '测试生图失败' });
  }
});
app.post('/api/images/variants', async (req, res) => {
  const input = variantsSchema.parse(req.body);
  if (!imageSettings().baseUrl || !imageSettings().model) {
    res.status(400).json({ error: '请先配置生图服务地址与模型' });
    return;
  }
  try {
    res.json(await generateVariants(input));
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : '生图失败' });
  }
});
app.post('/api/copy/rewrite', async (req, res) => {
  const input = rewriteInputSchema.parse(req.body);
  try {
    res.json(await rewriteCopy(input));
  } catch (error) {
    if (error instanceof z.ZodError) throw error;
    const message = error instanceof Error ? error.message : '文案改写失败';
    res.status(/敏感主题/.test(message) ? 400 : 502).json({ error: message });
  }
});
// 知识库：卡片、拆解、评论归集、搜索词与归因。平台一律由调用方传入，小红书与抖音各自独立。
app.get('/api/insights', (req, res) => {
  res.json(
    listInsights({
      platform: typeof req.query.platform === 'string' ? req.query.platform : '',
      kind: typeof req.query.kind === 'string' ? req.query.kind : '',
    }),
  );
});
app.get('/api/insights/attribution', (_req, res) => res.json(attribution()));
app.get('/api/insights/outcomes', (_req, res) => res.json(draftOutcomes()));
app.post('/api/insights', (req, res) => res.status(201).json(createInsight(req.body)));
app.post('/api/insights/adopt', (req, res) => res.status(201).json(adoptCandidates(req.body)));
app.patch('/api/insights/:id', (req, res) =>
  res.json(updateInsight(String(req.params.id), req.body)),
);
app.delete('/api/insights/:id', (req, res) => {
  deleteInsight(String(req.params.id));
  res.json({ ok: true });
});
app.post('/api/insights/breakdown', async (req, res) => {
  const { noteId } = z.object({ noteId: z.string().min(1) }).parse(req.body);
  try {
    res.json(await breakdownNote(noteId));
  } catch (error) {
    if (error instanceof z.ZodError) throw error;
    res.status(502).json({ error: error instanceof Error ? error.message : '作品拆解失败' });
  }
});
app.post('/api/insights/comments', async (req, res) => {
  try {
    res.json(await digestComments(req.body));
  } catch (error) {
    if (error instanceof z.ZodError) throw error;
    res.status(502).json({ error: error instanceof Error ? error.message : '评论归集失败' });
  }
});
app.post('/api/insights/author', async (req, res) => {
  try {
    res.json(await authorBreakdown(req.body));
  } catch (error) {
    if (error instanceof z.ZodError) throw error;
    res.status(502).json({ error: error instanceof Error ? error.message : '账号分析失败' });
  }
});
app.post('/api/topics', (req, res) => res.json(buildTopicPool(req.body)));
app.post('/api/insights/keywords', async (req, res) => {
  try {
    res.json(await suggestKeywords(req.body));
  } catch (error) {
    if (error instanceof z.ZodError) throw error;
    res.status(502).json({ error: error instanceof Error ? error.message : '搜索词挖掘失败' });
  }
});
app.get('/api/services', (req, res) => {
  const kind = req.query.kind === 'image' ? 'image' : 'text';
  res.json(listServices(kind));
});
app.post('/api/services', (req, res) => {
  res.status(201).json(createService(req.body));
});
app.post('/api/services/:id/activate', (req, res) => {
  res.json(activateService(String(req.params.id)));
});
app.delete('/api/services/:id', (req, res) => {
  res.json(deleteService(String(req.params.id)));
});
function rejectCommentSource(res: express.Response, platform: string | undefined, mode: string) {
  if (platform !== 'douyin' || mode !== 'live' || douyinProvider() !== 'redfox') return false;
  res.status(400).json({ error: redfoxCommentNotice });
  return true;
}
app.get('/api/douyin-data', (_req, res) => res.json(douyinSettings()));
app.put('/api/douyin-data', (req, res) => {
  if (active()) {
    res.status(409).json({ error: '请先停止当前任务，再切换数据源或密钥' });
    return;
  }
  res.json(saveDouyinSettings(req.body));
});
app.post('/api/douyin-data/test', async (req, res) => {
  const { keyword } = z.object({ keyword: z.string().trim().min(1).max(100) }).parse(req.body);
  if (!douyinUsesApi()) {
    res.status(400).json({ error: '浏览器模式请使用下方登录检查；高级 HTTP 请使用原连接测试' });
    return;
  }
  const client = douyinClient();
  const result = await client.search(
    {
      keyword,
      limit: 1,
      sort: 'general',
      noteType: 'all',
      interval: 1000,
      mode: 'live',
      platform: 'douyin',
    },
    null,
  );
  res.json({
    ok: true,
    count: result.items.length,
    requests: client.requests,
    provider: client.provider,
  });
});
app.get('/api/xhs-data', (_req, res) => res.json(xhsSettings()));
app.put('/api/xhs-data', (req, res) => {
  if (active()) {
    res.status(409).json({ error: '请先停止当前任务，再切换数据源或密钥' });
    return;
  }
  res.json(saveXhsSettings(req.body));
});
app.post('/api/xhs-data/test', async (req, res) => {
  const { keyword } = z.object({ keyword: z.string().trim().min(1).max(100) }).parse(req.body);
  const client = xhsClient();
  const result = await client.search(
    {
      keyword,
      limit: 1,
      sort: 'general',
      noteType: 'all',
      interval: 1000,
      mode: 'live',
      platform: 'xiaohongshu',
    },
    null,
  );
  res.json({
    ok: true,
    count: result.items.length,
    requests: client.requests,
    provider: client.provider,
  });
});
app.get('/api/xhs-data/tasks', (_req, res) =>
  res.json(all<Record<string, unknown>>('xhs-api-tasks').map(({ result, ...task }) => task)),
);
app.put('/api/xhs-data/tasks', (req, res) => {
  if (active()) {
    res.status(409).json({ error: '请先停止当前任务' });
    return;
  }
  const input = z
    .object({ id: z.string(), taskId: z.string().trim().min(1).max(200) })
    .strict()
    .parse(req.body);
  const task = get<{ id: string; taskId?: string }>('xhs-api-tasks', input.id);
  if (!task || task.taskId) {
    res.status(409).json({ error: '只能补填提交结果不确定的任务编号' });
    return;
  }
  put('xhs-api-tasks', { ...task, taskId: input.taskId, state: 'pending' });
  res.json({ ok: true });
});
app.get('/api/settings', (_req, res) => res.json(settings()));
app.put('/api/settings', (req, res) => {
  const input = z
    .object({
      mode: z.enum(['demo', 'live']),
      platform: z.enum(['xiaohongshu', 'douyin']).optional(),
      connectionType: z.enum(['browser', 'http']).optional(),
      providerUrl: serviceBaseUrl,
      token: z.string().max(10000).optional(),
      cookie: z.string().max(30000).optional(),
      rememberCookie: z.boolean(),
      accountName: z.string().trim().min(1).max(60),
      accountId: z.string().trim().min(1).max(100),
    })
    .parse(req.body);
  if (active()) {
    res.status(409).json({ error: '请在采集结束后修改连接配置' });
    return;
  }
  input.providerUrl = input.providerUrl.replace(/\/+$/, '');
  const changed = input.providerUrl !== configGet('providerUrl').replace(/\/+$/, '');
  if (
    changed &&
    ((input.token === undefined && configGet('token')) ||
      (input.cookie === undefined && hasCookie(input.accountId)))
  ) {
    res
      .status(400)
      .json({ error: '更换适配器地址时，请重新输入或明确清空令牌与 Cookie，避免发送旧凭证' });
    return;
  }
  bindLegacyProviderCredentials();
  for (const k of ['mode', 'providerUrl', 'accountName', 'accountId'] as const)
    configSet(k, input[k]);
  configSet('platform', input.platform || settings().platform || 'xiaohongshu');
  configSet('connectionType', input.connectionType || (input.providerUrl ? 'http' : 'browser'));
  if (input.token !== undefined) {
    configSet('token', input.token ? encrypt(input.token) : '');
    configSet('tokenProvider', JSON.stringify(input.providerUrl));
  }
  if (input.cookie !== undefined) {
    setSessionCookie(input.cookie, input.accountId);
    configSet(
      'cookie:' + input.accountId,
      input.rememberCookie && input.cookie ? encrypt(input.cookie) : '',
    );
  } else {
    const existing = getCookie(input.accountId);
    if (existing) setSessionCookie(existing, input.accountId);
    configSet(
      'cookie:' + input.accountId,
      input.rememberCookie && existing ? encrypt(existing) : '',
    );
  }
  configSet('rememberCookie:' + input.accountId, String(input.rememberCookie));
  put('accounts', {
    ...get<Account>('accounts', input.accountId),
    id: input.accountId,
    name: input.accountName,
    createdAt: get<Account>('accounts', input.accountId)?.createdAt || new Date().toISOString(),
  });
  res.json(settings());
});
app.get('/api/accounts', (_req, res) => res.json(accounts()));
app.post('/api/accounts', (req, res) => {
  const a = z
    .object({
      id: z.string().trim().min(1).max(100),
      name: z.string().trim().min(1).max(60),
      platform: z.enum(['xiaohongshu', 'douyin']).default('xiaohongshu'),
      cookie: z.string().max(30000).default(''),
      rememberCookie: z.boolean().default(false),
    })
    .parse(req.body);
  if (get('accounts', a.id)) {
    res.status(409).json({ error: '该账号 ID 已存在' });
    return;
  }
  put('accounts', {
    id: a.id,
    name: a.name,
    platform: a.platform,
    connectionType: 'http',
    createdAt: new Date().toISOString(),
  });
  setSessionCookie(a.cookie, a.id);
  configSet('cookie:' + a.id, a.rememberCookie && a.cookie ? encrypt(a.cookie) : '');
  configSet('rememberCookie:' + a.id, String(a.rememberCookie));
  res.status(201).json(accounts().find((x) => x.id === a.id));
});
app.delete('/api/accounts/:id', (req, res) => {
  const id = String(req.params.id);
  if (accounts().length <= 1) {
    res.status(400).json({ error: '至少保留一个账号' });
    return;
  }
  if (active()) {
    res.status(409).json({ error: '请在任务结束后删除账号' });
    return;
  }
  remove('accounts', id);
  setSessionCookie('', id);
  configSet('cookie:' + id, '');
  configSet('rememberCookie:' + id, '');
  if (settings().accountId === id) {
    const a = accounts()[0];
    configSet('accountId', a.id);
    configSet('accountName', a.name);
  }
  res.json({ ok: true });
});
app.post('/api/settings/test', async (_req, res) => {
  if (douyinUsesApi()) {
    res.status(400).json({ error: '请使用抖音数据源面板中的测试按钮' });
    return;
  }
  if (douyinProvider() === 'browser') {
    const c = await browserCall<{ status: string }>('/status', { platform: 'douyin' });
    res.json({ ok: c.status === 'ready', ...c });
    return;
  }
  res.json(await providerCall('/health', {}, schemas.health));
});
const platformEnum = z.enum(['xiaohongshu', 'douyin']);
app.use('/api/platforms/:platform', (req, res, next) => {
  if (req.params.platform === 'xiaohongshu') {
    res
      .status(410)
      .json({ error: '小红书已关闭浏览器连接，请在小红书 API 数据源面板配置 TikHub / RedFox' });
    return;
  }
  next();
});
app.get('/api/protection', (_req, res) =>
  res.json({
    platforms: Object.fromEntries(
      ['xiaohongshu', 'douyin'].map((p) => [p, protectionView(platformEnum.parse(p))]),
    ),
  }),
);
app.put('/api/protection/:platform', (req, res) => {
  const platform = platformEnum.parse(req.params.platform);
  if (active()) {
    res.status(409).json({ error: '请先暂停正在执行的任务，再修改采集额度与间隔' });
    return;
  }
  saveCollectionPolicy(platform, req.body);
  res.json(protectionView(platform));
});
app.post('/api/platforms/:platform/resume', async (req, res) => {
  const platform = platformEnum.parse(req.params.platform);
  if (platform !== 'xiaohongshu' && douyinProvider() === 'browser') {
    const state = await browserCall<{
      state: { status: string };
      pages: { text: string; frames: { text: string; visible?: boolean }[] }[];
    }>('/inspect', { platform });
    if (
      state.state.status !== 'ready' ||
      state.pages.some(
        (p) =>
          /请完成验证|请完成下列验证/.test(p.text) ||
          p.frames.some(
            (f) => f.visible !== false && /请完成验证|请完成下列验证|按住左边按钮/.test(f.text),
          ),
      )
    ) {
      res.status(409).json({ error: '官方登录或验证尚未完成，请先处理平台窗口中的提示' });
      return;
    }
  }
  resumePlatform(platform);
  res.json({ ok: true });
});
app.get('/api/platforms', async (_req, res) => res.json(await browserCall('/connections')));
app.post('/api/platforms/:platform/login', async (req, res) =>
  res.json(await browserCall('/login', { platform: platformEnum.parse(req.params.platform) })),
);
app.post('/api/platforms/:platform/login-preview', async (req, res) => {
  const platform = platformEnum.parse(req.params.platform);
  const connection = await browserCall<{ status: string; message: string }>('/status', {
    platform,
  });
  if (connection.status === 'ready') {
    res
      .set('Cache-Control', 'no-store')
      .json({ ready: true, message: '当前账号已验证登录，无需扫码' });
    return;
  }
  if (req.body.refresh === true) await browserCall('/refresh', { platform });
  res
    .set('Cache-Control', 'no-store')
    .type('png')
    .send(await browserScreenshot(platform));
});
app.post('/api/platforms/:platform/creator', async (req, res) =>
  res.json(await browserCall('/creator', { platform: platformEnum.parse(req.params.platform) })),
);
app.post('/api/platforms/:platform/network', async (req, res) =>
  res.json(
    await browserCall('/network', {
      platform: platformEnum.parse(req.params.platform),
      mode: z.enum(['system', 'direct']).parse(req.body.mode),
    }),
  ),
);
app.post('/api/platforms/:platform/status', async (req, res) =>
  res.json(await browserCall('/status', { platform: platformEnum.parse(req.params.platform) })),
);
app.post('/api/notes/:id/detail', async (req, res) => {
  const n = get<Note>('notes', String(req.params.id));
  if (!n) {
    res.status(404).json({ error: '作品不存在' });
    return;
  }
  if (n.source === 'live' && (n.platform === 'xiaohongshu' || douyinUsesApi())) {
    const detail = await (n.platform === 'xiaohongshu' ? xhsClient() : douyinClient()).detail(n);
    put('notes', detail);
    res.json(detail);
    return;
  }
  if (n.source === 'demo' || douyinProvider() === 'http') {
    res.json(n);
    return;
  }
  const detail = await browserCall<Note>('/detail', { note: n });
  put('notes', detail);
  res.json(detail);
});
app.all('/api/export/:kind', (req, res) => {
  if (!['GET', 'POST'].includes(req.method)) {
    res.status(405).json({ error: '不支持的请求方法' });
    return;
  }
  const options =
    req.method === 'POST'
      ? z
          .object({
            ids: z.array(z.string()).max(10000),
            format: z.enum(['json', 'csv']).default('json'),
          })
          .parse(req.body)
      : null;
  const format = options?.format || String(req.query.format || 'json');
  const kind = String(req.params.kind);
  if (!['notes', 'comments', 'leads', 'drafts', 'jobs'].includes(kind)) {
    res.status(400).json({ error: '不支持的导出类型' });
    return;
  }
  let items = all<Record<string, unknown>>(kind);
  if (kind === 'leads')
    items = all<Lead>('leads').map((l) => currentLead(l)) as unknown as Record<string, unknown>[];
  const ids =
    options?.ids ||
    String(req.query.ids || '')
      .split(',')
      .filter(Boolean);
  if (options || ids.length) items = items.filter((x) => ids.includes(String(x.id)));
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="openfind-${kind}.${format === 'csv' ? 'csv' : 'json'}"`,
  );
  if (format === 'csv') {
    const keys = [...new Set(items.flatMap((x) => Object.keys(x)))];
    const cell = (x: unknown) => {
      let v = typeof x === 'object' ? JSON.stringify(x) : String(x ?? '');
      if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
      return '"' + v.replace(/"/g, '""') + '"';
    };
    res
      .type('text/csv')
      .send(
        '\uFEFF' +
          [
            keys.map(cell).join(','),
            ...items.map((x) => keys.map((k) => cell(x[k])).join(',')),
          ].join('\r\n'),
      );
  } else res.json(items);
});
app.get('/api/drafts/:id/bundle', async (req, res) => {
  const d = get<Draft>('drafts', String(req.params.id));
  if (!d) {
    res.status(404).json({ error: '草稿不存在' });
    return;
  }
  const zip = new JSZip();
  zip.file('draft.json', JSON.stringify(d, null, 2));
  zip.file('正文.txt', `${d.title}\n\n${d.body}\n\n${d.tags.map((t) => '#' + t).join(' ')}`);
  for (let i = 0; i < d.images.length; i++) {
    const im = d.images[i];
    if (im.startsWith('data:image/'))
      zip.file(
        `images/${i + 1}.${im.includes('image/png') ? 'png' : im.includes('image/webp') ? 'webp' : 'jpg'}`,
        im.split(',')[1],
        { base64: true },
      );
    else if (/^\/assets\/[\w.-]+$/.test(im)) {
      const { readFile } = await import('node:fs/promises');
      zip.file(`images/${i + 1}.${im.split('.').at(-1)}`, await readFile(resolve('public' + im)));
    } else if (/^\/api\/media\/[a-f0-9-]+\.(png|jpe?g|webp)$/.test(im)) {
      const { readFile } = await import('node:fs/promises');
      zip.file(
        `images/${i + 1}.${im.split('.').at(-1)}`,
        await readFile(join(uploads, im.split('/').at(-1)!)),
      );
    } else if (/^https?:\/\//.test(im)) {
      const bytes = await downloadMedia(im, 10 * 1024 * 1024);
      const mime = imageMime(bytes);
      zip.file(
        `images/${i + 1}.${mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg'}`,
        bytes,
      );
    } else throw new Error('草稿包含无法导出的素材，请重新上传后保存');
  }
  if (d.kind === 'video' && d.video && /^\/api\/media\/[a-f0-9-]+\.(mp4|webm|mov)$/.test(d.video)) {
    const { readFile } = await import('node:fs/promises');
    zip.file(
      `video.${d.video.split('.').at(-1)}`,
      await readFile(join(uploads, d.video.split('/').at(-1)!)),
    );
  }
  res
    .type('application/zip')
    .attachment(`openfind-draft-${d.id}.zip`)
    .send(await zip.generateAsync({ type: 'nodebuffer' }));
});
if (existsSync(resolve('dist'))) {
  app.use(express.static(resolve('dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/index.html')));
}
app.use(
  (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof z.ZodError) {
      res
        .status(400)
        .json({ error: error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('；') });
      return;
    }
    const code = (error as { statusCode?: number })?.statusCode;
    res
      .status(code && code >= 400 && code < 600 ? code : 500)
      .json({ error: error instanceof Error ? error.message : '服务器错误' });
  },
);
if (process.env.NODE_ENV !== 'test') {
  app.listen(Number(process.env.PORT || 8791), '127.0.0.1', () =>
    console.log(`OpenFind API → http://127.0.0.1:${process.env.PORT || 8791}`),
  );
}
