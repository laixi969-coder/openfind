import type { LeadAssessment } from '../../shared/types';
export function AssessmentDetails({ assessment: a }: { assessment: LeadAssessment }) {
  return (
    <details className="assessment-details">
      <summary>查看具体判断依据 · {a.verdict || a.stage}</summary>
      <p>
        <b>{a.verdict || a.reason}</b> · {a.version} · 分数用于排序，不代表购买概率
      </p>
      <ul>
        {a.evidence.map((e, i) => (
          <li key={i}>
            <b>{e.label}</b>：<q>{e.excerpt}</q>（{e.points > 0 ? '+' : ''}
            {e.points}）
          </li>
        ))}
      </ul>
      {!!a.exclusions.length && <p className="inline-error">排除原因：{a.exclusions.join('；')}</p>}
      {a.threadEvidence?.map((e) => (
        <blockquote key={e.commentId}>
          <b>{e.role}：</b>
          {e.text}
        </blockquote>
      ))}
      {a.limitations?.map((text, i) => (
        <p className="field-hint" key={i}>
          待核实：{text}
        </p>
      ))}
      {a.semantic && (
        <section className="semantic-result">
          <b>
            模型补充建议 · {a.semantic.model} · {a.semantic.verdict}
          </b>
          <p>{a.semantic.reason}</p>
          {a.semantic.quotes.map((quote, i) => (
            <blockquote key={i}>{quote}</blockquote>
          ))}
          {a.semantic.limitations.map((text, i) => (
            <p key={i}>待核实：{text}</p>
          ))}
          <small>
            {new Date(a.semantic.reviewedAt).toLocaleString()} ·
            模型建议不自动改变候选，不替代人工判断
          </small>
        </section>
      )}
    </details>
  );
}
