import type { Platform } from '../shared/types.ts';
import { configGet, configSet } from './store.ts';
export type PlatformAction = 'search' | 'comments' | 'publish' | 'prepare';
export class ProtectionError extends Error {}
export const operationLimits = { search: 10, comments: 40, publish: 5, prepare: 10 } as const;
export const minimumReadInterval = 15000;
interface Protection {
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
  if (state.counts[action] >= operationLimits[action])
    return `已达到本地每日${action === 'search' ? '搜索批次' : action === 'comments' ? '评论批次' : action === 'prepare' ? '素材预览上传' : '发布提交'}上限 ${operationLimits[action]}；今日停止，不自动换号重试`;
  if (action === 'prepare' && state.lastUploadAt && now - state.lastUploadAt < 60000)
    return '本地素材上传间隔保护，请稍后再预览（至少间隔60秒）';
  if (
    (action === 'search' || action === 'comments') &&
    state.lastReadAt &&
    now - state.lastReadAt < minimumReadInterval
  )
    return `本地采集间隔保护，请 ${Math.ceil((minimumReadInterval - (now - state.lastReadAt)) / 1000)} 秒后再操作`;
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
  return previous.day === blank.day
    ? { ...previous, counts: { ...blank.counts, ...previous.counts } }
    : { ...blank, paused: previous.paused, reason: previous.reason, failures: previous.failures };
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
