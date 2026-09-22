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

/* ── Segmented chip ──────────────────────────────────────────────────────────
   分段筛选胶囊的**选中/未选中**两个状态。学生页的四个视图、线索页的队列筛选、
   试听的结果筛选共用同一份，避免第三次抄写出偏差（此前三处已经是 h-7/px-2.5
   和 h-6/px-2 两种规格）。

   选中态用**实心 accent 填充**而不是 7% 的 accent-bg：这是个强状态——一屏里只有
   一个是真——7% 的底色在白底上几乎看不出来，要「眯眼找」。实心填充把它变成
   一眼可见，代价只是那一小块面积。

   选中的那一个**不响应 hover**：它已经在目的地了，再给出「会变」的暗示是反的；
   未选中的响应 hover，才是在邀请切换。                                            */

export function chipStateClass(active: boolean): string {
  return active
    ? 'bg-accent text-accent-on font-510 shadow-sm'
    : 'text-muted hover:bg-row-hover hover:text-fg';
}

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

/* ── Pager ───────────────────────────────────────────────────────────────────
   服务端分页的翻页条。范式取自学生页（`第 N 页 · 显示 X / Y 条` + 上一页/下一页），
   抽出来是因为线索页的试听表与线索表都要用 —— 抄第二遍就会开始走样。

   total 为 0 时返回 null：那是空态，翻页没有意义。loading / error 两态由调用方拦
   （只有它知道自己处在哪一态），所以这里只看 total。

   紧凑尺寸保留至今（`/leads` 右栏那个 400px 的队列面板已在 2026-09-22 撤下，但它不是
   尺寸的唯一来源）：文案用 text-meta + size="sm"，并允许 flex-wrap —— 窄容器下才能
   不把「下一页」挤出可视区，而这是列表通用件，宽窄两种上下文都要能用。          */

export function Pager({
  page,
  total,
  shown,
  hasMore,
  onPage,
}: {
  page: number;
  total: number;
  shown: number;
  hasMore: boolean;
  onPage: (next: number) => void;
}) {
  if (total <= 0) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 border-t border-border">
      <span className="num text-meta text-muted">
        第 {page} 页 · 显示 {shown} / {total} 条
      </span>
      <span className="flex items-center gap-1.5">
        <Button size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          上一页
        </Button>
        <Button size="sm" disabled={!hasMore} onClick={() => onPage(page + 1)}>
          下一页
        </Button>
      </span>
    </div>
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
