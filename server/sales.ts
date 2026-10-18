import { Router } from 'express';
import { assessComment } from './domain.ts';
import { z } from 'zod';
import { get, put, all, configGet, configSet } from './store.ts';
import type { Lead, Note, Comment } from '../shared/types.ts';
import {
  emptySalesCase,
  emptySalesProfile,
  type SalesCase,
  type SalesEvent,
} from '../shared/sales.ts';
const router = Router();
const identity = (lead: Lead) =>
  `${lead.source}:${lead.platform || get<Note>('notes', lead.noteId)?.platform || 'xiaohongshu'}:${lead.authorId || lead.id}`;
export function readCase(id: string) {
  const record = get<SalesCase>('salesCases', id) || emptySalesCase(id);
  const lead = get<Lead>('leads', id)!;
  const duplicates = all<Lead>('leads').filter((other) => identity(other) === identity(lead));
  const relatedLeadId = duplicates.find(
    (other) =>
      other.id !== id &&
      get<SalesCase>('salesCases', other.id)?.events.some((e) => e.kind === 'outgoing'),
  )?.id;
  const stopped =
    record.stopped || duplicates.some((other) => get<SalesCase>('salesCases', other.id)?.stopped);
  return {
    ...record,
    relatedLeadId,
    ...(stopped
      ? {
          stopped: true,
          nextFollowUp: '',
          nextAction: '停止主动联系',
          stage: record.stage === 'won' ? ('won' as const) : ('lost' as const),
        }
      : {}),
  };
}
export function restricted(id: string) {
  const lead = get<Lead>('leads', id)!;
  const comment = get<Comment>('comments', lead.commentId);
  return comment
    ? assessComment(comment, get<Note>('notes', lead.noteId), Date.now(), all<Comment>('comments'))
        .stage === 'restricted'
    : lead.assessment?.stage === 'restricted';
}
const text = z.string().trim().max(2000);
const profileSchema = z
  .object({
    identity: text,
    offering: text,
    regions: text,
    priceRange: text,
    value: text,
    proof: text,
  })
  .strict();
router.get('/sales/profile', (_req, res) =>
  res.json(JSON.parse(configGet('sales:profile', JSON.stringify(emptySalesProfile)))),
);
router.put('/sales/profile', (req, res) => {
  const p = profileSchema.parse(req.body);
  configSet('sales:profile', JSON.stringify(p));
  res.json(p);
});
router.get('/sales/export', (_req, res) =>
  res
    .attachment('openfind-sales-records.json')
    .json({ exportedAt: new Date().toISOString(), cases: all<SalesCase>('salesCases') }),
);
router.get('/sales/summary', (_req, res) => {
  const leads = all<Lead>('leads');
  res.json(
    ['live', 'demo'].map((source) => {
      const cases = all<SalesCase>('salesCases')
        .filter((c) => leads.some((l) => l.id === c.id && l.source === source))
        .map((c) => readCase(c.id));
      const followUps = cases
        .filter(
          (c) =>
            !c.stopped &&
            !['won', 'lost'].includes(c.stage) &&
            c.nextFollowUp &&
            Date.parse(c.nextFollowUp) <= Date.now(),
        )
        .sort((a, b) => a.nextFollowUp.localeCompare(b.nextFollowUp));
      return {
        source,
        followUps: followUps.slice(0, 20).map((c) => ({
          id: c.id,
          name: leads.find((l) => l.id === c.id)!.name,
          action: c.nextAction,
          at: c.nextFollowUp,
        })),
        contacted: cases.filter((c) => c.events.some((e) => e.kind === 'outgoing')).length,
        replied: cases.filter((c) => c.events.some((e) => e.kind === 'incoming')).length,
        won: cases.filter((c) => c.stage === 'won').length,
        amount: cases.filter((c) => c.stage === 'won').reduce((n, c) => n + c.amount, 0),
        due: cases.filter(
          (c) =>
            !c.stopped &&
            !['won', 'lost'].includes(c.stage) &&
            c.nextFollowUp &&
            Date.parse(c.nextFollowUp) <= Date.now(),
        ).length,
      };
    }),
  );
});
router.use('/leads/:id/sales', (req, res, next) => {
  if (!get<Lead>('leads', String(req.params.id))) {
    res.status(404).json({ error: '客户不存在' });
    return;
  }
  next();
});
router.get('/leads/:id/sales', (req, res) => res.json(readCase(String(req.params.id))));
const patchSchema = z
  .object({
    revision: z.number().int().min(0),
    stage: z.enum(['new', 'contacted', 'replied', 'qualified', 'quoted', 'won', 'lost']),
    need: text,
    timing: text,
    budget: text,
    objection: text,
    nextAction: text,
    nextFollowUp: z.union([z.literal(''), z.iso.datetime()]),
    orderReference: text,
    amount: z.number().min(0).max(1000000000),
  })
  .strict();
router.put('/leads/:id/sales', (req, res) => {
  const id = String(req.params.id),
    current = readCase(id),
    patch = patchSchema.parse(req.body);
  if (patch.revision !== current.revision) {
    res.status(409).json({ error: '记录已变化，请重新打开后保存' });
    return;
  }
  const kinds = current.events.map((e) => e.kind);
  let error = '';
  if (current.stopped && patch.stage !== current.stage)
    error = '已明确拒绝联系，不能继续推进销售阶段';
  else if (restricted(id) && !['new', 'lost'].includes(patch.stage))
    error = '敏感主题不进入销售沟通流程';
  else if (
    ['contacted', 'replied', 'qualified', 'quoted', 'won'].includes(patch.stage) &&
    !kinds.includes('outgoing')
  )
    error = '先记录实际发出的沟通，再推进阶段';
  else if (
    ['replied', 'qualified', 'quoted', 'won'].includes(patch.stage) &&
    !kinds.includes('incoming')
  )
    error = '尚无客户实际回复，不能认定需求已确认或成交';
  else if (['qualified', 'quoted', 'won'].includes(patch.stage) && (!patch.need || !patch.timing))
    error = '请根据客户回复填写需求和行动时间';
  else if (['quoted', 'won'].includes(patch.stage) && !kinds.includes('quote'))
    error = '请记录实际提供的方案或报价及条件';
  else if (
    patch.stage === 'won' &&
    (!kinds.includes('order') || !patch.orderReference || patch.amount <= 0)
  )
    error = '成交登记需要订单记录、凭证说明/编号和实际金额';
  if (error) {
    res.status(400).json({ error });
    return;
  }
  const record = {
    ...current,
    ...patch,
    revision: current.revision + 1,
    updatedAt: new Date().toISOString(),
  };
  put('salesCases', record);
  res.json(record);
});
const eventSchema = z
  .object({
    id: z.uuid(),
    kind: z.enum(['outgoing', 'incoming', 'note', 'quote', 'order', 'optout']),
    channel: z.enum(['comment', 'message', 'other']),
    content: z.string().trim().min(1).max(3000),
  })
  .strict();
router.post('/leads/:id/sales/events', (req, res) => {
  const id = String(req.params.id),
    record = readCase(id),
    input = eventSchema.parse(req.body);
  const existing = record.events.find((e) => e.id === input.id);
  if (existing) {
    if (
      existing.kind !== input.kind ||
      existing.channel !== input.channel ||
      existing.content !== input.content
    ) {
      res.status(409).json({ error: '该提交编号已保存不同内容，请重新载入记录核对' });
      return;
    }
    res.json(record);
    return;
  }
  if ((record.stopped || restricted(id)) && ['outgoing', 'quote'].includes(input.kind)) {
    res.status(400).json({ error: '对方已拒绝联系，请停止主动沟通' });
    return;
  }
  if (record.events.length >= 500) {
    res.status(400).json({ error: '记录已达500条上限，请导出归档后人工处理' });
    return;
  }
  const event: SalesEvent = { ...input, createdAt: new Date().toISOString() };
  const next = {
    ...record,
    events: [...record.events, event],
    revision: record.revision + 1,
    updatedAt: event.createdAt,
    ...(input.kind === 'optout'
      ? {
          stopped: true,
          stage: record.stage === 'won' ? ('won' as const) : ('lost' as const),
          nextFollowUp: '',
          nextAction: '停止主动联系',
        }
      : {}),
  };
  put('salesCases', next);
  res.json(next);
});
export default router;
