import type { Lead } from './types.ts';
export const salesStages = {
  new: '待沟通',
  contacted: '已联系',
  replied: '已回复',
  qualified: '需求已确认',
  quoted: '已提供方案/报价',
  won: '已登记成交',
  lost: '已结束',
} as const;
export type SalesStage = keyof typeof salesStages;
export interface SalesProfile {
  identity: string;
  offering: string;
  regions: string;
  priceRange: string;
  value: string;
  proof: string;
}
export const emptySalesProfile: SalesProfile = {
  identity: '',
  offering: '',
  regions: '',
  priceRange: '',
  value: '',
  proof: '',
};
export interface SalesEvent {
  platformMessage?: {
    platform: string;
    accountId: string;
    threadId: string;
    messageId: string;
    timeLabel: string;
  };
  id: string;
  kind: 'outgoing' | 'incoming' | 'note' | 'quote' | 'order' | 'optout';
  channel: 'comment' | 'message' | 'other';
  content: string;
  createdAt: string;
}
export interface SalesCase {
  relatedLeadId?: string;
  id: string;
  revision: number;
  stage: SalesStage;
  need: string;
  timing: string;
  budget: string;
  objection: string;
  nextAction: string;
  nextFollowUp: string;
  stopped: boolean;
  orderReference: string;
  amount: number;
  events: SalesEvent[];
  updatedAt: string;
}
export const emptySalesCase = (id: string): SalesCase => ({
  id,
  revision: 0,
  stage: 'new',
  need: '',
  timing: '',
  budget: '',
  objection: '',
  nextAction: '',
  nextFollowUp: '',
  stopped: false,
  orderReference: '',
  amount: 0,
  events: [],
  updatedAt: '',
});
export function communicationPlan(lead: Lead, profile: SalesProfile, record: SalesCase) {
  const blocked =
    record.stopped ||
    ['won', 'lost'].includes(record.stage) ||
    lead.assessment?.stage === 'restricted';
  if (blocked)
    return { blocked: true, draft: '', goal: '已停止主动沟通；保留记录，不生成催促话术。' };
  if (record.relatedLeadId && !record.events.some((e) => e.kind === 'outgoing'))
    return {
      blocked: true,
      draft: '',
      goal: '同一用户已在另一条线索中联系过，请在原沟通记录继续，避免重复接触。',
    };
  if (!profile.identity.trim() || !profile.offering.trim() || !profile.value.trim())
    return {
      blocked: true,
      draft: '',
      goal: '先填写真实业务身份、产品/服务和本次可提供的帮助，避免假装自己是原博主或编造服务能力。',
    };
  if (!record.events.some((e) => e.kind === 'outgoing'))
    return {
      blocked: false,
      goal: '先表明身份，回应原问题，确认需求是否仍存在；一次只问一个问题。',
      draft: `你好，看到你问「${lead.content.slice(0, 65)}」。我是${profile.identity}，提供${profile.offering}。${profile.value}。这个问题你现在还需要了解吗？`,
    };
  if (!record.events.some((e) => e.kind === 'incoming'))
    return {
      blocked: true,
      draft: '',
      goal: '首条沟通尚无回复。先等待，不连续追问；只有对方同意的后续联系或新的有效互动才安排下一步。',
    };
  if (!record.need.trim())
    return {
      blocked: false,
      goal: '复述需求并确认具体目标，先问现状，不急着报价。',
      draft: '了解。你目前最想解决的一个具体问题是什么？我先按你的实际情况判断是否适合。',
    };
  if (!record.timing.trim())
    return {
      blocked: false,
      goal: '确认行动时间，区分收集灵感和近期要解决的问题。',
      draft: `关于${record.need}，你希望大概什么时候解决？`,
    };
  if (record.stage === 'quoted')
    return {
      blocked: false,
      goal: '找出方案与实际需求的差距，约定一个具体下一步。',
      draft: '上次的方案里，你觉得最需要调整的是哪一部分？',
    };
  return {
    blocked: false,
    goal: '核对适配和顾虑，再给有依据的选项；报价须人工确认范围与条件。',
    draft: record.budget.trim()
      ? `我理解你希望${record.timing}解决${record.need}。目前还有哪一点顾虑需要我先说明？`
      : '为避免推荐不合适的方案，你方便说一下可接受的预算范围吗？',
  };
}
