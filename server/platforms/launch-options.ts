import type { chromium } from 'playwright';

// Keep Playwright's process, crash reporting and sandbox defaults for both platforms.
// Reconstructing the Chrome command line drops required launch flags.
export function browserLaunchOptions(proxy?: {
  server: string;
}): NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]> {
  return {
    channel: 'chrome',
    headless: false,
    timeout: 30_000,
    viewport: { width: 1280, height: 860 },
    locale: 'zh-CN',
    acceptDownloads: true,
    proxy,
    args: ['--no-first-run', '--no-default-browser-check'],
  };
}
