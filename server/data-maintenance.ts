import { createHash } from 'node:crypto';
import { readdirSync, lstatSync, unlinkSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { all, db, get, remove, put, transaction, configGet, configSet, dataDir } from './store.ts';
import { managedBackups } from './auto-backup.ts';
import type { Comment, Lead, Note } from '../shared/types.ts';
import type { InboxThread } from '../shared/messages.ts';

const uploadName = /^[a-f0-9-]+\.(png|jpe?g|webp|mp4|mov|webm|tmp)$/;
export function retentionDays() {
  return Number(configGet('retention:days', '30'));
}
export function setRetentionDays(days: number) {
  configSet('retention:days', String(days));
}
function rows() {
  return db
    .prepare('SELECT kind,id,value FROM entities')
    .all()
    .map((r) => ({ kind: String(r.kind), id: String(r.id), value: JSON.parse(String(r.value)) }));
}
function references(value: unknown, found: Set<string>) {
  if (
    typeof value === 'string' &&
    /^\/api\/media\/[a-f0-9-]+\.(png|jpe?g|webp|mp4|mov|webm)$/.test(value)
  )
    found.add(value.split('/').at(-1)!);
  else if (Array.isArray(value)) value.forEach((v) => references(v, found));
  else if (value && typeof value === 'object')
    Object.values(value).forEach((v) => references(v, found));
}
export function cleanupPlan(now = Date.now()) {
  const cutoff = now - retentionDays() * 86400000;
  const entities = rows();
  const directory = join(dataDir, 'uploads');
  if (
    existsSync(directory) &&
    (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())
  )
    throw new Error('素材目录不是普通目录，已停止清理');
  const expiredGenerations = new Set(
    entities
      .filter(
        (r) =>
          r.kind === 'image-generations' &&
          r.value.status !== 'running' &&
          (Date.parse(r.value.createdAt || '') < cutoff ||
            (!r.value.createdAt &&
              Array.isArray(r.value.items) &&
              r.value.items.length > 0 &&
              r.value.items.every((item: { url?: string }) => {
                if (!item.url || !/^\/api\/media\/[a-f0-9-]+\.(png|jpe?g|webp)$/.test(item.url))
                  return false;
                const path = join(directory, item.url.split('/').at(-1)!);
                return (
                  existsSync(path) && lstatSync(path).isFile() && lstatSync(path).mtimeMs < cutoff
                );
              }))),
      )
      .map((r) => r.id),
  );
  const referenced = new Set<string>();
  for (const r of entities) {
    if (
      r.kind === 'draft-media' ||
      r.kind === 'request-receipts' ||
      (r.kind === 'image-generations' && expiredGenerations.has(r.id))
    )
      continue;
    references(r.value, referenced);
  }
  const files = existsSync(directory)
    ? readdirSync(directory)
        .filter((name) => {
          const path = join(directory, name),
            stat = lstatSync(path);
          return (
            uploadName.test(name) &&
            stat.isFile() &&
            !stat.isSymbolicLink() &&
            stat.mtimeMs < cutoff &&
            !referenced.has(name)
          );
        })
        .map((name) => ({ name, bytes: lstatSync(join(directory, name)).size }))
    : [];
  const receipts = entities
    .filter(
      (r) =>
        r.kind === 'request-receipts' &&
        r.value.category === 'model' &&
        r.value.state === 'received' &&
        Date.parse(r.value.createdAt) < cutoff,
    )
    .map((r) => r.id);
  const details = { days: retentionDays(), files, generations: [...expiredGenerations], receipts };
  return {
    ...details,
    bytes: files.reduce((n, f) => n + f.bytes, 0),
    token: createHash('sha256').update(JSON.stringify(details)).digest('hex'),
  };
}
export function executeCleanup(expectedToken: string) {
  const plan = cleanupPlan();
  if (plan.token !== expectedToken) throw new Error('清理范围已变化，请重新预览后确认');
  const filenames = new Set(plan.files.map((f) => f.name));
  // Remove stale cache references before files; failures leave extra bytes, never broken live drafts.
  transaction(() => {
    for (const id of plan.receipts) {
      const guard = get<{ id: string; attempt: string; state: string; scopeHash?: string }>(
        'request-guards',
        id,
      );
      if (!guard) throw new Error('模型回执缺少防重记录，已停止清理');
      if (guard.state !== 'consumed')
        put('request-guards', {
          id,
          attempt: guard.attempt,
          state: 'pending',
          scopeHash: guard.scopeHash,
        });
      remove('request-receipts', id);
    }
    for (const id of plan.generations) remove('image-generations', id);
    for (const r of all<{ id: string; url: string }>('draft-media'))
      if (filenames.has(r.url?.split('/').at(-1)!)) remove('draft-media', r.id);
  });
  for (const file of plan.files) unlinkSync(join(dataDir, 'uploads', file.name));
  configSet('retention:lastCleanup', new Date().toISOString());
  return {
    deletedFiles: plan.files.length,
    bytes: plan.bytes,
    deletedGenerations: plan.generations.length,
  };
}

export function forgetPlan(leadId: string) {
  const lead = get<Lead>('leads', leadId);
  if (!lead) throw new Error('客户不存在');
  const platform = (value: { platform?: string; noteId?: string }) =>
    value.platform || get<Note>('notes', value.noteId || '')?.platform || 'unknown';
  const leadPlatform = platform(lead);
  const match = (value: {
    authorId?: string;
    source?: string;
    platform?: string;
    noteId?: string;
    id?: string;
  }) =>
    value.source === lead.source &&
    platform(value) === leadPlatform &&
    (lead.authorId ? value.authorId === lead.authorId : value.id === lead.id);
  const leads = all<Lead>('leads').filter(match);
  const comments = all<Comment>('comments').filter(
    (c) =>
      c.source === lead.source &&
      platform(c) === leadPlatform &&
      (lead.authorId ? c.authorId === lead.authorId : c.id === lead.commentId),
  );
  const ids = new Set([...leads.map((l) => l.id), ...comments.map((c) => c.id)]);
  const threads = all<InboxThread>('inboxThreads').filter(
    (t) =>
      lead.source === 'live' &&
      t.platform === leadPlatform &&
      (ids.has(t.leadId || '') || (lead.authorId && (t.peerId || t.nativeId) === lead.authorId)),
  );
  threads.forEach((t) => {
    ids.add(t.id);
  });
  const sourceKey = (kind: string, id: string) => JSON.stringify([kind, id]);
  const sourceIds = new Set([
    ...leads.map((l) => sourceKey('leads', l.id)),
    ...comments.map((c) => sourceKey('comments', c.id)),
    ...threads.map((t) => sourceKey('inboxThreads', t.id)),
  ]);
  const relatedSources = (sources: { kind: string; id: string }[]) =>
    sources.some((source) => sourceIds.has(sourceKey(source.kind, source.id)));
  const contains = (value: unknown): boolean => {
    if (typeof value === 'string') {
      if (ids.has(value)) return true;
      if (/^[\[{]/.test(value)) {
        try {
          return contains(JSON.parse(value));
        } catch {
          /* plain text */
        }
      }
      return false;
    }
    if (Array.isArray(value)) return value.some(contains);
    return !!value && typeof value === 'object' && Object.values(value).some(contains);
  };
  const entities = rows();
  const deletions = new Map<string, { kind: string; id: string }>();
  const add = (r: { kind: string; id: string }) =>
    deletions.set(JSON.stringify([r.kind, r.id]), { kind: r.kind, id: r.id });
  const kinds = new Set([
    'comments',
    'leads',
    'salesCases',
    'inboxThreads',
    'replyDrafts',
    'semanticReviews',
    'semanticReviewHistory',
    'xhs-api-tasks',
    'insights',
    'request-receipts',
  ]);
  // Follow recorded input relationships, not coincidentally equal natural-language text.
  const dependents = new Map<string, string[]>();
  for (const r of entities) {
    if (r.kind !== 'insights' || !Array.isArray(r.value.sources)) continue;
    for (const source of r.value.sources) {
      const key = sourceKey(source.kind, source.id);
      const group = dependents.get(key);
      if (group) group.push(r.id);
      else dependents.set(key, [r.id]);
    }
  }
  const queue = [...sourceIds];
  for (let i = 0; i < queue.length; i++)
    for (const id of dependents.get(queue[i]) || [])
      if (!sourceIds.has(sourceKey('insights', id))) {
        ids.add(id);
        const key = sourceKey('insights', id);
        sourceIds.add(key);
        queue.push(key);
      }
  for (const r of entities) {
    if (!kinds.has(r.kind)) continue;
    if (
      r.kind === 'insights' ||
      (r.kind === 'request-receipts' &&
        r.value.category === 'model' &&
        Array.isArray(r.value.sources))
    ) {
      if (sourceIds.has(sourceKey(r.kind, r.id)) || relatedSources(r.value.sources || [])) add(r);
      continue;
    }
    if (r.kind === 'comments' || r.kind === 'leads' || r.kind === 'inboxThreads') {
      if (ids.has(r.id)) add(r);
    } else if (
      contains(r.value) ||
      (r.kind === 'semanticReviewHistory' && comments.some((c) => r.id.startsWith(c.id + ':')))
    )
      add(r);
  }
  // Remove dependent checkpoints as a unit; keep only opaque anti-replay tombstones.
  for (const r of entities)
    if (r.kind === 'jobs' && contains(r.value)) {
      add(r);
      ids.add(r.id);
    }
  for (const r of entities) if (r.kind === 'workflows' && contains(r.value)) add(r);
  for (const r of entities)
    if (r.kind === 'job-pages' && ids.has(r.value.jobId || r.id.slice(0, r.id.lastIndexOf(':'))))
      add(r);
  const list = [...deletions.values()].sort((a, b) => (a.kind + a.id).localeCompare(b.kind + b.id));
  const backups = managedBackups();
  const legacyModelReceipts = entities
    .filter(
      (r) =>
        r.kind === 'request-receipts' &&
        r.value.category === 'model' &&
        r.value.response &&
        !Array.isArray(r.value.sources),
    )
    .map((r) => r.id);
  return {
    leadId,
    entries: list,
    counts: Object.fromEntries(
      [...new Set(list.map((r) => r.kind))].map((kind) => [
        kind,
        list.filter((r) => r.kind === kind).length,
      ]),
    ),
    managedBackups: backups.length,
    legacyModelReceipts,
    token: createHash('sha256')
      .update(
        JSON.stringify([
          lead,
          list,
          backups,
          legacyModelReceipts,
          db.prepare('SELECT total_changes() n').get(),
          db.prepare('PRAGMA data_version').get(),
        ]),
      )
      .digest('hex'),
  };
}
export function forgetCustomer(
  leadId: string,
  token: string,
  includeBackups: boolean,
  includeLegacyModelReceipts = false,
) {
  const plan = forgetPlan(leadId);
  if (plan.token !== token) throw new Error('客户或清除范围已变化，请重新预览后确认');
  if (plan.legacyModelReceipts.length && !includeLegacyModelReceipts)
    throw Object.assign(
      new Error('旧版模型回执没有客户来源记录，请先确认清除这些原始回执，避免遗漏客户文本'),
      { statusCode: 409 },
    );
  if (includeLegacyModelReceipts)
    for (const id of plan.legacyModelReceipts)
      if (!plan.entries.some((r) => r.kind === 'request-receipts' && r.id === id))
        plan.entries.push({ kind: 'request-receipts', id });
  plan.counts['request-receipts'] = plan.entries.filter(
    (r) => r.kind === 'request-receipts',
  ).length;
  transaction(() => {
    const removedJobs = new Set(plan.entries.filter((r) => r.kind === 'jobs').map((r) => r.id));
    const removedReceipts = new Set(
      plan.entries.filter((r) => r.kind === 'request-receipts').map((r) => r.id),
    );
    for (const guard of all<{
      id: string;
      state: string;
      attempt: string;
      scopeHash?: string;
      consumedBy?: { jobId: string };
    }>('request-guards')) {
      if (
        removedJobs.has(guard.consumedBy?.jobId || '') ||
        (removedReceipts.has(guard.id) && guard.state !== 'consumed')
      ) {
        put('request-guards', {
          id: guard.id,
          attempt: guard.attempt,
          scopeHash: guard.scopeHash,
          state: 'pending',
        });
        remove('request-receipts', guard.id);
      }
    }
    for (const row of plan.entries) remove(row.kind, row.id);
  });
  let deletedBackups = 0;
  if (includeBackups) {
    for (const directory of managedBackups()) {
      rmSync(directory, { recursive: true });
      deletedBackups++;
    }
    configSet('backup:lastSuccess', '');
  }
  return {
    counts: plan.counts,
    deletedBackups,
    externalCopies:
      '其他目录、系统备份、导出文件及第三方平台的数据需要另行清除；重新采集也可能再次导入。',
  };
}
