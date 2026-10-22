import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Job } from '../shared/types.ts';

export const hashIdentity = (value: string) => createHash('sha256').update(value).digest('hex');
export const guardMigrationKey = 'request-guards:migration';
export function checkpointDigest(job: Job) {
  return hashIdentity(
    JSON.stringify({
      pages: job.pages,
      count: job.count,
      resultIds: job.resultIds,
      checkpoint: job.checkpoint,
      dataProvider: job.dataProvider,
      source: job.source,
      platform: job.platform,
      query: job.query,
    }),
  );
}
type Row = Record<string, any>;
function rows(db: DatabaseSync, kind: string): Row[] {
  return db
    .prepare('SELECT value FROM entities WHERE kind=?')
    .all(kind)
    .map((r) => JSON.parse(String(r.value)));
}
function indexed(db: DatabaseSync, kind: string) {
  return new Map(rows(db, kind).map((r) => [r.id, r]));
}
function fail() {
  throw new Error('采集请求、防重发标记或分页检查点不一致，已停止迁移/备份恢复');
}
export function validateCollectionState(db: DatabaseSync) {
  const receipts = indexed(db, 'request-receipts');
  const guards = indexed(db, 'request-guards');
  const pages = indexed(db, 'job-pages');
  const jobs = indexed(db, 'jobs');
  const migrated =
    db.prepare('SELECT value FROM config WHERE key=?').get(guardMigrationKey)?.value === '1';
  for (const r of receipts.values()) {
    if (!r.attempt || !['pending', 'received'].includes(r.state)) fail();
    const g = guards.get(r.id);
    if (!g) {
      if (migrated) fail();
      continue;
    }
    if (
      g.attempt !== r.attempt ||
      g.scopeHash !== r.scopeHash ||
      (g.state === 'pending') !== (r.state === 'pending')
    )
      fail();
    if (
      r.state === 'received' &&
      (!r.response || g.responseHash !== hashIdentity(JSON.stringify(r.response)))
    )
      fail();
  }
  for (const g of guards.values()) {
    if (!g.attempt || !['pending', 'received', 'poll-ready', 'consumed'].includes(g.state)) fail();
    if (['received', 'poll-ready'].includes(g.state) && !receipts.has(g.id)) fail();
    if (g.state === 'consumed') {
      const owner = g.consumedBy;
      const page = owner && pages.get(owner.jobId + ':' + owner.page);
      if (!page?.receipts?.some((r: Row) => r.id === g.id && r.attempt === g.attempt)) fail();
    }
  }
  const modernJobs = new Set<string>();
  for (const page of pages.values()) {
    const separator = page.id.lastIndexOf(':');
    const jobId = page.id.slice(0, separator);
    const number = Number(page.id.slice(separator + 1));
    const job = jobs.get(jobId);
    if (!job || !Number.isSafeInteger(number) || number < 1 || number > job.pages) fail();
    modernJobs.add(jobId);
    if (!Array.isArray(page.receipts)) fail();
    for (const ref of page.receipts) {
      const g = guards.get(ref.id);
      if (
        g?.state !== 'consumed' ||
        g.attempt !== ref.attempt ||
        (g.scopeHash && g.scopeHash !== hashIdentity(jobId)) ||
        page.id !== g.consumedBy?.jobId + ':' + g.consumedBy?.page
      )
        fail();
    }
  }
  const notes = indexed(db, 'notes'),
    comments = indexed(db, 'comments');
  for (const job of jobs.values()) {
    const page = pages.get(job.id + ':' + job.pages);
    if (!page) {
      if (modernJobs.has(job.id) || job.checkpoint?.requestReceipts?.length) fail();
      continue;
    }
    if (page.digest !== checkpointDigest(job as Job)) fail();
    for (const id of job.resultIds) {
      const item = (job.type === 'search' ? notes : comments).get(id);
      if (
        !item ||
        item.source !== job.source ||
        item.platform !== job.platform ||
        (job.type === 'comments' && item.noteId !== job.noteId)
      )
        fail();
    }
  }
}

// Serialize the complete migration against other writers. A durable version flag
// distinguishes old rows from later corruption; missing modern guards are never recreated.
export function migrateRequestGuards(db: DatabaseSync) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const version = db
      .prepare('SELECT value FROM config WHERE key=?')
      .get(guardMigrationKey)?.value;
    if (version && version !== '1') throw new Error('不支持此请求记录版本');
    if (!version) {
      validateCollectionState(db);
      for (const r of rows(db, 'request-receipts')) {
        const guard = {
          id: r.id,
          attempt: r.attempt,
          state: r.state,
          scopeHash: r.scopeHash,
          responseHash: r.response ? hashIdentity(JSON.stringify(r.response)) : undefined,
        };
        db.prepare('INSERT OR IGNORE INTO entities(kind,id,value) VALUES(?,?,?)').run(
          'request-guards',
          r.id,
          JSON.stringify(guard),
        );
      }
      db.prepare('INSERT INTO config(key,value) VALUES(?,?)').run(guardMigrationKey, '1');
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// A snapshot says nothing about charges incurred after it was taken. Old scopes
// may replay captured responses but cannot make fresh calls after restoration.
export function fenceRestoredScopes(db: DatabaseSync) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const scopes = [
      ...rows(db, 'jobs').map((j) => j.id),
      ...rows(db, 'workflows').map((w) => 'workflow:' + w.id),
      ...rows(db, 'xhs-api-tasks').map((t) => 'redfox-submit:' + t.id),
    ];
    for (const scope of scopes) {
      const id = hashIdentity(scope);
      db.prepare('INSERT OR IGNORE INTO entities(kind,id,value) VALUES(?,?,?)').run(
        'restore-scopes',
        id,
        JSON.stringify({ id }),
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
