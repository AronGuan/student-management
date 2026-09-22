/**
 * ClassesPage 的容量条。
 *
 * 类型不在这里另立：GET /classes 用 ../lib/types 的 ClassItem，名册用 ClassMember，
 * 两者都已按 model.go 对齐（ClassItem 的 subject_name / teacher_name / enrolled 带 omitempty，
 * 所以是可选键而不是 null；room 是真实列；没有 start_clock/end_clock 那两个钟点）。
 *
 * weekday 的约定是 1=周一 … 7=周日（种子数据与 lessons.weekday 一致），显示时用
 * `weekday % 7` 喂给 format.weekdayShort —— 它按 0=周日 索引。
 */
import { TriangleAlert } from 'lucide-react';

/**
 * 容量：条 + 数字 + 文字/图标三条通道（UIUX §4.0）。
 * 满了用 triangle-alert + "Full"，不用更红的颜色顶替语义。
 */
export function SeatsCell({ enrolled, capacity }: { enrolled: number; capacity: number }) {
  const full = capacity > 0 && enrolled >= capacity;
  const almost = !full && capacity > 0 && enrolled >= capacity - 1;
  const pct = capacity > 0 ? Math.min(1, Math.max(0, enrolled / capacity)) : 0;
  const fill = full ? 'bg-danger' : almost ? 'bg-warn' : 'bg-accent';

  return (
    <span className="inline-flex items-center gap-2">
      <span
        className="inline-block h-1.5 w-[56px] shrink-0 rounded-full overflow-hidden"
        style={{ backgroundColor: 'var(--credit-track)' }}
        aria-hidden
      >
        <span className={`block h-full ${fill}`} style={{ width: `${pct * 100}%` }} />
      </span>
      <span className="num text-row">
        {enrolled} / {capacity}
      </span>
      {full ? (
        <span className="inline-flex items-center gap-1 text-meta font-510 text-danger">
          <TriangleAlert size={16} aria-hidden />
          已满
        </span>
      ) : (
        <span className="text-meta text-muted">
          剩余 {capacity - enrolled} 个名额
        </span>
      )}
    </span>
  );
}
