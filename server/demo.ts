import type { Note, Comment } from '../shared/types.ts';
const names = [
  '木也设计',
  '一颗小橙子',
  '林间日记',
  '小鹿的生活提案',
  '阿白同学',
  '南风研究所',
  '慢慢生活',
  '有间工作室',
  '许许的灵感本',
  '小禾',
];
const topics = ['家居', '医美', '装修', '咖啡', '健身', '教育', '宠物', '美妆'];
const titles = [
  '把日子过成喜欢的样子',
  '这份避坑清单，请收好',
  '普通人也能拥有的松弛感',
  '做了三个月功课，我想说…',
  '真的后悔没有早点知道',
  '我的私藏清单，终于整理好了',
  '不跟风，只选适合自己的',
  '从0开始，这篇讲清楚',
  '问了很多次的答案都在这',
  '原来还可以这样选',
];
export function demoNotes(keyword = '家居', count = 24): Note[] {
  const topic = topics.find((t) => keyword.includes(t)) || keyword;
  return Array.from({ length: count }, (_, i) => ({
    id: `demo-${encodeURIComponent(keyword)}-${i + 1}`,
    title:
      i === 0
        ? `${topic}灵感｜把日子过成喜欢的样子`
        : i === 1
          ? `${topic}避坑指南：这6件事一定要知道`
          : i === 2
            ? `关于${topic}，一篇说清楚`
            : `${topic}｜${titles[i % titles.length]}`,
    body: `最近收到了很多关于${topic}的问题，今天把我的整理分享出来。\n\n01 先想清楚自己的实际需求，适合自己的才是好选择。\n02 多看真实反馈，提前了解流程和预算。\n03 做好记录，慢慢找到自己的节奏。\n\n这是一条 OpenFind 本地演示笔记，所有互动数据均为生成的样例，不是真实平台内容。`,
    author: names[i % names.length],
    authorId: `demo-user-${i % names.length}`,
    platform: 'xiaohongshu',
    type: i % 5 === 4 ? 'video' : 'image',
    images:
      i % 5 === 4
        ? []
        : [`/assets/cover-${(i % 12) + 1}.svg`, `/assets/cover-${((i + 4) % 12) + 1}.svg`],
    cover: `/assets/cover-${(i % 12) + 1}.svg`,
    likes:
      [12800, 8620, 4260, 21900, 3280, 15600, 6790, 1240, 986, 7280, 3460, 1820][i % 12] + i * 7,
    comments: Math.round(31 + i * 13 + (i % 4) * 57),
    saves: Math.round(200 + i * 71 + (i % 5) * 400),
    publishedAt: new Date(Date.now() - (i + 1) * 3600_000 * 7).toISOString(),
    tags: [topic, '生活灵感', '经验分享'],
    url: '',
    source: 'demo',
  }));
}
export function demoComments(noteId: string, count = 36): Comment[] {
  const contents = [
    '想问一下大概多少钱？预算三千可以吗',
    '想买同款，求链接！',
    '有上海的推荐吗？想了解一下',
    '请问哪里可以预约，需要提前多久',
    '这个思路好喜欢，先收藏了',
    '我也在做功课，想找专业的咨询一下',
    '求地址！周末想去看看',
    '可以分享一份报价清单吗',
    '谢谢分享，很有参考价值',
    '我也遇到了同样的问题',
    '怎么买？能联系一下吗',
    '感觉很适合我们家，求推荐',
  ];
  const regions = ['上海', '广东', '北京', '浙江', '四川', '江苏', '山东', '福建'];
  return Array.from({ length: count }, (_, i) => ({
    id: `${noteId}-comment-${i}`,
    noteId,
    parentId: i % 3 === 2 ? `${noteId}-comment-${i - 2}` : null,
    author:
      ['小鱼', '小满', 'Luna', '一只小熊', '晴天', 'Momo', '不晚', '花花'][i % 8] +
      (i > 7 ? String(i) : ''),
    authorId: `demo-commenter-${i}`,
    body: contents[i % contents.length],
    region: regions[i % 8],
    createdAt: new Date(Date.now() - i * 900000).toISOString(),
    likes: (i * 17) % 81,
    source: 'demo',
  }));
}
