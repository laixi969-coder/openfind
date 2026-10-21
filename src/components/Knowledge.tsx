import { useEffect, useMemo, useState } from 'react';
import {
  Pencil,
  PenLine,
  Plus,
  Sparkles,
  Trash2,
  Wand2,
  Copy,
  Search,
  BarChart3,
  MessageSquareText,
  Users,
} from 'lucide-react';
import type {
  AuthorBreakdown,
  CommentDigest,
  DraftOutcomes,
  InsightCandidate,
  InsightCard,
  InsightKind,
  KeywordDigest,
  KnowledgeAttribution,
  NoteBreakdown,
  Platform,
  RadarReport,
  TopicPool,
} from '../../shared/types';
import { api } from '../api';
import { useWorkspace } from '../context';
import { Busy, Empty, Modal, PageHeading } from './ui';

const KINDS: { id: InsightKind; name: string; hint: string }[] = [
  { id: 'angle', name: '选题', hint: '写给谁、切什么场景' },
  { id: 'structure', name: '结构', hint: '段落功能与顺序' },
  { id: 'hook', name: '钩子', hint: '开头句式' },
  { id: 'voice', name: '表达', hint: '语气与人称' },
  { id: 'pain', name: '痛点', hint: '想要但受阻' },
  { id: 'objection', name: '反对', hint: '不买的理由' },
  { id: 'deal', name: '成交', hint: '有效的确认与推进' },
  { id: 'forbidden', name: '禁区', hint: '绝对不写的表述' },
];
const KIND_NAME = Object.fromEntries(KINDS.map((k) => [k.id, k.name])) as Record<
  InsightKind,
  string
>;
const SOURCE_NAME: Record<InsightCard['source'], string> = {
  manual: '手写',
  breakdown: '拆解',
  comments: '评论归集',
  deal: '成交',
};
const PLATFORM_NAME: Record<string, string> = {
  all: '通用',
  xiaohongshu: '小红书',
  douyin: '抖音',
};
type Tab = 'cards' | 'topics' | 'keywords' | 'attribution';

const splitLines = (value: string) =>
  value
    .split('\n')
    .map((v) => v.trim())
    .filter(Boolean);
const splitTags = (value: string) =>
  value
    .split(/[,，、\s]+/)
    .map((v) => v.trim().replace(/^#/, ''))
    .filter(Boolean);

function CandidateList({
  platform,
  source,
  sourceNoteId,
  cards,
  onSaved,
}: {
  platform: Platform | 'all';
  source: 'breakdown' | 'comments';
  sourceNoteId?: string;
  cards: InsightCandidate[];
  onSaved: () => void;
}) {
  const { notify } = useWorkspace();
  const [picked, setPicked] = useState<string[]>(cards.map((_, i) => String(i)));
  const [busy, setBusy] = useState(false);
  const toggle = (index: number) => {
    const id = String(index);
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };
  async function adopt() {
    const selected = cards.filter((_, i) => picked.includes(String(i)));
    if (!selected.length) return;
    setBusy(true);
    try {
      await api('/insights/adopt', { platform, source, sourceNoteId, cards: selected });
      notify(`已存入 ${selected.length} 张方法卡`);
      onSaved();
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="knowledge-candidates">
      {cards.map((card, index) => (
        <label key={index} className="knowledge-candidate">
          <input
            type="checkbox"
            checked={picked.includes(String(index))}
            onChange={() => toggle(index)}
          />
          <div>
            <div className="knowledge-candidate-head">
              <span className="knowledge-kind">{KIND_NAME[card.kind]}</span>
              <b>{card.title}</b>
            </div>
            <p>{card.body}</p>
            {card.evidence.map((quote) => (
              <blockquote key={quote}>{quote}</blockquote>
            ))}
            {card.tags.length > 0 && (
              <div className="knowledge-tags">
                {card.tags.map((tag) => (
                  <span key={tag}>{tag}</span>
                ))}
              </div>
            )}
          </div>
        </label>
      ))}
      <div className="modal-action-row">
        <button
          className="btn primary"
          disabled={busy || !picked.length}
          onClick={() => void adopt()}
        >
          {busy ? <Busy text="保存中" /> : `采纳 ${picked.length} 张`}
        </button>
      </div>
    </div>
  );
}

export function Knowledge() {
  const { data, notify, navigate } = useWorkspace();
  const [tab, setTab] = useState<Tab>('cards');
  const [cards, setCards] = useState<InsightCard[]>([]);
  const [outcomes, setOutcomes] = useState<DraftOutcomes | null>(null);
  const [platform, setPlatform] = useState<'all' | Platform>('all');
  const [kind, setKind] = useState<InsightKind | 'all'>('all');
  const [editing, setEditing] = useState<InsightCard | 'new' | null>(null);
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [authorOpen, setAuthorOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const [nextCards, nextOutcomes] = await Promise.all([
        api<InsightCard[]>('/insights'),
        api<DraftOutcomes>('/insights/outcomes'),
      ]);
      setCards(nextCards);
      setOutcomes(nextOutcomes);
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const visible = cards
    .filter((c) => platform === 'all' || c.platform === platform || c.platform === 'all')
    .filter((c) => kind === 'all' || c.kind === kind);

  async function toggle(card: InsightCard) {
    try {
      const next = await api<InsightCard>(
        `/insights/${card.id}`,
        { enabled: !card.enabled },
        'PATCH',
      );
      setCards((prev) => prev.map((c) => (c.id === card.id ? next : c)));
    } catch (e) {
      notify((e as Error).message, true);
    }
  }
  async function remove(card: InsightCard) {
    try {
      await api(`/insights/${card.id}`, undefined, 'DELETE');
      setCards((prev) => prev.filter((c) => c.id !== card.id));
      notify('已删除该知识卡');
    } catch (e) {
      notify((e as Error).message, true);
    }
  }

  return (
    <div className="knowledge-page">
      <PageHeading
        eyebrow="知识库"
        title="让 AI 用你的经验干活"
        description="选题、拆解、评论归集、搜索词都能沉淀成卡。改写时会按平台与标签自动取用这些卡，小红书与抖音各一套，互不覆盖。"
        action={
          <button className="btn primary" onClick={() => setEditing('new')}>
            <Plus size={15} />
            新建卡片
          </button>
        }
      />
      <div className="knowledge-tabs filter-tabs">
        {(
          [
            ['cards', '方法卡'],
            ['topics', '选题池'],
            ['keywords', '搜索词'],
            ['attribution', '效果归因'],
          ] as [Tab, string][]
        ).map(([id, name]) => (
          <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
            {name}
          </button>
        ))}
        <span className="knowledge-tab-gap" />
        <button onClick={() => setBreakdownOpen(true)}>
          <Sparkles size={13} />
          拆解作品
        </button>
        <button onClick={() => setCommentsOpen(true)}>
          <MessageSquareText size={13} />
          评论归集
        </button>
        <button onClick={() => setAuthorOpen(true)}>
          <Users size={13} />
          分析账号
        </button>
      </div>

      {tab === 'cards' && (
        <section className="panel knowledge-panel">
          <div className="knowledge-toolbar">
            <select
              aria-label="平台"
              value={platform}
              onChange={(e) => setPlatform(e.target.value as typeof platform)}
            >
              <option value="all">全部平台</option>
              <option value="xiaohongshu">小红书</option>
              <option value="douyin">抖音</option>
            </select>
            <select
              aria-label="类型"
              value={kind}
              onChange={(e) => setKind(e.target.value as typeof kind)}
            >
              <option value="all">全部类型</option>
              {KINDS.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name}·{k.hint}
                </option>
              ))}
            </select>
            <span className="field-hint">
              共 {cards.length} 张，当前显示 {visible.length} 张；已带出{' '}
              {outcomes?.totals.drafts ?? 0} 篇草稿、{outcomes?.totals.published ?? 0}{' '}
              篇已回填作品。禁用的卡不会被改写取用
            </span>
          </div>
          {loading ? (
            <Busy text="载入知识库" />
          ) : !visible.length ? (
            <Empty
              title="还没有方法卡"
              sub="先拆解一篇你认可的作品，或把评论区反复出现的卡点归集进来；也可以手写一条自己的表达习惯。"
              action={
                <button className="btn primary" onClick={() => setEditing('new')}>
                  <Plus size={15} />
                  新建第一条
                </button>
              }
            />
          ) : (
            <div className="knowledge-list">
              {visible.map((card) => (
                <article key={card.id} className={card.enabled ? '' : 'disabled'}>
                  <header>
                    <span className="knowledge-kind">{KIND_NAME[card.kind]}</span>
                    <span className="knowledge-platform">{PLATFORM_NAME[card.platform]}</span>
                    <b>{card.title}</b>
                    <div className="knowledge-actions">
                      <button className="text-btn" onClick={() => void toggle(card)}>
                        {card.enabled ? '停用' : '启用'}
                      </button>
                      <button
                        className="icon-btn"
                        aria-label="编辑"
                        onClick={() => setEditing(card)}
                      >
                        <Pencil size={15} />
                      </button>
                      <button
                        className="icon-btn"
                        aria-label="删除"
                        onClick={() => void remove(card)}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </header>
                  <p>{card.body}</p>
                  {card.evidence.length > 0 && (
                    <div className="knowledge-evidence">
                      {card.evidence.map((quote) => (
                        <blockquote key={quote}>{quote}</blockquote>
                      ))}
                    </div>
                  )}
                  <footer>
                    {card.tags.map((tag) => (
                      <span key={tag} className="knowledge-tag">
                        {tag}
                      </span>
                    ))}
                    {(() => {
                      const outcome = outcomes?.rows.find((r) => r.cardId === card.id);
                      if (!outcome) return null;
                      return (
                        <span className="knowledge-outcome">
                          带出 {outcome.drafts} 篇草稿
                          {outcome.published ? ` · ${outcome.published} 篇已回填` : ''}
                        </span>
                      );
                    })()}
                    <em>
                      {SOURCE_NAME[card.source]} · 被引用 {card.usedCount} 次
                      {card.lastUsedAt
                        ? ` · 最近 ${new Date(card.lastUsedAt).toLocaleDateString('zh-CN')}`
                        : ''}
                    </em>
                  </footer>
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      {tab === 'topics' && (
        <TopicPanel notes={data.notes} platform={data.settings.platform || 'xiaohongshu'} />
      )}
      {tab === 'keywords' && (
        <KeywordPanel notes={data.notes} navigate={navigate} notify={notify} />
      )}
      {tab === 'attribution' && (
        <>
          <AttributionPanel />
          <CardOutcomesPanel data={outcomes} />
        </>
      )}

      {editing && (
        <CardEditor
          card={editing === 'new' ? null : editing}
          defaultPlatform={data.settings.platform || 'xiaohongshu'}
          onClose={() => setEditing(null)}
          onSaved={(card) => {
            setCards((prev) =>
              prev.some((c) => c.id === card.id)
                ? prev.map((c) => (c.id === card.id ? card : c))
                : [card, ...prev],
            );
            setEditing(null);
          }}
          notify={notify}
        />
      )}
      {breakdownOpen && (
        <BreakdownModal
          notes={data.notes}
          defaultPlatform={data.settings.platform || 'xiaohongshu'}
          onClose={() => {
            setBreakdownOpen(false);
            setTab('cards');
          }}
          onSaved={() => {
            void load();
            setBreakdownOpen(false);
          }}
        />
      )}
      {commentsOpen && (
        <CommentsModal
          notes={data.notes}
          defaultPlatform={data.settings.platform || 'xiaohongshu'}
          onClose={() => {
            setCommentsOpen(false);
            setTab('cards');
          }}
          onSaved={() => {
            void load();
            setCommentsOpen(false);
          }}
        />
      )}
      {authorOpen && (
        <AuthorModal
          notes={data.notes}
          defaultPlatform={data.settings.platform || 'xiaohongshu'}
          onClose={() => setAuthorOpen(false)}
          onSaved={() => {
            void load();
            setAuthorOpen(false);
          }}
        />
      )}
    </div>
  );
}

function CardEditor({
  card,
  defaultPlatform,
  onClose,
  onSaved,
  notify,
}: {
  card: InsightCard | null;
  defaultPlatform: Platform;
  onClose: () => void;
  onSaved: (card: InsightCard) => void;
  notify: (text: string, error?: boolean) => void;
}) {
  const [form, setForm] = useState({
    platform: (card?.platform || defaultPlatform) as InsightCard['platform'],
    kind: (card?.kind || 'structure') as InsightKind,
    title: card?.title || '',
    body: card?.body || '',
    tags: card?.tags.join('，') || '',
    evidence: card?.evidence.join('\n') || '',
    enabled: card?.enabled ?? true,
  });
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      const payload = {
        platform: form.platform,
        kind: form.kind,
        title: form.title,
        body: form.body,
        tags: splitTags(form.tags),
        evidence: splitLines(form.evidence),
        enabled: form.enabled,
      };
      const saved = card
        ? await api<InsightCard>(`/insights/${card.id}`, payload, 'PATCH')
        : await api<InsightCard>('/insights', payload);
      onSaved(saved);
      notify(card ? '已更新方法卡' : '已新建方法卡');
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={card ? '编辑方法卡' : '新建方法卡'}
      sub="写清「怎么用」，比写抽象的形容词更有用；标签决定改写时能不能被检索到。"
      onClose={onClose}
    >
      <div className="modal-body knowledge-form">
        <div className="field-row">
          <label className="field-label" htmlFor="card-platform">
            平台
          </label>
          <select
            id="card-platform"
            value={form.platform}
            onChange={(e) =>
              setForm({ ...form, platform: e.target.value as InsightCard['platform'] })
            }
          >
            <option value="all">两个平台通用</option>
            <option value="xiaohongshu">小红书</option>
            <option value="douyin">抖音</option>
          </select>
        </div>
        <div className="field-row">
          <label className="field-label" htmlFor="card-kind">
            类型
          </label>
          <select
            id="card-kind"
            value={form.kind}
            onChange={(e) => setForm({ ...form, kind: e.target.value as InsightKind })}
          >
            {KINDS.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name}·{k.hint}
              </option>
            ))}
          </select>
        </div>
        <div className="field-row">
          <label className="field-label" htmlFor="card-title">
            结论
          </label>
          <input
            id="card-title"
            value={form.title}
            maxLength={80}
            placeholder="例：开头先给结果，再讲过程"
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
        </div>
        <div className="field-row">
          <label className="field-label" htmlFor="card-body">
            怎么用
          </label>
          <textarea
            id="card-body"
            rows={5}
            value={form.body}
            maxLength={2000}
            placeholder="写清结构顺序、句式或禁区，改写时会作为写作偏好注入"
            onChange={(e) => setForm({ ...form, body: e.target.value })}
          />
        </div>
        <div className="field-row">
          <label className="field-label" htmlFor="card-tags">
            标签
          </label>
          <input
            id="card-tags"
            value={form.tags}
            placeholder="厨房，小户型，改造（用逗号分隔，决定能否被检索到）"
            onChange={(e) => setForm({ ...form, tags: e.target.value })}
          />
        </div>
        <div className="field-row">
          <label className="field-label" htmlFor="card-evidence">
            原话依据
          </label>
          <textarea
            id="card-evidence"
            rows={3}
            value={form.evidence}
            placeholder="每行一条，逐字引用评论或正文；没有依据就留空"
            onChange={(e) => setForm({ ...form, evidence: e.target.value })}
          />
        </div>
        <label className="checkbox-line">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
          />
          启用（停用后不会被改写取用）
        </label>
      </div>
      <div className="modal-action-row">
        <button className="btn" onClick={onClose}>
          取消
        </button>
        <button
          className="btn primary"
          disabled={busy || !form.title.trim() || !form.body.trim()}
          onClick={() => void save()}
        >
          {busy ? <Busy text="保存中" /> : '保存'}
        </button>
      </div>
    </Modal>
  );
}

function BreakdownModal({
  notes,
  defaultPlatform,
  onClose,
  onSaved,
}: {
  notes: { id: string; title: string; platform: Platform; publishedAt: string }[];
  defaultPlatform: Platform;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [platform, setPlatform] = useState<Platform>(defaultPlatform);
  const [noteId, setNoteId] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<NoteBreakdown | null>(null);
  const [error, setError] = useState('');
  const list = useMemo(
    () =>
      notes
        .filter((n) => n.platform === platform)
        .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
        .slice(0, 80),
    [notes, platform],
  );
  async function run() {
    if (!noteId) return;
    setBusy(true);
    setError('');
    setResult(null);
    try {
      setResult(await api<NoteBreakdown>('/insights/breakdown', { noteId }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="拆解一篇作品"
      sub="提取选题角度、段落结构与钩子句式；每条结论都要有原文依据，找不到依据的会被丢弃。"
      onClose={onClose}
      wide
    >
      <div className="modal-body">
        <div className="knowledge-toolbar">
          <select
            aria-label="平台"
            value={platform}
            onChange={(e) => {
              setPlatform(e.target.value as Platform);
              setNoteId('');
              setResult(null);
            }}
          >
            <option value="xiaohongshu">小红书</option>
            <option value="douyin">抖音</option>
          </select>
          <select aria-label="选择作品" value={noteId} onChange={(e) => setNoteId(e.target.value)}>
            <option value="">选择已采集的作品</option>
            {list.map((n) => (
              <option key={n.id} value={n.id}>
                {n.title.slice(0, 40)}
              </option>
            ))}
          </select>
          <button className="btn primary" disabled={!noteId || busy} onClick={() => void run()}>
            {busy ? <Busy text="拆解中" /> : '开始拆解'}
          </button>
        </div>
        <p className="field-hint">
          该平台已采集 {notes.filter((n) => n.platform === platform).length}{' '}
          篇；评论采得越多，拆解出的痛点越准。
        </p>
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        {result && (
          <>
            <p className="field-hint">
              {result.model} · 用时 {(result.elapsedMs / 1000).toFixed(1)} 秒 · 参考评论{' '}
              {result.commentSamples} 条
              {result.dropped > 0
                ? ` · 丢弃 ${result.dropped} 条不合格结论（引文无法核对或类型不符）`
                : ''}
            </p>
            <div className="knowledge-radar">
              <RadarChart report={result.radar} />
              <div className="knowledge-radar-side">
                <p className="field-hint">
                  对比样本：{result.radar.sample.label}（{result.radar.sample.size} 篇）
                </p>
                <div className="knowledge-metrics-list">
                  {result.radar.dims.map((d) => (
                    <div key={d.key}>
                      <span>{d.label}</span>
                      <b>{d.text}</b>
                      <em>
                        {d.percentile >= 95
                          ? '最高'
                          : d.percentile <= 5
                            ? '最低'
                            : `${d.percentile}%`}
                      </em>
                    </div>
                  ))}
                </div>
                {result.commentKeywords.length > 0 && (
                  <>
                    <p className="field-hint">评论区高频诉求（本机统计，按意图句提取）</p>
                    <div className="knowledge-tags">
                      {result.commentKeywords.map((k) => (
                        <span key={k.word}>
                          {k.word} ×{k.count}
                        </span>
                      ))}
                    </div>
                  </>
                )}
                <p className="field-hint">{result.radar.note}</p>
              </div>
            </div>
            <CandidateList
              platform={result.platform}
              source="breakdown"
              sourceNoteId={result.noteId}
              cards={result.cards}
              onSaved={onSaved}
            />
          </>
        )}
      </div>
    </Modal>
  );
}

function CommentsModal({
  notes,
  defaultPlatform,
  onClose,
  onSaved,
}: {
  notes: { id: string; title: string; platform: Platform }[];
  defaultPlatform: Platform;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [platform, setPlatform] = useState<Platform>(defaultPlatform);
  const [noteId, setNoteId] = useState('');
  const [limit, setLimit] = useState(60);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CommentDigest | null>(null);
  const [error, setError] = useState('');
  const list = useMemo(
    () => notes.filter((n) => n.platform === platform).slice(0, 80),
    [notes, platform],
  );
  async function run() {
    setBusy(true);
    setError('');
    setResult(null);
    try {
      setResult(
        await api<CommentDigest>('/insights/comments', {
          platform,
          noteIds: noteId ? [noteId] : [],
          limit,
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="归集评论区"
      sub="把已采集评论归纳成痛点和反对意见；每条结论必须带评论原话，编造的依据会被丢弃。"
      onClose={onClose}
      wide
    >
      <div className="modal-body">
        <div className="knowledge-toolbar">
          <select
            aria-label="平台"
            value={platform}
            onChange={(e) => setPlatform(e.target.value as Platform)}
          >
            <option value="xiaohongshu">小红书</option>
            <option value="douyin">抖音</option>
          </select>
          <select aria-label="范围" value={noteId} onChange={(e) => setNoteId(e.target.value)}>
            <option value="">该平台全部已采集评论</option>
            {list.map((n) => (
              <option key={n.id} value={n.id}>
                只归集：{n.title.slice(0, 30)}
              </option>
            ))}
          </select>
          <input
            aria-label="样本条数"
            type="number"
            min={5}
            max={200}
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value) || 60)}
          />
          <button className="btn primary" disabled={busy} onClick={() => void run()}>
            {busy ? <Busy text="归集中" /> : '开始归集'}
          </button>
        </div>
        <p className="field-hint">最多取最近 {limit} 条评论；平台之间不混用样本。</p>
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        {result && (
          <>
            <p className="field-hint">
              {result.model} · {result.commentCount} 条评论 · 用时{' '}
              {(result.elapsedMs / 1000).toFixed(1)} 秒
              {result.dropped > 0 ? ` · 丢弃 ${result.dropped} 条无原话依据的结论` : ''}
            </p>
            <CandidateList
              platform={result.platform}
              source="comments"
              cards={result.cards}
              onSaved={onSaved}
            />
          </>
        )}
      </div>
    </Modal>
  );
}

function KeywordPanel({
  notes,
  navigate,
  notify,
}: {
  notes: { platform: Platform }[];
  navigate: (page: 'discover') => void;
  notify: (text: string, error?: boolean) => void;
}) {
  const [platform, setPlatform] = useState<Platform>('xiaohongshu');
  const [seed, setSeed] = useState('');
  const [busy, setBusy] = useState(false);
  const [digest, setDigest] = useState<KeywordDigest | null>(null);
  const [error, setError] = useState('');
  async function run() {
    setBusy(true);
    setError('');
    try {
      setDigest(await api<KeywordDigest>('/insights/keywords', { platform, seed, limit: 24 }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function useKeyword(keyword: string) {
    sessionStorage.setItem('openfind:handoff-keyword', JSON.stringify({ keyword, platform }));
    navigate('discover');
  }
  return (
    <section className="panel knowledge-panel">
      <div className="knowledge-toolbar">
        <select
          aria-label="平台"
          value={platform}
          onChange={(e) => setPlatform(e.target.value as Platform)}
        >
          <option value="xiaohongshu">小红书</option>
          <option value="douyin">抖音</option>
        </select>
        <input
          aria-label="方向词"
          value={seed}
          placeholder="方向词，例如：厨房改造（可留空）"
          onChange={(e) => setSeed(e.target.value)}
        />
        <button className="btn primary" disabled={busy} onClick={() => void run()}>
          {busy ? (
            <Busy text="挖掘中" />
          ) : (
            <>
              <Wand2 size={15} />
              挖掘搜索词
            </>
          )}
        </button>
      </div>
      <p className="field-hint">
        用该平台已采集的评论反推用户真的会搜的词，不发新请求、不碰平台接口；配置大模型后会额外补充长尾词。
        当前平台已采集作品 {notes.filter((n) => n.platform === platform).length} 篇。
      </p>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {digest && (
        <>
          <p className="field-hint">
            语料 {digest.corpusComments} 条评论 · {digest.suggestions.length} 个候选词
            {digest.model ? ` · 已用 ${digest.model} 补充` : ' · 仅本机统计'}
          </p>
          {!digest.suggestions.length ? (
            <Empty
              title="没有挖到成型的搜索词"
              sub="评论里缺少带意图的提问。先多采集几篇作品的评论，再回来试一次。"
            />
          ) : (
            <div className="table-scroll">
              <table className="knowledge-table">
                <thead>
                  <tr>
                    <th>搜索词</th>
                    <th>意图</th>
                    <th>来源</th>
                    <th>命中</th>
                    <th>评论原话</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {digest.suggestions.map((s) => (
                    <tr key={s.keyword}>
                      <td>
                        <b>{s.keyword}</b>
                      </td>
                      <td>{s.intent}</td>
                      <td>{s.origin === 'corpus' ? '评论语料' : '模型补充'}</td>
                      <td>{s.hits || '—'}</td>
                      <td className="knowledge-sample">{s.sample || '—'}</td>
                      <td>
                        <button className="text-btn" onClick={() => useKeyword(s.keyword)}>
                          <Search size={13} />
                          去搜索
                        </button>
                        <button
                          className="text-btn"
                          onClick={() => {
                            void navigator.clipboard?.writeText(s.keyword);
                            notify('已复制');
                          }}
                        >
                          <Copy size={13} />
                          复制
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function AttributionPanel() {
  const [data, setData] = useState<KnowledgeAttribution | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    void api<KnowledgeAttribution>('/insights/attribution')
      .then(setData)
      .catch((e) => setError((e as Error).message));
  }, []);
  if (error) return <p className="inline-error">{error}</p>;
  if (!data) return <Busy text="统计中" />;
  return (
    <section className="panel knowledge-panel">
      <div className="knowledge-metrics">
        <div>
          <span>作品</span>
          <b>{data.totals.notes}</b>
        </div>
        <div>
          <span>线索</span>
          <b>{data.totals.leads}</b>
        </div>
        <div>
          <span>成交</span>
          <b>{data.totals.won}</b>
        </div>
        <div>
          <span>金额</span>
          <b>¥{data.totals.amount.toLocaleString('zh-CN')}</b>
        </div>
      </div>
      {!data.rows.length ? (
        <Empty
          title="还没有搜索记录"
          sub="跑过搜索任务后才会有归因数据。归因看的是「哪个词真的带回了线索与成交」，不是曝光量。"
        />
      ) : (
        <div className="table-scroll">
          <table className="knowledge-table">
            <thead>
              <tr>
                <th>搜索词</th>
                <th>平台</th>
                <th>作品</th>
                <th>线索</th>
                <th>已沟通</th>
                <th>成交</th>
                <th>金额</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr key={row.keyword + row.platform}>
                  <td>
                    <b>{row.keyword}</b>
                  </td>
                  <td>{PLATFORM_NAME[row.platform]}</td>
                  <td>{row.notes}</td>
                  <td>{row.leads}</td>
                  <td>{row.contacted}</td>
                  <td>{row.won}</td>
                  <td>{row.amount ? '¥' + row.amount.toLocaleString('zh-CN') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="field-hint">
        <BarChart3 size={13} /> {data.note}
      </p>
    </section>
  );
}

// 卡片 → 草稿 → 已回填作品。只展示记录，不自动给卡片加权：样本不够时加权等于用运气调参。
function CardOutcomesPanel({ data }: { data: DraftOutcomes | null }) {
  if (!data) return <Busy text="统计中" />;
  return (
    <section className="panel knowledge-panel">
      <div className="knowledge-toolbar">
        <b>方法卡带出了什么</b>
        <span className="field-hint">
          {data.totals.cards} 张卡被用过 · {data.totals.drafts} 篇草稿引用 · {data.totals.published}{' '}
          篇已回填作品
          {data.unattributed > 0 ? ` · ${data.unattributed} 篇旧草稿没有卡片记录` : ''}
        </span>
      </div>
      {!data.rows.length ? (
        <Empty
          title="还没有卡片带出的草稿"
          sub="在克隆创作里点「AI 改写」并套用结果，草稿会记下引用了哪几张卡；发布后回到内容工作室回填作品链接，这里就会有数据。"
        />
      ) : (
        <div className="table-scroll">
          <table className="knowledge-table">
            <thead>
              <tr>
                <th>方法卡</th>
                <th>类型</th>
                <th>平台</th>
                <th>草稿</th>
                <th>已回填</th>
                <th>赞</th>
                <th>评论</th>
                <th>收藏</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr key={row.cardId}>
                  <td>
                    <b>{row.title}</b>
                  </td>
                  <td>{KIND_NAME[row.kind]}</td>
                  <td>{PLATFORM_NAME[row.platform]}</td>
                  <td>{row.drafts}</td>
                  <td>{row.published}</td>
                  <td>{row.likes || '—'}</td>
                  <td>{row.comments || '—'}</td>
                  <td>{row.saves || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="field-hint">{data.note}</p>
    </section>
  );
}

// 六维雷达：画的是分位（相对同批作品的位置），不是绝对数字。
function RadarChart({ report }: { report: RadarReport }) {
  const size = 240,
    cx = size / 2,
    cy = size / 2,
    R = 78;
  const count = report.dims.length || 6;
  const angleAt = (i: number) => (-90 + (i * 360) / count) * (Math.PI / 180);
  const pointAt = (i: number, ratio: number) => {
    const a = angleAt(i);
    return `${(cx + Math.cos(a) * R * ratio).toFixed(1)},${(cy + Math.sin(a) * R * ratio).toFixed(1)}`;
  };
  const shape = report.dims
    .map((d, i) => pointAt(i, Math.max(0, Math.min(100, d.percentile)) / 100))
    .join(' ');
  return (
    <svg
      className="knowledge-radar-chart"
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label="作品分位雷达"
    >
      <title>作品在同批作品中的分位</title>
      {[0.25, 0.5, 0.75, 1].map((ratio) => (
        <polygon
          key={ratio}
          points={report.dims.map((_, i) => pointAt(i, ratio)).join(' ')}
          fill="none"
          stroke="#e8ebf0"
          strokeWidth="1"
        />
      ))}
      {report.dims.map((_, i) => (
        <line
          key={i}
          x1={cx}
          y1={cy}
          x2={cx + Math.cos(angleAt(i)) * R}
          y2={cy + Math.sin(angleAt(i)) * R}
          stroke="#eef0f4"
          strokeWidth="1"
        />
      ))}
      <polygon points={shape} fill="#ee3b5822" stroke="#ee3b58" strokeWidth="2" />
      {report.dims.map((d, i) => {
        const a = angleAt(i);
        const x = cx + Math.cos(a) * (R + 22);
        const y = cy + Math.sin(a) * (R + 22);
        const anchor = Math.cos(a) > 0.3 ? 'start' : Math.cos(a) < -0.3 ? 'end' : 'middle';
        return (
          <text
            key={d.key}
            x={x}
            y={y}
            fontSize="11"
            fill="#8a99ac"
            textAnchor={anchor}
            dominantBaseline="central"
          >
            {d.label}
          </text>
        );
      })}
    </svg>
  );
}

function AuthorModal({
  notes,
  defaultPlatform,
  onClose,
  onSaved,
}: {
  notes: {
    id: string;
    title: string;
    author: string;
    authorId: string;
    platform: Platform;
    likes: number;
  }[];
  defaultPlatform: Platform;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [platform, setPlatform] = useState<Platform>(defaultPlatform);
  const [authorId, setAuthorId] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AuthorBreakdown | null>(null);
  const [error, setError] = useState('');
  // 只有已入库 ≥3 篇的作者才有分析价值，否则看不出选题规律。
  const authors = useMemo(() => {
    const map = new Map<string, { id: string; name: string; count: number; top: number }>();
    for (const n of notes) {
      if (n.platform !== platform) continue;
      const key = n.authorId || n.author;
      if (!key) continue;
      const current = map.get(key) || { id: key, name: n.author || key, count: 0, top: 0 };
      current.count++;
      current.top = Math.max(current.top, n.likes || 0);
      current.name = n.author || current.name;
      map.set(key, current);
    }
    return [...map.values()]
      .filter((a) => a.count >= 3)
      .sort((a, b) => b.count - a.count || b.top - a.top);
  }, [notes, platform]);
  async function run() {
    if (!authorId) return;
    setBusy(true);
    setError('');
    setResult(null);
    try {
      setResult(await api<AuthorBreakdown>('/insights/author', { platform, authorId }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="分析一个账号"
      sub="只用已入库的该作者作品，不新抓主页；导入越多，规律越可信。"
      onClose={onClose}
      wide
    >
      <div className="modal-body">
        <div className="knowledge-toolbar">
          <select
            aria-label="平台"
            value={platform}
            onChange={(e) => {
              setPlatform(e.target.value as Platform);
              setAuthorId('');
              setResult(null);
            }}
          >
            <option value="xiaohongshu">小红书</option>
            <option value="douyin">抖音</option>
          </select>
          <select
            aria-label="选择作者"
            value={authorId}
            onChange={(e) => setAuthorId(e.target.value)}
          >
            <option value="">选择已入库 ≥3 篇的作者</option>
            {authors.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name.slice(0, 24)}（{a.count} 篇）
              </option>
            ))}
          </select>
          <button className="btn primary" disabled={!authorId || busy} onClick={() => void run()}>
            {busy ? <Busy text="分析中" /> : '开始分析'}
          </button>
        </div>
        {!authors.length && (
          <p className="field-hint">
            该作者平台还没有入库 3
            篇以上同一作者的作品。可以先在「发现作品」按作者名搜索，或用「粘贴链接」导入同一作者的
            3–5 篇。
          </p>
        )}
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        {result && (
          <>
            <p className="field-hint">
              {result.author} · {result.works.length} 篇已入库 · {result.model} · 用时{' '}
              {(result.elapsedMs / 1000).toFixed(1)} 秒
              {result.dropped > 0
                ? ` · 丢弃 ${result.dropped} 条不合格结论（引文无法核对或类型不符）`
                : ''}
            </p>
            <div className="table-scroll">
              <table className="knowledge-table">
                <thead>
                  <tr>
                    <th>作品</th>
                    <th>赞</th>
                    <th>评论</th>
                    <th>收藏</th>
                  </tr>
                </thead>
                <tbody>
                  {result.works.slice(0, 12).map((w) => (
                    <tr key={w.id}>
                      <td>{w.title}</td>
                      <td>{w.likes}</td>
                      <td>{w.comments}</td>
                      <td>{w.saves}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <CandidateList
              platform={result.platform}
              source="breakdown"
              cards={result.cards}
              onSaved={onSaved}
            />
          </>
        )}
      </div>
    </Modal>
  );
}

// 选题池：只来自评论里的真实提问，规则产出、零模型调用，可逐条回溯原话。
function TopicPanel({
  notes,
  platform: initialPlatform,
}: {
  notes: { platform: Platform }[];
  platform: Platform;
}) {
  const { newDraft, notify } = useWorkspace();
  const [platform, setPlatform] = useState<Platform>(initialPlatform);
  const [seed, setSeed] = useState('');
  const [busy, setBusy] = useState(false);
  const [pool, setPool] = useState<TopicPool | null>(null);
  const [error, setError] = useState('');

  async function run() {
    setBusy(true);
    setError('');
    try {
      setPool(await api<TopicPool>('/topics', { platform, seed, limit: 20 }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function create(title: string) {
    sessionStorage.setItem('openfind:handoff-draft', JSON.stringify({ title }));
    newDraft();
    notify('已把标题带进新建草稿，正文自己写或去克隆参考作品');
  }

  return (
    <section className="panel knowledge-panel">
      <div className="knowledge-toolbar">
        <select
          aria-label="平台"
          value={platform}
          onChange={(e) => setPlatform(e.target.value as Platform)}
        >
          <option value="xiaohongshu">小红书</option>
          <option value="douyin">抖音</option>
        </select>
        <input
          aria-label="方向词"
          value={seed}
          placeholder="方向词可留空，例如：厨房改造"
          onChange={(e) => setSeed(e.target.value)}
        />
        <button className="btn primary" disabled={busy} onClick={() => void run()}>
          {busy ? (
            <Busy text="生成中" />
          ) : (
            <>
              <Sparkles size={15} />
              生成选题
            </>
          )}
        </button>
      </div>
      <p className="field-hint">
        选题只来自该平台已采集评论里的真实提问，出现次数就是问过的人数；不调模型、不编主题。当前已采集作品{' '}
        {notes.filter((n) => n.platform === platform).length} 篇。
      </p>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {pool && !pool.ideas.length && (
        <Empty
          title="还没有可以成题的真实提问"
          sub="评论里没有带诉求的问句。先多采集几篇高互动作品的评论，或换个方向词再试。"
        />
      )}
      {pool && pool.ideas.length > 0 && (
        <>
          <p className="field-hint">
            语料 {pool.corpusComments} 条评论 · {pool.ideas.length} 个选题
          </p>
          <div className="knowledge-topics">
            {pool.ideas.map((idea) => (
              <article key={idea.id}>
                <header>
                  <b>{idea.title}</b>
                  <span className="knowledge-tag">{idea.intent}</span>
                  <em>{idea.count} 人问过</em>
                </header>
                <p>{idea.angle}</p>
                <blockquote>{idea.evidence}</blockquote>
                <footer>
                  <button className="text-btn" onClick={() => create(idea.title)}>
                    <PenLine size={13} />
                    去创作
                  </button>
                </footer>
              </article>
            ))}
          </div>
          <p className="field-hint">{pool.note}</p>
        </>
      )}
    </section>
  );
}
