import { useEffect, useMemo, useState, useRef } from 'react';
import { Check, Image as ImageIcon, RefreshCw, Settings2, Sparkles, X } from 'lucide-react';
import type { ImageGeneration, ImageSettings, ImageVariant } from '../../shared/types';
import { api } from '../api';
import { Busy } from './ui';

const DEFAULT_PROMPT =
  '保留主体身份、数量、主要姿态、核心视觉卖点、主次层级、版面大致构图及画幅比例；形状、材质、颜色、尺寸比例、包装和品牌标识保持一致，只替换为我的产品与品牌信息。';

type Mode = 'replace' | 'append';

export function AiImage({
  images,
  onUse,
  notify,
}: {
  images: string[];
  onUse: (urls: string[], mode: Mode) => void;
  notify: (text: string, error?: boolean) => void;
}) {
  const [settings, setSettings] = useState<ImageSettings | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [form, setForm] = useState({
    baseUrl: '',
    model: '',
    apiKey: '',
    size: '1024x1536' as ImageSettings['size'],
    mode: 'edit' as ImageSettings['mode'],
    watermark: true,
  });
  const [excluded, setExcluded] = useState<string[]>([]);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [count, setCount] = useState(1);
  const [variants, setVariants] = useState<ImageVariant[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [compare, setCompare] = useState<{ source: string; url: string } | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState<'' | 'check' | 'save' | 'generate'>('');
  const [error, setError] = useState('');
  const pendingRequest = useRef<{ fingerprint: string; id: string } | null>(null);
  useEffect(() => {
    void api<ImageGeneration[]>('/images/generations')
      .then((rows) => {
        setVariants((current) => [
          ...current,
          ...rows
            .flatMap((r) => r.items)
            .filter((v) => images.includes(v.source) && !current.some((c) => c.id === v.id)),
        ]);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    void api<ImageSettings>('/images')
      .then((s) => {
        setSettings(s);
        setForm({
          baseUrl: s.baseUrl,
          model: s.model,
          apiKey: '',
          size: s.size,
          mode: s.mode,
          watermark: s.watermark,
        });
        if (!s.baseUrl) setConfigOpen(true);
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  const sources = images.filter((url) => !excluded.includes(url));
  const total = form.mode === 'edit' ? sources.length * count : count;
  const configured = !!settings?.baseUrl && !!settings?.model;
  const pickedVariants = variants.filter((v) => picked.includes(v.id));
  const chip = !configured
    ? { className: 'idle', text: '未配置' }
    : status
      ? { className: status.ok ? 'ok' : 'fail', text: status.ok ? '已连接' : '连接失败' }
      : { className: 'idle', text: settings?.testedAt ? '上次生成可用' : '待检查' };

  async function saveConfig() {
    setBusy('save');
    setError('');
    try {
      const saved = await api<ImageSettings>(
        '/images',
        {
          serviceId: settings?.serviceId,
          baseUrl: form.baseUrl,
          model: form.model,
          size: form.size,
          mode: form.mode,
          watermark: form.watermark,
          ...(form.apiKey ? { apiKey: form.apiKey } : {}),
        },
        'PUT',
      );
      setSettings(saved);
      setForm({ ...form, apiKey: '' });
      setStatus(null);
      notify('生图服务配置已保存');
      return saved;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy('');
    }
  }

  async function reuse() {
    setBusy('save');
    setError('');
    try {
      const r = await api<{ settings: ImageSettings; copiedKey: boolean }>('/images/reuse-llm', {});
      setSettings(r.settings);
      setForm({
        baseUrl: r.settings.baseUrl,
        model: r.settings.model,
        apiKey: '',
        size: r.settings.size,
        mode: r.settings.mode,
        watermark: r.settings.watermark,
      });
      notify(
        r.copiedKey ? '已带入大模型地址与 Key，请填生图模型 ID' : '已带入大模型地址，请补填 Key',
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function check() {
    setBusy('check');
    setError('');
    try {
      const result = await api<{ ok: boolean; message: string; latencyMs?: number }>(
        '/images/check',
        {},
      );
      setStatus(result);
    } catch (e) {
      setStatus({ ok: false, message: (e as Error).message });
    } finally {
      setBusy('');
    }
  }

  async function generate() {
    if (!sources.length) {
      notify('请先选择至少一张原图', true);
      return;
    }
    setBusy('generate');
    setError('');
    try {
      const payload = {
        serviceId: settings?.serviceId,
        expectedModel: settings?.model,
        images: form.mode === 'edit' ? sources : [images[0] || sources[0]],
        prompt,
        count,
        mode: form.mode,
      };
      const fingerprint = JSON.stringify(payload);
      if (pendingRequest.current?.fingerprint !== fingerprint)
        pendingRequest.current = { fingerprint, id: crypto.randomUUID() };
      const result = await api<ImageGeneration>('/images/variants', {
        ...payload,
        requestId: pendingRequest.current.id,
      });
      pendingRequest.current = null;
      if (result.warning) setError(result.warning);
      setVariants((v) => [...result.items, ...v]);
      setPicked((v) => [...result.items.map((i) => i.id), ...v]);
      setSettings((s) => (s ? { ...s, testedAt: new Date().toISOString(), mode: form.mode } : s));
      setStatus({
        ok: true,
        message: `已生成 ${result.items.length} 张，用时 ${Math.round(result.elapsedMs / 1000)} 秒`,
      });
      notify(`AI 已生成 ${result.items.length} 张新版本，可对比后使用`);
    } catch (e) {
      setError((e as Error).message);
      setStatus({ ok: false, message: (e as Error).message });
    } finally {
      setBusy('');
    }
  }

  function apply(mode: Mode) {
    if (!pickedVariants.length) return;
    onUse(
      pickedVariants.map((v) => v.url),
      mode,
    );
    notify(
      mode === 'replace'
        ? `已用 ${pickedVariants.length} 张生成图替换素材`
        : `已追加 ${pickedVariants.length} 张生成图到素材`,
    );
  }

  return (
    <section className="ai-clone" aria-label="AI 生图">
      <header className="ai-clone-head">
        <div>
          <h3>
            <Sparkles size={15} />
            AI 生图
          </h3>
          <p>选择原图 → 生成新版本 → 对比后用于创作</p>
        </div>
        <span className={`ai-chip ${chip.className}`}>{chip.text}</span>
      </header>

      <div className="ai-toolbar">
        <button
          className="btn small"
          disabled={!!busy}
          onClick={() => void check()}
          title="检查生图服务是否可达"
        >
          {busy === 'check' ? <Busy text="检查中" /> : '检查服务'}
        </button>
        <button className="text-btn" onClick={() => setConfigOpen((v) => !v)}>
          <Settings2 size={12} />
          {configOpen ? '收起配置' : '配置服务'}
        </button>
        {settings?.testedAt && (
          <span className="ai-stamp">
            上次成功 {new Date(settings.testedAt).toLocaleString('zh-CN')}
          </span>
        )}
      </div>

      {configOpen && (
        <div className="ai-config">
          <p className="field-hint">
            支持 OpenAI 兼容的 <code>/images/edits</code>（参考图重绘）与{' '}
            <code>/images/generations</code>（文字生成）。地址与 Key
            只保存在本机，生成图同样落在本机；测试生图、同步模型在「连接设置 → 生图模型」。
          </p>
          <button className="text-btn" disabled={!!busy} onClick={() => void reuse()}>
            <RefreshCw size={12} />
            带入大模型地址与 Key
          </button>
          <div className="field-row">
            <label>
              服务地址
              <input
                aria-label="生图服务地址"
                type="url"
                placeholder="https://api.openai.com/v1"
                value={form.baseUrl}
                onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
              />
            </label>
            <label>
              模型 ID
              <input
                aria-label="生图模型"
                placeholder="gpt-image-1 / kolors / cogview-3-flash"
                value={form.model}
                onChange={(e) => setForm({ ...form, model: e.target.value })}
              />
            </label>
          </div>
          <div className="field-row">
            <label>
              API Key
              <input
                aria-label="生图 API Key"
                type="password"
                autoComplete="new-password"
                placeholder={settings?.hasApiKey ? '已加密保存，留空保持原值' : '本机服务可留空'}
                value={form.apiKey}
                onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
              />
            </label>
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
          <div className="ai-config-actions">
            <span className="field-hint">Key 只保存在本机，不会回传到页面</span>
            <button
              className="btn primary small"
              disabled={!!busy || !form.baseUrl || !form.model}
              onClick={() => void saveConfig()}
            >
              {busy === 'save' ? <Busy text="保存中" /> : '保存配置'}
            </button>
          </div>
        </div>
      )}

      {error && (
        <div>
          <p className="inline-error" role="alert">
            {error}
          </p>
          <button
            className="text-btn"
            disabled={!!busy}
            onClick={() => {
              pendingRequest.current = null;
              void generate();
            }}
          >
            新建生成请求（可能再次计费）
          </button>
        </div>
      )}
      {status?.ok && !error && <p className="ai-ok-note">{status.message}</p>}

      {images.length > 1 && (
        <>
          <div className="ai-sources-head">
            <span>原图</span>
            <div>
              <button className="text-btn" onClick={() => setExcluded([])}>
                全选原图
              </button>
              <button className="text-btn" onClick={() => setExcluded([...images])}>
                清空选图
              </button>
              <b>已选 {sources.length} 张</b>
            </div>
          </div>
          <div className="ai-sources">
            {images.map((url, i) => {
              const active = !excluded.includes(url);
              return (
                <button
                  key={url + i}
                  className={`ai-source ${active ? 'active' : ''}`}
                  aria-label={`原图${i + 1}${active ? '已选' : '未选'}`}
                  aria-pressed={active}
                  onClick={() =>
                    setExcluded((v) => (active ? [...v, url] : v.filter((x) => x !== url)))
                  }
                >
                  <img src={url} alt={`原图 ${i + 1}`} />
                  <span>{active ? <Check size={11} /> : <ImageIcon size={11} />}</span>
                </button>
              );
            })}
          </div>
        </>
      )}

      <label className="field-label ai-prompt-label" htmlFor="ai-prompt">
        重绘要求<span>{prompt.length} / 1000</span>
      </label>
      <textarea
        id="ai-prompt"
        className="ai-prompt"
        rows={4}
        value={prompt}
        maxLength={1000}
        onChange={(e) => setPrompt(e.target.value)}
      />

      <div className="ai-generate">
        <label>
          方式
          <select
            aria-label="生成方式"
            value={form.mode}
            onChange={(e) => setForm({ ...form, mode: e.target.value as ImageSettings['mode'] })}
          >
            <option value="edit">参考图重绘</option>
            <option value="generate">文字生成</option>
          </select>
        </label>
        <label>
          每张生成
          <select
            aria-label="生成张数"
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
          >
            <option value={1}>1 张</option>
            <option value={2}>2 张</option>
          </select>
        </label>
        <span className="field-hint">本次共 {total} 张</span>
        <button
          className="btn primary small"
          disabled={
            !!busy ||
            !configured ||
            !prompt.trim() ||
            !sources.length ||
            total > 6 ||
            (form.mode === 'edit' && sources.length > 4)
          }
          onClick={() => void generate()}
        >
          {busy === 'generate' ? <Busy text="生成中" /> : '生成变体'}
        </button>
      </div>

      {variants.length > 0 && (
        <div className="ai-results">
          <div className="ai-results-head">
            <span>生成结果 · 已选 {picked.length} 张</span>
            <div>
              <button className="text-btn" onClick={() => setPicked(variants.map((v) => v.id))}>
                全选
              </button>
              <button className="text-btn" onClick={() => setPicked([])}>
                清空
              </button>
              <button
                className="btn small"
                disabled={!picked.length || images.length + picked.length > 18}
                onClick={() => apply('append')}
              >
                追加到素材
              </button>
              <button
                className="btn primary small"
                disabled={!picked.length || picked.length > 18}
                onClick={() => apply('replace')}
              >
                替换全部素材
              </button>
            </div>
          </div>
          <div className="ai-variants">
            {variants.map((v, i) => {
              const active = picked.includes(v.id);
              return (
                <div className={`ai-variant ${active ? 'active' : ''}`} key={v.id}>
                  <button
                    className="ai-variant-main"
                    aria-label={`生成图${i + 1}${active ? '已选' : '未选'}`}
                    aria-pressed={active}
                    onClick={() =>
                      setPicked((p) => (active ? p.filter((id) => id !== v.id) : [...p, v.id]))
                    }
                  >
                    <img src={v.url} alt={`生成图 ${i + 1}`} />
                    <span className="ai-pick">{active && <Check size={12} />}</span>
                  </button>
                  <button
                    className="ai-compare"
                    onClick={() => setCompare({ source: v.source, url: v.url })}
                  >
                    对比原图
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {compare && (
        <div className="ai-compare-layer" role="dialog" aria-label="对比原图">
          <div className="ai-compare-card">
            <header>
              <b>原图 / 新版本</b>
              <button aria-label="关闭对比" onClick={() => setCompare(null)}>
                <X size={15} />
              </button>
            </header>
            <div>
              <figure>
                <img src={compare.source} alt="原图" />
                <figcaption>原图</figcaption>
              </figure>
              <figure>
                <img src={compare.url} alt="新版本" />
                <figcaption>新版本</figcaption>
              </figure>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
