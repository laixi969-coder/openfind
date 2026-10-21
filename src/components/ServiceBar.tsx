import { useCallback, useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import type { ModelService } from '../../shared/types';
import { api } from '../api';
import { useWorkspace } from '../context';
import { Busy } from './ui';

export function ServiceBar({
  kind,
  onChange,
}: {
  kind: 'text' | 'image';
  onChange: () => Promise<void> | void;
}) {
  const { notify } = useWorkspace();
  const [services, setServices] = useState<ModelService[] | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [form, setForm] = useState({ name: '', baseUrl: '', apiKey: '', model: '' });

  const load = useCallback(async () => {
    try {
      setServices(await api<ModelService[]>('/services?kind=' + kind));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [kind]);

  useEffect(() => {
    void load();
  }, [load]);

  async function activate(id: string) {
    setBusy(id);
    setError('');
    try {
      await api('/services/' + encodeURIComponent(id) + '/activate', {});
      await load();
      await onChange();
      notify('已切换到“' + (services?.find((s) => s.id === id)?.name || id) + '”');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function create() {
    if (!form.name.trim() || !form.baseUrl.trim()) {
      setError('请填写服务名称与地址');
      return;
    }
    setBusy('create');
    setError('');
    try {
      await api<ModelService>('/services', {
        kind,
        name: form.name.trim(),
        baseUrl: form.baseUrl.trim(),
        model: form.model.trim(),
        ...(form.apiKey ? { apiKey: form.apiKey } : {}),
      });
      setForm({ name: '', baseUrl: '', apiKey: '', model: '' });
      setOpen(false);
      await load();
      await onChange();
      notify('已添加并切换到这个服务');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function drop(id: string, name: string) {
    setBusy(id);
    setError('');
    try {
      await api('/services/' + encodeURIComponent(id), undefined, 'DELETE');
      await load();
      await onChange();
      notify('已删除服务“' + name + '”');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="service-bar">
      <div className="service-row">
        <span>模型服务</span>
        {services === null ? (
          <span className="field-hint">加载中…</span>
        ) : services.length ? (
          services.map((s) => (
            <span className={`service-chip ${s.active ? 'active' : ''}`} key={s.id}>
              <button
                aria-pressed={s.active}
                disabled={!!busy}
                onClick={() => void activate(s.id)}
                title={s.baseUrl}
              >
                {s.name}
                {!s.hasApiKey && ' · 无 Key'}
              </button>
              {!s.active && (
                <button
                  className="service-del"
                  aria-label={`删除服务 ${s.name}`}
                  disabled={!!busy}
                  onClick={() => void drop(s.id, s.name)}
                >
                  <X size={11} />
                </button>
              )}
            </span>
          ))
        ) : (
          <span className="field-hint">还没有服务，添加一个开始配置。</span>
        )}
        <button className="text-btn" onClick={() => setOpen((v) => !v)}>
          <Plus size={12} />
          添加其他服务
        </button>
      </div>
      {open && (
        <div className="service-add">
          <p className="field-hint">
            换一家服务商就新增一条：地址、Key、模型各自保存，随时点名称切换，互不覆盖。
          </p>
          <div className="field-row">
            <label>
              服务名称
              <input
                aria-label="新服务名称"
                placeholder="如 DeepSeek、硅基流动、本机 Ollama"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>
            <label>
              服务地址
              <input
                aria-label="新服务地址"
                type="url"
                placeholder="https://api.deepseek.com/v1"
                value={form.baseUrl}
                onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
              />
            </label>
          </div>
          <div className="field-row">
            <label>
              API Key
              <input
                aria-label="新服务 Key"
                type="password"
                autoComplete="new-password"
                placeholder="本机服务可留空"
                value={form.apiKey}
                onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
              />
            </label>
            <label>
              默认模型 ID
              <input
                aria-label="新服务模型"
                placeholder={kind === 'image' ? 'cogview-4 / gpt-image-1' : 'deepseek-chat'}
                value={form.model}
                onChange={(e) => setForm({ ...form, model: e.target.value })}
              />
            </label>
          </div>
          <div className="service-add-actions">
            {busy === 'create' && <Busy text="保存中" />}
            <button className="btn" onClick={() => setOpen(false)}>
              取消
            </button>
            <button className="btn primary" disabled={!!busy} onClick={() => void create()}>
              添加并切换
            </button>
          </div>
        </div>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
