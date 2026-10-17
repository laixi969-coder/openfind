import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'openfind-guard-'));
process.env.OPENFIND_DATA_DIR = dir;
const {
  freshProtection,
  evaluateBudget,
  recordPlatformFailure,
  protectionStatus,
  resumePlatform,
  operationLimits,
} = await import('../server/protection.ts');
after(async () => {
  (await import('../server/store.ts')).db.close();
  rmSync(dir, { recursive: true, force: true });
});
test('Paused platforms and exhausted budgets stop before the next operation', () => {
  const state = freshProtection();
  state.paused = true;
  state.reason = '官方验证';
  assert.match(evaluateBudget(state, 'search'), /已暂停/);
  state.paused = false;
  state.counts.search = operationLimits.search;
  assert.match(evaluateBudget(state, 'search'), /上限/);
});
test('Read interval applies across jobs and cannot be shortened by request input', () => {
  const state = freshProtection();
  state.lastReadAt = 100000;
  assert.match(evaluateBudget(state, 'comments', 105000), /10 秒/);
  assert.equal(evaluateBudget(state, 'search', 115000), '');
});
test('Verification pauses immediately, repeated failures pause and explicit resume preserves budgets', () => {
  recordPlatformFailure('douyin', '安全验证');
  assert.equal(protectionStatus('douyin').paused, true);
  resumePlatform('douyin');
  for (let i = 0; i < 3; i++) recordPlatformFailure('douyin', '页面未加载');
  assert.equal(protectionStatus('douyin').paused, true);
  const counts = protectionStatus('douyin').counts;
  resumePlatform('douyin');
  assert.equal(protectionStatus('douyin').paused, false);
  assert.deepEqual(protectionStatus('douyin').counts, counts);
});
