import { DouyinDataSettings } from './DouyinDataSettings';
import { XhsDataSettings } from './XhsDataSettings';
import { LlmSettingsPanel } from './LlmSettings';
import { useState } from 'react';
import {
  Settings,
  ShieldCheck,
  Plug,
  Eye,
  EyeOff,
  Save,
  Check,
  ArrowRight,
  ExternalLink,
  Terminal,
  Clock,
  History,
  Search,
  Download,
  ChevronRight,
  Play,
  Square,
  BookOpen,
  FileText,
  CheckCircle2,
  AlertTriangle,
  Globe,
  Server,
  Copy,
  Plus,
  Trash2,
} from 'lucide-react';
import type { Settings as SettingsType, Job } from '../../shared/types';
import { api, exportUrl } from '../api';
import { useWorkspace } from '../context';
import { PageHeading, Modal, Busy, SourceTag, Empty } from './ui';
import { PlatformConnections } from './PlatformConnections';
import { AccountForm } from './Accounts';
import { JobLog } from './Discover';
export function SettingsPage() {
  const { data, refresh, notify } = useWorkspace();
  const [form, setForm] = useState<SettingsType>(data.settings),
    [cookie, setCookie] = useState(''),
    [token, setToken] = useState(''),
    [showCookie, setShowCookie] = useState(false),
    [showToken, setShowToken] = useState(false),
    [clearToken, setClearToken] = useState(false),
    [clearCookie, setClearCookie] = useState(false),
    [busy, setBusy] = useState(''),
    [accountDialog, setAccountDialog] = useState(false),
    [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  async function save() {
    const s = await api<SettingsType>(
      '/settings',
      {
        ...form,
        cookie: cookie || clearCookie ? cookie : undefined,
        token: token || clearToken ? token : undefined,
      },
      'PUT',
    );
    setForm(s);
    setCookie('');
    setToken('');
    setClearToken(false);
    setClearCookie(false);
    await refresh();
    return s;
  }
  async function submit() {
    setBusy('save');
    try {
      await save();
      notify('连接配置已保存，凭证不会返回给前端');
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy('');
    }
  }
  async function test() {
    setBusy('test');
    setTestResult(null);
    try {
      await save();
      const r = await api<{ ok: boolean; accountName?: string; message?: string }>(
        '/settings/test',
        {},
      );
      if (!r.ok) throw new Error(r.message || '平台尚未登录');
      setTestResult({ ok: true, text: `连接成功${r.accountName ? ' · ' + r.accountName : ''}` });
      notify('数据服务连通性检查通过');
    } catch (e) {
      setTestResult({ ok: false, text: (e as Error).message });
      notify((e as Error).message, true);
    } finally {
      setBusy('');
    }
  }
  return (
    <>
      <PageHeading
        eyebrow="YOUR LOCAL CONNECTION"
        title="连接数据，让发现走得更远。"
        description="管理平台账号与数据服务，所有配置和凭证均保存在你的本机。"
      />
      <XhsDataSettings />
      <DouyinDataSettings />
      <PlatformConnections />
      <LlmSettingsPanel />
      <div className="settings-layout">
        <section className="panel settings-form">
          <div className="section-title">
            <Plug size={18} />
            <h2>运行与抖音高级连接设置</h2>
          </div>
          <label className="field-label">运行模式</label>
          <div className="mode-options">
            <button
              className={form.mode === 'demo' ? 'active' : ''}
              onClick={() => setForm({ ...form, mode: 'demo' })}
            >
              <span>
                <Play size={17} />
                演示模式
              </span>
              <p>使用本地样例，体验完整产品流程</p>
              {form.mode === 'demo' && <Check size={15} />}
            </button>
            <button
              className={form.mode === 'live' ? 'active' : ''}
              onClick={() => setForm({ ...form, mode: 'live' })}
            >
              <span>
                <Globe size={17} />
                真实模式
              </span>
              <p>小红书使用 API，抖音使用独立选择的数据源</p>
              {form.mode === 'live' && <Check size={15} />}
            </button>
          </div>
          <p className="field-hint">
            抖音采集方式请在上方「抖音数据源」选择；以下地址与令牌仅用于原有高级 HTTP 适配器。
          </p>
          <label className="field-label" htmlFor="provider-url">
            数据服务地址
          </label>
          <input
            id="provider-url"
            type="url"
            value={form.providerUrl}
            onChange={(e) => setForm({ ...form, providerUrl: e.target.value })}
            placeholder="http://127.0.0.1:9000"
          />
          <p className="field-hint">
            服务需实现 OpenFind 适配器协议：/health、/search、/comments。
          </p>
          <label className="field-label" htmlFor="provider-token">
            服务访问令牌<span>{form.hasToken ? '已加密保存' : '可选'}</span>
          </label>
          <div className="input-with-icon secret-input">
            <input
              id="provider-token"
              type={showToken ? 'text' : 'password'}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="new-password"
              placeholder={form.hasToken ? '已保存，留空保持原值' : '输入服务令牌（如需要）'}
            />
            <button
              className="icon-btn"
              aria-label={showToken ? '隐藏令牌' : '显示令牌'}
              onClick={() => setShowToken((v) => !v)}
            >
              {showToken ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          {form.hasToken && (
            <button
              className="text-btn small danger"
              onClick={() => {
                setToken('');
                setClearToken(true);
              }}
            >
              清除已保存令牌{clearToken && '（保存后生效）'}
            </button>
          )}
          <div className="settings-divider" />
          <div className="section-title">
            <span className="xhs-icon">小红书</span>
            <h2>平台账号</h2>
            <button
              className="text-btn"
              style={{ marginLeft: 'auto' }}
              onClick={() => setAccountDialog(true)}
            >
              <Plus size={13} />
              添加账号
            </button>
          </div>
          <div className="account-list">
            {data.accounts.map((a) => (
              <button
                key={a.id}
                className={form.accountId === a.id ? 'active' : ''}
                onClick={() => {
                  setForm({
                    ...form,
                    accountId: a.id,
                    accountName: a.name,
                    hasCookie: a.hasCookie,
                    rememberCookie: a.rememberCookie,
                  });
                  setCookie('');
                  setClearCookie(false);
                }}
              >
                <span className="author-avatar color-1">{a.name.slice(0, 1)}</span>
                <span>
                  <b>{a.name}</b>
                  <small>
                    {a.platform === 'douyin'
                      ? '抖音 · '
                      : a.platform === 'xiaohongshu'
                        ? '小红书 · '
                        : ''}
                    {a.connectionType === 'browser'
                      ? '本机浏览器登录'
                      : a.hasCookie
                        ? '已配置凭证'
                        : '未配置凭证'}
                  </small>
                </span>
                {form.accountId === a.id && <Check size={13} />}
              </button>
            ))}
          </div>
          <div className="field-row">
            <div>
              <label className="field-label" htmlFor="account-name">
                账号名称
              </label>
              <input
                id="account-name"
                value={form.accountName}
                onChange={(e) => setForm({ ...form, accountName: e.target.value })}
                maxLength={60}
              />
            </div>
            <div>
              <label className="field-label" htmlFor="account-id">
                账号 ID
              </label>
              <input
                id="account-id"
                value={form.accountId}
                onChange={(e) => setForm({ ...form, accountId: e.target.value })}
                maxLength={100}
              />
            </div>
          </div>
          <label className="field-label" htmlFor="platform-cookie">
            Cookie
            <button className="text-btn" onClick={() => setShowCookie((v) => !v)}>
              {showCookie ? <EyeOff size={13} /> : <Eye size={13} />}{' '}
              {showCookie ? '隐藏 Cookie' : '显示 Cookie'}
            </button>
          </label>
          <textarea
            id="platform-cookie"
            className={!showCookie ? 'masked' : ''}
            value={cookie}
            onChange={(e) => setCookie(e.target.value)}
            autoComplete="off"
            rows={4}
            placeholder={
              form.hasCookie
                ? '已有凭证，输入新值可替换；留空保持原值'
                : '粘贴你自己的已登录账号 Cookie'
            }
          />
          <label className="checkbox-line">
            <input
              type="checkbox"
              checked={form.rememberCookie}
              onChange={(e) => setForm({ ...form, rememberCookie: e.target.checked })}
            />
            <span>加密保存到本机，下次自动读取</span>
          </label>
          <p className="field-hint">
            未勾选时，Cookie 仅保留到本地服务关闭。已保存凭证不会回传前端。
          </p>
          {form.hasCookie && (
            <button
              className="text-btn small danger"
              onClick={() => {
                setCookie('');
                setClearCookie(true);
              }}
            >
              清除 Cookie{clearCookie && '（保存后生效）'}
            </button>
          )}
          <details className="cookie-help">
            <summary>Cookie 在哪里复制？</summary>
            <ol>
              <li>在浏览器中登录你自己的小红书账号。</li>
              <li>打开开发者工具 → Network，选中一个已登录请求。</li>
              <li>在 Request Headers 中找到 Cookie，复制其值后粘贴到上方。</li>
              <li>Cookie 不会出现在任务日志和导出数据中。</li>
            </ol>
          </details>
          {testResult && (
            <div className={`connection-test ${testResult.ok ? 'success' : 'failure'}`}>
              {testResult.ok ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}
              <span>{testResult.text}</span>
            </div>
          )}
          <div className="settings-actions">
            <button
              className="btn"
              disabled={!!busy || (form.connectionType === 'http' && !form.providerUrl)}
              onClick={() => void test()}
            >
              {busy === 'test' ? (
                <Busy text="检查中" />
              ) : (
                <>
                  <Plug size={15} />
                  保存并测试连接
                </>
              )}
            </button>
            <button className="btn primary" disabled={!!busy} onClick={() => void submit()}>
              {busy === 'save' ? (
                <Busy text="保存中" />
              ) : (
                <>
                  <Save size={15} />
                  保存设置
                </>
              )}
            </button>
          </div>
        </section>
        <aside className="settings-aside">
          <div className="panel">
            <div className="settings-aside-icon">
              <ShieldCheck size={22} />
            </div>
            <h3>本地优先，由你掌控。</h3>
            <p>作品、评论、线索、草稿和任务日志存入本机 SQLite 数据库。登录凭证独立加密。</p>
            <ul>
              <li>
                <Check size={13} />
                服务仅监听 127.0.0.1
              </li>
              <li>
                <Check size={13} />
                凭证采用 AES-256-GCM
              </li>
              <li>
                <Check size={13} />
                搜索与评论任务可随时停止
              </li>
              <li>
                <Check size={13} />
                支持 JSON、CSV 和图文包导出
              </li>
            </ul>
          </div>
          <div className="panel">
            <Server size={21} />
            <h3>接入真实数据</h3>
            <p>
              小红书使用 TikHub / RedFox API，无需扫码或
              Cookie；抖音可独立选择浏览器、TikHub、RedFox 或原有高级 HTTP
              适配器。发送与发布由用户自行完成。
            </p>
            <p className="field-hint">适配器完整字段及调用示例已随项目提供：docs/ADAPTER.md</p>
            <button
              className="text-btn"
              onClick={() =>
                void navigator.clipboard.writeText('docs/ADAPTER.md').then(
                  () => notify('文档路径已复制'),
                  () => notify('复制失败', true),
                )
              }
            >
              复制文档路径
              <Copy size={13} />
            </button>
          </div>
        </aside>
      </div>
      {accountDialog && (
        <AccountForm
          onClose={() => setAccountDialog(false)}
          onCreated={(a) =>
            setForm({
              ...form,
              accountId: a.id,
              accountName: a.name,
              hasCookie: a.hasCookie,
              rememberCookie: a.rememberCookie,
            })
          }
        />
      )}
    </>
  );
}
export function HistoryPage() {
  const { data, refresh, notify, navigate } = useWorkspace();
  const [selected, setSelected] = useState<Job | null>(null),
    [query, setQuery] = useState('');
  const statuses = { running: '运行中', completed: '已完成', stopped: '已停止', failed: '失败' };
  const jobs = data.jobs.filter((j) => j.keyword.includes(query));
  const current = data.jobs.find((j) => j.id === selected?.id) || selected;
  async function stop(j: Job) {
    try {
      await api(`/jobs/${j.id}/stop`, {});
      await refresh();
      notify('停止请求已提交');
    } catch (e) {
      notify((e as Error).message, true);
    }
  }
  return (
    <>
      <PageHeading
        eyebrow="EVERY STEP, IN SIGHT"
        title="每一步进展，都有迹可循。"
        description="查看历史任务、执行状态与完整日志，已采集的数据会持续保留。"
        action={
          <a className="btn" href={exportUrl('jobs')}>
            <Download size={15} />
            导出任务记录
          </a>
        }
      />
      <section className="panel results-box">
        <div className="results-heading">
          <div>
            <h2>
              任务记录<span>{jobs.length}</span>
            </h2>
            <p>从输入到结果，每一次执行都有记录。</p>
          </div>
          <div className="input-with-icon">
            <Search size={15} />
            <input
              aria-label="搜索任务"
              placeholder="搜索关键词或作品标题"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>
        {jobs.length ? (
          <div className="table-scroll">
            <table className="history-table">
              <thead>
                <tr>
                  <th>任务</th>
                  <th>来源</th>
                  <th>状态</th>
                  <th>结果 / 页数</th>
                  <th>创建时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id}>
                    <td>
                      <div className="task-cell">
                        <span>
                          {j.type === 'search' ? <Search size={17} /> : <Terminal size={17} />}
                        </span>
                        <div>
                          <b>{j.keyword}</b>
                          <small>{j.type === 'search' ? '关键词搜索' : '评论与楼中楼采集'}</small>
                        </div>
                      </div>
                    </td>
                    <td>
                      <SourceTag source={j.source} />
                    </td>
                    <td>
                      <span className={`job-status ${j.status}`}>
                        <i />
                        {statuses[j.status]}
                      </span>
                    </td>
                    <td>
                      {j.count} 条 <span className="muted">/ {j.pages} 页</span>
                    </td>
                    <td className="muted">
                      {new Date(j.createdAt).toLocaleString('zh-CN', { hour12: false })}
                    </td>
                    <td>
                      <div className="table-actions">
                        <button className="text-btn" onClick={() => setSelected(j)}>
                          查看日志
                          <ChevronRight size={13} />
                        </button>
                        {j.status === 'running' && (
                          <button
                            className="icon-btn danger"
                            aria-label="停止任务"
                            onClick={() => void stop(j)}
                          >
                            <Square size={13} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title="还没有任务记录"
            sub="先发现一篇好作品，任务进展会完整记录在这里。"
            action={
              <button className="btn primary" onClick={() => navigate('discover')}>
                开始搜索
                <ArrowRight size={14} />
              </button>
            }
          />
        )}
      </section>
      {current && (
        <Modal
          title="任务执行日志"
          sub={`${current.keyword} · ${statuses[current.status]} · ${current.count} 条结果`}
          onClose={() => setSelected(null)}
          wide
        >
          <div className="live-bar">
            <span>
              <i /> LIVE
            </span>
            <b>{current.id}</b>
            <SourceTag source={current.source} />
          </div>
          <JobLog job={current} />
        </Modal>
      )}
    </>
  );
}
const coverage = [
  ['07–09 秒', '任务工作台', '自然语言入口、示例任务、四阶段流程'],
  ['09–14 秒', '采集设置', '关键词、Cookie、记住凭证、上限、排序、类型、间隔、开始与停止'],
  ['15–23 秒', '实时作品结果', '实时计数、页数、耗时、瀑布流、滚动结果、筛选'],
  ['24–31 秒', '作品批量与悬浮操作', '全选图文、清空、图片包、JSON、卡片/日志、一键克隆与采集客户'],
  [
    '32–38 秒',
    '克隆创作与发布设置',
    '图片增删与排序、标题、正文、话题、可见范围、发布账号、保存/发布',
  ],
  ['39–45 秒', '评论与楼中楼采集', 'ROOT / REPLY、昵称、时间、属地、内容、实时日志、统计、筛选'],
];
export function Guide({ onClose }: { onClose: () => void }) {
  return (
    <Modal
      title="从视频，到 OpenFind"
      sub="基于 56.6 秒参考视频逐段整理的产品与页面覆盖"
      onClose={onClose}
      wide
    >
      <div className="modal-body guide-body">
        <div className="guide-intro">
          <BookOpen size={24} />
          <div>
            <h3>发现作品 → 筛选爆款 → 创作 / 采集客户</h3>
            <p>保留视频展示的关键流程，并补充客户管理、草稿持久化和任务历史。</p>
          </div>
        </div>
        <div className="coverage-table">
          {coverage.map(([time, title, desc]) => (
            <div key={time}>
              <span>{time}</span>
              <div>
                <b>{title}</b>
                <p>{desc}</p>
              </div>
              <CheckCircle2 size={17} />
            </div>
          ))}
        </div>
        <h3>视频能证明什么？</h3>
        <p>
          画面展示的是本地运行的小红书工具。旁白提到“全网平台”，但未展示其他平台；编辑器有发布设置，但视频没有显示发布成功回执。因此
          OpenFind 将演示流程和真实连接分开标记。
        </p>
        <h3>先试一遍完整流程</h3>
        <ol>
          <li>在「发现作品」填写关键词，或直接使用一句话任务。</li>
          <li>在卡片上选择「一键克隆」，编辑图片、文案和话题，保存草稿。</li>
          <li>选择「一键采集客户」，查看一级评论和楼中楼回复。</li>
          <li>把高意向评论保存为客户线索，记录跟进并准备沟通话术。</li>
          <li>
            在「连接设置」打开对应平台并扫码登录后，可手动触发搜索、评论采集；内容请复制或导出后自行发布。
          </li>
        </ol>
        <p className="guide-footnote">
          任务助手使用本地规则解析；意向评分使用可解释的关键词规则。完整逐页分析、架构与接口说明位于项目
          docs 目录。快捷键：⌘ / Ctrl + K 聚焦任务输入，Esc 关闭弹窗。
        </p>
      </div>
    </Modal>
  );
}
