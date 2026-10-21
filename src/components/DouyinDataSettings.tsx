import { useEffect, useState } from 'react';
import { api } from '../api';
type Provider = 'browser' | 'http' | 'tikhub' | 'redfox';
interface Config {
  provider: Provider;
  maxRequests: number;
  hasKeys: Record<'tikhub' | 'redfox', boolean>;
  commentsSupported: boolean;
}
export function DouyinDataSettings() {
  const [form, setForm] = useState<Config | null>(null),
    [key, setKey] = useState(''),
    [clear, setClear] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [keyword, setKeyword] = useState('家居');
  useEffect(() => {
    void api<Config>('/douyin-data')
      .then(setForm)
      .catch((e) => setMessage(e.message));
  }, []);
  const vendor = form?.provider === 'tikhub' || form?.provider === 'redfox';
  async function save(test = false) {
    if (!form) return;
    setBusy(true);
    setMessage('');
    try {
      const saved = await api<Config>(
        '/douyin-data',
        {
          provider: form.provider,
          maxRequests: form.maxRequests,
          ...(vendor && (key || clear) ? { apiKey: key } : {}),
        },
        'PUT',
      );
      setForm(saved);
      setKey('');
      setClear(false);
      if (test) {
        const r = await api<{ count: number; requests: number }>('/douyin-data/test', { keyword });
        setMessage(
          `测试成功：${r.count} 条作品，${r.requests} 次 API 请求；可能计费，测试结果未入库。`,
        );
      } else setMessage('抖音数据源已保存，小红书设置未改变');
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel settings-form" style={{ marginBottom: 24 }} aria-label="抖音数据源">
      <div className="section-title">
        <h2>抖音数据源</h2>
      </div>
      <p className="field-hint">
        与小红书独立配置，默认保留原有连接。切换仅影响后续抖音采集，已保存的数据不丢失；失败不会自动切换供应商或启动浏览器。发送、发布继续由你手动操作。
      </p>
      {form && (
        <>
          <label className="field-label" htmlFor="dy-source">
            抖音采集数据源
          </label>
          <select
            id="dy-source"
            disabled={busy}
            value={form.provider}
            onChange={(e) => {
              setForm({ ...form, provider: e.target.value as Provider });
              setKey('');
              setClear(false);
              setMessage('选择后请保存生效');
            }}
          >
            <option value="browser">现有浏览器方式</option>
            <option value="tikhub">TikHub（搜索、详情、评论）</option>
            <option value="redfox">RedFox（作品搜索与详情，不支持评论采集）</option>
            <option value="http">原有高级 HTTP 适配器</option>
          </select>
          {vendor && (
            <>
              <label className="field-label" htmlFor="dy-key">
                抖音 {form.provider === 'tikhub' ? 'TikHub' : 'RedFox'} API Key ·{' '}
                {form.hasKeys[form.provider as 'tikhub' | 'redfox'] ? '已加密保存' : '尚未配置'}
              </label>
              <input
                id="dy-key"
                type="password"
                autoComplete="new-password"
                value={key}
                disabled={busy}
                placeholder="留空保留已有密钥"
                onChange={(e) => {
                  setKey(e.target.value);
                  setClear(false);
                }}
              />
              <label className="field-hint">
                <input
                  type="checkbox"
                  checked={clear}
                  disabled={busy}
                  onChange={(e) => {
                    setClear(e.target.checked);
                    setKey('');
                  }}
                />
                清除当前抖音供应商密钥（保存后生效）
              </label>
              <p className="field-hint">
                密钥按平台和供应商分别加密保存。不自动复制小红书密钥；若供应商允许共用，可在此填写同一把
                Key，无需提供抖音 Cookie。
              </p>
              <label className="field-label" htmlFor="dy-budget">
                抖音每个采集步骤最多 API 请求（1–100）
              </label>
              <input
                id="dy-budget"
                type="number"
                min="1"
                max="100"
                value={form.maxRequests}
                disabled={busy}
                onChange={(e) => setForm({ ...form, maxRequests: Number(e.target.value) })}
              />
              <p className="field-hint">
                默认20次。整个获客流程有多个步骤，此上限不是整个流程的费用预算。采集条数是目标上限，分页、类型筛选、去重和服务覆盖会影响实际数量。
              </p>
            </>
          )}
          {form.provider === 'redfox' && (
            <p role="note">
              <strong>
                RedFox 当前仅接入抖音作品优质库搜索和详情，公开文档未提供可核实的评论接口。
              </strong>
              评论采集和一键获客会在请求前阻止。需要评论时，请主动切换到 TikHub
              或浏览器；不会自动代切换。热门排序按供应商热度（阅读数），与最多点赞不完全相同。
            </p>
          )}
          <button className="btn primary" disabled={busy} onClick={() => void save()}>
            保存抖音数据源
          </button>
          {vendor && (
            <>
              <label className="field-label" htmlFor="dy-test">
                抖音测试关键词
              </label>
              <input
                id="dy-test"
                value={keyword}
                disabled={busy}
                onChange={(e) => setKeyword(e.target.value)}
              />
              <button
                className="btn"
                disabled={busy || !keyword.trim()}
                onClick={() => void save(true)}
              >
                保存并测试抖音搜索一次（可能收费）
              </button>
            </>
          )}
        </>
      )}
      {message && <p role="status">{message}</p>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>方式</th>
              <th>参考价格</th>
              <th>权限与能力</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>现有浏览器</td>
              <td>本应用不收供应商 API 费</td>
              <td>
                需要本人登录及平台读取权限；保留原有频率和额度限制。自动浏览仍可能触发限流或账号限制。
              </td>
            </tr>
            <tr>
              <td>
                <a href="https://tikhub.io/douyin-api" target="_blank" rel="noreferrer">
                  TikHub
                </a>{' '}
                ·{' '}
                <a href="https://user.tikhub.io" target="_blank" rel="noreferrer">
                  获取密钥
                </a>
              </td>
              <td>搜索 US$0.01 / 请求；多数其他抖音接口 US$0.001 / 请求起，具体以端点报价为准</td>
              <td>
                需有效 Key、余额和对应搜索/App V3
                接口访问权限。搜索、详情、一级评论及接口随附回复；不额外展开全部二级评论。私密、删除或地区受限内容可能无法取得。
              </td>
            </tr>
            <tr>
              <td>
                <a href="https://redfox.hk/apis/douyin/774OBKK0" target="_blank" rel="noreferrer">
                  RedFox 搜索
                </a>{' '}
                /{' '}
                <a href="https://redfox.hk/apis/douyin/0OT1E306" target="_blank" rel="noreferrer">
                  详情
                </a>{' '}
                ·{' '}
                <a href="https://redfox.hk/dashboard/keys" target="_blank" rel="noreferrer">
                  获取密钥
                </a>
              </td>
              <td>优质库搜索、详情最低 ¥0.02 / 次起，按累计调用阶梯定价</td>
              <td>
                需有效 Key、余额及接口权限；T+1
                作品库，覆盖可能不完整。未接入广域库或抖音评论接口，不能读取私信。
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="field-hint">
        价格核对日期：2026-10-20。按请求计费，不是每条作品计费；失败也可能计费，本应用不自动重试付费请求。第三方
        API 权限不等于抖音官方授权，不保证账号绝对安全。实际价格及可用权限以供应商控制台为准。
      </p>
    </section>
  );
}
