// Hold the writer lock so the owner reads pending rows before a concurrent commit.
import { db, get, put } from '../../server/store.ts';
import { createHash } from 'node:crypto';
const [id, body] = process.argv.slice(2);
db.exec('BEGIN IMMEDIATE');
const receipt = get<any>('request-receipts', id)!;
const guard = get<any>('request-guards', id)!;
process.send?.({ ready: true });
process.once('message', () =>
  setTimeout(() => {
    const response = { status: 200, body };
    put('request-receipts', { ...receipt, state: 'received', response });
    put('request-guards', {
      ...guard,
      state: 'received',
      responseHash: createHash('sha256').update(JSON.stringify(response)).digest('hex'),
    });
    db.exec('COMMIT');
    db.close();
    process.disconnect();
  }, 80),
);
