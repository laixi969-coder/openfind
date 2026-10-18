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
export const qualificationVersion = 'intent-rules-3.1.1';
export function intentScore(
  body: string,
  createdAt = '',
  context = '',
  now = Date.now(),
): LeadAssessment {
  const evidence: LeadAssessment['evidence'] = [];
  const exclusions: string[] = [];
  const limitations: string[] = [];
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
  const text = body.normalize('NFKC').replace(/🔗/gu, '链接');
  const sensitive =
    /hpv|hiv|艾滋|宫颈|尖锐湿疣|癌症|肿瘤|感染|确诊|治疗|病情|抑郁|焦虑症|怀孕|孕\d*周|\d+周.{0,10}生|🤰|不孕|性取向|宗教信仰|脱发|米诺|骨科|足弓塌陷/iu.test(
      body + '\n' + context,
    );
  const resolved =
    /(?:已经|刚刚|刚|早就|已)(?:买到|买了|买好|购买|下单|预约|解决|找到|选好)|我买了|买好了|解决了|不用了|不需要了|不买了|不想买|不打算买|不要链接|不用给.{0,2}链接|不问价|已成交|我买的.{0,30}(?:残留|怎么|问题|坏)/.exec(
      text.replace(/(?:还没|没|未)买/g, '尚未购'),
    );
  const seller = /加我|私我|看我主页|看主页|厂家直销|我这有|我家有|专业代办/.exec(text);
  const path =
    /链接.{0,6}(?:给|发|分享)|(?:有|给|发).{0,4}链接(?:吗|么|嘛|[?？])|(?:求|蹲)个?链接|(?:在)?哪(?:里|儿)?买(?:的|到)?|怎么预约|如何预约|怎么买|想订|想下单|求联系方式|怎么联系|^.{0,16}链接[?？!！。]?$/.exec(
      text,
    );
  const sharing =
    /(?:静电消除器|封口器|洗手刷|罐头固定器|头箍|刷瓶豆|地毯|沙发|灯|花瓶).{0,12}(?:分享|推荐)(?:一?下|一下吗)|(?:分享|推荐)(?:一?下).{0,12}(?:牌子|品牌)|什么牌子.{0,12}推荐|线上还是线下买/.exec(
      text,
    );
  const serviceContext = /装修|软装|设计|改造|客厅|家居/.test(context);
  const service =
    serviceContext &&
    /(?:能|可以)?.{0,3}帮我设计|给我设计|求改|求设计|求改造|想找.{0,5}设计|找设计师/.exec(text);
  const costComparison =
    /(?:硬装|软装|装修|装的|花了).{0,16}\d+(?:\.\d+)?\s*(?:w|万|元|块).{0,8}(?:吗|么|[?？])/i.exec(
      text,
    );
  const vague =
    /有没有实物图|有实物图|好些个都是我很需要|我也想要|想要同款|好想要|这种怎么改|适合什么风格/.exec(
      text,
    );
  const plannedPurchase =
    !/(?:不|没)(?:想|会|打算|准备|计划|要去)|假如|如果|要是|听说|他说|她说|朋友说/.test(text) &&
    /(?:要去|准备去|打算去|计划去)[^。！？?\n]{0,24}买(?:花|灯|地毯|沙发|花瓶|家具|一|个|这|同款)/.exec(
      text,
    );
  const demand =
    plannedPurchase ||
    path ||
    sharing ||
    service ||
    /多少钱|求报价|报价多少|什么价|多少价|问价|价格多少|费用多少|怎么收费|想买|想做|想订|准备买|准备装修|求推荐|需要一个|需要一套|哪里有卖|还没买/.exec(
      text,
    );
  let intentType: NonNullable<LeadAssessment['intentType']> =
    path || sharing
      ? 'purchase'
      : service
        ? 'service'
        : demand
          ? 'purchase'
          : costComparison || vague
            ? 'interest'
            : 'discussion';
  if (plannedPurchase)
    evidence.push({ label: '本人明确表达前往采购的计划，未证实下单', excerpt: body, points: 10 });
  if (demand && !costComparison)
    evidence.push({
      label: service ? '主动请求设计或改造服务' : '明确表达产品需求或询价',
      excerpt: body,
      points: 35,
    });
  if ((path || sharing || service) && !costComparison)
    evidence.push({
      label: service ? '请求为本人提供方案，付费意愿未证实' : '询问商品获取、分享或购买渠道',
      excerpt: body,
      points: 20,
    });
  if (costComparison) {
    intentType = 'interest';
    evidence.push({ label: '询问既有装修成本，不等于新购买或委托', excerpt: body, points: 15 });
    limitations.push('缺少本人的采购计划或委托请求，可能仅在比较成本');
  }
  if (vague && !demand && !costComparison)
    evidence.push({ label: '有兴趣或信息需求，尚无明确购买路径', excerpt: body, points: 15 });
  if (/今天|明天|这周|本周|近期|最近|急需|着急|马上/.test(text) && demand && !costComparison)
    evidence.push({ label: '表达近期计划', excerpt: body, points: 10 });
  if (resolved) {
    exclusions.push(`已购买、售后、已解决或不再需要：${resolved[0]}`);
    intentType = 'resolved';
  }
  if (seller) {
    exclusions.push(`疑似推广而非购买咨询：${seller[0]}`);
    intentType = 'discussion';
  }
  if (sensitive) {
    exclusions.push('涉及健康等敏感主题，不建立个人营销画像；仅作公开内容研究');
    intentType = 'restricted';
  }
  if (!body.trim()) exclusions.push('没有文字内容，无法判断购买需求');
  let score = evidence.reduce((sum, e) => sum + e.points, 0);
  if (intentType === 'discussion') score = Math.min(score, 15);
  if (intentType === 'interest') score = Math.min(score, 49);
  if (ageDays === null) score = Math.min(score, 40);
  if (ageDays !== null && ageDays > 30) score = Math.min(score, 45);
  if (exclusions.length) score = 0;
  score = Math.min(99, score);
  if (intentType === 'purchase')
    limitations.push('仅能证明咨询或兴趣，未确认下单、预算、购买时间及与本业务的匹配');
  if (intentType === 'service') limitations.push('可能寻求免费建议，未证实付费委托或预算');
  if (ageDays !== null && ageDays > 7)
    limitations.push('超出本流程近7天窗口，不自动加入本次候选；需人工确认需求是否仍存在');
  const verdict = {
    purchase: '购买渠道或产品咨询',
    service: '设计或改造服务咨询',
    interest: '一般兴趣，待确认购买计划',
    discussion: '普通讨论，无购买证据',
    resolved: '已购买、售后或需求已结束',
    restricted: '敏感主题，仅供内容研究',
  }[intentType];
  return {
    version: qualificationVersion,
    assessedAt: new Date(now).toISOString(),
    score,
    intentType,
    verdict,
    limitations,
    stage:
      intentType === 'restricted'
        ? 'restricted'
        : intentType === 'resolved'
          ? 'resolved'
          : intentType === 'discussion'
            ? 'discussion'
            : intentType === 'interest'
              ? 'considering'
              : 'demand',
    recommended: score >= 50 && !exclusions.length,
    ageDays,
    withinSevenDays: ageDays !== null && now - timestamp <= 7 * 86400000,
    evidence,
    exclusions,
    reason:
      exclusions.join('；') ||
      `${verdict} · ${evidence.map((e) => e.label).join(' · ')}${ageDays !== null && ageDays > 30 ? ' · 较早信息，需人工确认需求是否仍存在' : ''}`,
  };
}
export function commentThread(c: Comment, comments: Comment[]) {
  const scoped = comments.filter(
    (x) =>
      x.noteId === c.noteId &&
      x.source === c.source &&
      (!c.platform || !x.platform || c.platform === x.platform),
  );
  let root = c;
  const seen = new Set([c.id]);
  for (let i = 0; i < 8 && root.parentId; i++) {
    const parent = scoped.find((x) => x.id === root.parentId);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    root = parent;
  }
  return { root, replies: scoped.filter((x) => x.parentId === root.id && x.id !== c.id) };
}
export function toLead(c: Comment, note?: Note, comments: Comment[] = []): Lead {
  const assessment = assessComment(c, note, Date.now(), comments);
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
export function assessComment(c: Comment, note?: Note, now = Date.now(), comments: Comment[] = []) {
  const { root, replies } = commentThread(c, comments);
  const authorReplies = replies.filter(
    (x) => x.authorId === note?.authorId && Date.parse(x.createdAt) >= Date.parse(c.createdAt),
  );
  const result = intentScore(
    c.body,
    c.createdAt,
    [
      note ? [note.title, note.body, ...note.tags].join('\n') : '',
      root.id !== c.id ? root.body : '',
      ...authorReplies.map((x) => x.body),
    ].join('\n'),
    now,
  );
  result.threadEvidence = [
    ...(root.id !== c.id ? [{ commentId: root.id, role: '所属主评论', text: root.body }] : []),
    ...authorReplies
      .slice(0, 4)
      .map((x) => ({ commentId: x.id, role: '作者回复（回复不等于已成交）', text: x.body })),
  ];
  if (result.stage !== 'restricted' && c.authorId && c.authorId === note?.authorId) {
    const reason = '作品作者自己的评论或回复，不作为潜在购买客户';
    return {
      ...result,
      score: 0,
      stage: 'discussion' as const,
      intentType: 'discussion' as const,
      verdict: '作者回复',
      recommended: false,
      reason,
      exclusions: [...result.exclusions, reason],
    };
  }
  if (
    !result.exclusions.length &&
    root.id !== c.id &&
    /我也想要|我也要|同求|蹲一个|求同款/.test(c.body)
  ) {
    const parent = intentScore(root.body, root.createdAt, note?.title || '', now);
    if (parent.intentType === 'purchase' && parent.recommended) {
      result.intentType = 'purchase';
      result.stage = 'demand';
      result.verdict = '跟随主评论询问同款';
      result.score = Math.min(99, 30 + 35 + 20);
      if (result.ageDays === null) result.score = 40;
      else if (result.ageDays > 30) result.score = 45;
      result.recommended = result.score >= 50;
      result.evidence.push({ label: '同一评论串的明确商品请求', excerpt: root.body, points: 55 });
      result.limitations = ['商品指代来自所属主评论，仍需核实具体型号及购买计划'];
      result.reason = `回复「${c.body}」承接主评论「${root.body}」，支持同款购买兴趣，未证实下单`;
    }
  }
  if (
    result.intentType === 'service' &&
    authorReplies.length &&
    replies.some(
      (x) =>
        x.authorId === c.authorId &&
        Date.parse(x.createdAt) > Date.parse(c.createdAt) &&
        /好的|谢谢|明白|收到/.test(x.body),
    )
  ) {
    result.threadEvidence?.push(
      ...replies
        .filter(
          (x) =>
            x.authorId === c.authorId &&
            Date.parse(x.createdAt) > Date.parse(c.createdAt) &&
            /好的|谢谢|明白|收到/.test(x.body),
        )
        .map((x) => ({ commentId: x.id, role: '原评论者后续回应', text: x.body })),
    );
    result.recommended = false;
    result.score = Math.min(result.score, 49);
    result.reason = '已收到作者的具体改造建议并致谢，暂无继续委托或付费请求';
    result.limitations?.push('只能确认曾咨询，不能认定仍需服务');
  }
  if (!result.exclusions.length && c.semantic) result.semantic = c.semantic;
  return result;
}
/** Sampling priority, not a lead score or an estimate of conversion. */
export function acquisitionPriority(note: Note, comments: Comment[], now = Date.now()) {
  const context = [note.title, note.body, ...note.tags].join('\n');
  if (intentScore('', '', context, now).stage === 'restricted')
    return { tier: -1, weight: 0, reason: '敏感主题：仅作内容研究，不建立个人营销画像' };
  const sample = comments.filter((c) => c.noteId === note.id && c.source === note.source);
  const recent = sample.filter((c) => {
    const a = assessComment(c, note, now, sample);
    return a.withinSevenDays === true && !a.exclusions.length && !!c.body.trim();
  });
  const needs = recent.filter((c) => assessComment(c, note, now, sample).recommended);
  const people = new Set(needs.map((c) => c.authorId || c.id)).size;
  if (people)
    return {
      tier: 3,
      weight: Math.min(people, 20),
      reason: `已读样本中有 ${people} 位近7天明确需求者，优先复核`,
    };
  if (recent.length)
    return {
      tier: 2,
      weight: Math.min(recent.length, 20),
      reason: `已读样本有 ${recent.length} 条近7天讨论，暂未发现明确需求`,
    };
  const time = Date.parse(note.publishedAt);
  const age =
    Number.isFinite(time) && time <= now + 300000 ? Math.max(0, (now - time) / 86400000) : null;
  const freshness = age === null ? 0 : age <= 7 ? 10 : age <= 30 ? 5 : 0;
  if (note.commentCountKnown === false)
    return {
      tier: 1,
      weight: freshness + 3,
      reason: '搜索页未提供评论数，需小样本采集核实；不等于零评论',
    };
  if (note.comments > 0)
    return {
      tier: 1,
      weight: freshness + Math.min(10, Math.log2(note.comments + 1)),
      reason: sample.length
        ? '已读样本未见近7天需求；可按需补查，勿当作确认客户'
        : `平台显示 ${note.comments} 条评论，日期与需求待采样核实`,
    };
  return { tier: 0, weight: freshness, reason: '暂无评论信号，暂缓采集；点赞不等于购买需求' };
}
export function viralScore(n: Note) {
  return Math.round(n.likes + n.comments * 3 + n.saves * 2);
}
