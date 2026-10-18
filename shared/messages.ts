import type { Platform } from './types.ts';
export interface InboxMessage {
  nativeId: string;
  direction: 'incoming' | 'outgoing';
  text: string;
  timeLabel: string;
  kind: 'text' | 'attachment';
}
export interface InboxThread {
  id: string;
  platform: Platform;
  accountId: string;
  accountName: string;
  nativeId: string;
  peerId?: string;
  name: string;
  preview: string;
  timeLabel: string;
  messages: InboxMessage[];
  revision: number;
  position?: number;
  leadId?: string;
  watching: boolean;
  autoSuggest: boolean;
  stopped: boolean;
  syncedAt: string;
  error: string;
  suggestionError?: string;
  suggestionGenerating?: boolean;
}
export interface ReplyDraft {
  id: string;
  threadId: string;
  contextHash: string;
  text: string;
  rationale: string;
  status: 'pending' | 'sending' | 'sent' | 'unknown' | 'stale';
  createdAt: string;
  sentMessageId?: string;
  beforeMessageIds?: string[];
}
export interface NativeInbox {
  platform: Platform;
  accountId: string;
  accountName: string;
  threads: {
    nativeId: string;
    peerId?: string;
    name: string;
    preview: string;
    timeLabel: string;
  }[];
  selected?: { nativeId: string; messages: InboxMessage[] };
}
