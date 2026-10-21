import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { ImageSettings } from '../../shared/types';
import { api } from '../api';
import { useWorkspace } from '../context';
import { ServiceBar } from './ServiceBar';
import { ModelPicker } from './ModelPicker';

export function ImageSettingsPanel() {
  const { notify } = useWorkspace();
  const [form, setForm] = useState<ImageSettings | null>(null);
  const [newModel, setNewModel] = useState('');
  const [key, setKey] = useState('');
  const [clear, setClear] = useState(false);
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState('');
  const [sample, setSample] = useState('');
  const [error, setError] = useState('');
  const reload = async () => setForm(await api<ImageSettings>('/images'));
  useEffect(() => {
    void api<ImageSettings>('/images')
      .then(setForm)
      .catch((e) => setError(e.message));
  }, []);
  async function save() {
    if (!form) throw new Error('配置尚未加载');
    const saved = await api<ImageSettings>(
      '/images',
      {
        baseUrl: form.baseUrl,
        model: form.model,
        size: form.size,
        mode: form.mode,
        watermark: form.watermark,
        ...(key || clear ? { apiKey: key } : {}),
      },
      'PUT',
    );
    setForm(saved);
    setKey('');
    setClear(false);
    return saved;
  }
  async function addModel() {
    const id = newModel.trim();
    if (!id) return;
    setBusy('add');
    setError('');
    try {
      const saved = await api<ImageSettings>('/images/models', { id });
      setForm((f) => (f ? { ...f, models: saved.models } : saved));
      setNewModel('');
      notify('生图模型已加入模型库');
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
      setForm(
        await api<ImageSettings>('/images/models/' + encodeURIComponent(id), undefined, 'DELETE'),
      );
      notify('已从生图模型库移除 ' + id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  async function act(action: 'save' | 'check' | 'sync' | 'test' | 'reuse') {
    setBusy(action);
    setResult('');
    setError('');
    try {
      if (action === 'reuse') {
        const r = await api<{ settings: ImageSettings; copiedKey: boolean }>(
          '/images/reuse-llm',
          {},
        );
        setForm(r.settings);
        setResult(
          r.copiedKey
            ? '已复用大模型的服务地址与 Key，请填写生图模型 ID 后保存'
            : '已复用大模型的服务地址；大模型没有保存 Key，请在这里补填',
        );
        return;
      }
      await save();
      if (action === 'check') {
        const r = await api<{ ok: boolean; message: string; latencyMs?: number }>(
          '/images/check',
          {},
        );
        setResult(r.ok ? `${r.message} · ${r.latencyMs ?? 0} ms` : r.message);
        setForm(await api<ImageSettings>('/images'));
      } else if (action === 'sync') {
        const r = await api<ImageSettings>('/images/models/sync', {});
        setForm(r);
        setResult(
          `已同步 ${r.models.filter((m) => !m.custom).length} 个模型；不会自动更换当前所选模型`,
        );
      } else if (action === 'test') {
        const r = await api<{
          model: string;
          latencyMs: number;
          sample: string;
          via: 'generations' | 'edits';
        }>('/images/test', {});
        setSample(r.sample);
        setResult(
          `真实出图测试通过 · ${r.model} · ${
            r.via === 'edits' ? '参考图重绘' : '文字生成'
          } · ${Math.round(r.latencyMs / 1000)} 秒`,
        );
        setForm(await api<ImageSettings>('/images'));
      } else notify('生图模型设置已保存');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  return (
    <section className="panel llm-settings" aria-label="生图模型设置">
      <h2>生图模型 · 克隆创作里的 AI 重绘</h2>
      <p>
        克隆创作下方的「AI
        生图」用它把原图重绘成新版本。这里与大模型分开配置：大模型负责评论语义复核，生图负责图片重绘；两者可以共用同一个服务地址与
        Key，但模型 ID 不同。
      </p>
      <ServiceBar kind="image" onChange={reload} />
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {form && (
        <>
          <button className="text-btn" disabled={!!busy} onClick={() => void act('reuse')}>
            <RefreshCw size={12} />
            复用大模型的服务地址与 Key
          </button>
          <div className="field-row">
            <label>
              服务 Base URL
              <input
                aria-label="生图服务地址"
                type="url"
                placeholder="https://api.openai.com/v1"
                value={form.baseUrl}
                onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
              />
            </label>
            <label>
              API Key
              <input
                aria-label="生图 API Key"
                type="password"
                autoComplete="new-password"
                placeholder={
                  form.hasApiKey ? '已加密保存，留空保持原值' : '输入服务 Key；本机服务可留空'
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
              label="生图模型 ID"
              ariaLabel="生图模型 ID"
              value={form.model}
              options={form.models}
              onChange={(model) => setForm({ ...form, model })}
            />
            <label>
              出图尺寸
              <select
                aria-label="出图尺寸"
                value={form.size}
                onChange={(e) =>
                  setForm({ ...form, size: e.target.value as ImageSettings['size'] })
                }
              >
                <option value="1024x1536">竖版 3:4</option>
                <option value="1024x1024">方图 1:1</option>
                <option value="1536x1024">横版 3:2</option>
              </select>
            </label>
          </div>
          <div className="field-row">
            <label>
              默认生成方式
              <select
                aria-label="默认生成方式"
                value={form.mode}
                onChange={(e) =>
                  setForm({ ...form, mode: e.target.value as ImageSettings['mode'] })
                }
              >
                <option value="edit">参考图重绘（保留构图）</option>
                <option value="generate">文字生成（不使用参考图）</option>
              </select>
            </label>
            <label>
              服务状态
              <input
                aria-label="生图服务状态"
                readOnly
                value={
                  form.baseUrl ? (form.model ? '已配置，可检查连接' : '缺少模型 ID') : '未配置'
                }
              />
            </label>
          </div>
          <label className="checkbox-line">
            <input
              type="checkbox"
              aria-label="关闭平台水印"
              checked={!form.watermark}
              onChange={(e) => setForm({ ...form, watermark: !e.target.checked })}
            />
            关闭平台水印（智谱 CogView
            需先在控制台开通「去水印」权限；其他服务若拒绝该参数请保持开启）
          </label>
          <p className="field-hint">
            参考图重绘调用 OpenAI 兼容的 <code>/images/edits</code>
            （multipart 图像输入），服务不支持时改用文字生成；「检查服务」只请求
            <code>/models</code>，不消耗生图额度；「测试生图」会真实生成一张图并消耗一次额度。Key
            使用本机 AES-GCM 加密，接口只返回是否已保存。
          </p>
          <div className="model-library">
            <div className="model-library-head">
              <span>
                生图模型库 · {form.models.length} 个
                {form.modelsSyncedAt
                  ? ` · 上次同步 ${new Date(form.modelsSyncedAt).toLocaleString('zh-CN')}`
                  : ''}
              </span>
            </div>
            <div className="model-add">
              <input
                aria-label="新增生图模型"
                placeholder="输入生图模型 ID，如 cogview-4 / glm-image"
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
                  ? '下拉框里直接切换型号；智谱的 CogView 不在 /models 里，用最后一项手动输入。'
                  : '还没有生图模型：手动添加 cogview-3-flash / cogview-4，或同步服务列表。'}
              </span>
              {form.models.some((m) => m.id === form.model && m.custom) && (
                <button
                  className="text-btn danger"
                  aria-label="删除当前自定义生图模型"
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
              上次生成成功：{new Date(form.testedAt).toLocaleString('zh-CN')}
            </p>
          )}
          <div className="settings-actions">
            <button
              className="btn"
              disabled={!!busy || !form.baseUrl}
              onClick={() => void act('sync')}
            >
              {busy === 'sync' ? '同步中…' : '同步最新模型'}
            </button>
            <button
              className="btn"
              disabled={!!busy || !form.baseUrl || !form.model}
              onClick={() => void act('check')}
            >
              {busy === 'check' ? '检查中…' : '检查服务'}
            </button>
            <button
              className="btn"
              disabled={!!busy || !form.baseUrl || !form.model}
              onClick={() => void act('test')}
            >
              {busy === 'test' ? '出图中…' : '测试生图'}
            </button>
            <button className="btn primary" disabled={!!busy} onClick={() => void act('save')}>
              保存生图设置
            </button>
          </div>
          {result && (
            <p className="connection-test success" role="status">
              {result}
            </p>
          )}
          {sample && (
            <figure className="image-test-sample">
              <img src={sample} alt="生图测试样例" />
              <figcaption>测试样例 · 本次真实生成</figcaption>
            </figure>
          )}
        </>
      )}
    </section>
  );
}
