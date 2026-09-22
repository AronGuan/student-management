import {
  CircleCheck,
  Clock,
  CalendarX,
  CalendarClock,
  X,
  CircleDashed,
  Check,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { AttendanceStatus } from '../lib/types';

/**
 * 出勤 6 态 —— 三通道冗余编码：颜色 + 图标形状 + 文本。
 * UIUX.md §4.2 / §7.0 置换表。去掉任意一通道后仍可读（灰度验收）。
 *
 * `unrecorded` 是显式第六态，不是空白单元格，且可点击就地填写。
 * 每个状态旁必须写明课时结算结果（−1 credit / no charge / pending）。
 */

export interface AttendanceSpec {
  label: string;
  icon: LucideIcon;
  /** 边框样式也是一条形状通道：solid vs dashed 在灰度下可分 */
  dashed: boolean;
  color: string;
  bg: string;
  /** 课时结算文本 */
  settlement: string;
  /** 老师是否可改（请假两态由服务端按 24h 阈值判定，只读） */
  readOnly: boolean;
  tooltip: string;
}

/** 「扣 1 课时」在同一张表里出现 4 次，提为常量避免四处漂移。 */
const MINUS_ONE = '−1 课时';

export const ATTENDANCE: Record<AttendanceStatus, AttendanceSpec> = {
  present: {
    label: '出勤',
    icon: CircleCheck,
    dashed: false,
    color: 'var(--success)',
    bg: 'var(--success-bg)',
    settlement: MINUS_ONE,
    readOnly: false,
    tooltip: '已出勤，扣 1 课时。',
  },
  late: {
    label: '迟到',
    icon: Clock,
    dashed: false,
    color: 'var(--warn)',
    bg: 'var(--warn-bg)',
    settlement: MINUS_ONE,
    readOnly: false,
    tooltip: '迟到，扣 1 课时。',
  },
  leave_approved: {
    label: '请假 · 提前满 24h 已批准',
    icon: CalendarX,
    dashed: true,
    color: 'var(--neutral-fg)',
    bg: 'var(--neutral-bg)',
    settlement: '不扣课时',
    readOnly: true,
    tooltip: '提前满 24h 提交，不扣课时。系统判定，只读。',
  },
  leave_late: {
    label: '请假 · 不足 24h',
    icon: CalendarClock,
    dashed: true,
    color: 'var(--warn)',
    bg: 'var(--warn-bg)',
    settlement: MINUS_ONE,
    readOnly: true,
    tooltip: '不足 24h 提交，扣 1 课时。系统判定，只读。',
  },
  absent: {
    label: '缺席',
    icon: X,
    dashed: false,
    color: 'var(--danger)',
    bg: 'var(--danger-bg)',
    settlement: MINUS_ONE,
    readOnly: false,
    tooltip: '未请假缺席，扣 1 课时。',
  },
  unrecorded: {
    label: '未记录',
    icon: CircleDashed,
    dashed: true,
    color: 'var(--meta)',
    bg: 'transparent',
    settlement: '待结算',
    readOnly: false,
    tooltip: '尚未记录。点击记录出勤。',
  },
};

/** 老师可提交的只有这三态 —— 与 openapi AttendanceRecordInput 枚举一致 */
export const TEACHER_SELECTABLE: AttendanceStatus[] = ['present', 'late', 'absent'];

export function AttendanceBadge({
  status,
  lateMinutes,
  onClick,
  compact = false,
}: {
  status: AttendanceStatus;
  lateMinutes?: number | null;
  onClick?: () => void;
  compact?: boolean;
}) {
  const spec = ATTENDANCE[status];
  const Icon = spec.icon;
  const label = status === 'late' && lateMinutes ? `迟到 ${lateMinutes} 分钟` : spec.label;

  const body = (
    <>
      <Icon size={16} aria-hidden style={{ color: spec.color }} />
      <span className="font-510" style={{ color: spec.color }}>
        {label}
      </span>
      {!compact && (
        <span className="num text-meta" style={{ color: 'var(--muted)' }}>
          {spec.settlement}
        </span>
      )}
    </>
  );

  const shared = [
    'inline-flex items-center gap-1.5 rounded-sm px-1.5 py-0.5',
    'text-meta transition-colors duration-150 ease-standard',
  ].join(' ');

  const style = {
    backgroundColor: spec.bg,
    border: `1px ${spec.dashed ? 'dashed' : 'solid'} ${spec.color}`,
  };

  if (!onClick) {
    return (
      <span className={shared} style={style} title={spec.tooltip} aria-label={`${label}，${spec.settlement}`}>
        {body}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={`${shared} cursor-pointer hover:opacity-80`}
      style={style}
      title={spec.tooltip}
      aria-label={`${label}，${spec.settlement}。点击可修改。`}
    >
      {body}
    </button>
  );
}

/** 点名抽屉里的三选一分段控件（点击「未记录」就地展开） */
export function AttendancePicker({
  value,
  onChange,
  disabledOptions = [],
}: {
  value: AttendanceStatus | null;
  onChange: (next: AttendanceStatus) => void;
  disabledOptions?: AttendanceStatus[];
}) {
  return (
    <div className="inline-flex rounded-md border border-border-strong overflow-hidden" role="group" aria-label="记录出勤">
      {TEACHER_SELECTABLE.map((status, index) => {
        const spec = ATTENDANCE[status];
        const Icon = status === 'present' ? Check : spec.icon;
        const active = value === status;
        const blocked = disabledOptions.includes(status);
        return (
          <button
            key={status}
            type="button"
            disabled={blocked}
            onClick={() => onChange(status)}
            aria-pressed={active}
            className={[
              'inline-flex items-center gap-1 h-7 px-2 text-meta font-510',
              'transition-colors duration-150 ease-standard',
              index > 0 ? 'border-l border-border' : '',
              blocked ? 'opacity-45 cursor-not-allowed' : 'cursor-pointer',
            ].join(' ')}
            style={{
              backgroundColor: active ? spec.bg : 'var(--surface)',
              color: active ? spec.color : 'var(--muted)',
            }}
          >
            <Icon size={16} aria-hidden />
            {spec.label}
          </button>
        );
      })}
    </div>
  );
}
