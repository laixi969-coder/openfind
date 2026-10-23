import { createHash, randomUUID } from 'node:crypto';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { all, db } from './store.ts';
import { assessComment, intentScore, withCommentIndex } from './domain.ts';
import { semanticFor, withTextService } from './llm.ts';
import type {
  Account,
  AcquisitionWorkflow,
  Comment,
  Draft,
  Job,
  Lead,
  Note,
  Settings,
  SemanticReview,
} from '../shared/types.ts';

const compress = promisify(gzip);
const instance = randomUUID();
let cache: { version: string; etag: string; json: string; gzip: Promise<Buffer> } | undefined;
export function workspaceState(settings: () => Settings, accounts: () => Account[]) {
  return withTextService(() => buildWorkspaceState(settings, accounts));
}
function buildWorkspaceState(settings: () => Settings, accounts: () => Account[]) {
  // data_version detects writes from the browser/other processes; total_changes detects ours.
  // Refresh age-dependent assessments at most once a minute even without writes.
  const version = JSON.stringify([
    db.prepare('PRAGMA data_version').get(),
    db.prepare('SELECT total_changes() AS n').get(),
    Math.floor(Date.now() / 60000),
  ]);
  if (cache?.version === version) return cache;
  const comments = all<Comment>('comments');
  return withCommentIndex(comments, () => {
    const notes = all<Note>('notes');
    const noteById = new Map(notes.map((n) => [n.id, n]));
    const commentById = new Map(comments.map((c) => [c.id, c]));
    const reviews = new Map(
      all<SemanticReview & { id: string }>('semanticReviews').map((r) => [r.id, r]),
    );
    const leads = all<Lead>('leads').map((l) => {
      const c = commentById.get(l.commentId),
        note = noteById.get(l.noteId);
      const context = comments;
      const assessment = c
        ? {
            ...assessComment(c, note, Date.now(), context),
            semantic: semanticFor(c, note, context, reviews.get(c.id) || null),
          }
        : intentScore(
            l.content,
            l.commentCreatedAt || '',
            note ? [note.title, note.body, ...note.tags].join('\n') : '',
          );
      return {
        ...l,
        score: assessment.score,
        reason: assessment.reason,
        assessment,
        commentCreatedAt: c?.createdAt || l.commentCreatedAt || '',
      };
    });
    const json = JSON.stringify({
      accounts: accounts(),
      notes,
      comments: comments.map((c) => ({
        ...c,
        semantic: semanticFor(c, noteById.get(c.noteId), comments, reviews.get(c.id) || null),
      })),
      leads,
      drafts: all<Draft>('drafts'),
      jobs: all<Job>('jobs'),
      workflows: all<AcquisitionWorkflow>('workflows'),
      settings: settings(),
    });
    const etag =
      '"' +
      createHash('sha256')
        .update(instance + version)
        .digest('hex') +
      '"';
    cache = { version, etag, json, gzip: compress(json, { level: 1 }) };
    // Attach a handler immediately: a client may only request the plain representation.
    void cache.gzip.catch(() => {});
    return cache;
  });
}
