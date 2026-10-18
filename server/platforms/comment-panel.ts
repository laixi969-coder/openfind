import type { Page } from 'playwright';

export async function openDouyinComments(page: Page) {
  // Image works render a recommendations/comments tab strip instead of the video action bar.
  const tab = page.getByText(/^评论[（(]\s*\d+\s*[)）]$/, { exact: true }).first();
  const action = page.locator('[data-e2e="comment-icon"], [data-e2e="comment-count"]').first();
  await tab
    .or(action)
    .first()
    .waitFor({ state: 'visible', timeout: 15000 })
    .catch(() => {});
  if (await tab.isVisible().catch(() => false)) await tab.click();
  else if (await action.isVisible().catch(() => false)) await action.click();
}
