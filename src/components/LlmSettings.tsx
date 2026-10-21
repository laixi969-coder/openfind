import { useEffect, useState } from 'react';
import type { LlmSettings as Config } from '../../shared/types';
import { api } from '../api';
import { useWorkspace } from '../context';
import { ServiceBar } from './ServiceBar';
import { ModelPicker } from './ModelPicker';
export function LlmSettingsPanel() {
  const { notify } = useWorkspace();
  const [form, setForm] = useState<Config | null>(null),
    [newModel, setNewModel] = useState(''),
    [key, setKey] = useState(''),
    [clear, setClear] = useState(false),
    [busy, setBusy] = useState(''),
    [result, setResult] = useState(''),
    [error, setError] = useState('');
  const reload = async () => setForm(await api<Config>('/llm'));
  useEffect(() => {
    void api<Config>('/llm')
      .then(setForm)
      .catch((e) => setError(e.message));
  }, []);
  async function addModel() {
    const id = newModel.trim();
    if (!id) return;
    setBusy('add');
    setError('');
    try {
      const saved = await api<Config>('/llm/models', { id });
      setForm((f) => (f ? { ...f, models: saved.models } : saved));
      setNewModel('');
      notify('模型已加入模型库');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  async function dropModel(id: string) {
    setBusy('drop');
    setError('');
    try {
      const saved = await api<Config>('/llm/models/' + encodeURIComponent(id), undefined, 'DELETE');
      setForm((f) =>
        f ? { ...f, models: saved.models, model: f.model === id ? '' : f.model } : saved,
      );
      notify('已从模型库移除 ' + id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
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
        setResult(
          `已同步服务当前账号可用的 ${
            r.models.filter((m) => !m.custom).length
          } 个模型；未自动更换所选模型`,
        );
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
      <ServiceBar kind="text" onChange={reload} />
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
            <ModelPicker
              label="模型 ID"
              ariaLabel="复核模型 ID"
              value={form.model}
              options={form.models}
              onChange={(model) => setForm({ ...form, model })}
            />
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
          <p className="field-hint">
            支持 OpenAI 兼容的 /models 与 /chat/completions JSON
            接口；同步的是所填服务当前可见列表，不代表每个模型均支持文本生成。列表中保留选中模型，避免自动升级改变判断。
          </p>
          <div className="model-library">
            <div className="model-library-head">
              <span>
                模型库 · {form.models.length} 个
                {form.modelsSyncedAt
                  ? ` · 上次同步 ${new Date(form.modelsSyncedAt).toLocaleString('zh-CN')}`
                  : ''}
              </span>
            </div>
            <div className="model-add">
              <input
                aria-label="新增文字模型"
                placeholder="输入模型 ID 添加到模型库，如 glm-4.7"
                value={newModel}
                onChange={(e) => setNewModel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void addModel();
                  }
                }}
              />
              <button
                className="btn small"
                disabled={!!busy || !newModel.trim()}
                onClick={() => void addModel()}
              >
                添加模型
              </button>
            </div>
            <div className="model-library-foot">
              <span className="field-hint">
                {form.models.length
                  ? '下拉框里直接切换型号，选最后一项可手动输入。'
                  : '还没有模型：手动添加，或同步服务当前列表。'}
              </span>
              {form.models.some((m) => m.id === form.model && m.custom) && (
                <button
                  className="text-btn danger"
                  aria-label="删除当前自定义模型"
                  disabled={!!busy}
                  onClick={() => void dropModel(form.model)}
                >
                  删除当前自定义模型
                </button>
              )}
            </div>
          </div>
          {form.testedAt && (
            <p className="field-hint">
              所选模型上次测试通过：{new Date(form.testedAt).toLocaleString('zh-CN')}
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
