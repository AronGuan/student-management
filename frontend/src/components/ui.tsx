import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { LoaderCircle } from 'lucide-react';

/* ── Button ──────────────────────────────────────────────────────────────────
   variant: primary(强调，每屏 ≤2 处) · secondary(描边) · ghost(次级/重试) · danger
   高度 32px（行内）/ 44px（size="touch"，家长端与移动端）                      */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'touch';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-on border border-accent hover:bg-accent-hover active:bg-accent-active',
  secondary: 'bg-surface text-fg border border-border-strong hover:bg-row-hover',
  ghost: 'bg-transparent text-muted border border-transparent hover:bg-row-hover hover:text-fg',
  danger: 'bg-surface text-danger border border-danger hover:bg-danger-bg',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-[26px] px-2 gap-1.5',
  md: 'h-8 px-3 gap-2',
  touch: 'h-11 px-4 gap-2',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading = false, className = '', children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled || loading}
      className={[
        'inline-flex items-center justify-center rounded-md text-row font-510',
        'transition-colors duration-150 ease-standard',
        'disabled:opacity-45 disabled:cursor-not-allowed',
        VARIANTS[variant],
        SIZES[size],
        className,
      ].join(' ')}
      {...rest}
    >
      {loading && <LoaderCircle size={14} className="animate-spin" aria-hidden />}
      {children}
    </button>
  );
});

/* ── Surfaces ───────────────────────────────────────────────────────────── */

export function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <section
      className={`rounded-lg border border-border bg-surface overflow-hidden ${className}`}
    >
      {children}
    </section>
  );
}

export function PanelHeader({
  title,
  count,
  icon,
  action,
}: {
  title: string;
  count?: number;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <header className="flex items-center justify-between gap-3 h-10 px-4 border-b border-border bg-surface-sunken">
      <h2 className="flex items-center gap-2 section-title text-fg">
        {icon}
        <span>{title}</span>
        {count !== undefined && <span className="num text-meta text-muted font-400">{count}</span>}
      </h2>
      {action}
    </header>
  );
}

/* ── Form primitives ────────────────────────────────────────────────────── */

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className = '', ...rest }, ref) {
    return (
      <input
        ref={ref}
        className={[
          'h-8 w-full rounded-md border border-border-strong bg-surface px-2',
          'text-row text-fg placeholder:text-meta',
          'transition-colors duration-150 ease-standard',
          'disabled:bg-surface-sunken disabled:text-meta',
          className,
        ].join(' ')}
        {...rest}
      />
    );
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className = '', children, ...rest }, ref) {
    return (
      <select
        ref={ref}
        className={[
          'h-8 rounded-md border border-border-strong bg-surface pl-2 pr-6',
          'text-row text-fg',
          'transition-colors duration-150 ease-standard',
          className,
        ].join(' ')}
        {...rest}
      >
        {children}
      </select>
    );
  },
);

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="col-header">{label}</span>
      {children}
      {hint && <span className="text-meta text-muted">{hint}</span>}
    </label>
  );
}

/* ── Misc ───────────────────────────────────────────────────────────────── */

export function KeyValue({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <span className="text-meta text-muted shrink-0">{k}</span>
      <span className="text-row text-fg text-right">{v}</span>
    </div>
  );
}

export function Divider() {
  return <div className="h-px bg-border" />;
}

export function Mono({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`num ${className}`}>{children}</span>;
}
