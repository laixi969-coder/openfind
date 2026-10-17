import { useState } from 'react';
import { UserPlus, Eye, EyeOff, ShieldCheck } from 'lucide-react';
import type { Account, Platform } from '../../shared/types';
import { api } from '../api';
import { useWorkspace } from '../context';
import { Modal, Busy } from './ui';
export function AccountForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated?: (a: Account) => void;
}) {
  const { refresh, notify } = useWorkspace();
  const [platform, setPlatform] = useState<Platform>('xiaohongshu');
  const [name, setName] = useState(''),
    [id, setId] = useState(''),
    [cookie, setCookie] = useState(''),
    [remember, setRemember] = useState(false),
    [show, setShow] = useState(false),
    [busy, setBusy] = useState(false);
  async function add() {
    setBusy(true);
    try {
      const a = await api<Account>('/accounts', {
        id,
        name,
        cookie,
        platform,
        rememberCookie: remember,
      });
      await refresh();
      notify('发布账号已添加');
      onCreated?.(a);
      onClose();
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="添加发布账号" sub="为你的内容选择合适的发布身份" onClose={onClose}>
      <form
        className="modal-body"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <label className="field-label" htmlFor="new-account-platform">
          平台
        </label>
        <select
          id="new-account-platform"
          value={platform}
          onChange={(e) => setPlatform(e.target.value as Platform)}
        >
          <option value="xiaohongshu">小红书</option>
          <option value="douyin">抖音</option>
        </select>
        <p className="field-hint">扫码登录的账号会自动添加。此表单用于高级数据服务账号。</p>
        <label className="field-label" htmlFor="new-account-name">
          账号名称
        </label>
        <input
          id="new-account-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例如：品牌官方账号"
          maxLength={60}
          required
        />
        <label className="field-label" htmlFor="new-account-id">
          平台账号 ID
        </label>
        <input
          id="new-account-id"
          value={id}
          onChange={(e) => setId(e.target.value)}
          placeholder="与真实数据服务中的账号 ID 一致"
          maxLength={100}
          required
        />
        <label className="field-label" htmlFor="new-account-cookie">
          Cookie{' '}
          <button type="button" className="text-btn" onClick={() => setShow((v) => !v)}>
            {show ? <EyeOff size={13} /> : <Eye size={13} />} {show ? '隐藏' : '显示'}
          </button>
        </label>
        <textarea
          id="new-account-cookie"
          className={show ? '' : 'masked'}
          rows={4}
          value={cookie}
          onChange={(e) => setCookie(e.target.value)}
          placeholder="填写该账号的登录 Cookie（演示可留空）"
          autoComplete="off"
        />
        <label className="checkbox-line">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          加密保存到本机，下次自动读取
        </label>
        <div className="publish-status">
          <ShieldCheck size={16} />
          <div>
            <b>每个账号的凭证独立保存</b>
            <p>发布时会再次检查服务当前账号与所选账号是否一致。</p>
          </div>
        </div>
        <div className="modal-action-row">
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={busy || !name.trim() || !id.trim()}>
            {busy ? (
              <Busy />
            ) : (
              <>
                <UserPlus size={14} />
                添加账号
              </>
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}
