import { useCallback, useEffect, useState } from 'react';
import {
  Search,
  Compass,
  Users,
  MessageSquareText,
  PenLine,
  History,
  Settings,
  ChevronRight,
  ArrowUpRight,
  Plus,
  Check,
  AlertCircle,
  X,
  Command,
  BookOpen,
  Monitor,
  PanelLeftClose,
  PanelLeftOpen,
  Workflow,
  Radio,
} from 'lucide-react';
import type { Snapshot, Note, Draft, Job } from '../shared/types';
import { api, getState } from './api';
import { WorkspaceContext, type Page } from './context';
import { Discover } from './components/Discover';
import { Comments, Leads } from './components/Customers';
import { Studio, Editor } from './components/Studio';
import { SettingsPage, HistoryPage, Guide } from './components/System';
const navs: { id: Page; name: string; icon: typeof Search }[] = [
  { id: 'discover', name: '发现作品', icon: Compass },
  { id: 'comments', name: '客户采集', icon: MessageSquareText },
  { id: 'leads', name: '客户线索', icon: Users },
  { id: 'studio', name: '内容工作室', icon: PenLine },
  { id: 'history', name: '任务记录', icon: History },
];
function currentPage(): Page {
  const p = location.hash.slice(1);
  return [...navs.map((n) => n.id), 'settings'].includes(p) ? (p as Page) : 'discover';
}
export default function App() {
  const [data, setData] = useState<Snapshot | null>(null),
    [page, setPage] = useState<Page>(currentPage),
    [error, setError] = useState(''),
    [toast, setToast] = useState<{ text: string; error: boolean } | null>(null),
    [editor, setEditor] = useState<{ note?: Note; draft?: Draft } | null>(null),
    [guide, setGuide] = useState(false),
    [collapsed, setCollapsed] = useState(false),
    [commentNoteId, setCommentNoteId] = useState('');
  const notify = useCallback((text: string, error = false) => setToast({ text, error }), []);
  const refresh = useCallback(async () => {
    try {
      setData(await getState());
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  const navigate = useCallback((p: Page) => {
    location.hash = p;
    setPage(p);
  }, []);
  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 1200);
    const hash = () => setPage(currentPage());
    window.addEventListener('hashchange', hash);
    return () => {
      clearInterval(id);
      window.removeEventListener('hashchange', hash);
    };
  }, [refresh]);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(id);
  }, [toast]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        navigate('discover');
        setTimeout(() => document.getElementById('agent-input')?.focus(), 50);
      }
      if (
        e.key === '?' &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement)
      )
        setGuide(true);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [navigate]);
  const collect = useCallback(
    async (note: Note) => {
      try {
        const j = await api<Job>('/comments/collect', {
          noteId: note.id,
          limit: 60,
          interval: 1000,
        });
        setCommentNoteId(j.noteId!);
        navigate('comments');
        await refresh();
        notify('评论采集已开始，包含楼中楼回复');
      } catch (e) {
        notify((e as Error).message, true);
      }
    },
    [navigate, refresh, notify],
  );
  const title = navs.find((n) => n.id === page)?.name || '连接设置';
  if (!data)
    return (
      <div className="boot">
        <div className="brand-mark">
          <Search />
        </div>
        <h1>OpenFind</h1>
        <p>{error ? '本地服务暂时无法连接' : '正在打开你的获客工作台…'}</p>
        {error && (
          <>
            <p>{error}</p>
            <button className="btn primary" onClick={() => void refresh()}>
              重新连接
            </button>
          </>
        )}
      </div>
    );
  const running = data.jobs.filter((j) => j.status === 'running').length;
  return (
    <WorkspaceContext.Provider
      value={{
        data,
        refresh,
        notify,
        navigate,
        clone: (note) => setEditor({ note }),
        editDraft: (draft) => setEditor({ draft }),
        newDraft: () => setEditor({}),
        collect,
        commentNoteId,
        setCommentNoteId,
      }}
    >
      <div className={`app-shell ${collapsed ? 'collapsed' : ''}`}>
        <aside className="sidebar">
          <a className="brand" href="#discover" aria-label="OpenFind 首页">
            <span className="brand-mark">
              <Search size={23} />
              <Plus size={12} className="brand-plus" />
            </span>
            <span>
              openfind<span className="brand-dot">.</span>
            </span>
          </a>
          <div className="workspace-selector">
            <span className="workspace-avatar">O</span>
            <div>
              <b>我的工作空间</b>
              <small>个人工作台</small>
            </div>
            <ChevronRight size={14} />
          </div>
          <div className="nav-label">
            工作空间 <span>WORKSPACE</span>
          </div>
          <nav>
            {navs.map((n) => (
              <button
                key={n.id}
                aria-label={n.name}
                title={n.name}
                className={`nav-item ${page === n.id ? 'active' : ''}`}
                onClick={() => navigate(n.id)}
              >
                <n.icon size={19} />
                <span>{n.name}</span>
                {n.id === 'leads' && data.leads.length > 0 && <em>{data.leads.length}</em>}
                {n.id === 'history' && running > 0 && <span className="nav-running" />}
              </button>
            ))}
          </nav>
          <div className="sidebar-platform">
            <div className="platform-top">
              <span className="xhs-icon">小红书</span>
              <b>小红书 / 抖音</b>
              <span className="dot" />
            </div>
            <p>{data.settings.mode === 'demo' ? '本地演示环境' : '真实服务模式'}</p>
            <button onClick={() => navigate('settings')}>
              管理连接
              <ArrowUpRight size={13} />
            </button>
          </div>
          <div className="sidebar-bottom">
            <button
              aria-label="连接设置"
              title="连接设置"
              className={`nav-item ${page === 'settings' ? 'active' : ''}`}
              onClick={() => navigate('settings')}
            >
              <Settings size={18} />
              <span>连接设置</span>
            </button>
            <button
              aria-label="使用指南与视频解析"
              title="使用指南与视频解析"
              className="nav-item"
              onClick={() => setGuide(true)}
            >
              <BookOpen size={18} />
              <span>使用指南与视频解析</span>
            </button>
            <div className="user-line">
              <span className="user-avatar">O</span>
              <div>
                <b>OpenFind 用户</b>
                <small>Local workspace</small>
              </div>
              <span className="local-pill">本地</span>
            </div>
          </div>
        </aside>
        <div className="main-shell">
          <header className="topbar">
            <div className="breadcrumbs">
              <button
                className="icon-btn sidebar-toggle"
                aria-label="切换侧栏"
                onClick={() => setCollapsed((v) => !v)}
              >
                {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
              </button>
              <span>工作空间</span>
              <ChevronRight size={13} />
              <b>{title}</b>
            </div>
            <div className="topbar-right">
              <span className="service-status">
                <i className="dot" />
                本地服务运行中
              </span>
              <button
                className="shortcut"
                onClick={() => {
                  navigate('discover');
                  setTimeout(() => document.getElementById('agent-input')?.focus(), 50);
                }}
              >
                <Search size={14} />
                <span>快速开始</span>
                <kbd>⌘ K</kbd>
              </button>
              <button
                className="user-avatar"
                aria-label="打开连接设置"
                onClick={() => navigate('settings')}
              >
                O
              </button>
            </div>
          </header>
          <main className="main-content">
            {error && (
              <div className="inline-error">
                <AlertCircle size={15} />
                与本地服务的连接中断，正在重试。{error}
              </div>
            )}
            {page === 'discover' && <Discover />}
            {page === 'comments' && <Comments />}
            {page === 'leads' && <Leads />}
            {page === 'studio' && <Studio />}
            {page === 'history' && <HistoryPage />}
            {page === 'settings' && <SettingsPage />}
            <footer className="workspace-footer">
              <span>
                <Workflow size={13} /> OpenFind · 让发现成为生意的起点
              </span>
              <span>
                <Monitor size={12} /> 数据保存在本机 <i /> v1.0.0
              </span>
            </footer>
          </main>
        </div>
        {toast && (
          <div
            className={`toast ${toast.error ? 'error' : ''}`}
            role={toast.error ? 'alert' : 'status'}
          >
            {toast.error ? <AlertCircle size={18} /> : <Check size={18} />}
            <span>{toast.text}</span>
            <button aria-label="关闭提示" onClick={() => setToast(null)}>
              <X size={15} />
            </button>
          </div>
        )}
        {running > 0 && (
          <button className="running-indicator" onClick={() => navigate('history')}>
            <Radio size={15} />
            {running} 个任务正在运行
          </button>
        )}
        {editor && (
          <Editor note={editor.note} draft={editor.draft} onClose={() => setEditor(null)} />
        )}
        {guide && <Guide onClose={() => setGuide(false)} />}
      </div>
    </WorkspaceContext.Provider>
  );
}
