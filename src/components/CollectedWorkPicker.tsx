import { useMemo, useState } from 'react';
import type { Platform } from '../../shared/types';
import { collectionTopics } from '../../shared/collection-groups';
import { useWorkspace } from '../context';

export function CollectedWorkPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string) => void;
}) {
  const { data } = useWorkspace();
  const current = data.notes.find((n) => n.id === value);
  const [platform, setPlatform] = useState<Platform>(
    current?.platform || data.settings.platform || 'xiaohongshu',
  );
  const [source, setSource] = useState(current?.source || data.settings.mode);
  const [topic, setTopic] = useState('');
  const [query, setQuery] = useState('');
  const topics = useMemo(
    () => collectionTopics(data.notes, data.jobs, data.workflows),
    [data.notes, data.jobs, data.workflows],
  );
  const scoped = data.notes.filter((n) => n.platform === platform && n.source === source);
  const categories = [...new Set(scoped.flatMap((n) => [...topics.get(n.id)!]))].sort((a, b) =>
    a.localeCompare(b, 'zh-CN'),
  );
  const filtered = scoped.filter(
    (n) =>
      (!topic || topics.get(n.id)?.has(topic)) &&
      (!query.trim() ||
        [n.title, n.author, n.id, ...n.tags]
          .join(' ')
          .toLowerCase()
          .includes(query.trim().toLowerCase())),
  );
  const groups = new Map<string, typeof filtered>();
  for (const n of filtered) {
    const label = topic || [...topics.get(n.id)!].sort((a, b) => a.localeCompare(b, 'zh-CN'))[0];
    groups.set(label, [...(groups.get(label) || []), n]);
  }
  function reset() {
    setTopic('');
    onChange('');
  }
  return (
    <div className="collected-work-picker">
      <div className="field-row">
        <label>
          作品平台
          <select
            aria-label="作品平台"
            value={platform}
            onChange={(e) => {
              setPlatform(e.target.value as Platform);
              reset();
            }}
          >
            <option value="xiaohongshu">小红书</option>
            <option value="douyin">抖音</option>
          </select>
        </label>
        <label>
          数据来源
          <select
            aria-label="作品数据来源"
            value={source}
            onChange={(e) => {
              setSource(e.target.value as typeof source);
              reset();
            }}
          >
            <option value="live">真实采集</option>
            <option value="demo">演示数据</option>
          </select>
        </label>
      </div>
      <label>
        采集主题
        <select
          aria-label="采集主题"
          value={topic}
          onChange={(e) => {
            setTopic(e.target.value);
            onChange('');
          }}
        >
          <option value="">全部主题（{scoped.length}）</option>
          {categories.map((t) => (
            <option value={t} key={t}>
              {t}（{scoped.filter((n) => topics.get(n.id)?.has(t)).length}）
            </option>
          ))}
        </select>
      </label>
      <label>
        搜索已采集作品
        <input
          aria-label="搜索已采集作品"
          placeholder="标题、作者、标签或作品 ID"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <label htmlFor="comment-note">目标作品 · {filtered.length} 篇</label>
      <select id="comment-note" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">请选择作品</option>
        {current && !filtered.some((n) => n.id === value) && (
          <option value={value}>当前选择：{current.title.slice(0, 48)}</option>
        )}
        {[...groups]
          .sort(([a], [b]) => a.localeCompare(b, 'zh-CN'))
          .map(([label, notes]) => (
            <optgroup key={label} label={`${label} · ${notes.length} 篇`}>
              {notes.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.title.length > 48 ? n.title.slice(0, 48) + '…' : n.title} · {n.author}
                </option>
              ))}
            </optgroup>
          ))}
      </select>
      {!filtered.length && (
        <p className="field-hint">当前分类没有匹配作品，可切换主题或清空搜索。</p>
      )}
      {current && <p className="field-hint">已选：{current.title}</p>}
    </div>
  );
}
