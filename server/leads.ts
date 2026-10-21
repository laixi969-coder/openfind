import type { Comment, Lead, Note } from '../shared/types.ts';
import { toLead } from './domain.ts';
import { all, get, put } from './store.ts';

export function leadIdentity(lead: Lead) {
  return JSON.stringify([
    lead.source,
    lead.platform || get<Note>('notes', lead.noteId)?.platform || 'unknown',
    lead.noteId,
    lead.authorId ? 'author' : 'comment',
    lead.authorId || lead.commentId,
  ]);
}
// One demand record per person/work. Keep legacy IDs so workflows and sales history
// remain attached; never infer identity from display names or delete old records.
export function saveCollectedLead(c: Comment, note: Note | undefined, comments: Comment[]) {
  const incoming = toLead(c, note, comments);
  const existing = all<Lead>('leads')
    .filter((l) => leadIdentity(l) === leadIdentity(incoming))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0];
  if (!existing) {
    put('leads', incoming);
    return { lead: incoming, added: true };
  }
  const oldTime = Date.parse(existing.commentCreatedAt || '');
  const newTime = Date.parse(c.createdAt);
  const newer =
    c.id === existing.commentId ||
    (Number.isFinite(newTime) &&
      (!Number.isFinite(oldTime) ||
        newTime > oldTime ||
        (newTime === oldTime && c.id > existing.commentId)));
  if (!newer) return { lead: existing, added: false };
  const lead: Lead = {
    ...existing,
    ...incoming,
    id: existing.id,
    status: existing.status,
    memo: existing.memo,
    outreach: existing.outreach,
    createdAt: existing.createdAt,
    revision: existing.revision || 0,
  };
  put('leads', lead);
  return { lead, added: false };
}
