import { useEffect, useState } from 'react';
import type { LlmSettings as Config } from '../../shared/types';
import { api } from '../api';
import { useWorkspace } from '../context';
export function LlmSettingsPanel() {
  const { notify } = useWorkspace();
  const [form, setForm] = useState<Config | null>(null),
    [key, setKey] = useState(''),
    [clear, setClear] = useState(false),
    [busy, setBusy] = useState(''),
    [result, setResult] = useState(''),
    [error, setError] = useState('');
  useEffect(() => {
    void api<Config>('/llm')
      .then(setForm)
      .catch((e) => setError(e.message));
  }, []);
  async function save() {
    if (!form) throw new Error('配置尚未加载');
    const saved = await api<Config>(
      '/llm',
      {
        enabled: form.enabled,
        baseUrl: form.baseUrl,
        model: form.model,
        maxComments: form.maxComments,
        requestTimeoutSeconds: form.requestTimeoutSeconds,
        reviewTimeoutSeconds: form.reviewTimeoutSeconds,
        ...(key || clear ? { apiKey: key } : {}),
      },
      'PUT',
    );
    setForm(saved);
    setKey('');
    setClear(false);
    return saved;
  }
  async function act(action: 'save' | 'test' | 'models') {
    setBusy(action);
    setResult('');
    setError('');
    try {
      await save();
      if (action === 'test') {
        const r = await api<{ model: string; latencyMs: number }>('/llm/test', {});
        setResult(`所选模型 ${r.model} 的真实生成与 JSON 输出测试通过 · ${r.latencyMs} ms`);
        setForm(await api<Config>('/llm'));
      } else if (action === 'models') {
        const r = await api<Config>('/llm/models/sync', {});
        setForm(r);
        setResult(`已同步服务当前账号可用的 ${r.models.length} 个模型；未自动更换所选模型`);
      } else notify('模型配置已保存');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  return (
    <section className="panel llm-settings" aria-label="大模型设置">
      <h2>大模型 · 可选语义复核</h2>
      <p>
        本地规则负责日期、作者、已购买及敏感主题排除。模型用于补充理解隐含需求、指代和上下文，结果与原文引用单独展示，保留人工判断。
      </p>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {form && (
        <>
          <label className="checkbox-line">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            />
            启用语义补充复核：将脱敏评论、标题及同串回复发送到所填模型服务
          </label>
          <p className="field-hint">
            默认关闭；不发送结构化昵称、用户
            ID、属地、账号凭证，识别到的号码、邮箱和链接会遮蔽。敏感主题在本地拦截。测试连接只发送固定测试文本。未配置或调用失败时，继续使用本地规则。
          </p>
          <div className="field-row">
            <label>
              服务 Base URL
              <input
                aria-label="模型服务地址"
                type="url"
                placeholder="https://api.openai.com/v1"
                value={form.baseUrl}
                onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
              />
            </label>
            <label>
              API Key
              <input
                aria-label="模型 API Key"
                type="password"
                autoComplete="new-password"
                placeholder={
                  form.hasApiKey ? '已加密保存，留空保持原值' : '输入服务 Key；本机模型可留空'
                }
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
            </label>
          </div>
          {form.hasApiKey && (
            <button
              className="text-btn danger"
              onClick={() => {
                setKey('');
                setClear(true);
              }}
            >
              清除已存 Key{clear ? '（保存后生效）' : ''}
            </button>
          )}
          <div className="field-row">
            <label>
              模型 ID
              <input
                aria-label="复核模型 ID"
                list="llm-model-options"
                value={form.model}
                onChange={(e) => setForm({ ...form, model: e.target.value })}
                placeholder="同步列表后选择，或手动填写"
              />
              <datalist id="llm-model-options">
                {form.models.map((m) => (
                  <option key={m.id} value={m.id} />
                ))}
              </datalist>
            </label>
            <label>
              单次复核评论上限
              <input
                aria-label="模型复核评论上限"
                type="number"
                min={1}
                max={200}
                value={form.maxComments}
                onChange={(e) => setForm({ ...form, maxComments: Number(e.target.value) })}
              />
            </label>
          </div>
          <div className="field-row">
            <label>
              单次模型请求时限（秒）
              <input
                aria-label="单次模型请求时限"
                type="number"
                min={20}
                max={300}
                value={form.requestTimeoutSeconds}
                onChange={(e) =>
                  setForm({ ...form, requestTimeoutSeconds: Number(e.target.value) })
                }
              />
            </label>
            <label>
              整轮模型复核时限（秒）
              <input
                aria-label="整轮模型复核时限"
                type="number"
                min={60}
                max={3600}
                value={form.reviewTimeoutSeconds}
                onChange={(e) => setForm({ ...form, reviewTimeoutSeconds: Number(e.target.value) })}
              />
            </label>
          </div>
          <p className="field-hint">
            建议单次120秒、整轮900秒；每5条保存一次。超时保留结果，继续时跳过有效缓存。此设置只影响模型，不改变平台验证码、限流或采集间隔。
          </p>
          <p className="field-hint">
            支持 OpenAI 兼容的 /models 与 /chat/completions JSON
            接口；同步的是所填服务当前可见列表，不代表每个模型均支持文本生成。列表中保留选中模型，避免自动升级改变判断。
          </p>
          {form.modelsSyncedAt && (
            <details>
              <summary>
                模型列表（{form.models.length}）· 上次同步{' '}
                {new Date(form.modelsSyncedAt).toLocaleString()}
              </summary>
              <div className="model-list">
                {form.models.map((m) => (
                  <button
                    className="btn small"
                    key={m.id}
                    onClick={() => setForm({ ...form, model: m.id })}
                  >
                    {m.id}
                  </button>
                ))}
              </div>
            </details>
          )}
          {form.testedAt && (
            <p className="field-hint">
              所选模型上次测试通过：{new Date(form.testedAt).toLocaleString()}
            </p>
          )}
          <div className="settings-actions">
            <button className="btn" disabled={!!busy} onClick={() => void act('models')}>
              {busy === 'models' ? '同步中…' : '同步最新模型列表'}
            </button>
            <button
              className="btn"
              disabled={!!busy || !form.model || !form.baseUrl}
              onClick={() => void act('test')}
            >
              {busy === 'test' ? '测试生成中…' : '测试模型连接'}
            </button>
            <button className="btn primary" disabled={!!busy} onClick={() => void act('save')}>
              保存模型设置
            </button>
          </div>
          {result && (
            <p className="connection-test success" role="status">
              {result}
            </p>
          )}
        </>
      )}
    </section>
  );
}
