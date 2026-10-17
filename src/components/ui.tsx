import { useEffect, useRef, type ReactNode } from 'react';
import { X, Loader2, Search, ArrowUpRight } from 'lucide-react';
export function Modal({
  title,
  sub,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  sub?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const active = document.activeElement as HTMLElement;
    const el = ref.current;
    el?.focus();
    const handler = (e: KeyboardEvent) => {
      if (Array.from(document.querySelectorAll('[role=dialog]')).at(-1) !== el) return;
      if (e.key === 'Escape') closeRef.current();
      if (e.key === 'Tab' && el) {
        const focusable = Array.from(
          el.querySelectorAll<HTMLElement>(
            'button:not(:disabled),a[href],input,textarea,select,[tabindex="0"]',
          ),
        );
        const first = focusable[0],
          last = focusable.at(-1);
        if (e.shiftKey && (document.activeElement === first || document.activeElement === el)) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', handler);
    const old = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handler);
      document.body.style.overflow = old;
      active?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`modal ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
      >
        <header className="modal-head">
          <div>
            <h2>{title}</h2>
            {sub && <p>{sub}</p>}
          </div>
          <button className="icon-btn" aria-label="关闭" onClick={onClose}>
            <X size={19} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
export function Empty({ title, sub, action }: { title: string; sub: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Search size={28} />
      </div>
      <h3>{title}</h3>
      <p>{sub}</p>
      {action}
    </div>
  );
}
export function Busy({ text = '处理中' }: { text?: string }) {
  return (
    <span className="busy">
      <Loader2 size={16} className="spin" />
      {text}
    </span>
  );
}
export function SourceTag({ source }: { source: 'demo' | 'live' }) {
  return (
    <span className={`source-tag ${source === 'live' ? 'live' : ''}`}>
      {source === 'demo' ? '演示' : '真实'}
    </span>
  );
}
export function PageHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">
          {eyebrow}
          <span />
        </div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action && <div>{action}</div>}
    </div>
  );
}
export function ExternalLink({ url, label }: { url?: string; label: string }) {
  return url && /^https?:\/\//.test(url) ? (
    <a href={url} target="_blank" rel="noreferrer">
      {label}
      <ArrowUpRight size={14} />
    </a>
  ) : (
    <span className="muted">演示内容无原文链接</span>
  );
}
