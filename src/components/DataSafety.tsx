import { useEffect, useState } from 'react';
import { api, clearPendingModelRequests } from '../api';
import { useWorkspace } from '../context';

type Policy = {
  textRequests: number;
  imageRequests: number;
  textTokens: number;
  maxOutputTokens: number;
  dailyCostCents: number;
  inputCentsPerMillion: number;
  outputCentsPerMillion: number;
  imageCents: number;
};
type Budget = {
  policy: Policy;
  day: string;
  usage: { textRequests: number; imageRequests: number; textTokens: number; costCents: number };
};
type Maintenance = {
  backup: {
    enabled: boolean;
    directory: string;
    lastSuccess: string;
    lastError: string;
    stale: boolean;
    running: boolean;
  };
  retentionDays: number;
};
type Cleanup = {
  token: string;
  files: { name: string }[];
  bytes: number;
  generations: string[];
  receipts: string[];
};
type Forget = {
  token: string;
  counts: Record<string, number>;
  managedBackups: number;
  leadId: string;
};
const labels: Record<keyof Policy, string> = {
  textRequests: '每日文字调用上限',
  imageRequests: '每日生图调用上限',
  textTokens: '每日文字 token 预留上限',
  maxOutputTokens: '每次输出 token 上限',
  dailyCostCents: '每日预估费用上限（分）',
  inputCentsPerMillion: '输入费率（分 / 百万 token）',
  outputCentsPerMillion: '输出费率（分 / 百万 token）',
  imageCents: '每张图片最高预估费用（分）',
};
export function DataSafety() {
  const { data, notify, refresh } = useWorkspace();
  const [budget, setBudget] = useState<Budget | null>(null);
  const [maintenance, setMaintenance] = useState<Maintenance | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cleanup, setCleanup] = useState<Cleanup | null>(null);
  const [forget, setForget] = useState<Forget | null>(null);
  const [search, setSearch] = useState('');
  const [leadId, setLeadId] = useState('');
  const [includeBackups, setIncludeBackups] = useState(false);
  async function load() {
    const [b, m] = await Promise.all([
      api<Budget>('/model-budget'),
      api<Maintenance>('/maintenance'),
    ]);
    setBudget(b);
    setMaintenance(m);
  }
  useEffect(() => {
    void load().catch((e) => setError((e as Error).message));
  }, []);
  async function action(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await work();
      await load();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!budget || !maintenance)
    return (
      <section className="panel">
        <h2>数据安全与预算</h2>
        <p>{error || '正在读取设置…'}</p>
        <button className="btn" onClick={() => void action(load)}>
          重新读取
        </button>
      </section>
    );
  return (
    <section className="panel settings-form" aria-label="数据安全与预算">
      <h2>数据安全与预算</h2>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <fieldset disabled={busy} style={{ border: 0, padding: 0 }}>
        <h3>模型预算</h3>
        <p>
          今日（UTC）已预留 {(budget.usage.costCents / 100).toFixed(2)} 元；文字{' '}
          {budget.usage.textRequests} 次，生图 {budget.usage.imageRequests} 次，文字{' '}
          {budget.usage.textTokens} token。
        </p>
        <p className="field-hint">
          按输入字节与最大输出预留预算，超时不返还。费用为人民币估算；请按所有服务中最高费率填写，并在供应商后台设置真实硬额度。联系方式会在文字请求出网前统一脱敏；参考图片仍会发送给所选生图服务。
        </p>
        <div className="form-grid">
          {(Object.keys(labels) as (keyof Policy)[]).map((key) => (
            <label key={key}>
              {labels[key]}
              <input
                type="number"
                min="1"
                value={budget.policy[key]}
                onChange={(e) =>
                  setBudget({
                    ...budget,
                    policy: { ...budget.policy, [key]: Number(e.target.value) },
                  })
                }
              />
            </label>
          ))}
        </div>
        <button
          className="btn"
          onClick={() =>
            void action(async () => {
              await api('/model-budget', budget.policy, 'PUT');
              notify('模型预算已保存');
            })
          }
        >
          保存模型预算
        </button>
        <button
          className="btn"
          onClick={() => {
            if (
              window.confirm('仅在供应商后台核对过结果后继续。允许新建请求可能再次计费，是否继续？')
            ) {
              clearPendingModelRequests();
              notify('已允许下一次手动操作新建请求；已有防重记录仍保留');
            }
          }}
        >
          已核对供应商，允许新建请求
        </button>
        <h3>自动备份</h3>
        <p>
          {maintenance.backup.stale ? '备份缺失或已超过26小时' : '备份正常'} · 最近成功：
          {maintenance.backup.lastSuccess
            ? new Date(maintenance.backup.lastSuccess).toLocaleString()
            : '尚无'}
        </p>
        {maintenance.backup.lastError && (
          <p className="inline-error">{maintenance.backup.lastError}</p>
        )}
        <label>
          <input
            type="checkbox"
            checked={maintenance.backup.enabled}
            onChange={(e) =>
              setMaintenance({
                ...maintenance,
                backup: { ...maintenance.backup, enabled: e.target.checked },
              })
            }
          />{' '}
          应用运行时每日自动备份，保留最近7份
        </label>
        <label>
          备份目录
          <input
            value={maintenance.backup.directory}
            onChange={(e) =>
              setMaintenance({
                ...maintenance,
                backup: { ...maintenance.backup, directory: e.target.value },
              })
            }
          />
        </label>
        <p className="field-hint">
          默认副本在同一块磁盘，无法防止整盘损坏。可指定外部磁盘目录；应用关闭时不会执行定时备份。副本包含凭证密钥，请保护访问权限。
        </p>
        <label>
          无引用素材与生成历史保留天数
          <input
            type="number"
            min="1"
            max="3650"
            value={maintenance.retentionDays}
            onChange={(e) => {
              setMaintenance({ ...maintenance, retentionDays: Number(e.target.value) });
              setCleanup(null);
            }}
          />
        </label>
        <button
          className="btn"
          onClick={() =>
            void action(async () => {
              await api(
                '/maintenance',
                {
                  backup: {
                    enabled: maintenance.backup.enabled,
                    directory: maintenance.backup.directory,
                  },
                  retentionDays: maintenance.retentionDays,
                },
                'PUT',
              );
              notify('备份与保留规则已保存');
            })
          }
        >
          保存备份与保留规则
        </button>
        <button
          className="btn"
          onClick={() =>
            void action(async () => {
              await api('/maintenance/backup', {});
              notify('备份已完成并校验');
            })
          }
        >
          立即备份
        </button>
        <h3>素材清理</h3>
        <p className="field-hint">
          仅清理超过保留期的无引用素材及过期生成记录；正在使用的草稿素材保留。先保存规则再预览。
        </p>
        <button
          className="btn"
          onClick={() =>
            void action(async () => setCleanup(await api<Cleanup>('/maintenance/cleanup', {})))
          }
        >
          预览可清理素材
        </button>
        {cleanup && (
          <p>
            可清理 {cleanup.files.length} 个文件（{(cleanup.bytes / 1048576).toFixed(1)} MB）、
            {cleanup.generations.length} 条生成记录、{cleanup.receipts.length} 条过期模型回执。
            <button
              className="btn"
              onClick={() => {
                if (
                  window.confirm(
                    '确认永久删除预览中的无引用素材、过期生成记录及模型回执？旧请求的防重标记会继续保留。',
                  )
                )
                  void action(async () => {
                    await api('/maintenance/cleanup', { confirm: true, token: cleanup.token });
                    setCleanup(null);
                    notify('素材清理完成');
                  });
              }}
            >
              确认清理
            </button>
          </p>
        )}
        <h3>清除客户资料</h3>
        <p className="field-hint">
          按平台与客户标识清除关联评论、线索、沟通、模型记录及依赖的任务历史。不会替你清除第三方平台、外部备份或已导出文件；重新采集也可能再次导入。
        </p>
        <label>
          查找客户
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="姓名或线索 ID（最多显示50项）"
          />
        </label>
        <select
          aria-label="要清除资料的客户"
          value={leadId}
          onChange={(e) => {
            setLeadId(e.target.value);
            setForget(null);
          }}
        >
          <option value="">请选择客户</option>
          {data.leads
            .filter((l) => (l.name + l.id).includes(search))
            .slice(0, 50)
            .map((l) => (
              <option key={l.id} value={l.id}>
                {l.name} · {l.platform} · {l.id}
              </option>
            ))}
        </select>
        <button
          className="btn"
          disabled={!leadId}
          onClick={() =>
            void action(async () => setForget(await api<Forget>('/maintenance/forget', { leadId })))
          }
        >
          预览资料清除范围
        </button>
        {forget && (
          <div>
            <p>
              关联记录：{JSON.stringify(forget.counts)}；本应用管理的备份 {forget.managedBackups}{' '}
              份。
            </p>
            <label>
              <input
                type="checkbox"
                checked={includeBackups}
                onChange={(e) => setIncludeBackups(e.target.checked)}
              />{' '}
              同时删除本应用在当前备份目录管理的全部备份；其他副本需另行处理
            </label>
            <button
              className="btn"
              onClick={() => {
                if (
                  window.confirm(
                    '确认永久清除预览中的客户资料及关联任务历史？' +
                      (includeBackups ? '也会删除全部受管备份。' : '旧备份仍可能含这些资料。'),
                  )
                )
                  void action(async () => {
                    await api('/maintenance/forget', {
                      leadId: forget.leadId,
                      token: forget.token,
                      confirm: true,
                      includeBackups,
                    });
                    setForget(null);
                    setLeadId('');
                    notify('关联资料清除完成；请另行处理外部副本');
                  });
              }}
            >
              确认清除客户资料
            </button>
          </div>
        )}
      </fieldset>
    </section>
  );
}

export function SafetyNotice() {
  const { navigate } = useWorkspace();
  const [message, setMessage] = useState('');
  useEffect(() => {
    let disposed = false,
      pending = false;
    const update = async () => {
      if (pending || document.hidden) return;
      pending = true;
      try {
        const [budget, maintenance] = await Promise.all([
          api<Budget>('/model-budget'),
          api<Maintenance>('/maintenance'),
        ]);
        const nearLimit =
          budget.usage.costCents >= budget.policy.dailyCostCents * 0.8 ||
          budget.usage.textRequests >= budget.policy.textRequests * 0.8 ||
          budget.usage.imageRequests >= budget.policy.imageRequests * 0.8 ||
          budget.usage.textTokens >= budget.policy.textTokens * 0.8;
        if (!disposed)
          setMessage(
            [
              nearLimit ? '今日模型预算已预留80%以上，请核对用量。' : '',
              maintenance.backup.enabled && maintenance.backup.stale
                ? '自动备份缺失或超过26小时，请检查备份目录与状态。'
                : '',
            ]
              .filter(Boolean)
              .join(' '),
          );
      } catch {
        /* Connection errors are already displayed by the workspace. */
      } finally {
        pending = false;
      }
    };
    void update();
    const timer = setInterval(() => void update(), 30000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);
  return message ? (
    <aside className="field-hint" aria-label="数据安全提醒" aria-live="polite">
      {message}{' '}
      <button className="text-btn" onClick={() => navigate('settings')}>
        查看数据安全与预算
      </button>
    </aside>
  ) : null;
}
