export type Platform = 'xiaohongshu' | 'douyin';
export interface PlatformConnection {
  network?: 'system' | 'direct';
  platform: Platform;
  status: 'disconnected' | 'opening' | 'awaiting_login' | 'ready' | 'challenge' | 'error';
  accountId?: string;
  accountName?: string;
  message: string;
  url?: string;
  checkedAt: string;
  browserOpen: boolean;
}
export type Mode = 'demo' | 'live';
export interface Note {
  id: string;
  title: string;
  body: string;
  author: string;
  authorId: string;
  platform: Platform;
  nativeId?: string;
  videoUrl?: string;
  detailState?: 'summary' | 'complete';
  type: 'image' | 'video';
  images: string[];
  cover: string;
  likes: number;
  comments: number;
  saves: number;
  publishedAt: string;
  tags: string[];
  url: string;
  source: Mode;
}
export interface Comment {
  platform?: Platform;
  id: string;
  noteId: string;
  parentId: string | null;
  author: string;
  authorId: string;
  body: string;
  region: string;
  createdAt: string;
  likes: number;
  source: Mode;
}
export interface Lead {
  assessment?: LeadAssessment;
  commentCreatedAt?: string;
  platform?: Platform;
  id: string;
  commentId: string;
  noteId: string;
  name: string;
  authorId: string;
  region: string;
  content: string;
  score: number;
  reason: string;
  status: 'new' | 'contacted' | 'qualified' | 'archived';
  memo: string;
  outreach: string;
  source: Mode;
  createdAt: string;
}
export interface LeadAssessment {
  version: string;
  assessedAt: string;
  score: number;
  reason: string;
  stage: 'demand' | 'considering' | 'resolved' | 'discussion' | 'restricted';
  recommended: boolean;
  ageDays: number | null;
  evidence: { label: string; excerpt: string; points: number }[];
  exclusions: string[];
}
export interface Draft {
  platform?: Platform;
  kind?: 'image' | 'video';
  video?: string;
  origin?: 'original' | 'clone';
  id: string;
  noteId: string;
  title: string;
  body: string;
  tags: string[];
  images: string[];
  visibility: 'public' | 'private';
  accountId: string;
  status: 'draft' | 'published' | 'demo_published';
  receipt?: string;
  createdAt: string;
  updatedAt: string;
}
export interface Log {
  at: string;
  level: 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR';
  message: string;
}
export interface Job {
  searchEvidence?: {
    sort: SearchInput['sort'];
    path: string;
    filterSelected: string | null;
    sortType: string | null;
  };
  query?: SearchInput;
  finishedAt?: string;
  dataFetchedAt?: string;
  platform?: Platform;
  id: string;
  type: 'search' | 'comments';
  status: 'running' | 'completed' | 'stopped' | 'failed';
  keyword: string;
  noteId?: string;
  count: number;
  pages: number;
  elapsed: number;
  resultIds: string[];
  logs: Log[];
  source: Mode;
  createdAt: string;
  error?: string;
}
export interface SearchInput {
  forceRefresh?: boolean;
  platform?: Platform;
  keyword: string;
  limit: number;
  sort: 'general' | 'latest' | 'popular';
  noteType: 'all' | 'image' | 'video';
  interval: number;
  mode: Mode;
}
export interface Settings {
  platform?: Platform;
  connectionType?: 'browser' | 'http';
  mode: Mode;
  providerUrl: string;
  hasToken: boolean;
  hasCookie: boolean;
  rememberCookie: boolean;
  accountName: string;
  accountId: string;
}
export interface Account {
  platform?: Platform;
  connectionType?: 'browser' | 'http';
  id: string;
  name: string;
  hasCookie: boolean;
  rememberCookie: boolean;
  createdAt: string;
}
export interface Snapshot {
  connections?: PlatformConnection[];
  accounts: Account[];
  notes: Note[];
  comments: Comment[];
  leads: Lead[];
  drafts: Draft[];
  jobs: Job[];
  settings: Settings;
}
