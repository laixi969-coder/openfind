import { CollectionBudget } from './CollectionBudget';
import { useEffect, useState } from 'react';
import {
  Plug,
  RefreshCw,
  ExternalLink,
  Monitor,
  CheckCircle2,
  AlertCircle,
  QrCode,
} from 'lucide-react';
import type { Platform, PlatformConnection } from '../../shared/types';
import { api } from '../api';
import { useWorkspace } from '../context';
import { Modal, Busy } from './ui';
export const platformNames: Record<Platform, string> = { xiaohongshu: '小红书', douyin: '抖音' };
export function PlatformConnections() {
  const { refresh, notify } = useWorkspace();
  const [previewPlatform, setPreviewPlatform] = useState<Platform | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );
  async function showLogin(p: Platform, reload = false) {
    setPreviewPlatform(p);
    setBusy(p);
    setPreviewUrl('');
    try {
      const response = await fetch(`/api/platforms/${p}/login-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh: reload }),
      });
      if (!response.ok) throw new Error((await response.json()).error || '无法显示扫码页');
      if (response.headers.get('content-type')?.includes('application/json')) {
        const state = await response.json();
        if (state.ready) {
          setPreviewPlatform(null);
          notify(state.message);
          await update();
          return;
        }
        throw new Error('官方页面尚未就绪');
      }
      setPreviewUrl(URL.createObjectURL(await response.blob()));
      await update();
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(null);
    }
  }
  const [connections, setConnections] = useState<PlatformConnection[]>([]),
    [protection, setProtection] = useState<
      Record<
        string,
        {
          paused: boolean;
          reason: string;
          counts: { search: number; comments: number; publish: number };
        }
      >
    >({}),
    [busy, setBusy] = useState<Platform | null>(null),
    [error, setError] = useState('');
  async function update() {
    try {
      const [connections, guard] = await Promise.all([
        api<PlatformConnection[]>('/platforms'),
        api<{ platforms: typeof protection }>('/protection'),
      ]);
      setConnections(connections);
      setProtection(guard.platforms);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void update();
    const timer = setInterval(() => void update(), 4000);
    return () => clearInterval(timer);
  }, []);
  async function open(p: Platform, creator = false) {
    setBusy(p);
    try {
      await api(`/platforms/${p}/${creator ? 'creator' : 'login'}`, {});
      await update();
      await refresh();
      notify(creator ? '已打开官方创作中心' : '请在新打开的官方浏览器中扫码登录');
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(null);
    }
  }
  async function check(p: Platform) {
    setBusy(p);
    try {
      const c = await api<PlatformConnection>(`/platforms/${p}/status`, {});
      await update();
      await refresh();
      notify(c.message, c.status === 'error');
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(null);
    }
  }
  return (
    <section className="native-connections panel">
      <div className="section-title">
        <Monitor size={18} />
        <h2>直接连接官方平台</h2>
        <span>本机浏览器</span>
      </div>
      <p className="connection-intro">
        本机浏览器接入。已登录仅表示身份验证通过，不代表搜索或评论读取权限已开通。
      </p>
      {error && (
        <div className="inline-error">
          <AlertCircle size={14} />
          {error}
        </div>
      )}
      <div className="connection-grid">
        {(['douyin'] as Platform[]).map((p) => {
          const c = connections.find((c) => c.platform === p);
          const ready = c?.status === 'ready';
          return (
            <div className="native-platform" key={p}>
              <div className="native-platform-title">
                <span className={`platform-symbol ${p}`}>{p === 'douyin' ? '抖' : '红'}</span>
                <div>
                  <h3>{platformNames[p]}</h3>
                  <span className={ready ? 'connection-ready' : 'muted'}>
                    {ready ? (
                      <>
                        <CheckCircle2 size={12} />
                        已验证登录
                      </>
                    ) : c?.status === 'error' ? (
                      '连接异常'
                    ) : c?.status === 'awaiting_login' ? (
                      '等待扫码登录'
                    ) : (
                      '尚未连接'
                    )}
                  </span>
                </div>
              </div>
              <p>
                {ready
                  ? `${c?.accountName || '已登录账号'} · 登录状态保存在本机`
                  : c?.message || '点击打开登录，在官方页面扫码'}
              </p>
              {protection[p] && (
                <div className={protection[p].paused ? 'inline-error' : 'field-hint'}>
                  <p>
                    {protection[p].paused
                      ? `操作已暂停：${protection[p].reason}`
                      : '操作保护已启用'}
                    <br />
                    内容与回复仅提供草稿，由你手动发布或发送
                  </p>
                  {protection[p].paused && (
                    <button
                      className="btn small"
                      disabled={busy === p}
                      onClick={() => {
                        setBusy(p);
                        void api(`/platforms/${p}/resume`, {})
                          .then(() => update())
                          .then(() => notify('保护暂停已解除，请回原任务重试'))
                          .catch((e) => notify((e as Error).message, true))
                          .finally(() => setBusy(null));
                      }}
                    >
                      我已处理平台提示，恢复操作
                    </button>
                  )}
                </div>
              )}
              <CollectionBudget platform={p} editable />
              <label className="platform-network">
                <span>网络</span>
                <select
                  aria-label={`${platformNames[p]}网络方式`}
                  value={c?.network || 'system'}
                  disabled={busy === p}
                  onChange={(e) => {
                    setBusy(p);
                    void api(`/platforms/${p}/network`, { mode: e.target.value })
                      .then(() => update())
                      .catch((e) => notify((e as Error).message, true))
                      .finally(() => setBusy(null));
                  }}
                >
                  <option value="system">使用系统代理</option>
                  <option value="direct">独立直连</option>
                </select>
              </label>
              <div className="native-platform-actions">
                <button
                  className="btn small"
                  disabled={busy === p}
                  onClick={() => void showLogin(p, true)}
                >
                  显示{platformNames[p]}扫码页
                </button>
                <button
                  className={`btn ${ready ? '' : 'primary'}`}
                  disabled={busy === p}
                  onClick={() => void open(p)}
                >
                  {busy === p ? (
                    <Busy text="连接中" />
                  ) : (
                    <>
                      <QrCode size={14} />
                      {ready ? '打开平台' : '打开浏览器登录'}
                    </>
                  )}
                </button>
                <button
                  className="icon-btn"
                  title={`检查${platformNames[p]}登录`}
                  disabled={busy === p}
                  onClick={() => void check(p)}
                >
                  <RefreshCw size={15} />
                </button>
                <button
                  className="text-btn"
                  disabled={busy === p}
                  onClick={() => void open(p, true)}
                >
                  创作中心
                  <ExternalLink size={12} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {previewPlatform && (
        <Modal
          title={`${platformNames[previewPlatform]}官方登录页`}
          wide
          sub="这是本机专用浏览器的实时截图。请使用对应 App 扫码并在手机确认。验证码及协议须在官方浏览器中由本人处理。"
          onClose={() => {
            setPreviewPlatform(null);
            setPreviewUrl('');
          }}
        >
          {busy === previewPlatform ? (
            <Busy text="正在读取官方页面" />
          ) : previewUrl ? (
            <img
              src={previewUrl}
              alt={`${platformNames[previewPlatform]}官方扫码登录页面`}
              style={{ width: '100%' }}
            />
          ) : (
            <p>未能读取官方登录页，请刷新或打开官方浏览器查看。</p>
          )}
          <div className="native-platform-actions">
            <button
              className="btn"
              disabled={busy === previewPlatform}
              onClick={() => void showLogin(previewPlatform, true)}
            >
              刷新二维码
            </button>
            <button
              className="btn"
              disabled={busy === previewPlatform}
              onClick={() => void showLogin(previewPlatform)}
            >
              更新截图
            </button>
            <button
              className="btn primary"
              disabled={busy === previewPlatform}
              onClick={() => void check(previewPlatform)}
            >
              我已扫码，检查登录
            </button>
          </div>
        </Modal>
      )}
      <div className="connection-footnote">
        真实采集每次最多100条，批次间隔遵循上方配置；验证、限流和连续失败会暂停。上述数值为本地保守限制，不是平台安全额度，也不能保证账号不受限制。不会自动切换账号重试或批量私信。
        <br />
        长期运营优先申请官方权限：
        <a
          href="https://open.douyin.com/platform/resource/docs/ability/search-management/video/"
          target="_blank"
          rel="noreferrer"
        >
          抖音关键词视频管理
        </a>{' '}
        ·{' '}
        <a href="https://ad.xiaohongshu.com/next_help/home" target="_blank" rel="noreferrer">
          小红书官方客资工具
        </a>
        。关键词、行业资质与使用范围以平台审批为准。
      </div>
    </section>
  );
}
