import express from 'express';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import multer from 'multer';
import { dataDir } from './store.ts';
import { setTimeout as delay } from 'node:timers/promises';
import JSZip from 'jszip';
import { z } from 'zod';
import { all, get, put, remove, configGet, configSet, encrypt } from './store.ts';
import { demoNotes, demoComments } from './demo.ts';
import { parseIntent, toLead, assessComment, intentScore } from './domain.ts';
import { providerCall, schemas, setSessionCookie, hasCookie, getCookie } from './provider.ts';
import { browserCall } from './platforms/client.ts';
import {
  reservePlatformAction,
  recordPlatformFailure,
  recordPlatformSuccess,
  protectionStatus,
  resumePlatform,
  operationLimits,
  minimumReadInterval,
  ProtectionError,
} from './protection.ts';
import type { Note, Comment, Lead, Draft, Job, Settings, Account } from '../shared/types.ts';
export const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '30mb' }));
app.use('/api', (req, res, next) => {
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
  next();
});
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
    put('jobs', j);
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
  put('jobs', j);
}
const active = () => [...running.keys()].length > 0;
function currentLead(lead: Lead): Lead {
  const c = get<Comment>('comments', lead.commentId);
  const note = get<Note>('notes', lead.noteId);
  const assessment = c
    ? assessComment(c, note)
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
async function runJob(job: Job, input: z.infer<typeof searchSchema>) {
  const abort = new AbortController();
  running.set(job.id, abort);
  const started = Date.now();
  let cursor: string | null = null;
  let readId: string | null = null;
  const seen = new Set<string>();
  try {
    log(
      job,
      'INFO',
      `${job.source === 'demo' ? '演示任务' : '真实任务'}开始：${job.type === 'search' ? input.keyword : job.noteId}`,
    );
    if (job.source === 'live' && !input.forceRefresh) {
      const cached = all<Job>('jobs').find(
        (j) =>
          j.id !== job.id &&
          j.source === 'live' &&
          j.status === 'completed' &&
          j.type === job.type &&
          j.platform === job.platform &&
          j.keyword === job.keyword &&
          j.noteId === job.noteId &&
          j.query?.sort === input.sort &&
          j.query?.noteType === input.noteType &&
          j.count >= input.limit &&
          Date.now() - Date.parse(j.dataFetchedAt || j.finishedAt || '') < 300000 &&
          j.resultIds.every((id) => get(job.type === 'search' ? 'notes' : 'comments', id)),
      );
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
    if (job.type === 'search') {
      sample = (sample as Note[]).filter(
        (n) => input.noteType === 'all' || n.type === input.noteType,
      );
      if (input.sort === 'popular') sample.sort((a, b) => (b as Note).likes - (a as Note).likes);
      if (input.sort === 'latest')
        sample.sort((a, b) => (b as Note).publishedAt.localeCompare((a as Note).publishedAt));
    }
    for (let page = 0; page < 200; page++) {
      abort.signal.throwIfAborted();
      let items: (Note | Comment)[] = [];
      if (job.source === 'demo') {
        await delay(420, undefined, { signal: abort.signal });
        items = sample.slice(page * 12, (page + 1) * 12);
        cursor = (page + 1) * 12 < sample.length ? String(page + 1) : null;
      } else {
        if (page)
          await delay(Math.max(minimumReadInterval, input.interval), undefined, {
            signal: abort.signal,
          });
        reservePlatformAction(input.platform, job.type);
        const result: {
          items: (Omit<Note, 'source'> | Omit<Comment, 'source'>)[];
          nextCursor: string | null;
          readId?: string;
          evidence?: { path: string; filterSelected: string | null; sortType: string | null };
        } =
          settings().connectionType === 'browser'
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
                )
              : await providerCall(
                  '/comments',
                  { noteId: job.noteId, includeReplies: true, cursor, platform: input.platform },
                  schemas.comments,
                  abort.signal,
                );
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
        recordPlatformSuccess(input.platform);
        items = result.items.map((x) => ({ ...x, source: 'live' })) as (Note | Comment)[];
        const next: string | null = result.nextCursor;
        if (next && next === cursor)
          throw new Error('数据服务返回重复分页游标，任务已停止以防无限请求');
        cursor = next;
      }
      abort.signal.throwIfAborted();
      for (const item of items) {
        if (seen.has(item.id)) continue;
        if (input.limit && job.count >= input.limit) break;
        seen.add(item.id);
        put(job.type === 'search' ? 'notes' : 'comments', item);
        job.resultIds.push(item.id);
        job.count++;
      }
      job.pages++;
      if (job.type === 'search' && input.sort === 'latest')
        job.resultIds.sort((a, b) =>
          (get<Note>('notes', b)?.publishedAt || '').localeCompare(
            get<Note>('notes', a)?.publishedAt || '',
          ),
        );
      job.elapsed = Math.round((Date.now() - started) / 1000);
      log(
        job,
        'SUCCESS',
        `${job.type === 'search' ? '作品' : '评论'}第 ${job.pages} 页完成，累计 ${job.count} 条（已去重）`,
      );
      if (!cursor || (input.limit > 0 && job.count >= input.limit)) break;
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
    if (abort.signal.aborted) {
      job.status = 'stopped';
      log(job, 'WARN', '任务已停止，已采集结果保留');
    } else {
      job.status = 'failed';
      job.error = e instanceof Error ? e.message : '任务失败';
      if (job.source === 'live' && !(e instanceof ProtectionError))
        recordPlatformFailure(input.platform, job.error);
      log(job, 'ERROR', job.error);
    }
  } finally {
    if (readId) await browserCall('/close-read', { cursor: readId }).catch(() => {});
    job.elapsed = Math.round((Date.now() - started) / 1000);
    if (job.status === 'completed') {
      job.finishedAt = new Date().toISOString();
      job.dataFetchedAt ||= job.finishedAt;
    }
    put('jobs', job);
    running.delete(job.id);
  }
}
app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'openfind' }));
app.get('/api/state', (_req, res) =>
  res.json({
    accounts: accounts(),
    notes: all<Note>('notes'),
    comments: all<Comment>('comments'),
    leads: all<Lead>('leads').map(currentLead),
    drafts: all<Draft>('drafts'),
    jobs: all<Job>('jobs'),
    settings: settings(),
  }),
);
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
  if (active() || publishing.size) {
    res.status(409).json({ error: '已有采集任务运行，请先停止或等待完成' });
    return;
  }
  if (input.mode === 'live' && settings().connectionType === 'http' && !configGet('providerUrl')) {
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
  void runJob(j, input);
  res.status(201).json(j);
});
app.post('/api/jobs/:id/stop', (req, res) => {
  const controller = running.get(String(req.params.id));
  if (!controller) {
    res.status(409).json({ error: '任务已结束' });
    return;
  }
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
  if (note.source === 'live' && (input.limit === 0 || input.limit > 100)) {
    res.status(400).json({ error: '真实评论采集每次请选择 1–100 条' });
    return;
  }
  if (active() || publishing.size) {
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
  });
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
      const lead = toLead(c, get<Note>('notes', c.noteId));
      if (lead.assessment?.stage === 'restricted') {
        restricted++;
        continue;
      }
      if (!get('leads', lead.id)) {
        put('leads', lead);
        added++;
      }
    }
  }
  res.json({ added, restricted });
});
app.patch('/api/leads/:id', (req, res) => {
  const lead = get<Lead>('leads', String(req.params.id));
  if (!lead) {
    res.status(404).json({ error: '客户不存在' });
    return;
  }
  const patch = z
    .object({
      status: z.enum(['new', 'contacted', 'qualified', 'archived']).optional(),
      memo: z.string().max(3000).optional(),
      outreach: z.string().max(3000).optional(),
    })
    .parse(req.body);
  put('leads', { ...lead, ...patch });
  res.json({ ...lead, ...patch });
});
const image = z
  .string()
  .max(12_000_000)
  .refine(
    (s) =>
      /^\/assets\/[\w.-]+$/.test(s) ||
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
});
app.post('/api/drafts', (req, res) => {
  const input = draftSchema.parse(req.body);
  let id = req.body.id ? z.string().parse(req.body.id) : randomUUID();
  const previous = get<Draft>('drafts', id);
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
  const source = get<Note>('notes', input.noteId);
  const d: Draft = {
    ...input,
    platform: input.platform || source?.platform || 'xiaohongshu',
    id,
    status: 'draft',
    createdAt: previous?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  put('drafts', d);
  res.status(201).json(d);
});
const publishing = new Set<string>();
app.post('/api/drafts/:id/publish', async (req, res) => {
  const id = String(req.params.id);
  const d = get<Draft>('drafts', id);
  if (!d) {
    res.status(404).json({ error: '请先保存草稿' });
    return;
  }
  if (active()) {
    res.status(409).json({ error: '请先等待当前采集任务结束，再提交发布' });
    return;
  }
  if (publishing.has(id)) {
    res.status(409).json({ error: '该草稿正在发布，请勿重复提交' });
    return;
  }
  if (d.status !== 'draft') {
    res.status(409).json({ error: '草稿已发布，请另存或修改后重新提交' });
    return;
  }
  if (!get<Account>('accounts', d.accountId)) {
    res.status(400).json({ error: '发布账号与当前连接不一致，请重新选择账号' });
    return;
  }
  publishing.add(id);
  try {
    const note = get<Note>('notes', d.noteId);
    const demo = note?.source === 'demo';
    if (!demo && settings().mode !== 'live') {
      res.status(400).json({ error: '真实发布需要在连接设置中切换真实模式' });
      return;
    }
    if (demo) {
      d.status = 'demo_published';
      d.receipt = `demo-receipt-${randomUUID()}`;
    } else {
      reservePlatformAction(d.platform || 'xiaohongshu', 'publish');
      if (settings().connectionType === 'browser') {
        const receipt = await browserCall<{ id: string; url: string }>('/publish', d);
        d.status = 'published';
        d.receipt = receipt.url;
      } else {
        const health = await providerCall(
          '/health',
          { accountId: d.accountId, platform: d.platform },
          schemas.health,
        );
        if (!health.ok) throw new Error('账号预检失败');
        if (!health.accountId || health.accountId !== d.accountId)
          throw new Error('账号预检失败：数据服务当前账号与发布账号不一致');
        const receipt = await providerCall(
          '/publish',
          { ...d, idempotencyKey: d.id },
          schemas.publish,
        );
        d.status = 'published';
        d.receipt = receipt.url;
      }
      recordPlatformSuccess(d.platform || 'xiaohongshu');
    }
    d.updatedAt = new Date().toISOString();
    put('drafts', d);
    res.json(d);
  } catch (error) {
    if (!(error instanceof ProtectionError))
      recordPlatformFailure(
        d.platform || 'xiaohongshu',
        error instanceof Error ? error.message : '发布失败',
      );
    throw error;
  } finally {
    publishing.delete(id);
  }
});
app.post('/api/drafts/:id/reconcile', async (req, res) => {
  const d = get<Draft>('drafts', String(req.params.id));
  if (!d) {
    res.status(404).json({ error: '草稿不存在' });
    return;
  }
  if (publishing.has(d.id)) {
    res.status(409).json({ error: '发布正在进行，请稍后核对' });
    return;
  }
  const result = await browserCall<{ status: string; receipt?: { url: string }; message?: string }>(
    '/reconcile-publish',
    d,
  );
  if (result.status === 'published' && result.receipt) {
    d.status = 'published';
    d.receipt = result.receipt.url;
    d.updatedAt = new Date().toISOString();
    put('drafts', d);
  }
  res.json(result);
});
app.post('/api/drafts/:id/prepare', async (req, res) => {
  const d = get<Draft>('drafts', String(req.params.id));
  if (!d) {
    res.status(404).json({ error: '草稿不存在' });
    return;
  }
  if (d.status !== 'draft') {
    res.status(409).json({ error: '作品已经发布' });
    return;
  }
  reservePlatformAction(d.platform || 'xiaohongshu', 'prepare');
  res.json(await browserCall('/prepare-publish', d));
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
  if (!/^[a-f0-9-]+\.(mp4|webm|mov)$/.test(name)) {
    res.status(400).json({ error: '无效素材' });
    return;
  }
  res.sendFile(join(uploads, name));
});
app.delete('/api/drafts/:id', (req, res) => {
  remove('drafts', String(req.params.id));
  res.json({ ok: true });
});
app.get('/api/settings', (_req, res) => res.json(settings()));
app.put('/api/settings', (req, res) => {
  const input = z
    .object({
      mode: z.enum(['demo', 'live']),
      platform: z.enum(['xiaohongshu', 'douyin']).optional(),
      connectionType: z.enum(['browser', 'http']).optional(),
      providerUrl: z.union([z.literal(''), z.url().refine((s) => /^https?:/.test(s))]),
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
  for (const k of ['mode', 'providerUrl', 'accountName', 'accountId'] as const)
    configSet(k, input[k]);
  configSet('platform', input.platform || settings().platform || 'xiaohongshu');
  configSet('connectionType', input.connectionType || (input.providerUrl ? 'http' : 'browser'));
  if (input.token !== undefined) configSet('token', input.token ? encrypt(input.token) : '');
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
  if (settings().connectionType === 'browser') {
    const c = await browserCall<{ status: string }>('/status', { platform: settings().platform });
    res.json({ ok: c.status === 'ready', ...c });
    return;
  }
  res.json(await providerCall('/health', {}, schemas.health));
});
const platformEnum = z.enum(['xiaohongshu', 'douyin']);
app.get('/api/protection', (_req, res) =>
  res.json({
    platforms: Object.fromEntries(
      ['xiaohongshu', 'douyin'].map((p) => [p, protectionStatus(platformEnum.parse(p))]),
    ),
    limits: operationLimits,
    minimumReadInterval,
  }),
);
app.post('/api/platforms/:platform/resume', async (req, res) => {
  const platform = platformEnum.parse(req.params.platform);
  if (settings().connectionType === 'browser') {
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
  if (n.source === 'demo' || settings().connectionType === 'http') {
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
    items = all<Lead>('leads').map(currentLead) as unknown as Record<string, unknown>[];
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
      zip.file(`images/${i + 1}.svg`, await readFile(resolve('public' + im)));
    } else zip.file(`images/${i + 1}-url.txt`, im);
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
    res.status(500).json({ error: error instanceof Error ? error.message : '服务器错误' });
  },
);
if (process.env.NODE_ENV !== 'test') {
  app.listen(Number(process.env.PORT || 8791), '127.0.0.1', () =>
    console.log(`OpenFind API → http://127.0.0.1:${process.env.PORT || 8791}`),
  );
}
