import type { ReactNode } from 'react';
import { Inbox, TriangleAlert, RotateCw, LoaderCircle } from 'lucide-react';
import { Button } from './ui';
import { humaniseError } from '../lib/api';

/**
 * 列表三态：loading / empty / error。
 * UIUX.md §8 的组件状态矩阵 + §2 参考表（Height / Plane）：骨架屏列宽行高与真实数据一致；
 * 错误不整页报错；空态必须给出**下一步**，通常是一个 CTA，但系统里确实没有可去的地方时
 * 说明文案就是下一步 —— 因此 `emptyCta` 是**可选**的，不要为了凑一个按钮而指向不存在的页面。
 */

export function SkeletonRows({ rows = 4, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div role="status" aria-label="加载中" className="divide-y divide-border">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-4 px-4 h-9">
          {Array.from({ length: cols }).map((__, c) => (
            <div
              key={c}
              className="h-2.5 rounded-sm bg-surface-sunken animate-pulse"
              style={{ width: c === 1 ? '38%' : '18%' }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export function EmptyState({
  message,
  ctaLabel,
  onCta,
}: {
  message: string;
  /** 可选 —— 没有可去的地方时不给，这个空态就只留说明文案（见文件头对 UIUX.md §2 的引用） */
  ctaLabel?: string;
  onCta?: () => void;
}) {
  return (
    <div className="flex flex-col items-start gap-3 px-4 py-8">
      <div className="flex items-center gap-2 text-muted">
        <Inbox size={24} strokeWidth={1.75} aria-hidden />
        <p className="text-body">{message}</p>
      </div>
      {onCta && ctaLabel && (
        <Button variant="secondary" size="sm" onClick={onCta}>
          {ctaLabel}
        </Button>
      )}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 px-4 py-3 bg-danger-bg border-y border-danger"
    >
      <span className="flex items-center gap-2 text-row text-danger">
        <TriangleAlert size={16} aria-hidden />
        {humaniseError(error)}
      </span>
      {onRetry && (
        <Button variant="ghost" size="sm" onClick={onRetry}>
          <RotateCw size={14} aria-hidden />
          重试
        </Button>
      )}
    </div>
  );
}

export function InlineSpinner({ label = '加载中' }: { label?: string }) {
  return (
    <span role="status" className="inline-flex items-center gap-1.5 text-meta text-muted">
      <LoaderCircle size={12} className="animate-spin" aria-hidden />
      {label}
    </span>
  );
}

/** 把 loading/empty/error/populated 四态收成一个容器，页面里不再散写。 */
export function ListState({
  loading,
  error,
  isEmpty,
  emptyMessage,
  emptyCta,
  onEmptyCta,
  onRetry,
  rows = 4,
  cols = 4,
  children,
}: {
  loading: boolean;
  error: unknown;
  isEmpty: boolean;
  emptyMessage: string;
  /**
   * 空态的下一步动作文案。**可选**：系统里确实没有可去的地方时不给，这一屏就只留
   * emptyMessage（见文件头 —— 不要为了凑一个按钮而指向不存在的页面）。
   */
  emptyCta?: string;
  onEmptyCta?: () => void;
  onRetry?: () => void;
  rows?: number;
  cols?: number;
  children: ReactNode;
}) {
  if (loading) return <SkeletonRows rows={rows} cols={cols} />;
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  if (isEmpty) return <EmptyState message={emptyMessage} ctaLabel={emptyCta} onCta={onEmptyCta} />;
  return <>{children}</>;
}
