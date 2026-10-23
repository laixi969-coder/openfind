import { Router } from 'express';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import type { InboxThread, ReplyDraft, NativeInbox, InboxMessage } from '../shared/messages.ts';
import type { Platform, Lead } from '../shared/types.ts';
import type { SalesCase, SalesProfile } from '../shared/sales.ts';
import { emptySalesProfile, stopsContact } from '../shared/sales.ts';
import { get, put, all, configGet } from './store.ts';
import { browserCall } from './platforms/client.ts';
import { transcriptHash, threadHash } from './message-hash.ts';
import { suggestPrivateReply } from './llm.ts';
import { intentScore } from './domain.ts';
import { readCase, restricted } from './sales.ts';
import { protectionStatus } from './protection.ts';
import { serviceIdentity } from './services.ts';
export const inboxTransport = {
  call: (body: unknown) => browserCall<NativeInbox>('/messaging', body),
};
const platformSchema = z.enum(['xiaohongshu', 'douyin']);
const router = Router();
const locks = new Set<Platform>();
export const inboxBusy = () => locks.size > 0 || suggesting.size > 0;
const draftHash = (t: InboxThread) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        threadHash(t),
        configGet('sales:profile'),
        configGet('llm:revision'),
        serviceIdentity(),
        'reply-policy-2',
      ]),
    )
    .digest('hex');
function thread(id: string) {
  const t = get<InboxThread>('inboxThreads', id);
  if (!t) throw new Error('会话不存在');
  return t;
}
const stableId = (p: Platform, a: string, id: string) =>
  createHash('sha256')
    .update(JSON.stringify([p, a, id]))
    .digest('hex');
export const isSystemGreeting = (m: InboxMessage) =>
  /^(我们已相互关注，开始聊天吧|我们已互相关注|你们已互相关注|你们已成为好友)/.test(m.text);
const optedOut = stopsContact;
function assertContact(t: InboxThread) {
  if (t.leadId && !get<Lead>('leads', t.leadId))
    throw new Error('关联原线索已删除，请解除关联后继续');
  if (t.stopped || (t.leadId && readCase(t.leadId).stopped))
    throw new Error('已停止联系，不能生成或发送');
  if (t.leadId && restricted(t.leadId)) throw new Error('敏感主题线索不用于个人营销联系');
}
export function mergeNative(data: NativeInbox): InboxThread[] {
  if (!data.accountId) throw new Error('没有可验证的登录身份');
  return data.threads.map((row, position) => {
    const id = stableId(data.platform, data.accountId, row.nativeId);
    const old = get<InboxThread>('inboxThreads', id);
    const selected = data.selected?.nativeId === row.nativeId ? data.selected.messages : undefined;
    const messages = selected || old?.messages || [];
    const changed = selected && transcriptHash(messages) !== transcriptHash(old?.messages || []);
    const next: InboxThread = {
      ...old,
      id,
      platform: data.platform,
      accountId: data.accountId,
      accountName: data.accountName,
      nativeId: row.nativeId,
      peerId: row.peerId || old?.peerId,
      name: row.name,
      preview: row.preview,
      timeLabel: row.timeLabel,
      position,
      messages,
      revision: (old?.revision || 0) + (changed ? 1 : 0),
      watching: false,
      autoSuggest: false,
      stopped:
        old?.stopped || !!selected?.some((m) => m.direction === 'incoming' && optedOut(m.text)),
      syncedAt: new Date().toISOString(),
      error: selected ? '' : old?.error || '',
    };
    put('inboxThreads', next);
    if (changed) {
      for (const d of all<ReplyDraft>('replyDrafts').filter(
        (d) => d.threadId === id && d.status === 'pending',
      ))
        put('replyDrafts', { ...d, status: 'stale' });
      if (next.leadId) {
        const record = readCase(next.leadId);
        const additions = messages.filter(
          (m) =>
            !isSystemGreeting(m) &&
            m.kind === 'text' &&
            !record.events.some((e) => e.id === `im:${id}:${m.nativeId}`),
        );
        if (additions.length) {
          const optout = additions.some((m) => m.direction === 'incoming' && stopsContact(m.text));
          put<SalesCase>('salesCases', {
            ...record,
            events: [
              ...record.events,
              ...additions.map((m) => ({
                id: `im:${id}:${m.nativeId}`,
                kind: m.direction,
                channel: 'message' as const,
                content: m.text,
                createdAt: new Date().toISOString(),
                platformMessage: {
                  platform: data.platform,
                  accountId: data.accountId,
                  threadId: id,
                  messageId: m.nativeId,
                  timeLabel: m.timeLabel,
                },
              })),
            ],
            revision: record.revision + 1,
            updatedAt: new Date().toISOString(),
            ...(optout
              ? {
                  stopped: true,
                  nextFollowUp: '',
                  nextAction: '停止主动联系',
                  stage: record.stage === 'won' ? 'won' : 'lost',
                }
              : {}),
          });
        }
      }
    }
    return next;
  });
}
export async function syncInbox(platform: Platform, id?: string) {
  if (locks.has(platform)) throw new Error('该平台私信操作进行中，请稍后');
  if (protectionStatus(platform).paused) throw new Error('平台保护暂停，请先在设置处理验证或异常');
  locks.add(platform);
  try {
    const t = id ? thread(id) : undefined;
    if (t && t.platform !== platform) throw new Error('平台与会话不符');
    const result = await inboxTransport.call({
      platform,
      operation: t ? 'read' : 'list',
      accountId: t?.accountId,
      nativeId: t?.nativeId,
      refresh: true,
    });
    if (
      result.platform !== platform ||
      (t &&
        (result.accountId !== t.accountId ||
          result.selected?.nativeId !== t.nativeId ||
          !result.threads.some((r) => r.nativeId === t.nativeId)))
    )
      throw new Error('平台身份或会话变化，请重新连接');
    return mergeNative(result);
  } finally {
    locks.delete(platform);
  }
}
function draftView(t: InboxThread, d: ReplyDraft) {
  return d.status === 'pending' && d.contextHash !== draftHash(t)
    ? { ...d, status: 'stale' as const }
    : d;
}
router.get('/inbox', (_req, res) =>
  res.json({
    threads: all<InboxThread>('inboxThreads')
      .map((t) => ({ ...t, suggestionGenerating: suggesting.has(t.id) }))
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0)),
    drafts: all<ReplyDraft>('replyDrafts').map((d) => draftView(thread(d.threadId), d)),
  }),
);
router.post('/inbox/:platform/sync', async (req, res) =>
  res.json(
    await syncInbox(
      platformSchema.parse(req.params.platform),
      z.string().optional().parse(req.body.threadId),
    ),
  ),
);
router.put('/inbox/threads/:id', async (req, res) => {
  const input = z
    .object({
      revision: z.number().int(),
      watching: z.boolean(),
      autoSuggest: z.boolean(),
      leadId: z.string().optional(),
      stopped: z.boolean(),
    })
    .strict()
    .parse(req.body);
  if (input.watching || input.autoSuggest) {
    res.status(410).json({ error: '自动托管已取消，请手动同步或生成草稿。' });
    return;
  }
  const t = thread(String(req.params.id));
  if (input.revision !== t.revision) {
    res.status(409).json({ error: '会话已变化，请刷新后设置' });
    return;
  }
  if (input.leadId) {
    const lead = get<Lead>('leads', input.leadId);
    if (
      !lead ||
      lead.source !== 'live' ||
      (lead.platform || 'xiaohongshu') !== t.platform ||
      lead.authorId !== (t.peerId || t.nativeId)
    )
      throw new Error('只能关联同平台且用户标识完全一致的真实线索，昵称匹配无效');
  }
  const next = {
    ...t,
    ...input,
    leadId: input.leadId === undefined ? t.leadId : input.leadId || undefined,
    revision: t.revision + 1,
  };
  put('inboxThreads', next);
  res.json(next);
});
async function generateSuggestionInternal(id: string) {
  const t = thread(id);
  assertContact(t);
  const messages = t.messages.filter((m) => m.kind === 'text' && !isSystemGreeting(m));
  if (!messages.length || messages.at(-1)?.direction !== 'incoming')
    throw new Error('尚无新的真实来信，不能生成客户回复建议');
  const originalComment = t.leadId ? get<Lead>('leads', t.leadId)?.content || '' : '';
  if (
    intentScore('', '', originalComment + '\n' + messages.map((m) => m.text).join('\n')).stage ===
    'restricted'
  )
    throw new Error('该会话含敏感主题，保留人工处理，不发送给模型');
  const hash = draftHash(t);
  const profile: SalesProfile = JSON.parse(
    configGet('sales:profile', JSON.stringify(emptySalesProfile)),
  );
  const result = await suggestPrivateReply({ originalComment, profile: { ...profile }, messages }, [
    { kind: 'inboxThreads', id },
    ...(t.leadId ? [{ kind: 'leads' as const, id: t.leadId }] : []),
  ]);
  const latest = thread(id);
  assertContact(latest);
  if (draftHash(latest) !== hash) throw new Error('生成期间会话已变化，请重新生成');
  const draft: ReplyDraft = {
    id: randomUUID(),
    threadId: id,
    contextHash: hash,
    ...result,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  put('replyDrafts', draft);
  return draft;
}
const suggesting = new Set<string>();
export async function generateSuggestion(id: string) {
  if (suggesting.has(id)) throw new Error('该会话正在生成建议，请等待');
  suggesting.add(id);
  try {
    const result = await generateSuggestionInternal(id);
    put('inboxThreads', { ...thread(id), suggestionError: '' });
    return result;
  } catch (e) {
    put('inboxThreads', { ...thread(id), suggestionError: (e as Error).message });
    throw e;
  } finally {
    suggesting.delete(id);
  }
}
router.post('/inbox/threads/:id/suggest', async (req, res) => {
  if (req.body.confirmContextToModel !== true)
    throw new Error('请确认将脱敏聊天上下文发往所配置的模型服务');
  res.json(await generateSuggestion(String(req.params.id)));
});
router.post('/inbox/threads/:id/drafts', (req, res) => {
  const t = thread(String(req.params.id));
  assertContact(t);
  const input = z
    .object({ text: z.string().trim().min(1).max(1000), revision: z.number().int() })
    .strict()
    .parse(req.body);
  if (input.revision !== t.revision) throw new Error('会话已变化，请刷新后保存草稿');
  const draft: ReplyDraft = {
    id: randomUUID(),
    threadId: t.id,
    contextHash: draftHash(t),
    text: input.text,
    rationale: '人工编写；尚未发送',
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  put('replyDrafts', draft);
  res.json(draft);
});
router.post('/inbox/drafts/:id/send', (_req, res) => {
  res.status(410).json({ error: '平台发送已取消，请复制草稿后自行到官方平台发送。' });
});
router.post('/inbox/drafts/:id/reconcile', async (req, res) => {
  const d = get<ReplyDraft>('replyDrafts', String(req.params.id));
  if (!d || d.status !== 'unknown' || !d.beforeMessageIds)
    throw new Error('此草稿没有可核对的发送记录');
  const t = thread(d.threadId);
  if (locks.has(t.platform)) throw new Error('平台操作进行中，请稍后');
  locks.add(t.platform);
  try {
    const data = await inboxTransport.call({
      platform: t.platform,
      operation: 'read',
      accountId: t.accountId,
      nativeId: t.nativeId,
      refresh: true,
    });
    if (
      data.platform !== t.platform ||
      data.accountId !== t.accountId ||
      data.selected?.nativeId !== t.nativeId ||
      !data.threads.some((r) => r.nativeId === t.nativeId)
    )
      throw new Error('平台身份或会话变化');
    mergeNative(data);
    const matches = data.selected.messages.filter(
      (m) =>
        m.direction === 'outgoing' &&
        m.text === d.text &&
        !d.beforeMessageIds!.includes(m.nativeId),
    );
    if (matches.length !== 1) throw new Error('刷新官方会话后仍无法唯一核对，保持锁定，未重发');
    put('replyDrafts', { ...d, status: 'sent', sentMessageId: matches[0].nativeId });
    res.json({ ok: true, messageId: matches[0].nativeId });
  } finally {
    locks.delete(t.platform);
  }
});
for (const d of all<ReplyDraft>('replyDrafts').filter((d) => d.status === 'sending'))
  put('replyDrafts', { ...d, status: 'unknown' });
// Compatibility for old callers: background platform access is permanently disabled.
export async function pollInbox() {}
for (const t of all<InboxThread>('inboxThreads')) {
  if (t.watching || t.autoSuggest)
    put('inboxThreads', { ...t, watching: false, autoSuggest: false });
}
export default router;
