import { useState } from 'react';
import type { Comment, Note, QualificationComparison as Comparison } from '../../shared/types';
const names: Record<string, string> = {
  purchase: '产品或渠道咨询',
  service: '服务咨询',
  interest: '兴趣待确认',
  discussion: '普通讨论',
  resolved: '已购买或已结束',
  restricted: '敏感主题',
  agree: '一致',
  rule_only: '仅规则入选',
  model_only: '仅模型建议',
  type_difference: '咨询类型不同',
  excluded: '本地硬性排除',
  pending: '尚未获得有效模型结果',
};
export function QualificationComparison({
  comparison,
  comments,
  notes,
}: {
  comparison: Comparison;
  comments: Comment[];
  notes: Note[];
}) {
  const [filter, setFilter] = useState('differences');
  const differences = ['rule_only', 'model_only', 'type_difference'];
  const shown = comparison.rows.filter(
    (r) =>
      filter === 'all' ||
      (filter === 'differences' && differences.includes(r.status)) ||
      filter === r.status,
  );
  return (
    <details className="workflow-details comparison-panel">
      <summary>
        规则与模型对照 · 已复核 {comparison.reviewed}/{comparison.total} 条
      </summary>
      <p>
        范围 {comparison.total} 条 · 有效模型结果 {comparison.reviewed} 条 · 本地排除{' '}
        {comparison.excluded} 条 · 待处理 {comparison.pending} 条。
      </p>
      <p>
        一致 {comparison.agreed} 条 · 仅规则入选 {comparison.ruleOnly} 条 · 仅模型建议{' '}
        {comparison.modelOnly} 条 · 类型不同 {comparison.typeDifferences} 条。
      </p>
      <p className="field-hint">
        分歧需要逐条核对原文，不能据此直接计算准确率或认定模型正确。作者、敏感语境等本地排除不发送模型；日期限制仍决定能否进入近期候选。
      </p>
      <label className="field-label">
        对照筛选
        <select
          aria-label="规则模型对照筛选"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="differences">只看分歧</option>
          <option value="all">全部范围内的评论（{comparison.total}）</option>
          {Object.entries(names)
            .filter(([key]) =>
              [
                'rule_only',
                'model_only',
                'type_difference',
                'excluded',
                'pending',
                'agree',
              ].includes(key),
            )
            .map(([key, name]) => (
              <option value={key} key={key}>
                {name}
              </option>
            ))}
        </select>
      </label>
      {!shown.length && <p>当前筛选没有记录。</p>}
      {shown.map((row) => {
        const c = comments.find((c) => c.id === row.commentId);
        return (
          <article className="review-item" key={row.commentId}>
            <b>
              {names[row.status]} · 规则：{names[row.ruleIntent] || row.ruleIntent} · 模型：
              {row.modelIntent ? names[row.modelIntent] || row.modelIntent : '未评估'}
            </b>
            <blockquote>{c?.body || '原评论不可用'}</blockquote>
            <small>{notes.find((n) => n.id === c?.noteId)?.title}</small>
            <p>规则依据：{row.ruleReason}</p>
            {row.modelReason && <p>模型依据：{row.modelReason}</p>}
            {c?.semantic?.validationWarning && (
              <p className="inline-error">证据校验：{c.semantic.validationWarning}</p>
            )}
            {c?.semantic?.quotes.map((q, i) => (
              <blockquote key={i}>模型引用：{q}</blockquote>
            ))}
            {!row.withinSevenDays && (
              <p className="field-hint">原始日期不在近7天窗口，模型建议不自动进入近期候选。</p>
            )}
          </article>
        );
      })}
    </details>
  );
}
