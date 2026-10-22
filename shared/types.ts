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
  commentCountKnown?: boolean;
  saves: number;
  publishedAt: string;
  tags: string[];
  url: string;
  source: Mode;
}
export interface Comment {
  semantic?: SemanticReview;
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
  revision?: number;
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
  intentType?: 'purchase' | 'service' | 'interest' | 'discussion' | 'resolved' | 'restricted';
  verdict?: string;
  limitations?: string[];
  threadEvidence?: { commentId: string; role: string; text: string }[];
  semantic?: SemanticReview;

  version: string;
  assessedAt: string;
  score: number;
  reason: string;
  stage: 'demand' | 'considering' | 'resolved' | 'discussion' | 'restricted';
  recommended: boolean;
  ageDays: number | null;
  withinSevenDays?: boolean;
  evidence: { label: string; excerpt: string; points: number }[];
  exclusions: string[];
}
export interface Draft {
  revision?: number;
  platform?: Platform;
  kind?: 'image' | 'video';
  video?: string;
  origin?: 'original' | 'clone';
  // 这篇草稿改写时引用了哪些方法卡，用于事后看卡片有没有带出东西。
  knowledgeIds?: string[];
  // 用户手动发布后回填的作品数据；系统不代发，只记录真实链接与互动数。
  result?: DraftResult;
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
export interface DraftResult {
  url: string;
  platform: Platform;
  noteId: string;
  title: string;
  likes: number;
  comments: number;
  saves: number;
  publishedAt: string;
  checkedAt: string;
}
export interface Log {
  at: string;
  level: 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR';
  message: string;
}
export interface Job {
  checkpoint?: {
    nextCursor: string | null;
    visitedCursors: string[];
    exhausted?: boolean;
    requestReceipts?: { id: string; attempt: string }[];
  };
  dataProvider?: string;
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
  workflows: AcquisitionWorkflow[];
  connections?: PlatformConnection[];
  accounts: Account[];
  notes: Note[];
  comments: Comment[];
  leads: Lead[];
  drafts: Draft[];
  jobs: Job[];
  settings: Settings;
}
export interface AcquisitionInput {
  links?: string[];
  keyword: string;
  platform: Platform;
  mode: Mode;
  searchLimit: number;
  maxNotes: number;
  commentLimit: number;
  supplement: boolean;
}
export interface QualificationComparison {
  total: number;
  reviewed: number;
  excluded: number;
  pending: number;
  agreed: number;
  ruleOnly: number;
  modelOnly: number;
  typeDifferences: number;
  rows: {
    commentId: string;
    ruleIntent: string;
    ruleAccepted: boolean;
    modelIntent?: string;
    modelAccepted?: boolean;
    status: 'excluded' | 'pending' | 'agree' | 'rule_only' | 'model_only' | 'type_difference';
    ruleReason: string;
    modelReason?: string;
    restrictions: string[];
    withinSevenDays: boolean;
  }[];
}
export interface QualificationReview {
  comparison?: QualificationComparison;
  reviewedAt: string;
  version: string;
  originalCommentIds: string[];
  addedCommentIds: string[];
  removedCommentIds: string[];
  reviewedCommentCount: number;
  semanticStatus: string;
}
export interface SemanticReview {
  validationWarning?: string;
  verdict: 'purchase' | 'service' | 'interest' | 'discussion' | 'resolved';
  reason: string;
  quotes: string[];
  limitations: string[];
  model: string;
  reviewedAt: string;
  inputHash: string;
}
export interface ModelOption {
  id: string;
  created?: number;
  custom?: boolean;
}
export interface ModelService {
  id: string;
  kind: 'text' | 'image';
  name: string;
  baseUrl: string;
  model: string;
  models: ModelOption[];
  modelsSyncedAt?: string;
  testedAt?: string;
  hasApiKey: boolean;
  active: boolean;
  createdAt: string;
}
export interface CopyRewrite {
  titles: string[];
  hooks: string[];
  body: string;
  tags: string[];
  avoid: string[];
  model: string;
  elapsedMs: number;
  overlap: number;
  knowledge?: { id: string; title: string; kind: InsightKind }[];
}
export interface ImageSettings {
  serviceId?: string;
  baseUrl: string;
  model: string;
  size: '1024x1024' | '1024x1536' | '1536x1024';
  mode: 'edit' | 'generate';
  watermark: boolean;
  hasApiKey: boolean;
  testedAt?: string;
  models: ModelOption[];
  modelsSyncedAt?: string;
}
export interface ImageVariant {
  id: string;
  url: string;
  source: string;
}
export interface ImageGeneration {
  id?: string;
  warning?: string;
  items: ImageVariant[];
  mode: 'edit' | 'generate';
  model: string;
  size: string;
  elapsedMs: number;
}
export interface LlmSettings {
  serviceId?: string;
  requestTimeoutSeconds: number;
  reviewTimeoutSeconds: number;
  enabled: boolean;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  models: ModelOption[];
  modelsSyncedAt?: string;
  testedAt?: string;
  maxComments: number;
}
export interface AcquisitionWorkflow {
  revision?: number;
  qualificationReview?: QualificationReview;
  reviewProgress?: {
    status: 'running' | 'completed' | 'failed';
    total: number;
    eligible: number;
    excluded: number;
    reviewed: number;
    pending: number;
    message: string;
    startedAt: string;
    updatedAt: string;
  };

  id: string;
  input: AcquisitionInput;
  status: 'running' | 'paused' | 'completed';
  stage: 'resolve' | 'search' | 'comments' | 'assess' | 'done';
  linkNoteIds?: Record<string, string>;
  searchIndex: number;
  searchJobIds: string[];
  noteIds: string[];
  selectedNoteIds: string[];
  completedNoteIds: string[];
  commentIds: string[];
  leadIds: string[];
  currentJobId?: string;
  message: string;
  logs: Log[];
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

export type CollectionPolicy = Record<
  'search' | 'comments',
  { dailyLimit: number; intervalMs: number }
>;
export interface ProtectionView {
  paused: boolean;
  reason: string;
  counts: Record<'search' | 'comments' | 'publish' | 'prepare', number>;
  policy: CollectionPolicy;
  resetAt: number;
  budgets: Record<'search' | 'comments', { remaining: number; availableAt: number | null }>;
}

// 知识卡：把业务经验沉淀成可被 AI 改写、评论归集复用的结构化条目。
// 平台用 'all' 表示两个平台通用；小红书与抖音各自一套，互不覆盖。
export type InsightKind =
  'angle' | 'structure' | 'hook' | 'voice' | 'pain' | 'objection' | 'deal' | 'forbidden';
export type InsightSource = 'manual' | 'breakdown' | 'comments' | 'deal';
export interface InsightCard {
  id: string;
  platform: Platform | 'all';
  kind: InsightKind;
  title: string;
  body: string;
  tags: string[];
  evidence: string[];
  source: InsightSource;
  sourceNoteId?: string;
  enabled: boolean;
  usedCount: number;
  lastUsedAt?: string;
  createdAt: string;
  updatedAt: string;
}
// 拆解与归集的产出先作为候选返回，用户确认后才写进知识库。
export interface InsightCandidate {
  kind: InsightKind;
  title: string;
  body: string;
  tags: string[];
  evidence: string[];
}
export interface NoteBreakdown {
  noteId: string;
  platform: Platform;
  model: string;
  cards: InsightCandidate[];
  dropped: number;
  commentSamples: number;
  elapsedMs: number;
  // 相对同类作品的位置，以及评论区高频词；都是本机统计，可复核。
  radar: RadarReport;
  commentKeywords: { word: string; count: number }[];
}
export interface RadarDimension {
  key: string;
  label: string;
  value: number;
  text: string;
  percentile: number;
}
export interface RadarReport {
  noteId: string;
  sample: { key: string; label: string; size: number };
  dims: RadarDimension[];
  note: string;
}
export interface AuthorWork {
  id: string;
  title: string;
  likes: number;
  comments: number;
  saves: number;
  publishedAt: string;
}
export interface AuthorBreakdown {
  platform: Platform;
  authorId: string;
  author: string;
  works: AuthorWork[];
  cards: InsightCandidate[];
  dropped: number;
  model: string;
  elapsedMs: number;
}
// 选题池：只从真实提问生成，标题与做法都是规则产出，不调模型、可复核。
export interface TopicIdea {
  id: string;
  title: string;
  angle: string;
  intent: KeywordIntent;
  count: number;
  evidence: string;
}
export interface TopicPool {
  platform: Platform;
  seed: string;
  corpusComments: number;
  ideas: TopicIdea[];
  note: string;
}
export interface CommentDigest {
  platform: Platform;
  commentCount: number;
  noteCount: number;
  model: string;
  cards: InsightCandidate[];
  dropped: number;
  elapsedMs: number;
}
export type KeywordIntent = '价格' | '选品' | '避坑' | '教程' | '场景' | '通用';
export interface KeywordSuggestion {
  keyword: string;
  intent: KeywordIntent;
  origin: 'corpus' | 'model';
  hits: number;
  sample: string;
}
export interface KeywordDigest {
  platform: Platform;
  seed: string;
  corpusComments: number;
  suggestions: KeywordSuggestion[];
  model?: string;
}
export interface AttributionRow {
  keyword: string;
  platform: Platform;
  notes: number;
  leads: number;
  contacted: number;
  won: number;
  amount: number;
}
export interface KnowledgeAttribution {
  rows: AttributionRow[];
  totals: { notes: number; leads: number; won: number; amount: number };
  note: string;
}
// 卡片 → 草稿 → 已回填作品的口径。互动数是作品级，同一作品用了多张卡时会在每张卡上各计一次。
export interface CardOutcome {
  cardId: string;
  title: string;
  platform: Platform | 'all';
  kind: InsightKind;
  drafts: number;
  published: number;
  likes: number;
  comments: number;
  saves: number;
}
export interface DraftOutcomes {
  rows: CardOutcome[];
  totals: {
    cards: number;
    drafts: number;
    published: number;
    likes: number;
    comments: number;
    saves: number;
  };
  unattributed: number;
  note: string;
}
