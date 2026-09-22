/**
 * TeachTodayPage 的共享类型与归一化。
 *
 * GET /lessons/:id/roster 的实际形状（service.AttendanceService.Roster；契约见 lib/types.ts
 * 的 Roster / RosterEntry）：固定是 `{ lesson, entries }`（handler 里 `OK(c, view)`，不是裸数组），
 * 每行只有 student_id / student_name / is_new_to_class / prefilled_status / current_status /
 * source / balance，**没有** status、settles、leave_resolution。
 *
 * prefilled_status 与 current_status 都是 *string（未记录即 null），两者必须分开看：
 * 前者是系统按请假记录预先判定的结果，后者是老师真正点过名的结果。归一化后页面只认
 * RosterRow，于是「未记录」永远是显式状态而不是空白。
 *
 * 服务端的 source 没有进 RosterRow：点名表上「这行是谁记的」完全由 status 决定
 * （isLeave(status) 即系统预填、只读、可走二级覆盖），多存一个副本只会多一处可能不一致。
 */
import { TriangleAlert } from 'lucide-react';
import { creditTier } from '../lib/format';
import type { AttendanceStatus } from '../lib/types';

export interface RosterRow {
  student_id: number;
  student_name: string;
  balance: number;
  status: AttendanceStatus;
  is_new_to_class: boolean;
  /**
   * 结算后果文案。服务端并不返回这个字符串（RosterEntry 里没有该字段），它由 status
   * 按 service.AttendanceStatus.Charges() 的口径在本地推出来 —— 目的是在老师按下提交
   * 之前就把后果写在行上，而不是提交后才告诉他扣了课时。
   */
  settles: string;
}

interface RawEntry {
  student_id: number;
  student_name?: string;
  balance?: number;
  current_status?: AttendanceStatus | null;
  prefilled_status?: AttendanceStatus | null;
  is_new_to_class?: boolean;
}

/** 服务端固定返回 { lesson, entries }；lesson 不取用，只读 entries */
export type RosterResponse = { entries?: RawEntry[] } | null | undefined;

function pickStatus(entry: RawEntry): AttendanceStatus {
  return entry.current_status ?? entry.prefilled_status ?? 'unrecorded';
}

export function normaliseRoster(res: RosterResponse): RosterRow[] {
  return (res?.entries ?? []).map((entry) => {
    const status = pickStatus(entry);
    return {
      student_id: entry.student_id,
      student_name: entry.student_name || `学生 #${entry.student_id}`,
      balance: entry.balance ?? 0,
      status,
      is_new_to_class: entry.is_new_to_class ?? false,
      // 不重抄一遍扣费规则：直接问 chargesACredit（它对应 Go 的 Charges()）
      settles: status === 'unrecorded' ? '待结算' : chargesACredit(status) ? '−1 课时' : '不扣课时',
    };
  });
}

/** 老师有权提交的只有这三态（与 openapi AttendanceRecordInput 枚举一致） */
export function isTeacherStatus(status: AttendanceStatus): boolean {
  return status === 'present' || status === 'late' || status === 'absent';
}

/** 服务端按 Charges() 判定：请假提前 ≥24h 不扣，其余（含请假不足24h）扣 1 节 */
export function chargesACredit(status: AttendanceStatus): boolean {
  return status !== 'leave_approved';
}

export function isLeave(status: AttendanceStatus): boolean {
  return status === 'leave_approved' || status === 'leave_late';
}

/**
 * 系统已判定的请假为什么是只读 —— 老师端必须解释清楚，不能只给一个灰按钮。
 * 只在 isLeave(status) 为真时调用：leave_approved 与 leave_late 已经把 24h 判定写进
 * 状态本身了，所以这里不需要（服务端也不返回）额外的 leave_resolution 字段。
 */
export function leaveExplanation(status: AttendanceStatus): string {
  return status === 'leave_approved'
    ? '家长提前满 24 小时请假，系统已记为批准请假，不扣课时。'
    : '家长请假不足 24 小时，系统已记为不足 24h 请假，扣 1 课时。';
}

/**
 * 课时余额。点名表只返回 balance、不返回套餐总量，因此这里**不画比例条** ——
 * 画一条分母未知的进度条就是在编数据。分档仍然走 creditTier（它只依赖 balance），
 * 三通道编码：三角图标 + 颜色 + 数字后写明 "剩余"。
 */
export function CreditsLeft({ balance }: { balance: number }) {
  const tier = creditTier(balance, 0);
  return (
    <span className="inline-flex items-center gap-1.5">
      {tier.alert && <TriangleAlert size={16} className="shrink-0 text-danger" aria-label="课时不足" />}
      <span className="text-meta text-muted">剩余</span>
      <span className={`num text-row font-510 ${tier.alert ? 'text-danger' : 'text-fg'}`}>{balance}</span>
      {tier.overdrawn && <span className="text-meta font-510 text-danger">已透支</span>}
    </span>
  );
}
