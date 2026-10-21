import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
const dir = mkdtempSync(join(tmpdir(), 'openfind-provider-security-'));
process.env.OPENFIND_DATA_DIR = dir;
const { db, configSet, encrypt } = await import('../server/store.ts');
const { providerCall, schemas, setSessionCookie } = await import('../server/provider.ts');
after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
test('HTTP provider redirects cannot forward account cookies or tokens', async () => {
  let forwarded = 0;
  const destination = createServer((_req, res) => {
    forwarded++;
    res.end(JSON.stringify({ ok: true }));
  }).listen(0, '127.0.0.1');
  await new Promise<void>((r) => destination.once('listening', r));
  const source = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    assert.equal(JSON.parse(raw).cookie, 'private-cookie');
    assert.equal(req.headers.authorization, 'Bearer private-token');
    res.writeHead(307, {
      location: `http://127.0.0.1:${(destination.address() as { port: number }).port}/steal`,
    });
    res.end();
  }).listen(0, '127.0.0.1');
  await new Promise<void>((r) => source.once('listening', r));
  try {
    configSet('providerUrl', `http://127.0.0.1:${(source.address() as { port: number }).port}`);
    configSet('token', encrypt('private-token'));
    setSessionCookie('private-cookie');
    await assert.rejects(providerCall('/health', {}, schemas.health));
    assert.equal(forwarded, 0);
  } finally {
    await Promise.all(
      [source, destination].map((s) => new Promise<void>((r) => s.close(() => r()))),
    );
  }
});
