import { useState, useRef } from 'react';
import {
  PenLine,
  Plus,
  ArrowRight,
  Image as ImageIcon,
  Upload,
  ArrowLeft,
  ArrowUp,
  ArrowDown,
  X,
  Save,
  Send,
  Download,
  Trash2,
  Copy,
  Clock,
  CheckCircle2,
  ShieldCheck,
  Eye,
  ExternalLink,
} from 'lucide-react';
import type { Note, Draft, Platform } from '../../shared/types';
import { api, safeUrl } from '../api';
import { useWorkspace } from '../context';
import { AccountForm } from './Accounts';
import { AiImage } from './AiImage';
import { CopyRewrite } from './CopyRewrite';
import { Modal, PageHeading, Empty, Busy, ExternalLink as SourceLink, SourceTag } from './ui';
export function Studio() {
  const { data, navigate, editDraft, notify, refresh, newDraft } = useWorkspace();
  const [filter, setFilter] = useState('all');
  const drafts = data.drafts.filter(
    (d) =>
      filter === 'all' ||
      (filter === 'draft' && d.status === 'draft') ||
      (filter === 'published' && d.status !== 'draft'),
  );
  async function remove(id: string) {
    try {
      await api(`/drafts/${id}`, undefined, 'DELETE');
      await refresh();
      notify('草稿已删除');
    } catch (e) {
      notify((e as Error).message, true);
    }
  }
  return (
    <>
      <PageHeading
        eyebrow="MAKE IT YOUR OWN"
        title="把灵感，变成你的下一篇作品。"
        description="从优质内容出发，调整图片和文案，沉淀属于你的内容资产。"
        action={
          <div className="original-creation-tools">
            <button className="btn" onClick={() => navigate('discover')}>
              从作品开始创作
            </button>
            <button className="btn primary" onClick={newDraft}>
              <Plus size={16} />
              原创草稿
            </button>
          </div>
        }
      />
      <div className="studio-intro">
        <span className="studio-intro-icon">
          <PenLine size={24} />
        </span>
        <div>
          <h3>好内容，值得再向前一步。</h3>
          <p>发现灵感 → 克隆为草稿 → 编辑图文 → 导出并手动发布</p>
        </div>
        <span>YOUR CONTENT STUDIO</span>
      </div>
      <section className="panel results-box">
        <div className="results-heading">
          <div>
            <h2>
              我的创作<span>{data.drafts.length}</span>
            </h2>
            <p>每一次保存，都让灵感离发布更近一步。</p>
          </div>
        </div>
        <div className="results-toolbar">
          <div className="filter-tabs">
            {[
              ['all', '全部创作'],
              ['draft', '草稿箱'],
              ['published', '发布记录'],
            ].map(([id, t]) => (
              <button
                key={id}
                onClick={() => setFilter(id)}
                className={filter === id ? 'active' : ''}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
        {drafts.length ? (
          <div className="draft-grid">
            {drafts.map((d) => (
              <article className="draft-card" key={d.id}>
                <button className="draft-cover" onClick={() => editDraft(d)}>
                  {d.kind === 'video' && d.video ? (
                    <video src={d.video} muted preload="metadata" aria-label={d.title} />
                  ) : (
                    <img src={d.images[0]} alt={d.title} />
                  )}
                  <span className={`draft-state ${d.status !== 'draft' ? 'published' : ''}`}>
                    {d.status === 'draft'
                      ? '草稿'
                      : d.status === 'demo_published'
                        ? '模拟发布'
                        : '已发布'}
                  </span>
                </button>
                <div>
                  <h3>{d.title}</h3>
                  <p>
                    <Clock size={12} />
                    {new Date(d.updatedAt).toLocaleString('zh-CN')}
                  </p>
                  <div className="draft-actions">
                    <button className="text-btn" onClick={() => editDraft(d)}>
                      <PenLine size={13} />
                      继续编辑
                    </button>
                    <a title="下载图文草稿包" href={`/api/drafts/${d.id}/bundle`}>
                      <Download size={15} />
                    </a>
                    <button
                      className="icon-btn"
                      aria-label={`删除草稿 ${d.title}`}
                      onClick={() => void remove(d.id)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <Empty
            title="给灵感一个落脚的地方"
            sub="在发现作品中，点击任意图文的「一键克隆」，开始你的第一次创作。"
            action={
              <button className="btn primary" onClick={() => navigate('discover')}>
                去找灵感
                <ArrowRight size={15} />
              </button>
            }
          />
        )}
      </section>
    </>
  );
}
export function Editor({
  note,
  draft: initial,
  onClose,
}: {
  note?: Note;
  draft?: Draft;
  onClose: () => void;
}) {
  const { data, refresh, notify, navigate } = useWorkspace();
  const source = note || data.notes.find((n) => n.id === initial?.noteId);
  const [platform, setPlatform] = useState<Platform>(
    initial?.platform || source?.platform || data.settings.platform || 'xiaohongshu',
  );
  const [kind, setKind] = useState<'image' | 'video'>(initial?.kind || 'image');
  const [video, setVideo] = useState(initial?.video || '');
  const videoFile = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(initial?.title || note?.title.slice(0, 20) || ''),
    [body, setBody] = useState(initial?.body ?? note?.body ?? ''),
    [tags, setTags] = useState((initial?.tags || note?.tags || []).join(' ')),
    [images, setImages] = useState<string[]>(initial?.images || note?.images || []),
    [visibility, setVisibility] = useState<Draft['visibility']>(initial?.visibility || 'public'),
    [accountId, setAccountId] = useState(
      initial?.accountId ||
        data.accounts.find(
          (a) =>
            (a.platform || 'xiaohongshu') ===
              (source?.platform || data.settings.platform || 'xiaohongshu') &&
            a.connectionType === 'browser',
        )?.id ||
        data.settings.accountId,
    ),
    [saved, setSaved] = useState<Draft | undefined>(initial),
    [busy, setBusy] = useState(''),
    [dirty, setDirty] = useState(false),
    [preview, setPreview] = useState(false),
    [accountDialog, setAccountDialog] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const demo = source?.source === 'demo';
  const valid =
    title.trim().length > 0 &&
    title.length <= 20 &&
    body.length <= 1000 &&
    (kind === 'video' ? !!video : images.length >= 1 && images.length <= 18);
  const editRevision = useRef(0);
  const changed = () => {
    editRevision.current++;
    setDirty(true);
  };
  async function persist() {
    const savingRevision = editRevision.current;
    const d = await api<Draft>('/drafts', {
      id: saved?.id,
      revision: saved?.revision || 0,
      noteId: source?.id || initial?.noteId || '',
      title,
      body,
      tags: tags.split(/[\s#]+/).filter(Boolean),
      images,
      visibility,
      accountId,
      platform,
      kind,
      video: kind === 'video' ? video : undefined,
      origin: source ? 'clone' : 'original',
    });
    setSaved(d);
    if (editRevision.current === savingRevision) setImages(d.images);
    setDirty(editRevision.current !== savingRevision);
    await refresh();
    return d;
  }
  async function save() {
    setBusy('save');
    try {
      await persist();
      notify('图文草稿已保存到内容工作室');
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy('');
    }
  }
  async function upload(files: FileList | null) {
    if (!files) return;
    try {
      if (files.length + images.length > 18) throw new Error('最多可添加 18 张图片');
      const arr = await Promise.all(
        Array.from(files).map(
          (f) =>
            new Promise<string>((resolve, reject) => {
              if (!['image/png', 'image/jpeg', 'image/webp'].includes(f.type)) {
                reject(new Error('仅支持 PNG、JPG、WebP 图片'));
                return;
              }
              if (f.size > 5 * 1024 * 1024) {
                reject(new Error('每张图片不能超过 5 MB'));
                return;
              }
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result as string);
              reader.onerror = () => reject(new Error('图片读取失败'));
              reader.readAsDataURL(f);
            }),
        ),
      );
      if (images.concat(arr).reduce((s, v) => s + v.length, 0) > 25_000_000)
        throw new Error('图片总大小超过本地请求上限，请减少图片');
      setImages((v) => [...v, ...arr]);
      changed();
    } catch (e) {
      notify((e as Error).message, true);
    }
    if (file.current) file.current.value = '';
  }
  function move(i: number, direction: number) {
    setImages((v) => {
      const a = [...v];
      [a[i], a[i + direction]] = [a[i + direction], a[i]];
      return a;
    });
    changed();
  }
  const published = saved && !dirty && saved.status !== 'draft';
  return (
    <Modal
      title={source ? '克隆创作' : '原创草稿'}
      sub="保留灵感，加入你的表达。编辑、预览并保存图文作品。"
      onClose={onClose}
      wide
    >
      <div className="editor-source">
        <span>{source ? '来源作品：' + source.title : '原创内容 · 图片与视频保存在本机'}</span>
        <SourceLink url={safeUrl(source?.url || '')} label="打开原作品" />
      </div>
      <div className="editor-original-options">
        <div>
          <label className="field-label" htmlFor="draft-platform">
            目标平台
          </label>
          <select
            id="draft-platform"
            value={platform}
            onChange={(e) => {
              const p = e.target.value as Platform;
              setPlatform(p);
              setAccountId(
                data.accounts.find(
                  (a) => (a.platform || 'xiaohongshu') === p && a.connectionType === 'browser',
                )?.id || '',
              );
              changed();
            }}
          >
            <option value="xiaohongshu">小红书</option>
            <option value="douyin">抖音</option>
          </select>
        </div>
        <div>
          <label className="field-label" htmlFor="draft-kind">
            内容类型
          </label>
          <select
            id="draft-kind"
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as 'image' | 'video');
              changed();
            }}
          >
            <option value="image">图文</option>
            <option value="video">视频</option>
          </select>
        </div>
      </div>
      <div className="editor-layout">
        <section className="editor-assets">
          {kind === 'video' ? (
            <div className="video-uploader">
              {video && <video src={video} controls />}
              <button className="btn" disabled={!!busy} onClick={() => videoFile.current?.click()}>
                {busy === 'video' ? (
                  <Busy text="上传中" />
                ) : (
                  <>
                    <Upload size={15} />
                    选择本地视频
                  </>
                )}
              </button>
              <input
                ref={videoFile}
                type="file"
                accept="video/mp4,video/webm,video/quicktime"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  if (file.size > 500 * 1024 * 1024) {
                    notify('视频不能超过500MB', true);
                    return;
                  }
                  setBusy('video');
                  const form = new FormData();
                  form.append('file', file);
                  void fetch('/api/media/video', { method: 'POST', body: form })
                    .then(async (r) => {
                      const d = await r.json();
                      if (!r.ok) throw new Error(d.error);
                      setVideo(d.url);
                      changed();
                      notify('视频已保存到本机');
                    })
                    .catch((e) => notify((e as Error).message, true))
                    .finally(() => setBusy(''));
                }}
              />
              <p>
                MP4 / WebM / MOV · 最大500MB
                <br />
                保存后可下载素材，由你在官方平台上传。
              </p>
            </div>
          ) : (
            <>
              <div className="editor-section-label">
                <h3>图片素材</h3>
                <span>{images.length} / 18</span>
              </div>
              <p className="field-hint">首张作为封面，可调整顺序或加入自己的图片。</p>
              <div className="editor-image-grid">
                {images.map((url, i) => (
                  <div className="editor-image" key={url + '-' + i}>
                    <img src={url} alt={`素材 ${i + 1}`} />
                    <span className="image-index">
                      {i + 1}
                      {i === 0 ? ' · 封面' : ''}
                    </span>
                    <div className="image-controls">
                      <button
                        aria-label={`图片${i + 1}前移`}
                        disabled={i === 0}
                        onClick={() => move(i, -1)}
                      >
                        <ArrowLeft size={11} />
                      </button>
                      <button
                        aria-label={`图片${i + 1}后移`}
                        disabled={i === images.length - 1}
                        onClick={() => move(i, 1)}
                      >
                        <ArrowRight size={11} />
                      </button>
                      <button
                        aria-label={`删除图片${i + 1}`}
                        onClick={() => {
                          setImages((v) => v.filter((_, j) => i !== j));
                          changed();
                        }}
                      >
                        <X size={11} />
                      </button>
                    </div>
                  </div>
                ))}
                {images.length < 18 && (
                  <button className="upload-tile" onClick={() => file.current?.click()}>
                    <Plus size={22} />
                    <span>添加本地图片</span>
                  </button>
                )}
              </div>
              <input
                ref={file}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple
                hidden
                onChange={(e) => void upload(e.target.files)}
              />
              <p className="field-hint">PNG / JPG / WebP · 单张不超过 5 MB</p>
            </>
          )}
          <div className="editor-note">
            <ShieldCheck size={16} />
            <p>草稿保存在本机。请在发布前确认图片、文案和拟用账号（备注）。</p>
          </div>
          {preview && (
            <div className="publish-preview">
              <h4>作品预览</h4>
              {images[0] && <img src={images[0]} alt="封面预览" />}
              <h3>{title || '填写一个标题'}</h3>
              <p>{body}</p>
              <div className="tag-list">
                {tags
                  .split(/\s+/)
                  .filter(Boolean)
                  .map((t, i) => (
                    <span key={i}>#{t}</span>
                  ))}
              </div>
            </div>
          )}
        </section>
        <section className="editor-fields">
          <div className="editor-section-label">
            <h3>内容编辑</h3>
            <button className="text-btn" onClick={() => setPreview((v) => !v)}>
              <Eye size={13} />
              {preview ? '收起预览' : '预览作品'}
            </button>
          </div>
          <CopyRewrite
            note={source}
            current={{ title, body, tags }}
            notify={notify}
            onApply={(patch) => {
              if (patch.title !== undefined) setTitle(patch.title);
              if (patch.body !== undefined) setBody(patch.body);
              if (patch.tags !== undefined) setTags(patch.tags);
              changed();
            }}
          />
          <label className="field-label" htmlFor="draft-title">
            标题<span>{title.length} / 20</span>
          </label>
          <input
            id="draft-title"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              changed();
            }}
            maxLength={20}
            placeholder="为这篇作品起一个好标题"
          />
          <label className="field-label" htmlFor="draft-body">
            正文<span>{body.length} / 1000</span>
          </label>
          <textarea
            id="draft-body"
            rows={9}
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
              changed();
            }}
            maxLength={1000}
            placeholder="写下你的独特表达…"
          />
          <label className="field-label" htmlFor="draft-tags">
            话题标签
          </label>
          <input
            id="draft-tags"
            value={tags}
            onChange={(e) => {
              setTags(e.target.value);
              changed();
            }}
            placeholder="多个话题用空格分隔"
          />
          <div className="field-row">
            <div>
              <label className="field-label" htmlFor="draft-visibility">
                可见范围
              </label>
              <select
                id="draft-visibility"
                value={visibility}
                onChange={(e) => {
                  setVisibility(e.target.value as Draft['visibility']);
                  changed();
                }}
              >
                <option value="public">公开可见</option>
                <option value="private">仅自己可见</option>
              </select>
            </div>
            <div>
              <label className="field-label" htmlFor="draft-account">
                拟用账号（备注）
                <button type="button" className="text-btn" onClick={() => setAccountDialog(true)}>
                  <Plus size={11} />
                  添加账号
                </button>
              </label>
              <select
                id="draft-account"
                value={accountId}
                onChange={(e) => {
                  setAccountId(e.target.value);
                  changed();
                }}
              >
                {data.accounts
                  .filter((a) => (a.platform || 'xiaohongshu') === platform)
                  .map((a) => (
                    <option value={a.id} key={a.id}>
                      {a.name}
                    </option>
                  ))}
              </select>
            </div>
          </div>
          <div className="publish-status">
            <ShieldCheck size={16} />
            <div>
              <b>保存素材，由你手动发布</b>
              <p>生成和编辑在本机完成。复制文案、下载素材包，再到官方平台自行上传发布。</p>
            </div>
          </div>
        </section>
      </div>
      {kind === 'image' && (
        <div className="editor-ai">
          <AiImage
            images={images}
            notify={notify}
            onUse={(urls, mode) => {
              if (mode === 'append' && images.length + urls.length > 18)
                notify('素材最多 18 张，超出部分未加入', true);
              setImages((v) => (mode === 'replace' ? urls : [...v, ...urls]));
              changed();
            }}
          />
        </div>
      )}
      <footer className="editor-footer">
        <span className="muted">
          {dirty ? '有未保存的修改' : saved ? '已保存到本机' : '完成后保存为草稿'}
        </span>
        <div>
          <button className="btn" onClick={onClose}>
            <ArrowLeft size={14} />
            返回作品列表
          </button>
          {saved && !dirty && !busy && (
            <a className="icon-btn" title="下载图文包" href={`/api/drafts/${saved.id}/bundle`}>
              <Download size={16} />
            </a>
          )}
          <button className="btn" disabled={!!busy || !valid} onClick={() => void save()}>
            {busy === 'save' ? (
              <Busy text="保存中" />
            ) : (
              <>
                <Save size={14} />
                保存草稿
              </>
            )}
          </button>
          <button
            className="btn primary"
            disabled={!!busy || !title.trim()}
            onClick={() =>
              void navigator.clipboard
                .writeText(
                  [
                    title,
                    body,
                    tags
                      .split(/\s+/)
                      .filter(Boolean)
                      .map((t) => (t.startsWith('#') ? t : '#' + t))
                      .join(' '),
                  ].join('\n\n'),
                )
                .then(
                  () => notify('文案已复制，请到官方平台手动发布'),
                  () => notify('复制失败，请手动复制文案', true),
                )
            }
          >
            复制发布文案
          </button>
        </div>
      </footer>
      {accountDialog && (
        <AccountForm
          onClose={() => setAccountDialog(false)}
          onCreated={(a) => {
            setAccountId(a.id);
            changed();
          }}
        />
      )}
    </Modal>
  );
}
