import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { configGet, configSet, get, put, transaction } from './store.ts';
import { journaledFetch } from './request-journal.ts';
import { serviceIdentity, type activeCredentials } from './services.ts';

export const modelPolicySchema = z
  .object({
    textRequests: z.number().int().min(1).max(10000),
    imageRequests: z.number().int().min(1).max(1000),
    textTokens: z.number().int().min(1024).max(100000000),
    maxOutputTokens: z.number().int().min(256).max(32000),
    // Local estimates in CNY cents; configure against the most expensive active model.
    dailyCostCents: z.number().int().min(1).max(10000000),
    inputCentsPerMillion: z.number().int().min(1).max(100000000),
    outputCentsPerMillion: z.number().int().min(1).max(100000000),
    imageCents: z.number().int().min(1).max(1000000),
  })
  .strict();
export function modelPolicy() {
  return modelPolicySchema.parse(
    JSON.parse(
      configGet(
        'model:policy',
        JSON.stringify({
          textRequests: 100,
          imageRequests: 20,
          textTokens: 200000,
          maxOutputTokens: 4096,
          dailyCostCents: 5000,
          inputCentsPerMillion: 10000,
          outputCentsPerMillion: 50000,
          imageCents: 1000,
        }),
      ),
    ),
  );
}
export function saveModelPolicy(input: unknown) {
  const policy = modelPolicySchema.parse(input);
  configSet('model:policy', JSON.stringify(policy));
  return modelBudget();
}
interface Usage {
  id: string;
  textRequests: number;
  imageRequests: number;
  textTokens: number;
  costCents: number;
}
const day = () => new Date().toISOString().slice(0, 10);
export function modelBudget() {
  return {
    policy: modelPolicy(),
    day: day(),
    usage: get<Usage>('model-usage', day()) || {
      id: day(),
      textRequests: 0,
      imageRequests: 0,
      textTokens: 0,
      costCents: 0,
    },
    currency: 'CNY',
    accounting: 'reserved-upper-estimate',
  };
}
export class ModelBudgetError extends Error {
  statusCode = 429;
}
const operation = new AsyncLocalStorage<string>();
let activeCalls = 0;
export const modelsBusy = () => activeCalls > 0;
export function withModelOperation<T>(id: string, work: () => T): T {
  return operation.run(id, work);
}
export function currentModelOperation() {
  return operation.getStore() || randomUUID();
}

function reserve(kind: 'text' | 'image', inputBytes: number, count: number, service: string) {
  transaction(() => {
    const { policy, usage } = modelBudget();
    // A byte is a conservative token bound for UTF-8 input. Never refund an uncertain call.
    const tokens = kind === 'text' ? inputBytes + policy.maxOutputTokens : 0;
    const cost =
      kind === 'text'
        ? Math.max(
            1,
            Math.ceil(
              (inputBytes * policy.inputCentsPerMillion +
                policy.maxOutputTokens * policy.outputCentsPerMillion) /
                1000000,
            ),
          )
        : count * policy.imageCents;
    if (
      usage[kind === 'text' ? 'textRequests' : 'imageRequests'] >=
        policy[kind === 'text' ? 'textRequests' : 'imageRequests'] ||
      usage.textTokens + tokens > policy.textTokens ||
      usage.costCents + cost > policy.dailyCostCents
    )
      throw new ModelBudgetError(
        '已达到本机今日模型预算，尚未发送请求；请核对用量或在数据安全设置调整预算',
      );
    const next = {
      ...usage,
      textRequests: usage.textRequests + Number(kind === 'text'),
      imageRequests: usage.imageRequests + Number(kind === 'image'),
      textTokens: usage.textTokens + tokens,
      costCents: usage.costCents + cost,
    };
    put('model-usage', next);
    const id = usage.id + ':' + service;
    const perService = get<Usage>('model-service-usage', id) || {
      id,
      textRequests: 0,
      imageRequests: 0,
      textTokens: 0,
      costCents: 0,
    };
    put('model-service-usage', {
      ...perService,
      textRequests: perService.textRequests + Number(kind === 'text'),
      imageRequests: perService.imageRequests + Number(kind === 'image'),
      textTokens: perService.textTokens + tokens,
      costCents: perService.costCents + cost,
    });
  });
}

export async function guardedModelFetch(
  kind: 'text' | 'image',
  credentials: ReturnType<typeof activeCredentials>,
  url: string,
  init: RequestInit,
  transport: typeof fetch,
  options: { operationId?: string; inputBytes?: number; count?: number } = {},
) {
  if (activeCalls >= 2)
    throw new ModelBudgetError('已有两个模型请求在执行，请等待完成后重试，尚未发送新请求');
  const identity = serviceIdentity(credentials);
  const scope =
    'model:' +
    createHash('sha256')
      .update(options.operationId || currentModelOperation())
      .digest('hex') +
    ':' +
    identity;
  activeCalls++;
  try {
    return await journaledFetch(
      scope,
      transport,
      () => reserve(kind, options.inputBytes || 0, options.count || 1, identity),
      false,
      false,
      kind === 'image' ? 60 * 1024 * 1024 : 2 * 1024 * 1024,
      'model',
    )(url, init);
  } finally {
    activeCalls--;
  }
}
