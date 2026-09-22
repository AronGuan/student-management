/**
 * MyCreditsPage 的共享类型与归一化（家长 / 学生视角）。
 *
 * 为什么余额条的分母由账本流水累计、而不是用「学生的课时包」：
 * GET /students/:id 其实**能**返回 packages（StudentDetail.Packages），所以这不是
 * 「拿不到」的问题，而是一致性问题 —— 分子 balance 的定义就是 SUM(credit_ledger.delta)，
 * 分母若改用 packages 就是两个数据源。退款后 packages 里的行仍留在列表里，
 * 分母会虚高、比例条算出来偏小甚至与实际不符。让分子分母同源于账本，
 * 就不会出现「已消耗 > 已购」这种自相矛盾的展示。
 * 界面上因此明确标注成「已购」而不是「套餐总量」，也不假装它是套餐配额。
 * 没有购买记录时宁可不画比例条，也不编一个分母。
 */
import type { Enrollment, LedgerEntry, LedgerReason, Lesson } from '../lib/types';
import { minutesToTime } from '../lib/format';

/**
 * 流水行。曾经这里重新声明一遍 note / lesson_label / actor_name，但 lib/types.ts 的
 * LedgerEntry 已按 Go 侧实际 tag 补齐了同样的三个可选字段（两个带 omitempty ⇒ 键缺席），
 * 于是这里的重复声明成了第二份真源 —— 改一处忘一处就会分叉。改为别名，页面代码不用动。
 */
export type LedgerRow = LedgerEntry;

export type CreditsResponse =
  | { balance?: number; entries?: LedgerRow[]; items?: LedgerRow[] }
  | null
  | undefined;

export function normaliseCredits(res: CreditsResponse): { balance: number; entries: LedgerRow[] } {
  return {
    balance: res?.balance ?? 0,
    entries: res?.entries ?? res?.items ?? [],
  };
}

export const REASON_LABEL: Record<LedgerReason, string> = {
  purchase: '购买课时包',
  consume: '上课扣减',
  leave_adjust: '请假调整',
  manual_adjust: '手工调整',
  refund: '退款',
  transfer_out: '转出',
};

/** 分母：只累计正向购买。退款会让它偏高，所以界面上叫「已购」并附口径说明。 */
export function purchasedTotal(entries: LedgerRow[]): number {
  return entries.filter((e) => e.reason === 'purchase' && e.delta > 0).reduce((sum, e) => sum + e.delta, 0);
}

export function purchases(entries: LedgerRow[]): LedgerRow[] {
  return entries.filter((e) => e.reason === 'purchase');
}

/* ── 课表 ────────────────────────────────────────────────────────────────── */

/**
 * 家长端的时段视图：来自 GET /students/:id 的 enrollments（status=active）。
 * 该接口本来就是为「学生抽屉」设计的一次性取数，报名行自带班名 / 科目 / 老师 /
 * 周几 / 起止分钟，所以周课表既能按**当前选中的孩子**精确呈现，也不需要逐班往返。
 */
export interface ScheduleSlot {
  class_id: number;
  class_name: string;
  subject_name: string | null;
  teacher_name: string | null;
  weekday: number;
  start_min: number;
  end_min: number;
}

/** 可选的具体课次（GET /lessons）。请假必须点名 lesson_id，所以这条链路是必需的。 */
export interface LessonOption {
  lesson_id: number;
  class_id: number;
  class_name: string;
  subject_name: string | null;
  teacher_name: string | null;
  lesson_date: string;
  start_min: number;
}

/**
 * 把一条课次补全成下拉项。服务端 GET /lessons 已带 class_name / subject_name，
 * 只有 teacher_name 不在课次上，所以用 enrollments 建的表补它。
 *
 * 这里用 `||` 而不是 `??`：两个来源的空值约定不同 —— `Lesson.subject_name`
 * 带 omitempty（缺席即 undefined），而 `Enrollment.subject_name` 是裸 string
 * （落空即 ""）。`undefined ?? ""` 的结果是 `""`，`?? null` 不会把 `""` 收成 null，
 * 于是 LessonOption 拿着空串往下走，下游所有 `?? '—'` 全部失效、界面显示空白。
 * `||` 对两者一视同仁，归一成 null 之后 ScheduleSlot / LessonOption 声明的
 * `string | null` 才真的成立。见 lib/types.ts 顶部「空值约定」。
 */
export function toLessonOption(lesson: Lesson, byClass: Map<number, Enrollment>): LessonOption {
  const cls = byClass.get(lesson.class_id);
  return {
    lesson_id: lesson.id,
    class_id: lesson.class_id,
    class_name: lesson.class_name || cls?.class_name || `班级 #${lesson.class_id}`,
    subject_name: lesson.subject_name || cls?.subject_name || null,
    teacher_name: cls?.teacher_name || null,
    lesson_date: lesson.lesson_date,
    start_min: lesson.start_min,
  };
}

/**
 * 课次开始时刻（墨尔本墙上时钟）。
 * 服务端保证所有时间串已是 +10:00 本地时间（ADR-007），这里只是把日期与分钟拼成
 * 同一个口径，交给 hoursUntil() 去算剩余小时数 —— 前端不做任何时区换算。
 */
export function lessonStartIso(lesson_date: string, start_min: number): string {
  return `${lesson_date}T${minutesToTime(start_min)}:00+10:00`;
}

/* ── 请假判定（提交前的告知）─────────────────────────────────────────────── */

export interface LeaveVerdict {
  late: boolean;
  headline: string;
  detail: string;
  /** 恰好卡在阈值边缘：hoursUntil 取整、服务端截断，两者最多差 1 小时，必须讲明 */
  borderline: boolean;
}

/**
 * 与 service.AttendanceService.RequestLeave 同一套阈值：hours >= leaveNoticeHours 免扣。
 * 关键在于**提交前**就把结论摆出来，而不是提交后才告诉家长扣了钱。
 */
export function verdictFor(hours: number, threshold: number): LeaveVerdict {
  const late = hours < threshold;
  const borderline = Math.abs(hours - threshold) <= 1;
  if (late) {
    return {
      late,
      borderline,
      headline: `不足 24h 请假 · 距上课还有 ${hours} 小时`,
      detail: `距上课不足 ${threshold} 小时才提交，将记为「不足 24h 请假」，扣 1 课时。系统在你提交的瞬间即判定，没有人工审批环节。`,
    };
  }
  return {
    late,
    borderline,
    headline: `提前满 24h 请假 · 距上课还有 ${hours} 小时`,
    detail: `距上课 ${threshold} 小时及以上提交，将记为「提前满 24h 已批准」，不扣课时。系统在你提交的瞬间即判定，没有人工审批环节。`,
  };
}

export const RESOLUTION_LABEL: Record<string, string> = {
  approved_ge_24h: '提前满 24h 已批准 · 不扣课时',
  late_lt_24h: '不足 24h 请假 · 扣 1 课时',
};
