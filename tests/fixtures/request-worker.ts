// Separate process so tests exercise durable recovery, not the in-memory map.
import { journaledFetch } from '../../server/request-journal.ts';
const [scope, url] = process.argv.slice(2);
try {
  const response = await journaledFetch(scope)(url);
  process.send?.({ result: await response.text() });
} catch (error) {
  process.send?.({ error: (error as Error).message });
}
// Parent terminates us to simulate process loss after receipt persistence.
setInterval(() => {}, 1000);
