import type { Page } from 'playwright';

export async function hasVisibleChallenge(page: Page): Promise<boolean> {
  const matches = page.locator(
    'iframe[src*="captcha"], [id*="captcha"], .captcha_verify_container',
  );
  // Platforms may leave a hidden widget before the active challenge in the DOM.
  for (let i = 0, count = await matches.count(); i < count; i++) {
    if (await matches.nth(i).isVisible()) return true;
  }
  return false;
}
