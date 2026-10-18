import type { Comment, Note, QualificationComparison } from '../shared/types.ts';
import { assessComment } from './domain.ts';

/** Disagreement is an audit queue, not evidence that either classifier is correct. */
export function compareQualifications(
  comments: Comment[],
  notes: Note[],
  context = comments,
  now = Date.now(),
): QualificationComparison {
  const rows: QualificationComparison['rows'] = comments.map((c) => {
    const a = assessComment(
      c,
      notes.find((n) => n.id === c.noteId),
      now,
      context,
    );
    const ruleAccepted = a.recommended && a.withinSevenDays === true;
    const model = a.semantic;
    const modelAccepted =
      !!model &&
      !a.exclusions.length &&
      a.withinSevenDays === true &&
      ['purchase', 'service'].includes(model.verdict);
    const status = a.exclusions.length
      ? 'excluded'
      : !model
        ? 'pending'
        : ruleAccepted !== modelAccepted
          ? ruleAccepted
            ? 'rule_only'
            : 'model_only'
          : a.intentType !== model.verdict
            ? 'type_difference'
            : 'agree';
    return {
      commentId: c.id,
      ruleIntent: a.intentType || a.stage,
      ruleAccepted,
      modelIntent: model?.verdict,
      modelAccepted: model ? modelAccepted : undefined,
      status,
      ruleReason: a.reason,
      modelReason: model?.reason,
      restrictions: a.exclusions,
      withinSevenDays: a.withinSevenDays === true,
    };
  });
  return {
    total: rows.length,
    reviewed: rows.filter((r) => r.modelIntent !== undefined).length,
    excluded: rows.filter((r) => r.status === 'excluded').length,
    pending: rows.filter((r) => r.status === 'pending').length,
    agreed: rows.filter((r) => r.status === 'agree').length,
    ruleOnly: rows.filter((r) => r.status === 'rule_only').length,
    modelOnly: rows.filter((r) => r.status === 'model_only').length,
    typeDifferences: rows.filter((r) => r.status === 'type_difference').length,
    rows,
  };
}
