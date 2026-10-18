import { useEffect, useState } from 'react';
import type { Lead, Note } from '../../shared/types';
import {
  communicationPlan,
  emptySalesProfile,
  salesStages,
  type SalesCase,
  type SalesEvent,
  type SalesProfile,
} from '../../shared/sales';
import { api, safeUrl } from '../api';
import { useWorkspace } from '../context';
export function SalesMetrics({
  revision,
  onOpen,
}: {
  revision: number;
  onOpen: (id: string) => void;
}) {
  const [rows, setRows] = useState<
    {
      source: string;
      contacted: number;
      replied: number;
      won: number;
      amount: number;
      due: number;
      followUps: { id: string; name: string; action: string; at: string }[];
    }[]
  >([]);
  const [error, setError] = useState('');
  useEffect(() => {
    void api<typeof rows>('/sales/summary')
      .then(setRows)
      .catch((e) => setError(e.message));
  }, [revision]);
  return (
    <section className="panel sales-metrics" aria-label="沟通与成交记录">
      <h3>从回复到结果 · 人工登记</h3>
      <a className="btn small" href="/api/sales/export" download>
        导出沟通记录
      </a>
      <p>意向分数不等于成交。以下统计来自实际沟通记录与成交凭证说明。</p>
      {error && <p role="alert">{error}</p>}
      {rows.map((r) => (
        <p key={r.source}>
          <b>{r.source === 'live' ? '真实线索' : '演示线索'}</b> · 已联系 {r.contacted} · 已回复{' '}
          {r.replied} · 已登记成交 {r.won} · 登记金额 ¥{r.amount.toFixed(2)} · 到期跟进 {r.due}
          {r.followUps.map((f) => (
            <button className="btn small" key={f.id} onClick={() => onOpen(f.id)}>
              跟进 {f.name} · {f.action || '核对约定的下一步'}
            </button>
          ))}
        </p>
      ))}
    </section>
  );
}
const profileFields = {
  identity: '业务身份',
  offering: '产品或服务',
  regions: '服务地区',
  priceRange: '真实价格范围',
  value: '这次能提供的具体帮助',
  proof: '可核验案例或产品资料',
} as const;
const eventLabels = {
  outgoing: '实际发出的消息',
  incoming: '客户实际回复',
  note: '内部备注',
  quote: '已提供的方案/报价',
  order: '订单或成交记录',
  optout: '对方拒绝联系',
} as const;
export function SalesWorkbench({
  lead,
  note,
  onChange,
}: {
  lead: Lead;
  note?: Note;
  onChange: () => void;
}) {
  const { notify } = useWorkspace();
  const [record, setRecord] = useState<SalesCase | null>(null),
    [profile, setProfile] = useState<SalesProfile>(emptySalesProfile),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [dirty, setDirty] = useState(false);
  const [kind, setKind] = useState<SalesEvent['kind']>('incoming'),
    [channel, setChannel] = useState<SalesEvent['channel']>('message'),
    [content, setContent] = useState(''),
    [eventId, setEventId] = useState(() => crypto.randomUUID());
  useEffect(() => {
    let alive = true;
    void Promise.all([
      api<SalesCase>(`/leads/${encodeURIComponent(lead.id)}/sales`),
      api<SalesProfile>('/sales/profile'),
    ])
      .then(([r, p]) => {
        if (alive) {
          setRecord(r);
          setProfile(p);
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [lead.id]);
  const route = `/leads/${encodeURIComponent(lead.id)}/sales`;
  async function act(task: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await task();
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const plan = record ? communicationPlan(lead, profile, record) : null;
  function field<K extends keyof SalesCase>(key: K, value: SalesCase[K]) {
    if (record) {
      setRecord({ ...record, [key]: value });
      setDirty(true);
    }
  }
  return (
    <section className="sales-workbench" aria-label="沟通成交工作台">
      <h3>沟通与成交工作台</h3>
      <p>先核实能否提供匹配的帮助 → 获得回复 → 明确需求和时间 → 提供方案 → 登记实际结果。</p>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <fieldset className="sales-editor" disabled={busy || !record}>
        <details className="workflow-details">
          <summary>真实业务资料 · 生成话术前填写</summary>
          <div className="sales-fields">
            {Object.entries(profileFields).map(([key, label]) => (
              <label key={key}>
                {label}
                <textarea
                  aria-label={label}
                  rows={2}
                  value={profile[key as keyof SalesProfile]}
                  maxLength={2000}
                  onChange={(e) => setProfile({ ...profile, [key]: e.target.value })}
                />
              </label>
            ))}
          </div>
          <button
            className="btn"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                setProfile(await api<SalesProfile>('/sales/profile', profile, 'PUT'));
                notify('业务资料已保存');
              })
            }
          >
            保存业务资料
          </button>
        </details>
        {!record ? (
          <p>正在加载沟通记录…</p>
        ) : (
          <>
            <div className="sales-plan">
              <b>下一步沟通建议</b>
              <p>{plan?.goal}</p>
              {plan?.draft && (
                <>
                  <blockquote>{plan.draft}</blockquote>
                  <button
                    className="btn"
                    disabled={busy || dirty}
                    onClick={() =>
                      void navigator.clipboard.writeText(plan.draft).then(
                        () => notify('草稿已复制；复制不代表已发送'),
                        () => setError('复制失败，请手动选择草稿'),
                      )
                    }
                  >
                    复制本次沟通草稿
                  </button>
                </>
              )}
              {note && safeUrl(note.url) && (
                <a className="btn" href={safeUrl(note.url)} target="_blank" rel="noreferrer">
                  打开原作品，核对评论并进入平台沟通
                </a>
              )}
              <p className="field-hint">
                原作品入口不是私信发送接口。请核对用户名和原评论，由你在平台实际回复；本工作台记录结果，不自动群发或假装消息已送达。报价、库存、案例和承诺均需核实。
              </p>
            </div>
            <div className="sales-fields">
              <label>
                销售阶段
                <select
                  aria-label="销售阶段"
                  value={record.stage}
                  disabled={record.stopped}
                  onChange={(e) => field('stage', e.target.value as SalesCase['stage'])}
                >
                  {Object.entries(salesStages).map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              {(
                ['need', 'timing', 'budget', 'objection', 'nextAction', 'orderReference'] as const
              ).map((key) => (
                <label key={key}>
                  {
                    {
                      need: '客户确认的需求',
                      timing: '行动时间',
                      budget: '预算范围',
                      objection: '主要顾虑',
                      nextAction: '双方约定的下一步',
                      orderReference: '成交凭证说明或订单编号',
                    }[key]
                  }
                  <textarea
                    rows={2}
                    aria-label={
                      {
                        need: '客户确认的需求',
                        timing: '行动时间',
                        budget: '预算范围',
                        objection: '主要顾虑',
                        nextAction: '双方约定的下一步',
                        orderReference: '成交凭证说明或订单编号',
                      }[key]
                    }
                    value={record[key]}
                    maxLength={2000}
                    onChange={(e) => field(key, e.target.value)}
                  />
                </label>
              ))}
              <label>
                下次跟进时间
                <input
                  aria-label="下次跟进时间"
                  type="datetime-local"
                  disabled={record.stopped}
                  value={
                    record.nextFollowUp
                      ? new Date(
                          Date.parse(record.nextFollowUp) -
                            new Date(record.nextFollowUp).getTimezoneOffset() * 60000,
                        )
                          .toISOString()
                          .slice(0, 16)
                      : ''
                  }
                  onChange={(e) =>
                    field(
                      'nextFollowUp',
                      e.target.value ? new Date(e.target.value).toISOString() : '',
                    )
                  }
                />
              </label>
              <label>
                实际成交金额（元）
                <input
                  aria-label="实际成交金额"
                  type="number"
                  min={0}
                  step="0.01"
                  value={record.amount}
                  onChange={(e) => field('amount', Number(e.target.value))}
                />
              </label>
            </div>
            <div className="modal-action-row">
              <button
                className="btn primary"
                disabled={busy || !dirty}
                onClick={() =>
                  void act(async () => {
                    const {
                      id: _,
                      events: __,
                      updatedAt: ___,
                      stopped: ____,
                      relatedLeadId: _____,
                      ...patch
                    } = record;
                    setRecord(await api<SalesCase>(route, patch, 'PUT'));
                    setDirty(false);
                    notify('销售进展已保存');
                  })
                }
              >
                保存销售进展
              </button>
              <button
                className="btn"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    setRecord(await api<SalesCase>(route));
                    setDirty(false);
                  })
                }
              >
                重新载入已保存进展
              </button>
            </div>
            <h4>记录已发生的沟通</h4>
            <p className="field-hint">
              这是人工登记，不会向客户发送消息。未获回复不反复催促；对方拒绝后停止主动沟通。先保存上方修改，再添加记录。
            </p>
            <div className="field-row">
              <label>
                记录类型
                <select
                  aria-label="沟通记录类型"
                  value={kind}
                  onChange={(e) => setKind(e.target.value as SalesEvent['kind'])}
                >
                  {Object.entries(eventLabels).map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                实际沟通渠道
                <select
                  aria-label="沟通渠道"
                  value={channel}
                  onChange={(e) => setChannel(e.target.value as SalesEvent['channel'])}
                >
                  <option value="message">平台私信</option>
                  <option value="comment">原评论回复</option>
                  <option value="other">其他已获同意的渠道</option>
                </select>
              </label>
            </div>
            <textarea
              aria-label="实际沟通内容"
              rows={3}
              value={content}
              maxLength={3000}
              onChange={(e) => setContent(e.target.value)}
              placeholder="粘贴实际消息、客户回复或凭证说明，保留准确措辞"
            />
            <button
              className="btn"
              disabled={
                busy ||
                dirty ||
                !content.trim() ||
                (record.stopped && ['outgoing', 'quote'].includes(kind))
              }
              onClick={() =>
                void act(async () => {
                  setRecord(
                    await api<SalesCase>(route + '/events', {
                      id: eventId,
                      kind,
                      channel,
                      content,
                    }),
                  );
                  setContent('');
                  setEventId(crypto.randomUUID());
                  notify('实际沟通记录已保存');
                })
              }
            >
              登记沟通记录
            </button>
            {record.stopped && (
              <p className="inline-error">对方已拒绝联系：已停止主动跟进并清空跟进时间。</p>
            )}
            <div className="sales-timeline">
              {[...record.events].reverse().map((e) => (
                <article key={e.id}>
                  <b>
                    {eventLabels[e.kind]} ·{' '}
                    {e.channel === 'message'
                      ? '平台私信'
                      : e.channel === 'comment'
                        ? '评论'
                        : '其他渠道'}
                  </b>
                  <small>
                    {e.platformMessage
                      ? `平台时间：${e.platformMessage.timeLabel || '未知'} · 同步于 ${new Date(e.createdAt).toLocaleString()}`
                      : new Date(e.createdAt).toLocaleString()}
                  </small>
                  <p>{e.content}</p>
                </article>
              ))}
            </div>
          </>
        )}
      </fieldset>
    </section>
  );
}
