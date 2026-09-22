import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { CircleCheck, TriangleAlert, X } from 'lucide-react';

type ToastTone = 'success' | 'error' | 'info';

interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
}

const ToastContext = createContext<{ push: (tone: ToastTone, message: string) => void }>({
  push: () => {},
});

export function useToast() {
  return useContext(ToastContext);
}

let seq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);

  const push = useCallback((tone: ToastTone, message: string) => {
    const id = ++seq;
    setItems((prev) => [...prev, { id, tone, message }]);
    window.setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="fixed bottom-4 right-4 z-[1300] flex flex-col gap-2" aria-live="polite">
        {items.map((t) => {
          const Icon = t.tone === 'success' ? CircleCheck : TriangleAlert;
          const color =
            t.tone === 'success' ? 'var(--success)' : t.tone === 'error' ? 'var(--danger)' : 'var(--muted)';
          return (
            <div
              key={t.id}
              role={t.tone === 'error' ? 'alert' : 'status'}
              className="flex items-center gap-2 rounded-md bg-surface px-3 py-2 text-row"
              style={{ border: `1px solid ${color}`, boxShadow: 'var(--shadow-popover)' }}
            >
              <Icon size={16} aria-hidden style={{ color }} />
              <span className="text-fg">{t.message}</span>
              <button
                type="button"
                aria-label="关闭"
                onClick={() => setItems((prev) => prev.filter((x) => x.id !== t.id))}
                className="ml-1 text-meta hover:text-fg transition-colors duration-150 ease-standard"
              >
                <X size={14} aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
