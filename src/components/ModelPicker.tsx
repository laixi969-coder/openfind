import { useState } from 'react';
import type { ModelOption } from '../../shared/types';

// 模型选择：默认是带三角的下拉列表，最后一项目是手动输入；
// 服务 /models 没有列出、或想用列表外的型号时走手动输入。
export function ModelPicker({
  label,
  ariaLabel,
  value,
  options,
  onChange,
}: {
  label: string;
  ariaLabel: string;
  value: string;
  options: ModelOption[];
  onChange: (id: string) => void;
}) {
  const [manual, setManual] = useState(false);
  const known = options.some((m) => m.id === value);
  if (manual)
    return (
      <label>
        {label}
        <div className="model-manual">
          <input
            aria-label={ariaLabel}
            value={value}
            placeholder="输入模型 ID，如 deepseek-chat"
            onChange={(e) => onChange(e.target.value)}
          />
          <button type="button" className="text-btn" onClick={() => setManual(false)}>
            从列表选择
          </button>
        </div>
      </label>
    );
  return (
    <label>
      {label}
      <select
        aria-label={ariaLabel}
        className="model-select"
        value={known ? value : value ? '__current' : ''}
        onChange={(e) => {
          const next = e.target.value;
          if (next === '__manual') setManual(true);
          else if (next !== '__current' && next !== '') onChange(next);
        }}
      >
        {!value && <option value="">选择模型</option>}
        {value && !known && <option value="__current">{value}（未入库）</option>}
        {options.map((m) => (
          <option key={m.id} value={m.id}>
            {m.id}
            {m.custom ? ' · 自定义' : ''}
          </option>
        ))}
        <option value="__manual">＋ 手动输入新模型…</option>
      </select>
    </label>
  );
}
