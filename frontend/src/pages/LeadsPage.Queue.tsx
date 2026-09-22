/**
 * ⚠️ 本组件**当前未被引用** —— /leads 右栏（48h 跟进队列）已隐藏（2026-09-22 用户裁定）。
 * 理由与完整的恢复清单写在 LeadsPage.tsx 的文件头注释里；一句话版本：右栏在的时候
 * 它同时是「浏览全部跟进」的唯一去处，而那个面板被读成了噪音，所以先撤下来。
 * 文件整份保留是为了随时恢复 —— 恢复时记得同时还原 LeadsPage.tsx 里被删掉的
 * queue* 状态、QUEUE_PAGE_SIZE、loadQueue/refreshQueue/changeQueueFilter 与容器 grid 类。
 * 能力没有消失：POST /follow-ups/:id/complete 仍在，入口在学生抽屉的转化卡上
 * （LeadsPage.Playbook.tsx:125）。
 *
 * 48h 跟进队列（R2 的下游）。
 *
 * 逾期与否**由服务端过滤**（`?status=overdue` 走 SQL 的 due_at < now），文案用服务端
 * 算好的逾期小时数；slaCountdown 只负责进度条几何，不参与「是否进这个队列」的判断 ——
 * 否则页面与服务端会在临界点互相矛盾。排序也是服务端保证的（due_at 升序）。
 */
import { useState } from 'react';
import { CircleCheck, Phone } from 'lucide-react';
import { Button, Pager, chipStateClass } from '../components/ui';
import { ListState } from '../components/StateViews';
import { dateTime } from '../lib/format';
import { FollowUpStatus } from './LeadsPage.Shared';
import type { FollowUpListRow } from './LeadsPage.Shared';

export type QueueFilter = 'pending' | 'overdue' | 'done';

const FILTERS: { key: QueueFilter; label: string }[] = [
  { key: 'pending', label: '待处理' },
  { key: 'overdue', label: '逾期' },
  { key: 'done', label: '已完成' },
];

export default function LeadsQueue({
  items,
  loading,
  error,
  onRetry,
  onComplete,
  filter,
  onFilter,
  highlightId,
  total,
  page,
  hasMore,
  onPageChange,
}: {
  items: FollowUpListRow[];
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  onComplete: (id: number) => Promise<void>;
  filter: QueueFilter;
  onFilter: (next: QueueFilter) => void;
  highlightId: number | null;
  total: number;
  page: number;
  hasMore: boolean;
  onPageChange: (next: number) => void;
}) {
  const [busyId, setBusyId] = useState<number | null>(null);

  async function complete(id: number) {
    setBusyId(id);
    try {
      await onComplete(id);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1 px-4 h-9 border-b border-border bg-surface-sunken">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => onFilter(f.key)}
            aria-pressed={filter === f.key}
            className={`h-6 rounded-sm px-2 text-meta font-510 transition-colors duration-150 ease-standard ${chipStateClass(
              filter === f.key,
            )}`}
          >
            {f.label}
          </button>
        ))}
        <span className="ml-auto num text-meta text-muted">{items.length}</span>
      </div>

      <ListState
        loading={loading}
        error={error}
        isEmpty={items.length === 0}
        emptyMessage={
          filter === 'overdue'
            ? '没有逾期项。所有试听跟进都在 48 小时窗口内。'
            : filter === 'done'
              ? '暂无已关闭的跟进。'
              : '暂无待处理跟进。记录试听结果会在同一事务中生成一条。'
        }
        emptyCta={filter === 'pending' ? '查看逾期' : '查看待处理'}
        onEmptyCta={() => onFilter(filter === 'pending' ? 'overdue' : 'pending')}
        onRetry={onRetry}
        rows={4}
        cols={3}
      >
        <div className="divide-y divide-border">
          {items.map((item) => {
            // 已知取舍：队列按 due_at 升序，新生成的跟进落在**末页**，所以刚记完结果时
            // 这条高亮基本看不到（分页之前它就在第一屏）。这是既有排序行为的延续 ——
            // 不为它改排序、也不强行跳页，真要看到就翻到末页。
            const isNew = highlightId === item.id;
            const done = item.status === 'done';
            return (
              <div
                key={item.id}
                className={`px-4 py-2 flex items-start justify-between gap-3 transition-colors duration-200 ease-standard hover:bg-row-hover ${
                  isNew ? 'bg-accent-bg border-l-2 border-accent' : 'border-l-2 border-transparent'
                }`}
              >
                <div className="min-w-0 flex flex-col gap-1">
                  <span className="flex items-center gap-2 text-row font-510 text-fg truncate">
                    {item.student_name ?? `学生 #${item.student_id}`}
                    {isNew && <span className="text-meta font-510 text-accent">新建</span>}
                  </span>
                  <span className="num text-meta text-muted">到期 {dateTime(item.due_at)}</span>
                  <FollowUpStatus item={item} />
                </div>
                {done ? (
                  <span className="num shrink-0 text-meta text-muted">
                    {item.completed_at ? dateTime(item.completed_at) : '已关闭'}
                  </span>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={busyId === item.id}
                    disabled={busyId !== null}
                    onClick={() => void complete(item.id)}
                  >
                    <CircleCheck size={16} aria-hidden />
                    标记为已跟进
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      </ListState>

      {/* 分页器只属于「有数据」这一态：加载中 / 空 / 报错都由 ListState 承担，不该出现翻页。 */}
      {!loading && !error && (
        <Pager page={page} total={total} shown={items.length} hasMore={hasMore} onPage={onPageChange} />
      )}

      <p className="flex items-center gap-1.5 px-4 py-2 border-t border-border text-meta text-muted">
        <Phone size={16} aria-hidden />
        窗口在试听结果记录后 48 小时关闭。
      </p>
    </div>
  );
}
