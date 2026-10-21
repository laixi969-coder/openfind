import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ModelOption, ModelService } from '../shared/types.ts';
import {
  all,
  configGet,
  configSet,
  decrypt,
  encrypt,
  get,
  put,
  remove,
  transaction,
} from './store.ts';

export type ServiceKind = 'text' | 'image';

interface StoredService {
  id: string;
  kind: ServiceKind;
  name: string;
  baseUrl: string;
  key: string;
  model: string;
  synced: ModelOption[];
  custom: ModelOption[];
  modelsSyncedAt?: string;
  testedAt?: string;
  createdAt: string;
}

const activeKey: Record<ServiceKind, string> = {
  text: 'llm:serviceId',
  image: 'image:serviceId',
};

export const serviceBaseUrl = z
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

export const serviceInputSchema = z
  .object({
    kind: z.enum(['text', 'image']),
    name: z.string().trim().min(1, '请填写服务名称').max(40),
    baseUrl: serviceBaseUrl.refine((v) => !!v, '请填写服务地址'),
    apiKey: z.string().max(10000).optional(),
    model: z.string().trim().max(200).default(''),
  })
  .strict();

export const servicePatchSchema = z
  .object({
    name: z.string().trim().min(1).max(40).optional(),
    baseUrl: serviceBaseUrl.optional(),
    apiKey: z.string().max(10000).optional(),
    model: z.string().trim().max(200).optional(),
  })
  .strict();

function merge(synced: ModelOption[], custom: ModelOption[]): ModelOption[] {
  const map = new Map<string, ModelOption>();
  for (const item of synced) map.set(item.id, { ...item, custom: false });
  for (const item of custom) if (!map.has(item.id)) map.set(item.id, { id: item.id, custom: true });
  return [...map.values()];
}

function read(kind: ServiceKind) {
  return all<StoredService>('model-services').filter((s) => s.kind === kind);
}

function view(service: StoredService, activeId: string): ModelService {
  return {
    id: service.id,
    kind: service.kind,
    name: service.name,
    baseUrl: service.baseUrl,
    model: service.model,
    models: merge(service.synced || [], service.custom || []),
    modelsSyncedAt: service.modelsSyncedAt,
    testedAt: service.testedAt,
    hasApiKey: !!service.key,
    active: service.id === activeId,
    createdAt: service.createdAt,
  };
}

export function listServices(kind: ServiceKind) {
  const activeId = configGet(activeKey[kind]);
  return read(kind).map((s) => view(s, activeId));
}

export function activeService(kind: ServiceKind) {
  const id = configGet(activeKey[kind]);
  const found = id ? get<StoredService>('model-services', id) : undefined;
  if (found && found.kind === kind) return found;
  const first = read(kind)[0];
  if (first) {
    configSet(activeKey[kind], first.id);
    return first;
  }
  return undefined;
}

export function activeCredentials(kind: ServiceKind) {
  const service = activeService(kind);
  return {
    id: service?.id || '',
    name: service?.name || '',
    baseUrl: service?.baseUrl || '',
    model: service?.model || '',
    key: service?.key ? decrypt(service.key) : '',
    models: service ? merge(service.synced || [], service.custom || []) : [],
    modelsSyncedAt: service?.modelsSyncedAt,
    testedAt: service?.testedAt,
  };
}

function write(service: StoredService) {
  put('model-services', service);
}

export function createService(input: unknown) {
  const next = serviceInputSchema.parse(input);
  const base = next.baseUrl.replace(/\/+$/, '');
  const service: StoredService = {
    id: randomUUID(),
    kind: next.kind,
    name: next.name,
    baseUrl: base,
    key: next.apiKey ? encrypt(next.apiKey) : '',
    model: next.model,
    synced: [],
    custom: next.model ? [{ id: next.model }] : [],
    createdAt: new Date().toISOString(),
  };
  write(service);
  configSet(activeKey[next.kind], service.id);
  return view(service, service.id);
}

export function activateService(id: string) {
  const service = get<StoredService>('model-services', id);
  if (!service) throw new Error('服务不存在');
  configSet(activeKey[service.kind], service.id);
  return view(service, service.id);
}

export function deleteService(id: string) {
  const service = get<StoredService>('model-services', id);
  if (!service) throw new Error('服务不存在');
  remove('model-services', id);
  if (configGet(activeKey[service.kind]) === id) {
    const next = read(service.kind)[0];
    configSet(activeKey[service.kind], next?.id || '');
  }
  return { ok: true };
}

export function updateActive(
  kind: ServiceKind,
  patch: {
    name?: string;
    baseUrl?: string;
    model?: string;
    apiKey?: string;
    synced?: ModelOption[];
    syncedAt?: string;
    testedAt?: string;
    keepKey?: boolean;
  },
) {
  let service = activeService(kind);
  if (!service) {
    service = {
      id: randomUUID(),
      kind,
      name: kind === 'text' ? '文字服务' : '生图服务',
      baseUrl: '',
      key: '',
      model: '',
      synced: [],
      custom: [],
      createdAt: new Date().toISOString(),
    };
    write(service);
    configSet(activeKey[kind], service.id);
  }
  if (patch.name !== undefined) service.name = patch.name;
  if (patch.baseUrl !== undefined) service.baseUrl = patch.baseUrl.replace(/\/+$/, '');
  if (patch.model !== undefined) {
    service.model = patch.model;
    if (patch.model && !merge(service.synced, service.custom).some((m) => m.id === patch.model))
      service.custom = [...service.custom, { id: patch.model }];
  }
  if (patch.apiKey !== undefined) service.key = patch.apiKey ? encrypt(patch.apiKey) : '';
  if (patch.synced !== undefined) service.synced = patch.synced;
  if (patch.syncedAt !== undefined) service.modelsSyncedAt = patch.syncedAt;
  if (patch.testedAt !== undefined) service.testedAt = patch.testedAt;
  write(service);
  return service;
}

export function addServiceModel(kind: ServiceKind, input: unknown) {
  const id = z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[\w./:@+-]+$/, '模型 ID 只能包含字母、数字与 . / : @ + - _')
    .parse((input as { id?: unknown })?.id);
  const service = activeService(kind);
  if (!service) throw new Error('请先添加一个模型服务');
  if (!service.custom.some((m) => m.id === id)) service.custom = [...service.custom, { id }];
  write(service);
  return view(service, service.id);
}

export function removeServiceModel(kind: ServiceKind, id: string) {
  const service = activeService(kind);
  if (!service) throw new Error('请先添加一个模型服务');
  service.custom = service.custom.filter((m) => m.id !== id);
  write(service);
  return view(service, service.id);
}

function nameFromUrl(baseUrl: string) {
  try {
    const host = new URL(baseUrl).hostname;
    if (/bigmodel\.cn$/.test(host)) return '智谱';
    if (/deepseek\.com$/.test(host)) return 'DeepSeek';
    if (/siliconflow\.cn$/.test(host)) return '硅基流动';
    if (/openai\.com$/.test(host)) return 'OpenAI';
    if (/dashscope\.aliyuncs\.com$/.test(host)) return '阿里百炼';
    if (/volces\.com$/.test(host)) return '火山方舟';
    if (/moonshot\.(cn|ai)$/.test(host)) return 'Kimi';
    if (['127.0.0.1', 'localhost', '[::1]'].includes(host)) return '本机服务';
    return host.replace(/^api\./, '');
  } catch {
    return '默认服务';
  }
}

// 把历史的单服务配置迁移成一条服务记录，避免升级后配置丢失。
export function migrateServices() {
  transaction(() => {
    const services = all<StoredService>('model-services');
    for (const kind of ['text', 'image']) {
      if (services.some((s) => s.kind === kind)) configSet('migration:services:' + kind, '1');
    }
    const now = new Date().toISOString();
    const textBase = configGet('llm:baseUrl');
    const textKey = configGet('llm:key');
    if (
      !configGet('migration:services:text') &&
      !services.some((s) => s.kind === 'text') &&
      (textBase || textKey)
    ) {
      const service: StoredService = {
        id: 'service-text-default',
        kind: 'text',
        name: nameFromUrl(textBase),
        baseUrl: textBase,
        key: textKey,
        model: configGet('llm:model'),
        synced: list(configGet('llm:models')),
        custom: list(configGet('llm:customModels')).map((m) => ({ ...m, custom: true })),
        modelsSyncedAt: configGet('llm:modelsSyncedAt') || undefined,
        testedAt: configGet('llm:testedAt') || undefined,
        createdAt: now,
      };
      write(service);
      configSet('llm:serviceId', service.id);
      configSet('migration:services:text', '1');
    }
    const imageBase = configGet('image:baseUrl');
    const imageKey = configGet('image:key');
    if (
      !configGet('migration:services:image') &&
      !services.some((s) => s.kind === 'image') &&
      (imageBase || imageKey)
    ) {
      const service: StoredService = {
        id: 'service-image-default',
        kind: 'image',
        name: nameFromUrl(imageBase),
        baseUrl: imageBase,
        key: imageKey,
        model: configGet('image:model'),
        synced: list(configGet('image:models')),
        custom: list(configGet('image:customModels')).map((m) => ({ ...m, custom: true })),
        modelsSyncedAt: configGet('image:modelsSyncedAt') || undefined,
        testedAt: configGet('image:testedAt') || undefined,
        createdAt: now,
      };
      write(service);
      configSet('image:serviceId', service.id);
      configSet('migration:services:image', '1');
    }
  });
}

function list(value: string): ModelOption[] {
  try {
    const parsed = JSON.parse(value || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((m) => ({ id: String(m?.id || ''), created: m?.created }))
      .filter((m) => m.id);
  } catch {
    return [];
  }
}

migrateServices();

// Commit asynchronous results only to the exact configuration that made the request.
export function updateServiceResult(
  expected: ReturnType<typeof activeCredentials>,
  patch: { synced?: ModelOption[]; syncedAt?: string; testedAt?: string },
) {
  const service = get<StoredService>('model-services', expected.id);
  if (
    !service ||
    service.baseUrl !== expected.baseUrl ||
    service.model !== expected.model ||
    (service.key ? decrypt(service.key) : '') !== expected.key
  )
    return;
  if (patch.synced !== undefined) service.synced = patch.synced;
  if (patch.syncedAt !== undefined) service.modelsSyncedAt = patch.syncedAt;
  if (patch.testedAt !== undefined) service.testedAt = patch.testedAt;
  write(service);
}
