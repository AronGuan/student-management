import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';

/** 右侧抽屉。200ms 进出，Esc 关闭，焦点陷阱简化实现（进入时聚焦容器）。 */
export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  width = 520,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  width?: number;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    panelRef.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[1100] flex justify-end" role="dialog" aria-modal="true" aria-label={title}>
      <div
        className="absolute inset-0 transition-opacity duration-200 ease-standard"
        style={{ backgroundColor: 'rgba(0,0,0,0.18)' }}
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        className="relative h-full bg-surface border-l border-border flex flex-col outline-none"
        style={{ width, maxWidth: '100vw', boxShadow: 'var(--shadow-popover)' }}
      >
        <header className="flex items-start justify-between gap-3 px-4 py-3 border-b border-border bg-surface-sunken">
          <div className="min-w-0">
            <h2 className="section-title text-fg truncate">{title}</h2>
            {subtitle && <p className="text-meta text-muted truncate">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭面板"
            className="shrink-0 p-1 rounded-md text-muted hover:bg-row-hover hover:text-fg transition-colors duration-150 ease-standard"
          >
            <X size={20} aria-hidden />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-4">{children}</div>

        {footer && <div className="border-t border-border px-4 py-3 bg-surface-sunken">{footer}</div>}
      </div>
    </div>
  );
}
