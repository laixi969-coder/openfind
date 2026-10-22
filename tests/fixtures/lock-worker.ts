import { db } from '../../server/store.ts';
db.exec('BEGIN IMMEDIATE');
process.send?.({ ready: true });
process.once('message', () => {
  db.exec('ROLLBACK');
  process.send?.({ released: true });
  db.close();
  process.disconnect();
});
