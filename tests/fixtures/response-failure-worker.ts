import { db } from '../../server/store.ts';
import { journaledFetch } from '../../server/request-journal.ts';
const [scope, url] = process.argv.slice(2);
db.exec(
  "CREATE TRIGGER fail_received BEFORE UPDATE ON entities WHEN NEW.kind='request-receipts' AND json_extract(NEW.value,'$.state')='received' BEGIN SELECT RAISE(ABORT, 'disk write failed'); END",
);
try {
  await journaledFetch(scope)(url);
} catch (error) {
  process.send?.({ error: (error as Error).message });
}
setInterval(() => {}, 1000);
