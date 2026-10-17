import type { BrowserContext, Page } from 'playwright';
import type { Platform } from '../../shared/types.ts';
import { configSet } from '../store.ts';

const installed = new WeakSet<BrowserContext>();
export function installDiagnostics(context: BrowserContext, platform: Platform) {
  if (installed.has(context)) return;
  installed.add(context);
  const errors: { at: string; url: string; message: string }[] = [];
  function attach(page: Page) {
    page.on('pageerror', (error) => {
      errors.push({
        at: new Date().toISOString(),
        url: page.url().split('?')[0],
        message: error.message.replace(/https?:\/\/\S+/g, (url) => url.split('?')[0]).slice(0, 500),
      });
      configSet('browserDiagnostics:' + platform, JSON.stringify(errors.slice(-15)));
    });
  }
  for (const page of context.pages()) attach(page);
  context.on('page', attach);
}
