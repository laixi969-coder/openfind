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

test('Per-platform policy persists without resetting usage or clearing verification', async () => {
  const { saveCollectionPolicy, collectionPolicy, reservePlatformAction, protectionView } =
    await import('../server/protection.ts');
  assert.equal(collectionPolicy('douyin').search.dailyLimit, 100);
  reservePlatformAction('xiaohongshu', 'search');
  recordPlatformFailure('xiaohongshu', 'captcha');
  const policy = {
    search: { dailyLimit: 120, intervalMs: 30000 },
    comments: { dailyLimit: 75, intervalMs: 5000 },
  };
  saveCollectionPolicy('xiaohongshu', policy);
  assert.deepEqual(collectionPolicy('xiaohongshu'), policy);
  assert.equal(collectionPolicy('douyin').search.dailyLimit, 100);
  let view = protectionView('xiaohongshu');
  assert.equal(view.counts.search, 1);
  assert.equal(view.budgets.search.remaining, 119);
  assert.equal(view.budgets.search.availableAt, null);
  assert.throws(() => reservePlatformAction('xiaohongshu', 'search'), /暂停/);
  resumePlatform('xiaohongshu');
  const state = protectionStatus('xiaohongshu');
  assert.match(evaluateBudget(state, 'search', state.lastReadAt! + 5000), /25 秒/);
  assert.equal(evaluateBudget(state, 'comments', state.lastReadAt! + 5000), '');
  saveCollectionPolicy('xiaohongshu', { ...policy, search: { ...policy.search, dailyLimit: 1 } });
  view = protectionView('xiaohongshu');
  assert.equal(view.budgets.search.remaining, 0);
  assert.equal(view.budgets.search.availableAt, Math.max(view.resetAt, state.lastReadAt! + 30000));
  assert.equal(new Date(view.resetAt).getUTCHours(), 0);
  assert.match(evaluateBudget(protectionStatus('xiaohongshu'), 'search'), /上限 1/);
  for (const value of [0, -1, 1.5, 10001])
    assert.throws(() =>
      saveCollectionPolicy('xiaohongshu', {
        ...policy,
        search: { ...policy.search, dailyLimit: value },
      }),
    );
  for (const value of [0, 999, 3600001])
    assert.throws(() =>
      saveCollectionPolicy('xiaohongshu', {
        ...policy,
        comments: { ...policy.comments, intervalMs: value },
      }),
    );
});
test('UTC rollover resets counts but retains cooldown and platform pauses', async () => {
  const { configSet } = await import('../server/store.ts');
  configSet(
    'protection:douyin',
    JSON.stringify({
      ...freshProtection(0),
      counts: { search: 100, comments: 100, publish: 0, prepare: 0 },
      lastReadAt: Date.now(),
      paused: true,
      reason: '验证',
      failures: 1,
    }),
  );
  const state = protectionStatus('douyin');
  assert.equal(state.counts.search, 0);
  assert.equal(state.paused, true);
  assert.ok(state.lastReadAt);
});
