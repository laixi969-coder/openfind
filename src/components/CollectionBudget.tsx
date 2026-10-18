import { useEffect, useState } from 'react';
import type { CollectionPolicy, Platform, ProtectionView } from '../../shared/types';
import { api } from '../api';
import { useWorkspace } from '../context';

const names = { xiaohongshu: '小红书', douyin: '抖音' };
const time = (value: number) => new Date(value).toLocaleString('zh-CN', { hour12: false });
export function CollectionBudget({
  platform,
  editable = false,
}: {
  platform: Platform;
  editable?: boolean;
}) {
  const { notify } = useWorkspace();
  const [status, setStatus] = useState<ProtectionView | null>(null);
  const [draft, setDraft] = useState<CollectionPolicy | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let alive = true;
    setStatus(null);
    setDraft(null);
    async function update() {
      try {
        const data = await api<{ platforms: Record<Platform, ProtectionView> }>('/protection');
        if (alive) {
          setStatus(data.platforms[platform]);
          setError('');
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    }
    void update();
    const timer = window.setInterval(() => void update(), 2000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [platform]);
  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      setStatus(await api<ProtectionView>(`/protection/${platform}`, draft, 'PUT'));
      setDraft(null);
      notify('采集配置已保存，已用额度与保护暂停保持不变');
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setSaving(false);
    }
  }
  const policy = draft || status?.policy;
  return (
    <section className="collection-budget" aria-label={`${names[platform]}采集额度`}>
      <h3>{names[platform]} · 本地采集额度</h3>
      {error && <p className="inline-error">额度读取失败：{error}</p>}
      {!status || !policy ? (
        <p>正在读取额度…</p>
      ) : (
        <>
          <p className="field-hint">
            按请求批次计数，翻页也占用额度；缓存命中不扣减。每日 UTC 00:00 重置，下次：
            {time(status.resetAt)}（本机时间）。
          </p>
          <div className="budget-grid">
            {(['search', 'comments'] as const).map((action) => {
              const label = action === 'search' ? '搜索' : '评论采集';
              const budget = status.budgets[action];
              return (
                <div key={action}>
                  <b>
                    {label}：剩余 {budget.remaining} / {status.policy[action].dailyLimit} 批
                  </b>
                  <p>
                    今日已用 {status.counts[action]} 批 · 间隔{' '}
                    {status.policy[action].intervalMs / 1000} 秒
                  </p>
                  <p>
                    {budget.availableAt === null
                      ? '需完成平台验证或处理异常后手动恢复'
                      : budget.availableAt > Date.now()
                        ? `可再次请求：${time(budget.availableAt)}`
                        : '现在可请求'}
                  </p>
                  {editable && (
                    <div className="field-row">
                      <label>
                        每日批次数
                        <input
                          aria-label={`${names[platform]}${label}每日批次数`}
                          type="number"
                          min={1}
                          max={10000}
                          step={1}
                          required
                          value={policy[action].dailyLimit}
                          onChange={(e) =>
                            setDraft({
                              ...policy,
                              [action]: { ...policy[action], dailyLimit: Number(e.target.value) },
                            })
                          }
                        />
                      </label>
                      <label>
                        间隔（秒）
                        <input
                          aria-label={`${names[platform]}${label}间隔秒数`}
                          type="number"
                          min={1}
                          max={3600}
                          step={1}
                          required
                          value={policy[action].intervalMs / 1000}
                          onChange={(e) =>
                            setDraft({
                              ...policy,
                              [action]: {
                                ...policy[action],
                                intervalMs: Number(e.target.value) * 1000,
                              },
                            })
                          }
                        />
                      </label>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {status.paused && (
            <p className="inline-error">
              保护暂停：{status.reason}。额度重置或修改配置不会解除暂停。
            </p>
          )}
          {editable && (
            <>
              <p className="field-hint">
                默认搜索、评论各 100 批/天、15
                秒。间隔按同平台上一次采集请求计算；单任务可设置更长间隔。额度 1–10000，间隔 1–3600
                秒。这是本地控制，不是平台许可或安全保证。
              </p>
              <button className="btn" disabled={!draft || saving} onClick={() => void save()}>
                {saving ? '保存中…' : `保存${names[platform]}采集配置`}
              </button>
            </>
          )}
        </>
      )}
    </section>
  );
}
