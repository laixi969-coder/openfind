import { useEffect, useState } from 'react';
import { api } from '../api';
type Provider = 'tikhub' | 'redfox';
interface Config {
  provider: Provider;
  maxRequests: number;
  hasKeys: Record<Provider, boolean>;
}
interface Task {
  id: string;
  taskId?: string;
  state: string;
  visibleAfterTime?: string;
}
export function XhsDataSettings() {
  const [form, setForm] = useState<Config | null>(null);
  const [key, setKey] = useState('');
  const [clear, setClear] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [keyword, setKeyword] = useState('家居');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [recover, setRecover] = useState<Record<string, string>>({});
  useEffect(() => {
    void Promise.all([api<Config>('/xhs-data'), api<Task[]>('/xhs-data/tasks')])
      .then(([f, t]) => {
        setForm(f);
        setTasks(t);
      })
      .catch((e) => setMessage(e.message));
  }, []);
  async function act(test = false) {
    if (!form) return;
    setBusy(true);
    setMessage('');
    try {
      const saved = await api<Config>(
        '/xhs-data',
        {
          provider: form.provider,
          maxRequests: form.maxRequests,
          ...(key || clear ? { apiKey: key } : {}),
        },
        'PUT',
      );
      setForm(saved);
      setKey('');
      setClear(false);
      if (test) {
        const r = await api<{ count: number; requests: number }>('/xhs-data/test', { keyword });
        setMessage(
          `连接成功，读取 ${r.count} 条作品，调用 ${r.requests} 次 API；本次可能计费，结果未入库。`,
        );
      } else setMessage('小红书 API 设置已保存');
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function attach(task: Task) {
    setBusy(true);
    try {
      await api('/xhs-data/tasks', { id: task.id, taskId: recover[task.id] }, 'PUT');
      setTasks(await api<Task[]>('/xhs-data/tasks'));
      setMessage('任务编号已补填，请继续原流程或重新采集相同作品与条数');
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="panel settings-form"
      style={{ marginBottom: 24 }}
      aria-label="小红书 API 数据源"
    >
      <div className="section-title">
        <h2>小红书 API 数据源</h2>
      </div>
      <p role="note" className="field-hint">
        <strong>自动浏览小红书进行采集可能导致限流、账号限制甚至封号。</strong>
        本应用已关闭小红书模拟浏览、自动托管、发送及发布，仅通过所选 API
        读取数据。内容生成、分类和分析保留，发送与发布请自行操作。
      </p>
      <p className="field-hint">
        无需小红书登录或 Cookie。第三方 API
        并非小红书官方授权保证，数据覆盖和服务稳定性以供应商为准；切换后不会自动回退到浏览器。抖音连接保持不变。
      </p>
      {form && (
        <>
          <label className="field-label" htmlFor="xhs-source">
            数据源
          </label>
          <select
            id="xhs-source"
            disabled={busy}
            value={form.provider}
            onChange={(e) => {
              setForm({ ...form, provider: e.target.value as Provider });
              setKey('');
              setClear(false);
              setMessage('切换后请保存生效');
            }}
          >
            <option value="tikhub">TikHub（默认，分页采集）</option>
            <option value="redfox">RedFox（作品库，评论异步）</option>
          </select>
          <label className="field-label" htmlFor="xhs-key">
            {form.provider === 'tikhub' ? 'TikHub' : 'RedFox'} API Key ·{' '}
            {form.hasKeys[form.provider] ? '已加密保存' : '尚未配置'}
          </label>
          <input
            id="xhs-key"
            type="password"
            autoComplete="new-password"
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              setClear(false);
            }}
            placeholder="输入供应商 API Key；留空保留已有密钥"
            disabled={busy}
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
            />{' '}
            清除当前供应商密钥（保存后生效）
          </label>
          <p className="field-hint">两家密钥分别加密保存在本机，不会在浏览器中回显。</p>
          <label className="field-label" htmlFor="xhs-budget">
            每个采集步骤最多请求次数（1–100）
          </label>
          <input
            id="xhs-budget"
            type="number"
            min="1"
            max="100"
            value={form.maxRequests}
            disabled={busy}
            onChange={(e) => setForm({ ...form, maxRequests: Number(e.target.value) })}
          />
          <p className="field-hint">
            一个获客流程包含多个搜索和评论步骤；这是单步骤请求上限，并非整个流程的费用上限。请求失败不自动重试。所选采集条数是目标上限，不保证
            API 有足够结果。
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>服务</th>
                  <th>参考价格</th>
                  <th>数据与时效</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <a href="https://tikhub.io/xiaohongshu-api" target="_blank" rel="noreferrer">
                      TikHub 价格
                    </a>{' '}
                    ·{' '}
                    <a href="https://user.tikhub.io" target="_blank" rel="noreferrer">
                      获取密钥
                    </a>
                  </td>
                  <td>标准约 US$0.01 / 请求</td>
                  <td>
                    按请求而非作品条数计费；搜索、详情、评论分页分别调用。保留接口返回的评论及随附回复。
                  </td>
                </tr>
                <tr>
                  <td>
                    <a
                      href="https://redfox.hk/apis/xiaohongshu/384C6W6B"
                      target="_blank"
                      rel="noreferrer"
                    >
                      RedFox 文档
                    </a>{' '}
                    ·{' '}
                    <a href="https://redfox.hk/dashboard/keys" target="_blank" rel="noreferrer">
                      获取密钥
                    </a>
                  </td>
                  <td>搜索和详情最低 ¥0.02 / 次起；评论最低 ¥0.03 / 每20条起</td>
                  <td>
                    作品优质库
                    T+1；仅一级评论，异步任务文档注明24小时后可见，结果查询免费。实际阶梯价格请查供应商控制台。
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="field-hint">
            价格核对日期：2026-10-20。RedFox
            的最低价格取决于累计调用阶梯，实际单价、失败请求计费及余额以供应商控制台为准。API
            费用由供应商收取。
          </p>
          <button className="btn primary" disabled={busy} onClick={() => void act()}>
            保存小红书数据源
          </button>
          <label className="field-label" htmlFor="xhs-test">
            测试搜索关键词
          </label>
          <input
            id="xhs-test"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            disabled={busy}
          />
          <button className="btn" disabled={busy || !keyword.trim()} onClick={() => void act(true)}>
            保存并测试一次搜索（可能收费）
          </button>
        </>
      )}
      {message && <p role="status">{message}</p>}
      {tasks.filter((t) => t.state !== 'completed').length > 0 && (
        <details>
          <summary>RedFox 待完成任务</summary>
          {tasks
            .filter((t) => t.state !== 'completed')
            .map((t) => (
              <div key={t.id}>
                <p>
                  {t.taskId || '提交结果不确定'} · {t.visibleAfterTime || t.state}
                </p>
                <p className="field-hint">{t.id}</p>
                {!t.taskId && (
                  <>
                    <input
                      aria-label="供应商后台任务编号"
                      value={recover[t.id] || ''}
                      onChange={(e) => setRecover({ ...recover, [t.id]: e.target.value })}
                    />
                    <button
                      className="btn"
                      disabled={busy || !recover[t.id]}
                      onClick={() => void attach(t)}
                    >
                      补填已有任务编号
                    </button>
                  </>
                )}
              </div>
            ))}
          <p>在原流程点击继续，或重新采集相同作品及相同条数，查询已有任务。不会重复提交。</p>
        </details>
      )}
    </section>
  );
}
