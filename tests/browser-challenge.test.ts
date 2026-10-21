import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { hasVisibleChallenge } from '../server/platforms/challenge.ts';

function page(visible: boolean[]): Page {
  return {
    locator: () => ({
      count: async () => visible.length,
      nth: (i: number) => ({ isVisible: async () => visible[i] }),
    }),
  } as unknown as Page;
}

test('active challenge is detected even after a hidden widget', async () => {
  assert.equal(await hasVisibleChallenge(page([false, true])), true);
  assert.equal(await hasVisibleChallenge(page([false, false])), false);
  assert.equal(await hasVisibleChallenge(page([])), false);
});
