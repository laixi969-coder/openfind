import express from 'express';
import { statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { configGet, configSet, encrypt, decrypt } from './store.ts';
import { z } from 'zod';
import {
  connection,
  openLogin,
  checkLogin,
  loginScreenshot,
  browserSearch,
  browserComments,
  readDetail,
  closeRead,
  inspectPlatform,
  openCreator,
  refreshPlatform,
  closeBrowsers,
  setNetwork,
} from './platforms/browser.ts';

import type { Note, SearchInput } from '../shared/types.ts';
if (!configGet('browserServiceToken'))
  configSet('browserServiceToken', encrypt(randomBytes(32).toString('hex')));
const app = express();
app.use(express.json({ limit: '30mb' }));
app.use((req, res, next) => {
  if (req.get('authorization') !== 'Bearer ' + decrypt(configGet('browserServiceToken'))) {
    res.status(403).json({ error: '本机服务认证失败' });
    return;
  }
  next();
});
// Xiaohongshu is API-only, including legacy login, inbox and detail routes.
app.use((req, res, next) => {
  if ((req.body?.platform || req.body?.note?.platform) === 'xiaohongshu') {
    res.status(410).json({
      error:
        '小红书已改用 API 数据源，已关闭模拟浏览、自动采集及互动；请到设置配置 TikHub / RedFox',
    });
    return;
  }
  next();
});
const platform = z.enum(['xiaohongshu', 'douyin']);
app.get('/connections', (_req, res) =>
  res.json(['xiaohongshu', 'douyin'].map((p) => connection(platform.parse(p)))),
);
app.post('/login', async (req, res) => {
  const p = platform.parse(req.body.platform);
  await openLogin(p);
  res.json(await checkLogin(p));
});
app.post('/status', async (req, res) =>
  res.json(await checkLogin(platform.parse(req.body.platform))),
);
app.post('/messaging', async (req, res) => {
  const module = await import(
    './platforms/messages.ts?revision=' +
      statSync(new URL('./platforms/messages.ts', import.meta.url)).mtimeMs
  );
  res.json(await module.messaging(req.body));
});
app.post('/screenshot', async (req, res) => {
  const p = platform.parse(req.body.platform);
  const bytes = req.body.loginOnly
    ? await (
        await import(
          './platforms/messages.ts?revision=' +
            statSync(new URL('./platforms/messages.ts', import.meta.url)).mtimeMs
        )
      ).loginPreview(p)
    : await loginScreenshot(p);
  res.set('Cache-Control', 'no-store').type('png').send(bytes);
});
app.post('/search', async (req, res) => {
  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) abort.abort();
  });
  res.json(await browserSearch(req.body as SearchInput, abort.signal));
});
app.post('/comments', async (req, res) => {
  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) abort.abort();
  });
  res.json(await browserComments(req.body, abort.signal));
});
app.post('/detail', async (req, res) => res.json(await readDetail(req.body.note as Note)));
app.post('/resolve-work', async (req, res) => {
  const input = z
    .object({ url: z.string().max(2048), platform })
    .strict()
    .parse(req.body);
  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) abort.abort();
  });
  const module = await import(
    './platforms/links.ts?revision=' +
      statSync(new URL('./platforms/links.ts', import.meta.url)).mtimeMs
  );
  res.json(await module.resolveWorkLink(input.url, input.platform, abort.signal));
});
app.post('/inspect', async (req, res) =>
  res.json(await inspectPlatform(platform.parse(req.body.platform))),
);
app.post('/network', async (req, res) =>
  res.json(
    await setNetwork(
      platform.parse(req.body.platform),
      z.enum(['system', 'direct']).parse(req.body.mode),
    ),
  ),
);
app.post('/refresh', async (req, res) =>
  res.json(await refreshPlatform(platform.parse(req.body.platform), !!req.body.creator)),
);
app.post('/creator', async (req, res) => {
  await openCreator(platform.parse(req.body.platform));
  res.json({ ok: true });
});
for (const path of ['/prepare-publish', '/reconcile-publish', '/publish']) {
  app.post(path, (_req, res) =>
    res.status(410).json({ error: '平台代发与代填已取消，请手动发布。' }),
  );
}
app.post('/close-read', async (req, res) => {
  await closeRead(String(req.body.cursor));
  res.json({ ok: true });
});
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) =>
  res.status(400).json({ error: err instanceof Error ? err.message : '连接失败' }),
);
app.listen(Number(process.env.OPENFIND_BROWSER_PORT || 8792), '127.0.0.1', () =>
  console.log('OpenFind 内置平台浏览器服务已启动'),
);

process.on('SIGTERM', () => {
  void closeBrowsers().finally(() => process.exit(0));
});
process.on('SIGINT', () => {
  void closeBrowsers().finally(() => process.exit(0));
});
