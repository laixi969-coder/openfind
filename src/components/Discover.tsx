import { useState, useMemo, useEffect, useRef, type ReactNode } from 'react';
import {
  Search,
  ArrowRight,
  Sparkles,
  ChevronDown,
  ChevronRight,
  SlidersHorizontal,
  Download,
  LayoutGrid,
  Terminal,
  Square,
  Play,
  Eye,
  EyeOff,
  ShieldCheck,
  Heart,
  MessageCircle,
  Bookmark,
  Copy,
  Users,
  Check,
  ArrowUpRight,
  Flame,
  Filter,
  Image as ImageIcon,
  Clock,
  RotateCcw,
  FileJson,
  ArrowDownWideNarrow,
  X,
} from 'lucide-react';
import JSZip from 'jszip';
import type { Note, Job, SearchInput, Platform } from '../../shared/types';
import { api, shortNum, saveFile, exportUrl, safeUrl, downloadExport } from '../api';
import { useWorkspace } from '../context';
import { Empty, Busy, SourceTag, PageHeading, Modal, ExternalLink } from './ui';
import { acquisitionPriority } from '../../server/domain';
export function Discover() {
  const { data, notify, refresh, navigate, clone, collect } = useWorkspace();
  const params = new URLSearchParams(location.search);
  const requestedPlatform = params.get('platform');
  const initialJob =
    data.jobs.find((j) => j.id === params.get('job')) ||
    data.jobs.find(
      (j) =>
        j.type === 'search' &&
        (j.platform || 'xiaohongshu') ===
          (requestedPlatform || data.settings.platform || 'xiaohongshu'),
    );
  const [platform, setPlatform] = useState<Platform>(
    requestedPlatform === 'douyin' || requestedPlatform === 'xiaohongshu'
      ? requestedPlatform
      : data.settings.platform || 'xiaohongshu',
  );
  const [keyword, setKeyword] = useState(initialJob?.keyword || '家居'),
    [limit, setLimit] = useState(20),
    [sort, setSort] = useState<SearchInput['sort']>(initialJob?.query?.sort || 'latest'),
    [noteType, setNoteType] = useState<SearchInput['noteType']>(
      initialJob?.query?.noteType || 'all',
    ),
    [interval, setInterval] = useState(data.settings.mode === 'live' ? 15000 : 1000),
    [prompt, setPrompt] = useState(''),
    [planning, setPlanning] = useState(false),
    [busy, setBusy] = useState(false),
    [query, setQuery] = useState(''),
    [view, setView] = useState<'cards' | 'logs'>('cards'),
    [filter, setFilter] = useState('all'),
    [resultSort, setResultSort] = useState(
      data.settings.mode === 'live' ? 'acquisition' : 'default',
    ),
    [selected, setSelected] = useState<string[]>([]),
    [advanced, setAdvanced] = useState(false),
    [forceRefresh, setForceRefresh] = useState(false),
    [detail, setDetail] = useState<Note | null>(null),
    [zipBusy, setZipBusy] = useState(false),
    [jobId, setJobId] = useState(params.get('job') || ''),
    [planText, setPlanText] = useState('');
  const searches = data.jobs.filter(
    (j) => j.type === 'search' && (j.platform || 'xiaohongshu') === platform,
  );
  const job = searches.find((j) => j.id === jobId) || searches[0];
  const running = data.jobs.some((j) => j.status === 'running');
  const notes = useMemo(() => {
    const byId = new Map(data.notes.map((n) => [n.id, n]));
    return (job?.resultIds || []).map((id) => byId.get(id)).filter((n): n is Note => !!n);
  }, [data.notes, job]);
  const priorities = useMemo(
    () => new Map(notes.map((n) => [n.id, acquisitionPriority(n, data.comments)])),
    [notes, data.comments],
  );
  const shown = useMemo(() => {
    let n = notes.filter(
      (n) =>
        (!query ||
          [n.title, n.author, n.id, ...n.tags]
            .join(' ')
            .toLowerCase()
            .includes(query.toLowerCase())) &&
        (filter === 'all' ||
          (filter === 'viral' && n.likes >= 5000) ||
          (filter === 'image' && n.type === 'image') ||
          (filter === 'video' && n.type === 'video') ||
          (filter === 'selected' && selected.includes(n.id))),
    );
    if (resultSort === 'likes') n = n.sort((a, b) => b.likes - a.likes);
    if (resultSort === 'comments') n = n.sort((a, b) => b.comments - a.comments);
    if (resultSort === 'saves') n = n.sort((a, b) => b.saves - a.saves);
    if (resultSort === 'latest') n = n.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    if (resultSort === 'acquisition')
      n = n.sort((a, b) => {
        const pa = priorities.get(a.id)!,
          pb = priorities.get(b.id)!;
        return (
          pb.tier - pa.tier || pb.weight - pa.weight || b.publishedAt.localeCompare(a.publishedAt)
        );
      });
    return n;
  }, [notes, query, filter, resultSort, selected, priorities]);
  async function start(overrides: Partial<SearchInput> = {}) {
    setBusy(true);
    try {
      const input = {
        keyword,
        platform,
        limit,
        sort,
        noteType,
        interval,
        mode: data.settings.mode,
        forceRefresh,
        ...overrides,
      };
      const j = await api<Job>('/jobs', input);
      setJobId(j.id);
      history.replaceState(null, '', `?platform=${input.platform}&job=${j.id}#discover`);
      setSelected([]);
      setQuery('');
      setFilter('all');
      setView('cards');
      await refresh();
      notify('搜索任务已开始');
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  async function agentRun() {
    if (!prompt.trim()) return;
    setPlanning(true);
    try {
      const p = await api<{
        keyword: string;
        limit: number;
        sort: SearchInput['sort'];
        noteType: SearchInput['noteType'];
        explanation: string;
      }>('/intent', { text: prompt });
      setKeyword(p.keyword);
      setLimit(p.limit);
      setSort(p.sort);
      setNoteType(p.noteType);
      setPlanText(p.explanation);
      await start(p);
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setPlanning(false);
    }
  }
  async function stop() {
    if (!job) return;
    try {
      await api(`/jobs/${job.id}/stop`, {});
      await refresh();
      notify('任务已停止，结果已保留');
    } catch (e) {
      notify((e as Error).message, true);
    }
  }
  function toggle(id: string) {
    setSelected((v) => (v.includes(id) ? v.filter((x) => x !== id) : [...v, id]));
  }
  async function downloadImages() {
    const items = notes.filter((n) => selected.includes(n.id) && n.images.length);
    if (!items.length) {
      notify('请先选择至少一篇图文作品', true);
      return;
    }
    setZipBusy(true);
    try {
      const zip = new JSZip();
      zip.file('notes.json', JSON.stringify(items, null, 2));
      for (const [ni, n] of items.entries()) {
        for (const [i, url] of n.images.entries()) {
          const r = await fetch(url);
          if (!r.ok) throw new Error(`图片下载失败：${n.title}`);
          const b = await r.blob();
          const extension = b.type.includes('svg')
            ? 'svg'
            : b.type.includes('png')
              ? 'png'
              : b.type.includes('webp')
                ? 'webp'
                : 'jpg';
          zip.file(`${ni + 1}-${n.id.replace(/[^\w-]/g, '_')}/${i + 1}.${extension}`, b);
        }
        zip.file(`${ni + 1}-${n.id.replace(/[^\w-]/g, '_')}/正文.txt`, n.title + '\n\n' + n.body);
      }
      saveFile(await zip.generateAsync({ type: 'blob' }), 'openfind-图文素材.zip');
      notify(`已打包 ${items.length} 篇作品的图片与正文`);
    } catch (e) {
      notify((e as Error).message + '；远程图片需允许跨域下载', true);
    } finally {
      setZipBusy(false);
    }
  }
  const steps = [
    ['理解任务', planText ? '已生成执行计划' : '输入需求，明确方向'],
    ['搜索作品', job?.status === 'running' ? '正在采集…' : `${job?.count || 0} 篇作品已就绪`],
    ['筛选结果', '发现值得借鉴的内容'],
    ['开始行动', '创作内容 / 采集客户'],
  ];
  return (
    <>
      <PageHeading
        eyebrow="DISCOVER & CONNECT"
        title="让好内容，带来新客户。"
        description="找到行业爆款，发现潜在需求，把每一次灵感变成增长机会。"
        action={
          <span className="platform-status">
            <span className="xhs-icon">{platform === 'douyin' ? '抖音' : '小红书'}</span>
            {platform === 'douyin' ? '抖音' : '小红书'}
            <span className="status-mini">
              {data.settings.mode === 'demo' ? '演示模式' : '真实模式'}
            </span>
          </span>
        }
      />
      <section className="agent-panel">
        <div className="agent-label">
          <span className="sparkle-box">
            <Sparkles size={18} />
          </span>
          <div>
            <b>一句话，开始你的获客任务</b>
            <span>告诉 OpenFind 你想找什么，剩下的交给工作台。</span>
          </div>
          <span className="agent-badge">任务助手</span>
        </div>
        <form
          className="agent-form"
          onSubmit={(e) => {
            e.preventDefault();
            void agentRun();
          }}
        >
          <input
            id="agent-input"
            placeholder="例如：帮我找到 20 篇家居行业的高互动作品"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            maxLength={2000}
          />
          <button className="btn primary" disabled={!prompt.trim() || planning || running}>
            {planning ? (
              <Busy text="理解中" />
            ) : (
              <>
                开始任务
                <ArrowRight size={16} />
              </>
            )}
          </button>
        </form>
        <div className="prompt-examples">
          <span>试试这样说</span>
          {['找 20 篇家居高互动作品', '搜索医美作品并展示结果', '找 30 篇最新装修笔记'].map((t) => (
            <button key={t} onClick={() => setPrompt(t)}>
              {t}
              <ArrowUpRight size={11} />
            </button>
          ))}
        </div>
        {planText && (
          <div className="plan-text">
            <Check size={13} />
            {planText}
            <span>规则解析器 · 可在下方调整</span>
          </div>
        )}
      </section>
      <div className="workflow-steps">
        {steps.map((s, i) => (
          <div
            className={`workflow-step ${i === 1 && job?.status === 'running' ? 'current' : ''} ${i < 2 && job?.status === 'completed' ? 'done' : ''}`}
            key={s[0]}
          >
            <span className="step-number">
              {i < 2 && job?.status === 'completed' ? (
                <Check size={13} />
              ) : (
                String(i + 1).padStart(2, '0')
              )}
            </span>
            <div>
              <b>{s[0]}</b>
              <small>{s[1]}</small>
            </div>
            {i < 3 && <ChevronRight size={14} className="step-arrow" />}
          </div>
        ))}
      </div>
      <div className="discover-layout">
        <section className="search-panel panel">
          <div className="section-title">
            <SlidersHorizontal size={17} />
            <h2>采集设置</h2>
            <span>01</span>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void start();
            }}
          >
            <div className="field-hint">组合获客：先搜近期作品，再按评论需求选采集对象。</div>
            <div className="prompt-examples" aria-label="获客搜索策略">
              {(
                [
                  ['latest', '近期需求（主线）', 20],
                  ['general', '相关作品（补充）', 20],
                  ['popular', '高互动（少量探索）', 10],
                ] as const
              ).map(([value, label, count]) => (
                <button
                  type="button"
                  key={value}
                  onClick={() => {
                    setSort(value);
                    setLimit(count);
                    setResultSort('acquisition');
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <label className="field-label" htmlFor="collection">
              采集功能
            </label>
            <select
              id="collection"
              value="search"
              onChange={(e) => {
                if (e.target.value === 'comments') navigate('comments');
              }}
            >
              <option value="search">关键词搜索笔记</option>
              <option value="comments">作品评论与楼中楼</option>
            </select>
            <label className="field-label" htmlFor="keyword">
              搜索关键词<span>必填</span>
            </label>
            <div className="input-with-icon">
              <Search size={15} />
              <input
                id="keyword"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="输入行业、产品或话题"
                maxLength={100}
                required
              />
            </div>
            <div className="field-hint">从一个关键词开始，发现你的内容机会。</div>
            <label className="field-label" htmlFor="search-platform">
              数据平台
            </label>
            <select
              id="search-platform"
              value={platform}
              onChange={(e) => {
                setPlatform(e.target.value as Platform);
                setSelected([]);
                setJobId('');
              }}
            >
              <option value="xiaohongshu">小红书 · 图文与视频</option>
              <option value="douyin">抖音 · 视频与图文</option>
            </select>
            <div className="field-row">
              <div>
                <label className="field-label" htmlFor="limit">
                  结果上限
                </label>
                <input
                  id="limit"
                  type="number"
                  min={data.settings.mode === 'live' ? 1 : 0}
                  max={data.settings.mode === 'live' ? 100 : 500}
                  value={limit}
                  onChange={(e) => setLimit(Number(e.target.value))}
                />
              </div>
              <div>
                <label className="field-label" htmlFor="sort">
                  搜索排序
                </label>
                <select
                  id="sort"
                  value={sort}
                  onChange={(e) => setSort(e.target.value as SearchInput['sort'])}
                >
                  <option value="general">综合排序</option>
                  <option value="popular">最热优先</option>
                  <option value="latest">最新发布</option>
                </select>
              </div>
            </div>
            <div className="field-hint">
              {data.settings.mode === 'live'
                ? '真实采集每次1–100条，批次至少间隔15秒。'
                : '0 表示持续翻页，直到数据源返回结束。'}
            </div>
            <div className="field-row">
              <div>
                <label className="field-label" htmlFor="note-type">
                  笔记类型
                </label>
                <select
                  id="note-type"
                  value={noteType}
                  onChange={(e) => setNoteType(e.target.value as SearchInput['noteType'])}
                >
                  <option value="all">全部类型</option>
                  <option value="image">图文笔记</option>
                  <option value="video">视频笔记</option>
                </select>
              </div>
              <div>
                <label className="field-label" htmlFor="interval">
                  请求间隔
                </label>
                <select
                  id="interval"
                  value={interval}
                  onChange={(e) => setInterval(Number(e.target.value))}
                >
                  {data.settings.mode === 'live' && (
                    <>
                      <option value="15000">15 秒</option>
                      <option value="30000">30 秒</option>
                      <option value="60000">60 秒</option>
                    </>
                  )}
                  <option value="1000" disabled={data.settings.mode === 'live'}>
                    1000 ms
                  </option>
                  <option value="2000" disabled={data.settings.mode === 'live'}>
                    2000 ms
                  </option>
                  <option value="3000" disabled={data.settings.mode === 'live'}>
                    3000 ms
                  </option>
                  <option value="500" disabled={data.settings.mode === 'live'}>
                    500 ms
                  </option>
                </select>
              </div>
            </div>
            <button
              type="button"
              className="advanced-toggle"
              onClick={() => setAdvanced((v) => !v)}
            >
              <ShieldCheck size={14} />
              账号与 Cookie 设置
              <ChevronDown size={14} className={advanced ? 'rotate' : ''} />
            </button>
            {advanced && (
              <div className="credential-box">
                <p>Cookie 仅在服务端使用。勾选记住后，通过 AES-256-GCM 加密保存在本机。</p>
                <button type="button" className="text-btn" onClick={() => navigate('settings')}>
                  配置账号与连接
                  <ArrowUpRight size={13} />
                </button>
                <details>
                  <summary>Cookie 在哪里复制？</summary>
                  <p>
                    登录你自己的平台账号，在开发者工具的 Network 中查看请求头
                    Cookie。请仅在连接设置内填写，不要放入任务描述。
                  </p>
                </details>
              </div>
            )}
            <label className="field-label">
              <input
                type="checkbox"
                checked={forceRefresh}
                onChange={(e) => setForceRefresh(e.target.checked)}
              />
              刷新平台数据（默认复用5分钟内已有结果）
            </label>
            <div className="search-actions">
              <button
                type="submit"
                className="btn primary"
                disabled={busy || running || !keyword.trim()}
              >
                {busy ? (
                  <Busy />
                ) : (
                  <>
                    <Search size={16} />
                    开始搜索
                  </>
                )}
              </button>
              <button
                type="button"
                className="stop-btn"
                disabled={job?.status !== 'running'}
                onClick={() => void stop()}
                aria-label="停止搜索"
              >
                <Square size={14} />
              </button>
            </div>
            {job?.status === 'running' ? (
              <div className="task-status">
                <span className="dot" />
                正在采集 · 已获取 {job.count} 条
              </div>
            ) : job?.status === 'failed' ? (
              <div className="task-status failure">{job.error}</div>
            ) : (
              <div className="field-hint centered">
                {data.settings.mode === 'demo'
                  ? '当前使用本地演示数据，可切换真实连接'
                  : '结果自动保存至本机，可随时停止'}
              </div>
            )}
          </form>
          <div className="search-tip">
            <div>
              <span>一点小提示</span>
              <Sparkles size={14} />
            </div>
            <p>越具体的关键词，越容易找到真正有需求的人。</p>
            <button
              onClick={() => {
                setKeyword('装修');
                setPrompt('找到 20 篇装修高互动作品');
              }}
            >
              试试「装修」
              <ArrowRight size={12} />
            </button>
          </div>
        </section>
        <section className="results-panel">
          <div className="result-stats">
            <div>
              <span>
                发现作品 <ImageIcon size={14} />
              </span>
              <strong>
                {notes.length}
                <small>篇</small>
              </strong>
              <em>每个灵感，都有价值</em>
            </div>
            <div>
              <span>
                高互动作品 <Flame size={14} />
              </span>
              <strong>
                {notes.filter((n) => n.likes >= 5000).length}
                <small>篇</small>
              </strong>
              <em>5000+ 点赞的潜力内容</em>
            </div>
            <div>
              <span>
                当前任务 <Clock size={14} />
              </span>
              <strong className="status-text">
                {job?.status === 'running'
                  ? '采集中'
                  : job?.status === 'failed'
                    ? '任务失败'
                    : job?.status === 'stopped'
                      ? '已停止'
                      : '已完成'}
                <i className={`dot ${job?.status === 'failed' ? 'red' : ''}`} />
              </strong>
              <em>
                {job?.pages || 0} 页 · 耗时 {job?.elapsed || 0} 秒
              </em>
            </div>
          </div>
          <div className="results-box panel">
            <div className="results-heading">
              <div>
                <h2>
                  发现的作品 <span>{notes.length}</span>
                </h2>
                <p>从内容里，找到下一次增长的可能。</p>
              </div>
              <div className="results-export">
                <a
                  className="btn small"
                  href={exportUrl(
                    'notes',
                    'json',
                    notes.map((n) => n.id),
                  )}
                  onClick={(e) => {
                    if (!notes.length) {
                      e.preventDefault();
                      notify('当前没有可导出的作品', true);
                    } else {
                      e.preventDefault();
                      void downloadExport(
                        'notes',
                        'json',
                        notes.map((n) => n.id),
                      ).catch((e) => notify((e as Error).message, true));
                    }
                  }}
                >
                  <FileJson size={14} />
                  导出 JSON
                </a>
                <button
                  className="icon-btn"
                  title="查看任务记录"
                  onClick={() => navigate('history')}
                >
                  <HistoryIcon />
                </button>
              </div>
            </div>
            <div className="results-toolbar">
              <div className="filter-tabs">
                {[
                  ['all', '全部作品'],
                  ['viral', '高互动'],
                  ['image', '图文'],
                  ['video', '视频'],
                ].map(([id, t]) => (
                  <button
                    key={id}
                    onClick={() => setFilter(id)}
                    className={filter === id ? 'active' : ''}
                  >
                    {id === 'viral' && <Flame size={13} />} {t}
                  </button>
                ))}
              </div>
              <div className="display-switch">
                <button
                  className={view === 'cards' ? 'active' : ''}
                  aria-label="卡片视图"
                  onClick={() => setView('cards')}
                >
                  <LayoutGrid size={15} />
                </button>
                <button
                  className={view === 'logs' ? 'active' : ''}
                  aria-label="日志视图"
                  onClick={() => setView('logs')}
                >
                  <Terminal size={15} />
                </button>
              </div>
            </div>
            <div className="result-filters">
              <div className="input-with-icon">
                <Search size={14} />
                <input
                  aria-label="筛选作品"
                  placeholder="筛选标题、作者或笔记 ID"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                {query && (
                  <button className="icon-btn" aria-label="清空筛选" onClick={() => setQuery('')}>
                    <X size={13} />
                  </button>
                )}
              </div>
              <div className="sort-select">
                <ArrowDownWideNarrow size={14} />
                <select
                  aria-label="结果排序"
                  value={resultSort}
                  onChange={(e) => setResultSort(e.target.value)}
                >
                  <option value="acquisition">获客优先（需求＋时效）</option>
                  <option value="default">默认排序</option>
                  <option value="likes">点赞最多</option>
                  <option value="comments">评论最多</option>
                  <option value="saves">收藏最多</option>
                  <option value="latest">最新发布</option>
                </select>
              </div>
            </div>
            {resultSort === 'acquisition' && (
              <p className="field-hint" style={{ padding: '0 16px' }}>
                下方按本机已读评论的需求与时效重排；无评论样本时使用作品日期和评论数初筛，点赞量不决定客户意向。
              </p>
            )}
            <div className="live-bar">
              <span>
                <i /> LIVE
              </span>
              <b>
                {job?.status === 'running'
                  ? 'SEARCHING'
                  : job?.status === 'stopped'
                    ? 'STOPPED'
                    : job?.status === 'failed'
                      ? 'SEARCH FAILED'
                      : job
                        ? 'SEARCH COMPLETE'
                        : 'READY'}
                <span>· {notes.length} NOTES</span>
              </b>
              <SourceTag source={job?.source || 'demo'} />
              <span className="live-bar-right">{view === 'cards' ? 'CARD VIEW' : 'EVENT LOG'}</span>
            </div>
            {job?.searchEvidence && (
              <p className="field-hint" style={{ padding: '0 16px' }}>
                已核对平台排序：
                {job.searchEvidence.sort === 'latest'
                  ? '最新发布'
                  : job.searchEvidence.sort === 'popular'
                    ? '最多点赞'
                    : '综合'}{' '}
                · 作品日期见卡片；评论线索按评论自身日期判断。
              </p>
            )}
            {view === 'cards' ? (
              shown.length ? (
                <>
                  <NoteMasonry>
                    {shown.map((n) => (
                      <NoteCard
                        key={n.id}
                        note={n}
                        priorityReason={
                          resultSort === 'acquisition' ? priorities.get(n.id)?.reason : undefined
                        }
                        selected={selected.includes(n.id)}
                        toggle={() => toggle(n.id)}
                        onDetail={() => setDetail(n)}
                        onClone={() => {
                          void (async () => {
                            try {
                              const full =
                                n.source === 'live' && n.detailState === 'summary'
                                  ? await api<Note>(
                                      '/notes/' + encodeURIComponent(n.id) + '/detail',
                                      {},
                                    )
                                  : n;
                              await refresh();
                              clone(full);
                            } catch (e) {
                              notify((e as Error).message, true);
                            }
                          })();
                        }}
                        onCollect={() => void collect(n)}
                      />
                    ))}
                  </NoteMasonry>
                  <div className="result-bottom">
                    <span>
                      已展示 {shown.length} / {notes.length} 篇作品
                    </span>
                    <span>
                      <Check size={12} />
                      结果已保存在本机
                    </span>
                  </div>
                </>
              ) : (
                <Empty
                  title={job?.status === 'running' ? '正在发现好内容' : '没有符合条件的作品'}
                  sub={
                    job?.status === 'running'
                      ? '结果会随着采集自动出现在这里。'
                      : '调整关键词、搜索范围或筛选条件后再试试。'
                  }
                  action={
                    <button
                      className="btn"
                      onClick={() => {
                        setQuery('');
                        setFilter('all');
                      }}
                    >
                      重置筛选
                    </button>
                  }
                />
              )
            ) : (
              <JobLog job={job} />
            )}
          </div>
        </section>
      </div>
      {selected.length > 0 && (
        <div className="selection-bar">
          <span className="selected-count">
            <Check size={14} />
            已选 {selected.length} 篇
          </span>
          <button
            onClick={() =>
              setSelected(
                shown.filter((n) => n.type === 'image' && n.images.length).map((n) => n.id),
              )
            }
          >
            全选图文
          </button>
          <button onClick={() => setSelected([])}>清空选择</button>
          <button
            className="btn primary small"
            disabled={zipBusy}
            onClick={() => void downloadImages()}
          >
            {zipBusy ? (
              <Busy text="打包中" />
            ) : (
              <>
                <Download size={14} />
                下载图片包
              </>
            )}
          </button>
        </div>
      )}
      <div className="batch-tools">
        <button
          onClick={() => {
            const ids = shown.filter((n) => n.type === 'image' && n.images.length).map((n) => n.id);
            setSelected(ids);
            if (!ids.length) notify('当前没有可选择的图文作品', true);
          }}
        >
          <Check size={14} />
          全选图文
        </button>
        <span>选中作品，批量带走你的灵感</span>
      </div>
      {detail && (
        <Modal title="作品详情" sub="查看内容、互动数据与来源" onClose={() => setDetail(null)} wide>
          <div className="note-detail">
            <img src={detail.cover} alt={detail.title} />
            <div>
              <SourceTag source={detail.source} />
              <h2>{detail.title}</h2>
              <p className="muted">
                {detail.author} ·{' '}
                {detail.publishedAt
                  ? new Date(detail.publishedAt).toLocaleDateString('zh-CN')
                  : '平台未提供时间'}
              </p>
              <div className="detail-stats">
                <span>
                  <Heart size={15} />
                  {shortNum(detail.likes)}
                </span>
                <span>
                  <MessageCircle size={15} />
                  {shortNum(detail.comments)}
                </span>
                <span>
                  <Bookmark size={15} />
                  {shortNum(detail.saves)}
                </span>
              </div>
              <p className="note-body">{detail.body}</p>
              <div className="tag-list">
                {detail.tags.map((t) => (
                  <span key={t}>#{t}</span>
                ))}
              </div>
              <ExternalLink url={safeUrl(detail.url)} label="打开原作品" />
              <div className="modal-action-row">
                <button
                  className="btn"
                  onClick={() => {
                    void collect(detail);
                    setDetail(null);
                  }}
                >
                  <Users size={15} />
                  采集客户
                </button>
                <button
                  className="btn primary"
                  disabled={detail.type === 'video' || !detail.images.length}
                  onClick={() => {
                    clone(detail);
                    setDetail(null);
                  }}
                >
                  <Copy size={15} />
                  克隆创作
                </button>
              </div>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
function HistoryIcon() {
  return <RotateCcw size={15} />;
}
export function NoteCard({
  note: n,
  selected,
  toggle,
  onDetail,
  onClone,
  onCollect,
  priorityReason,
}: {
  note: Note;
  selected: boolean;
  toggle: () => void;
  onDetail: () => void;
  onClone: () => void;
  onCollect: () => void;
  priorityReason?: string;
}) {
  return (
    <article className={`note-card ${selected ? 'selected' : ''}`}>
      <div className="note-cover">
        <button className="note-cover-main" onClick={onDetail} aria-label={`查看 ${n.title}`}>
          <img src={n.cover} alt={n.title} loading="lazy" />
        </button>
        {n.type === 'image' && n.images.length > 0 ? (
          <label className={`note-select ${selected ? 'checked' : ''}`}>
            <input
              type="checkbox"
              aria-label={`选择 ${n.title}`}
              checked={selected}
              onChange={toggle}
            />
            {selected ? <Check size={12} /> : <ImageIcon size={12} />}
            <span>{selected ? '已选择' : n.images.length + ' 图'}</span>
          </label>
        ) : (
          <span className="video-badge">
            <Play size={11} fill="currentColor" />
            视频
          </span>
        )}
        {n.likes >= 10000 && (
          <span className="hot-badge">
            <Flame size={10} />
            高热度
          </span>
        )}
        <div className="card-hover-actions">
          <button
            className="btn primary small"
            onClick={onClone}
            disabled={n.type === 'video' || !n.images.length}
          >
            <Copy size={13} />
            {n.type === 'video' ? '仅支持图文克隆' : '一键克隆'}
          </button>
          <button className="btn small" onClick={onCollect}>
            <Users size={13} />
            一键采集客户
          </button>
        </div>
      </div>
      <div className="note-card-body">
        {priorityReason && <p className="field-hint">{priorityReason}</p>}
        <button className="note-title" onClick={onDetail}>
          {n.title}
        </button>
        <div className="field-hint">
          {n.publishedAt ? (
            <time dateTime={n.publishedAt}>
              发布于 {new Date(n.publishedAt).toLocaleString('zh-CN', { hour12: false })}
            </time>
          ) : (
            '原始发布日期待核实'
          )}
        </div>
        <div className="note-author">
          <span className={`author-avatar color-${n.author.length % 4}`}>
            {n.author.slice(0, 1)}
          </span>
          <span>{n.author}</span>
          <span className="note-likes">
            <Heart size={12} />
            {shortNum(n.likes)}
          </span>
        </div>
      </div>
    </article>
  );
}
export function JobLog({ job }: { job?: Job }) {
  return (
    <div className="job-log">
      {job?.logs.length ? (
        job.logs.map((l, i) => (
          <div key={i} className={`log-row log-${l.level.toLowerCase()}`}>
            <span>{String(i + 1).padStart(4, '0')}</span>
            <time>{new Date(l.at).toLocaleTimeString('zh-CN', { hour12: false })}</time>
            <b>[{l.level}]</b>
            <p>{l.message}</p>
          </div>
        ))
      ) : (
        <p className="muted">等待任务开始…</p>
      )}
      <div className="terminal-cursor">▊</div>
    </div>
  );
}

function NoteMasonry({ children }: { children: ReactNode[] }) {
  const container = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(4);
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const update = () =>
      setColumns(Number(getComputedStyle(el).getPropertyValue('--columns')) || 4);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="note-grid" ref={container}>
      {Array.from({ length: columns }, (_, column) => (
        <div className="note-column" key={column}>
          {children.filter((_, index) => index % columns === column)}
        </div>
      ))}
    </div>
  );
}
