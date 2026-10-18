import { z } from 'zod';
import type { CollectionPolicy } from '../shared/types.ts';
import type { Platform } from '../shared/types.ts';
import { configGet, configSet } from './store.ts';
export type PlatformAction = 'search' | 'comments' | 'publish' | 'prepare';
export class ProtectionError extends Error {}
export const operationLimits = { search: 100, comments: 100, publish: 5, prepare: 10 } as const;
export const minimumReadInterval = 15000;
export const collectionPolicySchema = z
  .object({
    search: z
      .object({
        dailyLimit: z.number().int().min(1).max(10000),
        intervalMs: z.number().int().min(1000).max(3600000),
      })
      .strict(),
    comments: z
      .object({
        dailyLimit: z.number().int().min(1).max(10000),
        intervalMs: z.number().int().min(1000).max(3600000),
      })
      .strict(),
  })
  .strict();
export function collectionPolicy(platform: Platform): CollectionPolicy {
  try {
    return collectionPolicySchema.parse(
      JSON.parse(configGet('collection-policy:' + platform) || 'null'),
    );
  } catch {
    return {
      search: { dailyLimit: 100, intervalMs: 15000 },
      comments: { dailyLimit: 100, intervalMs: 15000 },
    };
  }
}
export function saveCollectionPolicy(platform: Platform, input: unknown) {
  const policy = collectionPolicySchema.parse(input);
  configSet('collection-policy:' + platform, JSON.stringify(policy));
  return policy;
}
export function readInterval(state: Protection, action: 'search' | 'comments') {
  return state.policy?.[action].intervalMs ?? minimumReadInterval;
}
interface Protection {
  policy?: CollectionPolicy;
  day: string;
  counts: Record<PlatformAction, number>;
  paused: boolean;
  reason: string;
  failures: number;
  lastReadAt?: number;
  lastUploadAt?: number;
}
export function freshProtection(now = Date.now()): Protection {
  return {
    day: new Date(now).toISOString().slice(0, 10),
    counts: { search: 0, comments: 0, publish: 0, prepare: 0 },
    paused: false,
    reason: '',
    failures: 0,
  };
}
export function evaluateBudget(state: Protection, action: PlatformAction, now = Date.now()) {
  if (state.paused) return `平台操作已暂停：${state.reason}。处理后请在连接设置中恢复`;
  const limit =
    action === 'search' || action === 'comments'
      ? (state.policy?.[action].dailyLimit ?? operationLimits[action])
      : operationLimits[action];
  if (state.counts[action] >= limit)
    return `已达到本地每日${action === 'search' ? '搜索批次' : action === 'comments' ? '评论批次' : action === 'prepare' ? '素材预览上传' : '发布提交'}上限 ${limit}；今日停止，不自动换号重试`;
  if (action === 'prepare' && state.lastUploadAt && now - state.lastUploadAt < 60000)
    return '本地素材上传间隔保护，请稍后再预览（至少间隔60秒）';
  if (
    (action === 'search' || action === 'comments') &&
    state.lastReadAt &&
    now - state.lastReadAt < readInterval(state, action)
  )
    return `本地采集间隔保护，请 ${Math.ceil((readInterval(state, action) - (now - state.lastReadAt)) / 1000)} 秒后再操作`;
  return '';
}
export function protectionStatus(platform: Platform): Protection {
  const blank = freshProtection();
  let previous: Protection;
  try {
    previous = JSON.parse(configGet('protection:' + platform) || 'null') || blank;
  } catch {
    previous = blank;
  }
  const state =
    previous.day === blank.day
      ? { ...previous, counts: { ...blank.counts, ...previous.counts } }
      : {
          ...blank,
          paused: previous.paused,
          reason: previous.reason,
          failures: previous.failures,
          lastReadAt: previous.lastReadAt,
          lastUploadAt: previous.lastUploadAt,
        };
  return { ...state, policy: collectionPolicy(platform) };
}
export function protectionView(platform: Platform, now = Date.now()) {
  const state = protectionStatus(platform);
  const resetAt = new Date(state.day + 'T00:00:00.000Z').getTime() + 86400000;
  return {
    ...state,
    policy: state.policy!,
    resetAt,
    budgets: Object.fromEntries(
      (['search', 'comments'] as const).map((action) => {
        const remaining = Math.max(0, state.policy![action].dailyLimit - state.counts[action]);
        return [
          action,
          {
            remaining,
            availableAt: state.paused
              ? null
              : Math.max(
                  now,
                  remaining ? 0 : resetAt,
                  (state.lastReadAt || 0) + readInterval(state, action),
                ),
          },
        ];
      }),
    ),
  };
}
function save(platform: Platform, state: Protection) {
  configSet('protection:' + platform, JSON.stringify(state));
}
export function reservePlatformAction(platform: Platform, action: PlatformAction) {
  const state = protectionStatus(platform);
  const error = evaluateBudget(state, action);
  if (error) throw new ProtectionError(error);
  state.counts[action]++;
  if (action === 'search' || action === 'comments') state.lastReadAt = Date.now();
  if (action === 'prepare') state.lastUploadAt = Date.now();
  save(platform, state);
}
export function pausePlatform(platform: Platform, reason: string) {
  save(platform, { ...protectionStatus(platform), paused: true, reason });
}
export function recordPlatformFailure(platform: Platform, message: string) {
  const state = protectionStatus(platform);
  state.failures++;
  if (
    /验证码|captcha|安全验证|请完成验证|频繁|429|403|本人.*验证/i.test(message) ||
    state.failures >= 3
  ) {
    state.paused = true;
    state.reason = /验证码|captcha|安全验证|请完成验证/i.test(message)
      ? '平台要求本人验证'
      : state.failures >= 3
        ? '连续三次操作失败，需要检查连接和平台提示'
        : '平台限制当前操作';
  }
  save(platform, state);
}
export function recordPlatformSuccess(platform: Platform) {
  save(platform, { ...protectionStatus(platform), failures: 0 });
}
export function resumePlatform(platform: Platform) {
  save(platform, { ...protectionStatus(platform), paused: false, reason: '', failures: 0 });
}
