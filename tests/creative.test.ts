import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const dir = mkdtempSync(join(tmpdir(), 'openfind-creative-'));
process.env.OPENFIND_DATA_DIR = dir;
const { db } = await import('../server/store.ts');
const {
  saveImageSettings,
  generateVariants,
  generationHistory,
  testImageGeneration,
  imageSettings,
} = await import('../server/images.ts');
const { createService } = await import('../server/services.ts');
const { rewriteCopy } = await import('../server/copy.ts');
let calls = 0;
let mode = 'ok';
const paths: string[] = [];
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=';
const image = 'data:image/png;base64,' + png;
const provider = createServer(async (req, res) => {
  for await (const _chunk of req) {
    /* drain */
  }
  calls++;
  paths.push(req.url!);
  res.setHeader('content-type', 'application/json');
  if (mode === 'fail' || (mode === 'partial' && calls === 2)) {
    res.statusCode = 500;
    res.end('{}');
    return;
  }
  res.end(JSON.stringify({ data: [{ b64_json: png }] }));
}).listen(0, '127.0.0.1');
await new Promise<void>((r) => provider.once('listening', r));
const baseUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;
function setup() {
  calls = 0;
  paths.length = 0;
  mode = 'ok';
  saveImageSettings({ baseUrl, apiKey: '', model: 'image', mode: 'edit' });
}
after(async () => {
  await new Promise<void>((r) => provider.close(() => r()));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('test generation honors selected mode and never falls back after a failure', async () => {
  setup();
  mode = 'fail';
  await assert.rejects(testImageGeneration(), /500/);
  assert.equal(calls, 1);
  assert.deepEqual(paths, ['/v1/images/edits']);
});

test('partial batches return saved files and replaying a request does not generate twice', async () => {
  setup();
  mode = 'partial';
  const input = {
    requestId: randomUUID(),
    images: [image, image],
    prompt: 'test',
    count: 1,
    mode: 'edit' as const,
  };
  const result = await generateVariants(input);
  assert.equal(result.items.length, 1);
  assert.match(result.warning!, /未自动重试/);
  assert.equal(calls, 2);
  assert.deepEqual((await generateVariants(input)).items, result.items);
  assert.equal(calls, 2);
  assert.ok(generationHistory().some((r) => r.id === result.id && r.items.length === 1));
  await assert.rejects(generateVariants({ ...input, prompt: 'different' }), /其他内容/);
});

test('failed requests stay failed on replay and invalid later sources never trigger a paid first request', async () => {
  setup();
  mode = 'fail';
  const input = {
    requestId: randomUUID(),
    images: [image],
    prompt: 'test',
    count: 1,
    mode: 'generate' as const,
  };
  await assert.rejects(generateVariants(input));
  await assert.rejects(generateVariants(input));
  assert.equal(calls, 1);
  setup();
  await assert.rejects(
    generateVariants({
      images: [image, '/assets/demo.svg'],
      prompt: 'test',
      count: 1,
      mode: 'edit',
    }),
  );
  assert.equal(calls, 0);
});

test('stale service choices stop image and copy requests before billing', async () => {
  setup();
  const before = imageSettings();
  createService({ kind: 'image', name: 'different', baseUrl, model: 'image' });
  await assert.rejects(
    generateVariants({
      images: [image],
      prompt: 'test',
      count: 1,
      serviceId: before.serviceId,
      expectedModel: before.model,
    }),
    /已切换/,
  );
  await assert.rejects(
    rewriteCopy({ noteId: 'unused', style: 'same', serviceId: 'old-text-service' }),
    /已切换/,
  );
  assert.equal(calls, 0);
});

test('stale image configuration cannot overwrite a newly selected service', () => {
  setup();
  assert.throws(
    () => saveImageSettings({ serviceId: 'obsolete-service', baseUrl, model: 'wrong-model' }),
    /服务已切换/,
  );
  assert.equal(imageSettings().model, 'image');
});
