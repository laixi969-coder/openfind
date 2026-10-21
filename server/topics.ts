import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Comment, KeywordIntent, Note, Platform, TopicPool } from '../shared/types.ts';
import { all } from './store.ts';
import { demandPhrases } from './insights.ts';

// 标题后缀按语气分，控制在 20 字以内（小红书标题上限）。
const SUFFIX: Record<KeywordIntent, string> = {
  价格: '预算怎么拆',
  避坑: '容易踩的坑',
  教程: '分步做法',
  选品: '怎么挑',
  场景: '按空间说',
  通用: '先看这几点',
};
// 每个意图给一句可执行的写法建议，规则产出，不是模型编的。
const ANGLES: Record<KeywordIntent, string> = {
  价格: '把预算拆成硬装、材料、家电三块，各给区间并说明哪块能往后放，别只报总数。',
  避坑: '列出最容易翻车的几个位置，每个配一张实拍或示意图，最后给验收清单。',
  教程: '按「准备—执行—验收」三步走，每步给一个能自己核对的检查点。',
  选品: '给一张对比表：低中高三个价位各选一个代表，写清适合谁、不适合谁。',
  场景: '按空间逐个讲：这个场景里最容易被忽略的三件事，配一张现场图。',
  通用: '先给结论再给依据，中间用分点，结尾留一个不强迫的互动问题。',
};

function titleOf(phrase: string, intent: KeywordIntent) {
  const suffix = SUFFIX[intent];
  const room = Math.max(4, 20 - suffix.length - 1);
  const head = phrase.length > room ? phrase.slice(0, room) : phrase;
  return head + '｜' + suffix;
}

// 选题池只吃真实提问：不调模型、不编主题，来源可逐条回溯到评论原话。
export function buildTopicPool(input: unknown): TopicPool {
  const v = z
    .object({
      platform: z.enum(['xiaohongshu', 'douyin']),
      seed: z.string().trim().max(40).default(''),
      limit: z.number().int().min(5).max(30).default(15),
    })
    .strict()
    .parse(input);
  const notes = all<Note>('notes').filter((n) => n.platform === v.platform);
  const noteIds = new Set(notes.map((n) => n.id));
  const comments = all<Comment>('comments')
    .filter((c) => noteIds.has(c.noteId) || c.platform === v.platform)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 2000);
  const phrases = demandPhrases(comments.map((c) => c.body))
    // 太短的短语没有主语，直接当标题会像半句话。
    .filter((p) => p.phrase.length >= 6)
    .filter((p) => (v.seed ? p.phrase.includes(v.seed) : true));
  return {
    platform: v.platform as Platform,
    seed: v.seed,
    corpusComments: comments.length,
    ideas: phrases.slice(0, v.limit).map((item) => ({
      id: createHash('sha256').update(item.phrase).digest('hex').slice(0, 12),
      title: titleOf(item.phrase, item.intent),
      angle: ANGLES[item.intent],
      intent: item.intent,
      count: item.count,
      evidence: item.sample,
    })),
    note: '选题只来自已采集评论里的真实提问，出现次数就是评论里问过的人数；标题是规则拼的，可以改。评论越多，这个池子越准。',
  };
}
