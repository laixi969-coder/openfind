import { configGet, decrypt } from '../store.ts';
export async function browserCall<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(
    `http://127.0.0.1:${process.env.OPENFIND_BROWSER_PORT || 8792}${path}`,
    {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + decrypt(configGet('browserServiceToken')),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal
        ? AbortSignal.any([
            signal,
            AbortSignal.timeout(path.includes('publish') ? 600_000 : 90_000),
          ])
        : AbortSignal.timeout(path.includes('publish') ? 600_000 : 90_000),
    },
  ).catch((e: Error) => {
    if (signal?.aborted) throw e;
    if (e.name === 'TimeoutError')
      throw new Error('平台操作超时，请查看官方浏览器当前状态；发布请先核对作品管理以免重复提交');
    throw new Error('无法连接内置平台浏览器服务，请运行 npm run dev 或 npm start');
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '平台连接失败');
  return result as T;
}

export async function browserScreenshot(platform: 'xiaohongshu' | 'douyin') {
  const response = await fetch(
    `http://127.0.0.1:${process.env.OPENFIND_BROWSER_PORT || 8792}/screenshot`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + decrypt(configGet('browserServiceToken')),
      },
      body: JSON.stringify({ platform, loginOnly: true }),
      signal: AbortSignal.timeout(20000),
      redirect: 'error',
    },
  );
  if (!response.ok || !response.headers.get('content-type')?.startsWith('image/png'))
    throw new Error('无法读取官方登录页面，请先打开平台浏览器');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 10 * 1024 * 1024) throw new Error('登录页面截图过大');
  return bytes;
}
