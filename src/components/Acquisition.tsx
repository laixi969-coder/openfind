import { QualificationComparison } from './QualificationComparison';
import { AssessmentDetails } from './AssessmentDetails';
import { CollectionBudget } from './CollectionBudget';
import { useState } from 'react';
import { Play, Pause, ArrowRight, Download, Workflow, CheckCircle2, Clock } from 'lucide-react';
import type { AcquisitionWorkflow, Platform } from '../../shared/types';
import { acquisitionPriority, assessComment } from '../../server/domain';
import { useWorkspace } from '../context';
import { api, downloadExport } from '../api';
import { PageHeading, SourceTag } from './ui';

const platformName = (p: Platform) => (p === 'douyin' ? '抖音' : '小红书');
export function Acquisition() {
  const { data, refresh, notify, navigate, setCommentNoteId } = useWorkspace();
  const flows = data.workflows || [];
  const initial =
    flows.find((w) => w.id === new URLSearchParams(location.search).get('workflow')) || flows[0];
  const [flowId, setFlowId] = useState(initial?.id || '');
  const [platform, setPlatform] = useState<Platform>(
    initial?.input.platform || data.settings.platform || 'xiaohongshu',
  );
  const [keyword, setKeyword] = useState(initial?.input.keyword || '家居');
  const [searchLimit, setSearchLimit] = useState(20);
  const [maxNotes, setMaxNotes] = useState(3);
  const [commentLimit, setCommentLimit] = useState(20);
  const [supplement, setSupplement] = useState(true);
  const [busy, setBusy] = useState(false);
  const [reviewFilter, setReviewFilter] = useState('all');
  const flow = flows.find((w) => w.id === flowId);
  const active =
    flows.some((w) => w.status === 'running' || w.reviewProgress?.status === 'running') ||
    data.jobs.some((j) => j.status === 'running');
  const notes =
    flow?.noteIds.map((id) => data.notes.find((n) => n.id === id)).filter((n) => !!n) || [];
  const comments =
    flow?.commentIds.map((id) => data.comments.find((c) => c.id === id)).filter((c) => !!c) || [];
  const leads =
    flow?.leadIds.map((id) => data.leads.find((l) => l.id === id)).filter((l) => !!l) || [];
  const currentJob = data.jobs.find((j) => j.id === flow?.currentJobId);
  function select(id: string) {
    setFlowId(id);
    history.replaceState(null, '', `?workflow=${encodeURIComponent(id)}#acquisition`);
  }
  async function start() {
    setBusy(true);
    try {
      const w = await api<AcquisitionWorkflow>('/workflows', {
        keyword,
        platform,
        mode: data.settings.mode,
        searchLimit,
        maxNotes,
        commentLimit,
        supplement,
      });
      select(w.id);
      await refresh();
      notify('流程已启动，搜索、评论采集和线索判断将依次执行');
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  async function control(action: 'pause' | 'resume') {
    if (!flow) return;
    setBusy(true);
    try {
      await api(`/workflows/${flow.id}/${action}`, {});
      await refresh();
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  async function review(useModel = false) {
    if (!flow) return;
    setBusy(true);
    try {
      const reviewed = await api<AcquisitionWorkflow>(`/workflows/${flow.id}/review`, { useModel });
      await refresh();
      const incomplete = reviewed.reviewProgress?.status === 'failed';
      notify(
        incomplete
          ? `规则复核完成，模型仍有${reviewed.reviewProgress!.pending}条待处理；已保存完成结果`
          : '全部评论已复核，保留原候选变更记录',
        incomplete,
      );
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  const stages = ['search', 'comments', 'assess', 'done'];
  const stageIndex = flow ? stages.indexOf(flow.stage) : -1;
  return (
    <>
      <PageHeading
        eyebrow="ONE-CLICK ACQUISITION"
        title="从搜索，到值得复核的需求。"
        description="选好平台和关键词，自动搜索、挑选作品、采集评论并保存候选。结果与判断依据留在同一页。"
      />
      <CollectionBudget platform={platform} />
      <section className="acquisition-setup" aria-label="一键获客设置">
        <div className="acquisition-intro">
          <Workflow size={22} />
          <div>
            <h2>组合获客流程</h2>
            <p>最新作品为主 · 近期需求优先 · 相关与高互动补充</p>
          </div>
          <SourceTag source={data.settings.mode} />
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void start();
          }}
        >
          <div className="acquisition-fields">
            <label>
              获客平台
              <select
                aria-label="获客平台"
                value={platform}
                onChange={(e) => setPlatform(e.target.value as Platform)}
              >
                <option value="xiaohongshu">小红书</option>
                <option value="douyin">抖音</option>
              </select>
            </label>
            <label className="acquisition-keyword">
              产品或场景关键词
              <input
                required
                maxLength={100}
                aria-label="获客关键词"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="例如：小户型沙发"
              />
            </label>
            <label>
              每次搜索作品数
              <input
                aria-label="每次搜索作品数"
                type="number"
                min={1}
                max={40}
                required
                value={searchLimit}
                onChange={(e) => setSearchLimit(Number(e.target.value))}
              />
            </label>
            <label>
              最多采样作品数
              <input
                aria-label="最多采样作品数"
                type="number"
                min={1}
                max={5}
                required
                value={maxNotes}
                onChange={(e) => setMaxNotes(Number(e.target.value))}
              />
            </label>
            <label>
              每篇评论上限
              <input
                aria-label="每篇评论上限"
                type="number"
                min={1}
                max={50}
                required
                value={commentLimit}
                onChange={(e) => setCommentLimit(Number(e.target.value))}
              />
            </label>
          </div>
          <div className="acquisition-actions">
            <label>
              <input
                type="checkbox"
                checked={supplement}
                onChange={(e) => setSupplement(e.target.checked)}
              />
              作品不足时补充相关、高互动搜索（遵守剩余额度）
            </label>
            <button className="btn primary" disabled={busy || active || !keyword.trim()}>
              <Play size={15} />
              一键执行获客
            </button>
          </div>
        </form>
        <p className="field-hint">
          默认最多采样3篇，每篇20条评论。仅将近7天明确需求保存为候选，仍需核对产品与地区匹配；不自动发送消息。登录、验证、额度或连接问题会暂停并保留进度。
        </p>
      </section>
      <section className="acquisition-results" aria-label="流程结果">
        <div className="acquisition-toolbar">
          <h2>执行与结果</h2>
          <select aria-label="选择获客流程" value={flowId} onChange={(e) => select(e.target.value)}>
            <option value="">选择历史流程</option>
            {flows.map((w) => (
              <option key={w.id} value={w.id}>
                {platformName(w.input.platform)} · {w.input.keyword} ·{' '}
                {new Date(w.createdAt).toLocaleString()} ·{' '}
                {w.status === 'completed' ? '已完成' : w.status === 'paused' ? '已暂停' : '执行中'}
              </option>
            ))}
          </select>
        </div>
        {!flow ? (
          <p className="acquisition-empty">
            填写关键词并一键执行。作品、评论和候选线索会逐步出现在这里，刷新页面也能继续查看。
          </p>
        ) : (
          <>
            <div className="acquisition-toolbar">
              <h3>
                {platformName(flow.input.platform)} · {flow.input.keyword}
              </h3>
              <SourceTag source={flow.input.mode} />
              {flow.status === 'completed' && (
                <button className="btn" disabled={busy || active} onClick={() => void review()}>
                  {busy ? '复核中…' : '重新复核全部评论'}
                </button>
              )}
              {flow.status === 'completed' && (
                <button className="btn" disabled={busy || active} onClick={() => void review(true)}>
                  本次使用模型复核
                </button>
              )}
              <span className={'workflow-status ' + flow.status}>
                {flow.status === 'completed'
                  ? '已完成'
                  : flow.status === 'paused'
                    ? '已暂停'
                    : '执行中'}
              </span>
              {flow.status === 'running' && (
                <button className="btn" disabled={busy} onClick={() => void control('pause')}>
                  <Pause size={14} />
                  暂停流程
                </button>
              )}
              {flow.status === 'paused' && (
                <>
                  <button
                    className="btn primary"
                    disabled={busy || active}
                    onClick={() => void control('resume')}
                  >
                    <Play size={14} />
                    继续流程
                  </button>
                  <button className="btn" onClick={() => navigate('settings')}>
                    检查登录与验证
                  </button>
                </>
              )}
            </div>
            <ol className="acquisition-steps">
              {['搜索与选样', '评论采集', '线索判断', '结果保存'].map((label, i) => (
                <li
                  key={label}
                  className={
                    i < stageIndex || flow.status === 'completed'
                      ? 'done'
                      : i === stageIndex
                        ? 'current'
                        : ''
                  }
                >
                  {i < stageIndex || flow.status === 'completed' ? (
                    <CheckCircle2 size={17} />
                  ) : (
                    <Clock size={17} />
                  )}
                  <span>{label}</span>
                </li>
              ))}
            </ol>
            {flow.reviewProgress && (
              <p className="workflow-model-progress" role="status">
                {flow.reviewProgress.message}（总范围 {flow.reviewProgress.total}，本地排除{' '}
                {flow.reviewProgress.excluded}，有效结果 {flow.reviewProgress.reviewed}，待处理{' '}
                {flow.reviewProgress.pending}）
              </p>
            )}
            <p className="workflow-message" role="status">
              {flow.message}
            </p>
            {currentJob && (
              <p className="field-hint">
                当前步骤已读取 {currentJob.pages} 批、{currentJob.count} 条。
                {currentJob.logs.at(-1)?.message}
              </p>
            )}
            <p className="field-hint">
              候选作品包含本次搜索及同平台、同关键词的历史发现；评论与线索只统计本流程读取或有效缓存复用的结果。
            </p>
            <div className="acquisition-metrics">
              {[
                [notes.length, '候选作品'],
                [`${flow.completedNoteIds.length}/${flow.selectedNoteIds.length}`, '作品已采样'],
                [comments.length, '已保存评论'],
                [leads.length, '候选线索'],
              ].map(([n, label]) => (
                <div key={label}>
                  <strong>{n}</strong>
                  <span>{label}</span>
                </div>
              ))}
            </div>
            {flow.qualificationReview?.comparison && (
              <QualificationComparison
                comparison={flow.qualificationReview.comparison}
                comments={comments}
                notes={notes}
              />
            )}
            {flow.qualificationReview && (
              <section className="qualification-review" aria-label="线索逐条复核">
                <h3>线索逐条复核 · {flow.qualificationReview.version}</h3>
                <p>
                  已复核全部 {flow.qualificationReview.reviewedCommentCount} 条评论；原候选{' '}
                  {flow.qualificationReview.originalCommentIds.length} 条，降级{' '}
                  {flow.qualificationReview.removedCommentIds.length} 条，补入{' '}
                  {flow.qualificationReview.addedCommentIds.length} 条。
                  {flow.qualificationReview.semanticStatus}
                </p>
                <p className="field-hint">
                  复核时间：{new Date(flow.qualificationReview.reviewedAt).toLocaleString()}
                  。候选表示有可复核的咨询证据，不代表已确认购买或付费。降级不删除原 CRM 跟进记录。
                </p>
                {[
                  ...flow.qualificationReview.originalCommentIds,
                  ...flow.qualificationReview.addedCommentIds,
                ].map((id) => {
                  const c = data.comments.find((c) => c.id === id);
                  if (!c) return null;
                  const a = assessComment(
                    c,
                    data.notes.find((n) => n.id === c.noteId),
                    Date.now(),
                    data.comments,
                  );
                  const added = flow.qualificationReview!.addedCommentIds.includes(id);
                  return (
                    <article key={id} className="review-item">
                      <b>
                        {added
                          ? '补入候选'
                          : flow.qualificationReview!.removedCommentIds.includes(id)
                            ? '降级待确认'
                            : '保留原候选'}{' '}
                        · {c.author} · {a.verdict}
                      </b>
                      <blockquote>{c.body}</blockquote>
                      <p>{a.reason}</p>
                      <p className="field-hint">
                        所属作品：{data.notes.find((n) => n.id === c.noteId)?.title} ·{' '}
                        {c.createdAt ? new Date(c.createdAt).toLocaleString() : '日期待核实'}
                      </p>
                      <AssessmentDetails assessment={a} />
                    </article>
                  );
                })}
              </section>
            )}
            <div className="acquisition-toolbar">
              <h3>
                本次候选线索 <small>近7天 · 明确需求 · 待人工复核</small>
              </h3>
              {leads.length > 0 && (
                <button
                  className="btn"
                  onClick={() =>
                    void downloadExport('leads', 'csv', flow.leadIds).catch((e) =>
                      notify(e.message, true),
                    )
                  }
                >
                  <Download size={14} />
                  导出本次候选
                </button>
              )}
            </div>
            {leads.length ? (
              <div className="workflow-leads">
                {leads.map((l) => (
                  <article className="workflow-lead" key={l.id}>
                    <div>
                      <b>{l.name}</b>
                      <span>
                        {l.score} 分 · {l.assessment?.ageDays ?? '未知'} 天前
                      </span>
                    </div>
                    <p>{l.content}</p>
                    <small>{l.reason}</small>
                    {l.assessment && <AssessmentDetails assessment={l.assessment} />}
                    <button className="text-btn" onClick={() => navigate('leads')}>
                      进入客户线索复核 <ArrowRight size={12} />
                    </button>
                  </article>
                ))}
              </div>
            ) : (
              <p className="acquisition-empty">
                {flow.status === 'completed'
                  ? '已完成采集，暂无满足近7天明确需求条件的候选。下方可查看原始评论及未入选理由。'
                  : '符合规则的候选将自动保存到这里，已读评论也会保留。'}
              </p>
            )}
            <details open className="workflow-details">
              <summary>作品与选样依据（{notes.length}）</summary>
              <div className="workflow-note-list">
                {notes.map((n) => (
                  <article key={n.id}>
                    <div>
                      <b>{n.title}</b>
                      <small>
                        {n.author} ·{' '}
                        {n.commentCountKnown === false
                          ? '评论数待核实'
                          : `${n.comments} 条平台评论`}{' '}
                        ·{' '}
                        {n.publishedAt
                          ? new Date(n.publishedAt).toLocaleDateString()
                          : '日期待核实'}
                      </small>
                      <p>{acquisitionPriority(n, data.comments).reason}</p>
                    </div>
                    <button
                      className="btn"
                      onClick={() => {
                        setCommentNoteId(n.id);
                        navigate('comments');
                      }}
                    >
                      {flow.completedNoteIds.includes(n.id)
                        ? '查看评论'
                        : flow.selectedNoteIds.includes(n.id)
                          ? '已选采样'
                          : '查看作品评论'}
                    </button>
                  </article>
                ))}
              </div>
            </details>
            <details open className="workflow-details">
              <summary>原始评论与判断（{comments.length}）</summary>
              <label className="field-label">
                筛选复核结论
                <select
                  aria-label="筛选复核结论"
                  value={reviewFilter}
                  onChange={(e) => setReviewFilter(e.target.value)}
                >
                  <option value="all">全部评论</option>
                  <option value="candidate">本地规则候选</option>
                  <option value="interest">兴趣与成本比较，待确认</option>
                  <option value="resolved">已购买或售后</option>
                  <option value="model">模型建议，待人工确认</option>
                  <option value="excluded">已排除</option>
                </select>
              </label>
              <div className="workflow-comment-list">
                {comments.map((c) => {
                  const a = assessComment(
                    c,
                    data.notes.find((n) => n.id === c.noteId),
                    Date.now(),
                    data.comments,
                  );
                  const accepted = a.recommended && a.withinSevenDays === true;
                  if (
                    (reviewFilter === 'candidate' && !accepted) ||
                    (reviewFilter === 'interest' && a.intentType !== 'interest') ||
                    (reviewFilter === 'resolved' && a.stage !== 'resolved') ||
                    (reviewFilter === 'excluded' && !a.exclusions.length) ||
                    (reviewFilter === 'model' &&
                      (!a.semantic ||
                        !['purchase', 'service'].includes(a.semantic.verdict) ||
                        accepted))
                  )
                    return null;
                  return (
                    <article key={c.id}>
                      <div>
                        <b>{c.author}</b>
                        <small>
                          {c.createdAt ? new Date(c.createdAt).toLocaleString() : '原始日期缺失'} ·{' '}
                          {c.parentId ? '回复' : '主评论'}
                        </small>
                        <span>{accepted ? '候选需求' : '未入选'}</span>
                      </div>
                      <p>{c.body}</p>
                      <small>
                        {a.reason}
                        {a.recommended && !accepted ? ' · 超出本流程近7天窗口' : ''}
                      </small>
                      <AssessmentDetails assessment={a} />
                    </article>
                  );
                })}
              </div>
            </details>
            <details className="workflow-details">
              <summary>执行日志与搜索凭据</summary>
              {flow.searchJobIds.map((id) => {
                const j = data.jobs.find((x) => x.id === id);
                return (
                  j && (
                    <p className="field-hint" key={id}>
                      搜索 {j.query?.sort} · {j.status} · {j.count} 条 ·{' '}
                      {j.searchEvidence ? `平台响应：${j.searchEvidence.path}` : '无平台排序凭据'}
                      {j.dataFetchedAt
                        ? ` · 数据读取于 ${new Date(j.dataFetchedAt).toLocaleString()}`
                        : ''}
                    </p>
                  )
                );
              })}
              <ol className="workflow-logs">
                {flow.logs.map((l, i) => (
                  <li key={i}>
                    <time>{new Date(l.at).toLocaleTimeString()}</time>
                    {l.message}
                  </li>
                ))}
              </ol>
            </details>
          </>
        )}
      </section>
    </>
  );
}
