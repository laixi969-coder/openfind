import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserLaunchOptions } from '../server/platforms/launch-options.ts';
import { workflowErrorMessage } from '../server/workflow-errors.ts';

test('Chrome keeps managed launch arguments and reports startup before client timeout', () => {
  const proxy = { server: 'http://127.0.0.1:49416' };
  const options = browserLaunchOptions(proxy);
  assert.equal(options.ignoreDefaultArgs, undefined);
  assert.equal(options.proxy, proxy);
  assert.ok(options.timeout! < 90_000);
  assert.ok(!options.args!.some((arg) => /user-data-dir|remote-debugging|proxy-server/.test(arg)));
});

test('Launch timeout is not mislabeled as a page control failure', () => {
  const raw =
    'browserType.launchPersistentContext: Timeout 180000ms exceeded. Failed to initialize sandbox.';
  assert.match(workflowErrorMessage(new Error(raw)), /浏览器启动失败/);
  assert.doesNotMatch(workflowErrorMessage(new Error(raw)), /控件/);
  assert.match(workflowErrorMessage(new Error('locator.click: Timeout 30000ms exceeded')), /控件/);
});
