import { db, get, put, transaction } from '../../server/store.ts';
try {
  transaction(() => {
    const counter = get<{ id: string; value: number }>('test', 'counter')!;
    process.send?.({ ready: true });
    // Let the other process contend after this transaction has read its snapshot.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    put('test', { ...counter, value: counter.value + 1 });
  });
  process.send?.({ success: true });
} catch (error) {
  process.send?.({ error: (error as Error).message });
}
db.close();
process.disconnect();
