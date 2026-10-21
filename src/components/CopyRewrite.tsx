import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import type { CopyRewrite as Copy, LlmSettings, Note } from '../../shared/types';
import { api } from '../api';
import { Busy } from './ui';

const STYLES = [
  ['same', '同风格重写'],
  ['spoken', '更口语'],
  ['pro', '更专业'],
  ['hook', '更强钩子'],
] as const;

export function CopyRewrite({
  note,
  current,
  onApply,
  notify,
}: {
  note?: Note;
  current: { title: string; body: string; tags: string };
  onApply: (patch: {
    title?: string;
    body?: string;
    tags?: string;
    knowledgeIds?: string[];
  }) => void;
  notify: (text: string, error?: boolean) => void;
}) {
  const [llm, setLlm] = useState<LlmSettings | null>(null);
  const [style, setStyle] = useState<(typeof STYLES)[number][0]>('same');
  const [useKnowledge, setUseKnowledge] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Copy | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void api<LlmSettings>('/llm')
      .then(setLlm)
      .catch(() => setLlm(null));
  }, []);

  if (!note) return null;
  const ready = !!llm?.baseUrl && !!llm?.model;
  const untouched =
    current.title === note.title.slice(0, 20) &&
    current.body === note.body &&
    current.tags === note.tags.join(' ');

  async function rewrite() {
    if (!note) return;
    setBusy(true);
    setError('');
    try {
      const r = await api<Copy>('/copy/rewrite', {
        noteId: note.id,
        style,
        useKnowledge,
        serviceId: llm?.serviceId,
        expectedModel: llm?.model,
      });
      setResult(r);
      notify(
        `已生成 ${r.titles.length} 个标题与正文，与原作重复度 ${Math.round(r.overlap * 100)}%` +
          (r.knowledge?.length ? `，引用了 ${r.knowledge.length} 张方法卡` : ''),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // 套用改写结果时把本次引用的卡片带上，草稿才能记下用过哪些方法卡。
  function apply(patch: { title?: string; body?: string; tags?: string; knowledgeIds?: string[] }) {
    const ids = result?.knowledge?.map((k) => k.id);
    onApply(ids?.length ? { ...patch, knowledgeIds: ids } : patch);
  }

  function useHook(hook: string) {
    const lines = current.body.split('\n');
    lines[0] = hook;
    apply({ body: lines.join('\n') });
  }

  return (
    <section className="copy-ai" aria-label="AI 改写文案">
      <header>
        <h3>
          <Sparkles size={14} />
          AI 改写
        </h3>
        {untouched && (
          <span className="copy-flag" title="标题与正文仍与原作品一致，建议改写后再发布">
            仍是原文
          </span>
        )}
      </header>
      <p className="field-hint">
        点「AI
        改写」才会调用模型；不点则标题、正文与话题保持参考作品原样，也可以直接手动改。模型只做改写，不编造价格、疗效与资质。
      </p>
      {!ready ? (
        <p className="field-hint copy-off">
          未配置大模型。请在「连接设置 → 大模型」填写服务地址与模型 ID，或手动改写标题与正文。
        </p>
      ) : (
        <div className="copy-ai-row">
          <select
            aria-label="改写风格"
            value={style}
            onChange={(e) => setStyle(e.target.value as typeof style)}
          >
            {STYLES.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
          <button className="btn small primary" disabled={busy} onClick={() => void rewrite()}>
            {busy ? <Busy text="改写中" /> : 'AI 改写'}
          </button>
          <label
            className="checkbox-line knowledge-switch"
            title="关闭后按通用规则改写，用来对比方法卡有没有用"
          >
            <input
              type="checkbox"
              checked={useKnowledge}
              onChange={(e) => setUseKnowledge(e.target.checked)}
            />
            用我的方法卡
          </label>
          <span className="field-hint">{llm?.model}</span>
        </div>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {result && (
        <div className="copy-result">
          <div className="copy-titles">
            <span>标题候选 · 点击套用</span>
            <div>
              {result.titles.map((t) => (
                <button
                  key={t}
                  className={t === current.title ? 'active' : ''}
                  onClick={() => apply({ title: t })}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
          {result.hooks.length > 0 && (
            <div className="copy-hooks">
              <span>开头钩子 · 替换正文第一行</span>
              <div>
                {result.hooks.map((h) => (
                  <button key={h} onClick={() => useHook(h)}>
                    {h}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="copy-body">
            <p>{result.body}</p>
            <button className="text-btn" onClick={() => apply({ body: result.body })}>
              应用正文
            </button>
          </div>
          <div className="copy-tags">
            <span>话题</span>
            {result.tags.map((t) => (
              <b key={t}>#{t}</b>
            ))}
            <button className="text-btn" onClick={() => apply({ tags: result.tags.join(' ') })}>
              应用话题
            </button>
          </div>
          <footer>
            <span>
              与原作重复度 {Math.round(result.overlap * 100)}% · {result.model} ·{' '}
              {(result.elapsedMs / 1000).toFixed(1)} 秒
            </span>
            <button
              className="btn small primary"
              onClick={() =>
                apply({
                  title: result.titles[0],
                  body: result.body,
                  tags: result.tags.join(' '),
                })
              }
            >
              应用整篇
            </button>
          </footer>
          {result.avoid.length > 0 && (
            <p className="field-hint">本次刻意规避：{result.avoid.join('、')}</p>
          )}
          {result.knowledge?.length ? (
            <p className="field-hint">
              本次引用方法卡：{result.knowledge.map((k) => k.title).join('、')}
            </p>
          ) : useKnowledge ? (
            <p className="field-hint">
              这次没有匹配到方法卡。去「知识库」按标签补几张，下次改写就会带上。
            </p>
          ) : (
            <p className="field-hint">本次关闭了方法卡，按通用规则改写。</p>
          )}
        </div>
      )}
    </section>
  );
}
