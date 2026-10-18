import { createHash } from 'node:crypto';
import type { InboxMessage, InboxThread } from '../shared/messages.ts';
export const transcriptHash = (messages: InboxMessage[]) =>
  createHash('sha256')
    .update(
      JSON.stringify(
        messages.map(({ nativeId, direction, text, kind }) => ({
          nativeId,
          direction,
          text,
          kind,
        })),
      ),
    )
    .digest('hex');
export const threadHash = (t: InboxThread) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        t.platform,
        t.accountId,
        t.nativeId,
        t.leadId || '',
        t.stopped,
        transcriptHash(t.messages),
      ]),
    )
    .digest('hex');
