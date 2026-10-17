import type { Comment, Lead, Note, LeadAssessment } from '../shared/types.ts';
export function parseIntent(text: string) {
  const n = text.match(/(\d+)\s*[篇条个]/);
  const cn = text.match(/([一二两三四五六七八九十]+)\s*[篇条个]/)?.[1];
  const digits: Record<string, number> = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  const cnCount = cn
    ? cn.includes('十')
      ? (digits[cn.split('十')[0]] || 1) * 10 + (digits[cn.split('十')[1]] || 0)
      : digits[cn]
    : 0;
  const limit = /不限|所有|全部/.test(text)
    ? 0
    : n
      ? Math.min(500, Math.max(1, Number(n[1])))
      : cnCount || 20;
  const known = ['医美', '家具', '装修', '家居', '咖啡', '健身', '教育', '宠物', '美妆', '穿搭'];
  const keyword =
    known.find((k) => text.includes(k)) ||
    text
      .replace(
        /帮我|请|找到|搜索|采集|最热门|热门|高互动|作品|笔记|并展示结果|找|\d+\s*[篇条个]/g,
        '',
      )
      .trim() ||
    '家居';
  return {
    keyword,
    limit,
    sort: /热门|爆款|高互动|最火/.test(text)
      ? ('popular' as const)
      : /最新|最近/.test(text)
        ? ('latest' as const)
        : ('general' as const),
    noteType: /视频/.test(text)
      ? ('video' as const)
      : /图文/.test(text)
        ? ('image' as const)
        : ('all' as const),
    explanation: `搜索「${keyword}」的${limit === 0 ? '全部' : limit + '篇'}${/视频/.test(text) ? '视频' : '作品'}，按${/热门|爆款|高互动|最火/.test(text) ? '热度' : /最新|最近/.test(text) ? '发布时间' : '相关性'}排序`,
  };
}
export function intentScore(
  body: string,
  createdAt = '',
  context = '',
  now = Date.now(),
): LeadAssessment {
  const evidence: LeadAssessment['evidence'] = [];
  const exclusions: string[] = [];
  const timestamp = Date.parse(createdAt);
  const ageDays =
    Number.isFinite(timestamp) && timestamp <= now + 300000
      ? Math.max(0, Math.floor((now - timestamp) / 86400000))
      : null;
  const fresh =
    ageDays === null
      ? 0
      : ageDays <= 3
        ? 30
        : ageDays <= 7
          ? 24
          : ageDays <= 30
            ? 12
            : ageDays <= 90
              ? 3
              : 0;
  evidence.push({
    label: ageDays === null ? '评论日期缺失或异常，待核实' : `评论距今 ${ageDays} 天`,
    excerpt: createdAt || '无原始日期',
    points: fresh,
  });
  const sensitive =
    /hpv|hiv|艾滋|宫颈|尖锐湿疣|癌症|肿瘤|感染|确诊|治疗|病情|抑郁|焦虑症|怀孕|不孕|性取向|宗教信仰/iu.test(
      body + '\n' + context,
    );
  const resolved =
    /(?:已经|刚刚|刚|早就|已)(?:买到|买了|买好|购买|下单|预约|解决|找到|选好)|买好了|问题解决了|不用了|不需要了|不买了|不想买|不打算买|已成交/.exec(
      body,
    );
  const seller = /加我|私我|看我主页|看主页|厂家直销|我这有|我家有|专业代办/.exec(body);
  const purchasePath =
    /(?:有|给|发).{0,4}链接(?:吗|么|[?？])|(?:求|蹲)个?链接|(?:在)?哪(?:里|儿)?买(?:的)?|怎么预约|如何预约|怎么买|想订|想下单|求联系方式|怎么联系/.exec(
      body,
    );
  const priceQuestion = /\d+(?:\.\d+)?\s*(?:w|万|元|块).{0,8}(?:吗|么|[?？])/i.exec(body);
  const demand =
    purchasePath ||
    priceQuestion ||
    /多少钱|花多少|花了多少|求报价|报价多少|什么价格|价格多少|预算|费用多少|怎么收费|想买|想做|想订|想了解|准备买|准备装修|求推荐|需要一个|需要一套|怎么预约|求链接|怎么买|哪里买|哪里有卖|还没买/.exec(
      body,
    );
  const action = purchasePath;
  const urgent = /今天|明天|这周|本周|近期|最近|急需|着急|马上/.exec(body);
  if (demand) evidence.push({ label: '明确表达需求或询价', excerpt: demand[0], points: 35 });
  if (action) evidence.push({ label: '明确询问购买或联系路径', excerpt: action[0], points: 20 });
  if (urgent && demand) evidence.push({ label: '表达近期计划', excerpt: urgent[0], points: 10 });
  if (resolved) exclusions.push(`已购买、已解决或不再需要：${resolved[0]}`);
  if (seller) exclusions.push(`疑似推广而非购买咨询：${seller[0]}`);
  if (sensitive)
    exclusions.push(
      '涉及健康等敏感主题，不建立个人营销画像；仅做公开内容研究或处理用户主动授权的咨询',
    );
  if (!body.trim()) exclusions.push('没有文字内容，无法判断购买需求');
  let score = evidence.reduce((sum, e) => sum + e.points, 0);
  if (!demand) score = Math.min(score, 15);
  if (ageDays === null) score = Math.min(score, 40);
  if (ageDays !== null && ageDays > 30) score = Math.min(score, 45);
  if (exclusions.length) score = 0;
  score = Math.min(99, score);
  const stage: LeadAssessment['stage'] = sensitive
    ? 'restricted'
    : resolved
      ? 'resolved'
      : seller || !demand
        ? 'discussion'
        : action
          ? 'demand'
          : 'considering';
  return {
    version: 'intent-rules-2.1',
    assessedAt: new Date(now).toISOString(),
    score,
    stage,
    recommended: score >= 50 && !exclusions.length,
    ageDays,
    evidence,
    exclusions,
    reason:
      exclusions.join('；') ||
      (demand
        ? `${evidence.map((e) => e.label).join(' · ')}${ageDays !== null && ageDays > 30 ? ' · 较早信息，需人工确认需求是否仍存在' : ''}`
        : '仅参与讨论，未见明确购买需求'),
  };
}
export function toLead(c: Comment, note?: Note): Lead {
  const assessment = assessComment(c, note);
  return {
    id: `${c.source}:${c.authorId || c.id}:${c.noteId}`,
    commentId: c.id,
    noteId: c.noteId,
    platform: c.platform,
    name: c.author,
    authorId: c.authorId,
    region: c.region,
    content: c.body,
    score: assessment.score,
    reason: assessment.reason,
    assessment,
    commentCreatedAt: c.createdAt,
    status: assessment.stage === 'resolved' ? 'archived' : 'new',
    memo: '',
    outreach: `你好，${c.author}，看到你在相关笔记下提到「${c.body.slice(0, 36)}」，如果你还在了解，我可以分享一些资料供你参考。`,
    source: c.source,
    createdAt: new Date().toISOString(),
  };
}
export function assessComment(c: Comment, note?: Note) {
  const result = intentScore(
    c.body,
    c.createdAt,
    note ? [note.title, note.body, ...note.tags].join('\n') : '',
  );
  if (result.stage !== 'restricted' && c.authorId && c.authorId === note?.authorId) {
    const reason = '作品作者自己的评论或回复，不作为潜在购买客户';
    return {
      ...result,
      score: 0,
      stage: 'discussion' as const,
      recommended: false,
      reason,
      exclusions: [...result.exclusions, reason],
    };
  }
  return result;
}
export function viralScore(n: Note) {
  return Math.round(n.likes + n.comments * 3 + n.saves * 2);
}
