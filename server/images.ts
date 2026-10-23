import { randomUUID, createHash } from 'node:crypto';
import { fetch as externalFetch, FormData } from 'undici';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { ImageSettings, ImageVariant, ImageGeneration } from '../shared/types.ts';
import { configGet, configSet, dataDir, all, get, put } from './store.ts';
import { modelDispatcher } from './model-transport.ts';
import { llmSettings } from './llm.ts';
import { downloadMedia, readLimitedBody } from './remote-media.ts';
import { activeCredentials, updateActive, updateServiceResult } from './services.ts';
import { guardedModelFetch, currentModelOperation } from './model-safety.ts';
import { redactModelText } from './privacy.ts';

const baseUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    if (!value) return true;
    try {
      const u = new URL(value);
      return (
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash &&
        (u.protocol === 'https:' ||
          (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)))
      );
    } catch {
      return false;
    }
  }, '服务地址须为 HTTPS，或本机 HTTP；不能包含凭证、查询参数或片段');

export const imageSettingsSchema = z
  .object({
    serviceId: z.string().optional(),
    baseUrl: baseUrlSchema,
    model: z.string().trim().min(1).max(200),
    apiKey: z.string().max(10000).optional(),
    size: z.enum(['1024x1024', '1024x1536', '1536x1024']).default('1024x1536'),
    mode: z.enum(['edit', 'generate']).default('edit'),
    watermark: z.boolean().default(true),
  })
  .strict();

export const variantsSchema = z
  .object({
    requestId: z.uuid().optional(),
    serviceId: z.string().optional(),
    expectedModel: z.string().optional(),
    images: z.array(z.string().max(12_000_000)).min(1).max(4),
    prompt: z.string().trim().min(1).max(1000),
    count: z.number().int().min(1).max(2).default(1),
    mode: z.enum(['edit', 'generate']).optional(),
  })
  .strict()
  .refine((v) => v.images.length * v.count <= 6, { message: '单次最多生成 6 张图片' });

export function imageSettings(): ImageSettings {
  const active = activeCredentials('image');
  return {
    serviceId: active.id,
    baseUrl: active.baseUrl,
    model: active.model,
    size: (configGet('image:size') || '1024x1536') as ImageSettings['size'],
    mode: (configGet('image:mode') || 'edit') as ImageSettings['mode'],
    watermark: configGet('image:watermark', 'true') !== 'false',
    hasApiKey: !!active.key,
    testedAt: active.testedAt,
    models: active.models,
    modelsSyncedAt: active.modelsSyncedAt,
  };
}

export function saveImageSettings(input: unknown) {
  const next = imageSettingsSchema.parse(input);
  const previous = imageSettings();
  if (next.serviceId && next.serviceId !== previous.serviceId)
    throw failure('生图服务已切换，请重新打开编辑器后保存配置');
  const base = next.baseUrl.replace(/\/+$/, '');
  const changed = base !== previous.baseUrl;
  if (changed && next.apiKey === undefined && previous.hasApiKey)
    throw new z.ZodError([
      {
        code: 'custom',
        path: ['apiKey'],
        message: '更换服务地址时请重新输入该服务的 API Key，或明确清空旧 Key',
      },
    ]);
  configSet('image:size', next.size);
  configSet('image:mode', next.mode);
  configSet('image:watermark', String(next.watermark));
  updateActive('image', {
    baseUrl: base,
    model: next.model,
    ...(next.apiKey !== undefined ? { apiKey: next.apiKey } : {}),
    ...(changed || next.model !== previous.model || next.apiKey !== undefined
      ? { synced: [], syncedAt: '' }
      : {}),
    ...(changed || next.model !== previous.model || next.apiKey !== undefined
      ? { testedAt: '' }
      : {}),
  });
  return imageSettings();
}

function authHeaders(key: string): Record<string, string> {
  return key ? { Authorization: 'Bearer ' + key } : {};
}

// 复用语义复核模型的地址与 Key：同一家服务通常同时提供对话与生图，
// 但模型 ID 不复用——对话模型和生图模型不是同一个。
export function reuseLlmService() {
  const llm = llmSettings();
  if (!llm.baseUrl) throw new Error('请先在“大模型”里填写服务地址');
  const text = activeCredentials('text');
  updateActive('image', {
    baseUrl: llm.baseUrl,
    apiKey: text.key,
    synced: [],
    syncedAt: '',
    testedAt: '',
  });
  return { settings: imageSettings(), copiedKey: !!text.key };
}

const failure = (message: string) => new Error(message);

export async function checkImageService() {
  const credentials = activeCredentials('image');
  const settings = imageSettings();
  if (!settings.baseUrl) return { ok: false, message: '尚未配置生图服务地址' };
  const started = Date.now();
  let response: Awaited<ReturnType<typeof externalFetch>>;
  try {
    response = await externalFetch(settings.baseUrl + '/models', {
      dispatcher: modelDispatcher,
      headers: authHeaders(credentials.key),
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    const detail = (error as Error).name === 'TimeoutError' ? '连接超时' : (error as Error).message;
    return { ok: false, message: '生图服务连接失败：' + detail };
  }
  const latencyMs = Date.now() - started;
  if (!response.ok) await response.body?.cancel();
  if (response.status === 401 || response.status === 403)
    return { ok: false, message: '生图服务拒绝访问，请检查 API Key' };
  if (response.status >= 500)
    return { ok: false, message: `生图服务暂时不可用（HTTP ${response.status}）` };
  if (!response.ok)
    return {
      ok: true,
      latencyMs,
      message: `服务可达（HTTP ${response.status}，未提供模型列表），可直接尝试生成`,
    };
  let models: string[] = [];
  try {
    const body = JSON.parse((await readLimitedBody(response, 2_000_000)).toString('utf8')) as {
      data?: { id?: string }[];
    };
    models = (body.data || []).map((m) => m.id).filter((id): id is string => !!id);
  } catch {
    // A reachable service without a JSON model list is still usable.
  }
  if (models.length && !models.includes(settings.model))
    return {
      ok: true,
      latencyMs,
      message: `服务可达；模型列表未包含 ${settings.model}（生图模型常与对话模型分开列出），可直接测试生图`,
    };
  return {
    ok: true,
    latencyMs,
    message: models.length
      ? `服务可用，已找到模型 ${settings.model}`
      : `服务可达，将直接调用 ${settings.model}`,
  };
}

const uploadsDir = join(dataDir, 'uploads');
const uploadsReady = mkdir(uploadsDir, { recursive: true, mode: 0o700 });

async function sourceImage(url: string) {
  if (url.startsWith('data:image/')) {
    const match = /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(url);
    if (!match) throw failure('参考图格式不支持，请使用 PNG、JPEG 或 WebP');
    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.length > 10 * 1024 * 1024) throw failure('参考图超过 10MB');
    return { buffer, mime: imageMime(buffer) };
  }
  if (/^\/api\/media\/[a-f0-9-]+\.(png|jpe?g|webp)$/.test(url)) {
    const name = url.split('/').at(-1)!;
    const buffer = await readFile(join(uploadsDir, name));
    return { buffer, mime: imageMime(buffer) };
  }
  if (/^https?:\/\//.test(url)) {
    const buffer = await downloadMedia(url, 10 * 1024 * 1024);
    return { buffer, mime: imageMime(buffer) };
  }
  throw failure('演示素材不能用于 AI 重绘，请先上传自己的图片');
}

export function imageMime(buffer: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' {
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png';
  if (buffer.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return 'image/jpeg';
  if (
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return 'image/webp';
  throw failure('生成结果不是 PNG、JPEG 或 WebP 图片');
}

function extension(mime: string) {
  return mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
}

async function persist(buffer: Buffer): Promise<string> {
  const mime = imageMime(buffer);
  const name = randomUUID() + '.' + extension(mime);
  await uploadsReady;
  await writeFile(join(uploadsDir, name), buffer, { mode: 0o600 });
  return '/api/media/' + name;
}

function resultImages(body: unknown) {
  const record = body as { data?: unknown[]; images?: unknown[] };
  const list = Array.isArray(record?.data)
    ? record.data
    : Array.isArray(record?.images)
      ? record.images
      : [];
  return list
    .map((item) => {
      if (typeof item === 'string') return item.startsWith('http') ? { url: item } : { b64: item };
      const entry = item as { b64_json?: string; url?: string; image_url?: string };
      return { b64: entry?.b64_json, url: entry?.url || entry?.image_url };
    })
    .filter((item) => !!item.b64 || !!item.url);
}

async function saveResult(result: { b64?: string; url?: string }) {
  if (result.b64) {
    if (result.b64.length > Math.ceil((20 * 1024 * 1024) / 3) * 4)
      throw failure('生成结果超过 20MB');
    return persist(Buffer.from(result.b64, 'base64'));
  }
  const buffer = await downloadMedia(result.url!, 20 * 1024 * 1024);
  return persist(buffer);
}

async function requestOnce(
  settings: ImageSettings,
  source: { buffer: Buffer; mime: string } | null,
  prompt: string,
  count: number,
  credentials: ReturnType<typeof activeCredentials>,
  operationId = currentModelOperation(),
) {
  const key = credentials.key;
  prompt = redactModelText(prompt);
  const guarded: typeof externalFetch = (url, init) =>
    guardedModelFetch(
      'image',
      credentials,
      String(url),
      init as unknown as RequestInit,
      externalFetch as unknown as typeof fetch,
      {
        operationId,
        payloadHash: createHash('sha256')
          .update(
            JSON.stringify([
              settings.model,
              prompt,
              count,
              settings.size,
              settings.watermark,
              source ? createHash('sha256').update(source.buffer).digest('hex') : null,
            ]),
          )
          .digest('hex'),
        count,
      },
    ) as unknown as ReturnType<typeof externalFetch>;
  const timeout = AbortSignal.timeout(300000);
  let response: Awaited<ReturnType<typeof externalFetch>>;
  if (settings.mode === 'edit' && source) {
    const form = new FormData();
    form.append('model', settings.model);
    form.append('prompt', prompt);
    form.append('n', String(count));
    form.append('size', settings.size);
    form.append(
      'image',
      new Blob([new Uint8Array(source.buffer)], { type: source.mime }),
      'source.' + extension(source.mime),
    );
    response = await guarded(settings.baseUrl + '/images/edits', {
      method: 'POST',
      dispatcher: modelDispatcher,
      headers: authHeaders(key),
      body: form,
      redirect: 'error',
      signal: timeout,
    });
  } else {
    response = await guarded(settings.baseUrl + '/images/generations', {
      method: 'POST',
      dispatcher: modelDispatcher,
      headers: { 'Content-Type': 'application/json', ...authHeaders(key) },
      body: JSON.stringify({
        model: settings.model,
        prompt,
        n: count,
        size: settings.size,
        // 智谱 CogView 支持关闭平台水印；其他服务若拒绝未知字段，请保持默认开启。
        ...(settings.watermark ? {} : { watermark_enabled: false }),
      }),
      redirect: 'error',
      signal: timeout,
    });
  }
  const text = (await readLimitedBody(response, 60 * 1024 * 1024)).toString('utf8');
  if (!response.ok) {
    if (response.status === 401 || response.status === 403)
      throw failure('生图服务拒绝访问，请检查 API Key');
    if (settings.mode === 'edit' && [400, 404, 405, 501].includes(response.status))
      throw failure(
        '该服务不支持图生图（/images/edits）。请改用文字生成模式，或换成支持参考图重绘的服务。',
      );
    throw failure(`生图失败（HTTP ${response.status}）`);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw failure('生图服务返回的不是 JSON，请确认服务地址指向 OpenAI 兼容接口');
  }
  const images = resultImages(body);
  if (!images.length) throw failure('生图服务没有返回图片，请检查模型是否支持图片生成');
  return images.slice(0, count);
}

interface GenerationRecord extends ImageGeneration {
  id: string;
  createdAt?: string;
  inputHash: string;
  status: 'running' | 'completed' | 'failed';
}
for (const record of all<GenerationRecord>('image-generations')) {
  if (record.status === 'running')
    put('image-generations', {
      ...record,
      status: 'failed',
      warning: '服务重启，请核对已保存结果；未自动重新提交生图请求',
    });
}
export function generationHistory() {
  return all<GenerationRecord>('image-generations')
    .slice(0, 30)
    .map(({ inputHash: _, ...r }) => r);
}
export async function generateVariants(
  input: z.infer<typeof variantsSchema>,
): Promise<ImageGeneration> {
  const id = input.requestId || randomUUID();
  const { requestId: _, ...payload } = input;
  const inputHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const previous = get<GenerationRecord>('image-generations', id);
  if (previous) {
    if (previous.inputHash !== inputHash) throw failure('该请求编号已用于其他内容，请新建生成请求');
    if (previous.status === 'running') throw failure('该生成请求仍在处理中，未重复提交');
    if (previous.items.length) return previous;
    throw failure(previous.warning || '请求已失败；结果可能已计费，未自动重复提交');
  }
  const credentials = activeCredentials('image');
  const settings = imageSettings();
  if (
    (input.serviceId && input.serviceId !== credentials.id) ||
    (input.expectedModel && input.expectedModel !== settings.model)
  )
    throw failure('生图服务已切换，请重新打开编辑器核对服务后生成');
  if (!settings.baseUrl || !settings.model) throw failure('请先配置生图服务地址与模型');
  const mode = input.mode || settings.mode;
  const active: ImageSettings = { ...settings, mode };
  const started = Date.now();
  const record: GenerationRecord = {
    id,
    createdAt: new Date().toISOString(),
    inputHash,
    status: 'running',
    items: [],
    mode,
    model: settings.model,
    size: settings.size,
    elapsedMs: 0,
  };
  put('image-generations', record);
  try {
    const targets = mode === 'edit' ? input.images : input.images.slice(0, 1);
    // Reject invalid references before starting any paid generation.
    const sources = [];
    for (const url of targets) sources.push(mode === 'edit' ? await sourceImage(url) : null);
    for (let i = 0; i < targets.length; i++) {
      const results = await requestOnce(
        active,
        sources[i],
        input.prompt,
        input.count,
        credentials,
        record.id + ':' + i,
      );
      for (const result of results) {
        record.items.push({ id: randomUUID(), url: await saveResult(result), source: targets[i] });
        record.elapsedMs = Date.now() - started;
        put('image-generations', record);
      }
    }
    record.status = 'completed';
    updateServiceResult(credentials, { testedAt: new Date().toISOString() });
  } catch (error) {
    record.status = 'failed';
    record.warning =
      (error instanceof Error ? error.message : '生图失败') + '；已保存完成的图片，未自动重试';
    if (!record.items.length) throw failure(record.warning);
  } finally {
    record.elapsedMs = Date.now() - started;
    put('image-generations', record);
  }
  return record;
}

export async function syncImageModels() {
  const credentials = activeCredentials('image');
  const settings = imageSettings();
  if (!settings.baseUrl) throw failure('请先填写生图服务地址');
  let response: Awaited<ReturnType<typeof externalFetch>>;
  try {
    response = await externalFetch(settings.baseUrl + '/models', {
      dispatcher: modelDispatcher,
      headers: authHeaders(credentials.key),
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    throw failure('生图服务连接失败：' + (error as Error).message);
  }
  const text = (await readLimitedBody(response, 2_000_000)).toString('utf8');
  if (!response.ok) throw failure(`同步失败（HTTP ${response.status}）`);
  let body: { data?: { id?: string; created?: number }[] };
  try {
    body = JSON.parse(text);
  } catch {
    throw failure('服务返回的不是 JSON，无法同步模型列表');
  }
  const models = (body.data || [])
    .map((m) => ({ id: String(m?.id || ''), created: m?.created }))
    .filter((m) => m.id);
  if (!models.length) throw failure('服务没有返回可用模型');
  updateServiceResult(credentials, { synced: models, syncedAt: new Date().toISOString() });
  return imageSettings();
}

// 纯白 256×256，作为只支持图生图服务的测试参考图。
const TEST_REFERENCE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAAACXBIWXMAAAABAAAAAQBPJcTWAAACvklEQVR4nO3TMQ0AMAzAsE0af8odjB6xEeTJnZkDVW87ADYZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpH9fKBvtTNALPAAAAAElFTkSuQmCC',
  'base64',
);

export async function testImageGeneration() {
  const credentials = activeCredentials('image');
  const settings = imageSettings();
  if (!settings.baseUrl || !settings.model) throw failure('请先保存生图服务地址与模型');
  const prompt = '纯白背景中央一个红色圆形，极简，无文字';
  const started = Date.now();
  const via = settings.mode === 'edit' ? 'edits' : 'generations';
  const results = await requestOnce(
    { ...settings, size: '1024x1024' },
    settings.mode === 'edit' ? { buffer: TEST_REFERENCE, mime: 'image/png' } : null,
    prompt,
    1,
    credentials,
  );
  const sample = await saveResult(results[0]);
  updateServiceResult(credentials, { testedAt: new Date().toISOString() });
  return { model: settings.model, latencyMs: Date.now() - started, sample, via };
}
