import { resolveWorkRedirects } from './work-redirects.ts';
import { allowNetworkRequest } from './network.ts';
import { parseWorkLink } from '../../shared/work-links.ts';
import type { Platform } from '../../shared/types.ts';
import { requireSession } from './browser.ts';
import { stat } from 'node:fs/promises';
const failures = new Map<Platform, import('playwright').Page>();
export async function resolveWorkLink(url: string, platform: Platform, signal?: AbortSignal) {
  let link = parseWorkLink(url);
  if (link.platform !== platform) throw Error('链接平台与流程不一致');
  const session = await requireSession(platform);
  signal?.throwIfAborted();
  link = await resolveWorkRedirects(
    link,
    async (target) => {
      allowNetworkRequest(target);
      const response = await session.context.request.get(target, {
        maxRedirects: 0,
        timeout: 20000,
        failOnStatusCode: false,
      });
      const result = { status: response.status(), location: response.headers().location };
      await response.dispose();
      return result;
    },
    signal,
  );
  const page = await session.context.newPage();
  try {
    const helperUrl = new URL('./linked-work-page.ts', import.meta.url);
    const revision = (await stat(helperUrl)).mtimeMs;
    const { readLinkedWork } = await import(helperUrl.href + '?revision=' + revision);
    const note = await readLinkedWork(page, link, signal);
    await page.close();
    return note;
  } catch (e) {
    if (!signal?.aborted && !page.isClosed()) {
      const old = failures.get(platform);
      failures.set(platform, page);
      await page.bringToFront().catch(() => {});
      if (old && old !== page) await old.close().catch(() => {});
    } else await page.close().catch(() => {});
    throw e;
  }
}
