import { get, db } from '../../server/store.ts';
import { commitJobPage, saveJobState } from '../../server/job-progress.ts';
import type { Job } from '../../shared/types.ts';
const job = get<Job>('jobs', process.argv[2])!;
process.send?.({ ready: true });
process.once('message', () => {
  let rejected = false;
  try {
    commitJobPage(job, job.query!, [], { nextCursor: null, visitedCursors: [] });
  } catch {
    rejected = true;
  }
  job.status = 'failed';
  const saved = saveJobState(job);
  process.send?.({ rejected, saved, pages: job.pages });
  db.close();
  process.disconnect();
});
