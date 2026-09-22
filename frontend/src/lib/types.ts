/**
 * 接口类型 —— 与后端 Go handler 的实际响应一一对应。
 *
 * 本文件是与后端对齐后的**唯一类型真源**。此前它按 docs/openapi.yaml 的理想形状
 * 编写，而实现与规格在若干处发生了漂移；经裁定以**运行中的 Go handler 为准**
 * （规格是文档，运行时才是被评审的东西），因此这里按实际响应修正，
 * 并由 docs/openapi.yaml 同步跟进。不要在页面组件里另立重复的响应类型。
 */

import type { PageMeta } from './api';

export type UserRole = 'admin' | 'teacher' | 'student';

export interface User {
  id: number;
  role: UserRole;
  username: string;
  display_name: string;
  status: 'active' | 'disabled';
}

/** GET /auth/me —— student_ids 恒为数组（非 student 角色为空数组），永不为 null。 */
export interface AuthMe {
  user: User;
  student_ids: number[];
}

export type StudentStatus = 'lead' | 'trial' | 'active' | 'churned';

export interface Guardian {
  id: number;
  name: string;
  phone: string;
  email: string;
  relationship: string;
  is_primary: boolean;
}

export interface Student {
  id: number;
  /** Go 侧是 *uint64，学生可以不归属任何顾问，所以真的会是 null。 */
  owner_admin_id: number | null;
  user_id: number | null;
  full_name: string;
  preferred_name: string;
  /** 等级是标签而非数值：'Year 9' / 'Prep'。 */
  year_level: string;
  status: StudentStatus;
  /** Go 侧是 string（不是 *string）：未填写时给 ""，不会给 null。 */
  source: string;
  created_at: string;
  updated_at: string;
  /**
   * 调用者能否写这个学生 —— R7 的结论，由服务端算好（model.CanWrite）。
   * 列表与详情都带（它挂在共享的 Student 结构上）。前端所有写入动作只看这一个
   * 布尔，绝不在浏览器里自己比较 owner_admin_id。
   */
  can_write: boolean;
}

export interface StudentListItem extends Student {
  balance: number;
  owner_admin_name: string;
  active_class_count: number;
  pending_followup: boolean;
}

export interface CreditPackage {
  id: number;
  student_id: number;
  name: string;
  total_credits: number;
  price_cents: number;
  purchased_at: string;
  purchased_by_admin_id: number;
  status: 'active' | 'void' | 'refunded';
  /** R9：字段存在但服务端不校验到期，所以通常缺省。 */
  expires_at?: string | null;
}

export type LedgerReason =
  | 'purchase'
  | 'consume'
  | 'leave_adjust'
  | 'manual_adjust'
  | 'refund'
  | 'transfer_out';

/** 账本行只增不改：余额 = SUM(delta)，不存在冗余余额字段。 */
export interface LedgerEntry {
  id: number;
  student_id: number;
  /**
   * 下面这些 Go 侧都带 `omitempty`：**为空时键整个缺席，而不是给 null**。
   * 所以用可选（`?`）而不是 `| null` —— 否则 `entry.note ?? fallback` 这类写法
   * 在类型上看着安全，实际拿到的是 undefined。
   */
  package_id?: number | null;
  delta: number;
  reason: LedgerReason;
  lesson_id?: number | null;
  attendance_id?: number | null;
  actor_user_id: number;
  note?: string | null;
  created_at: string;
  /** 该端点 join 出来的展示字段（service/student.go:210），不是账本表的列。 */
  lesson_label?: string;
  actor_name?: string;
}

/** 学生在某一班级中的报名记录（GET /classes/:id/enrollments）。 */
export interface ClassMember {
  student_id: number;
  full_name: string;
  balance: number;
  status: 'active' | 'withdrawn';
}

/** 学生的报名记录，展开后用于 StudentDetail.enrollments。 */
export interface Enrollment {
  id: number;
  class_id: number;
  class_name: string;
  /**
   * 约定 B：`EnrollmentRow.SubjectName` 是裸 string、无 omitempty
   * （service/student_detail.go:46），LEFT JOIN 落空时是 `""` 而**不是** null。
   * 消费侧必须用 `||` 兜底，用 `??` 会静默失效。
   */
  subject_name: string;
  /** 约定 B，同 subject_name（service/student_detail.go:47）。 */
  teacher_name: string;
  weekday: number;
  start_min: number;
  end_min: number;
  status: 'active' | 'withdrawn';
  enrolled_on: string;
  withdrawn_on: string | null;
}

/**
 * `GET /follow-ups` 的一行（model.FollowUp）。
 *
 * `trial_id` / `completed_at` / `completed_by_user_id` / `note` 在 Go 侧都带 `omitempty`
 * （model.go:266 / :269 / :270 / :271）——为空时键**整个缺席**，所以是可选（`?`）而不是 `| null`。
 */
export interface FollowUp {
  id: number;
  student_id: number;
  student_name: string;
  trial_id?: number;
  due_at: string;
  status: 'pending' | 'done' | 'overdue';
  completed_at?: string;
  completed_by_user_id?: number;
  note?: string;
}

export type AttendanceStatus =
  | 'present'
  | 'late'
  | 'absent'
  | 'leave_approved'
  | 'leave_late'
  | 'unrecorded';

export type AiStatus = 'ok' | 'invalid' | 'unavailable';

/** 决策卡由 LLM 产出，或由确定性规则引擎降级产出。source 用于区分，绝不掩盖降级。 */
export type AiSource = 'llm' | 'rule';

export interface AiConversionCard {
  id: number;
  student_id: number;
  kind: 'trial_conversion';
  ai_status: AiStatus;
  source: AiSource;
  conversion_signal: 'strong' | 'weak' | 'blocked';
  guardian_concerns: string[];
  blocker: 'none' | 'price' | 'schedule' | 'outcome' | 'undecided' | 'competitor';
  next_action: 'call' | 'send_material' | 'arrange_second_trial' | 'wait' | 'close';
  follow_up_within_days: number;
  advisor_note: string;
  evidence: string[];
  model: string | null;
  created_at: string;
}

export interface AiRenewalCard {
  id: number;
  student_id: number;
  kind: 'renewal_risk';
  ai_status: AiStatus;
  source: AiSource;
  churn_risk: 'high' | 'medium' | 'low';
  risk_factors: string[];
  recommended_package: 'small' | 'standard' | 'large' | 'none';
  contact_from: string;
  contact_to: string;
  advisor_note: string;
  evidence: string[];
  model: string | null;
  created_at: string;
}

export type AiDecisionCard = AiConversionCard | AiRenewalCard;

export interface StudentDetail extends Student {
  balance: number;
  guardians: Guardian[];
  enrollments: Enrollment[];
  packages: CreditPackage[];
  follow_ups: FollowUp[];
  latest_ai_card: AiDecisionCard | null;
}

/**
 * GET /classes 的行（model.Class）。
 *
 * 没有 start_clock / end_clock —— 这两个钟点字段只存在于 /dashboard/teacher 的行上，
 * 这里曾经声明过，读到的永远是 undefined。时间要显示就用 start_min/end_min 自己格式化。
 * subject_name / teacher_name / enrolled 都带 `omitempty`，为空时键缺席。
 */
export interface ClassItem {
  id: number;
  name: string;
  subject_id: number;
  subject_name?: string;
  teacher_id: number;
  teacher_name?: string;
  weekday: number;
  start_min: number;
  end_min: number;
  capacity: number;
  room: string;
  enrolled?: number;
  status: 'active' | 'archived';
}

export interface ClassDetail extends ClassItem {
  seats_left: number;
}

export interface Subject {
  id: number;
  name: string;
}

export interface TeacherOption {
  id: number;
  display_name: string;
  username: string;
}

export interface Lesson {
  id: number;
  class_id: number;
  class_name: string;
  subject_name: string | null;
  teacher_id: number;
  lesson_date: string;
  weekday: number;
  start_min: number;
  end_min: number;
  status: 'scheduled' | 'cancelled' | 'completed';
  cancel_reason: string | null;
}

export interface Trial {
  id: number;
  student_id: number;
  subject_id: number;
  subject_name: string | null;
  teacher_id: number | null;
  scheduled_at: string;
  duration_min: number;
  outcome: 'pending' | 'converted' | 'lost';
  outcome_note: string | null;
  created_at: string;
}

/**
 * 点名表的一行。prefilled_status 与 current_status 必须分开：
 * 前者是系统依请假记录预先判定的结果，后者是老师实际记录的。
 * 老师端要把「已批准的请假」显示为预填且只读，同时仍需知道是否已点过名。
 */
export interface RosterEntry {
  student_id: number;
  student_name: string;
  is_new_to_class: boolean;
  prefilled_status: AttendanceStatus | null;
  current_status: AttendanceStatus | null;
  source: 'prefilled' | 'teacher_override' | 'system' | null;
  balance: number;
}

export interface Roster {
  lesson: Lesson;
  entries: RosterEntry[];
}

export interface Attendance {
  id: number;
  lesson_id: number;
  student_id: number;
  status: AttendanceStatus;
  source: 'prefilled' | 'teacher_override' | 'system';
  recorded_by_user_id: number | null;
  recorded_at: string | null;
  note: string | null;
}

export interface LeaveRequest {
  id: number;
  lesson_id: number;
  student_id: number;
  requested_by_user_id: number;
  requested_at: string;
  reason: string | null;
  /** 服务端即时判定：≥24h 免扣，<24h 仍扣 1 课时。不存在审批队列。 */
  resolution: 'approved_ge_24h' | 'late_lt_24h';
  created_at: string;
}

/**
 * 工作台队列行 —— 逾期跟进。服务端只算逾期小时数，展示文案归前端。
 *
 * `overdue_hours` 来自 dashboard 的 `followUpRow`（dashboard.go:36）：`int64` 非指针、**无** `omitempty`，
 * 且 SQL 已按 `WHERE fu.due_at < now` 预过滤 —— **键恒在、值恒为正**（正 = 已逾期小时数）。
 * 别和 `/follow-ups` 的 `model.FollowUp.overdue_hours` 混：那个是 `*int64 + omitempty`，非 pending 时键整个缺席。
 */
export interface FollowUpQueueRow {
  id: number;
  student_id: number;
  student_name: string;
  due_at: string;
  overdue_hours: number;
}

export interface TrialQueueRow {
  id: number;
  student_id: number;
  student_name: string;
  subject_name: string | null;
  teacher_name: string | null;
  scheduled_at: string;
  outcome: 'pending' | 'converted' | 'lost';
}

/**
 * dashboard.low_credit[] 的一行。
 *
 * 这里曾经有一个 `weeks_left: string`，但 dashboard.go 的三条 SQL 从不 select 它，
 * 于是每个响应都带一个恒为空串的字段——契约里写着一个永远没有值的字段，比不写更糟。
 * 「还能撑几周」需要每生每周消耗量，没有端点提供，所以先删掉而不是先编一个。
 * 同类问题（fe-admin 已记录）：卡片列表页没有 total_credits，因此没有分母就画进度条。
 */
export interface LowCreditRow {
  student_id: number;
  full_name: string;
  balance: number;
  total_credits: number;
}

export interface AdminDashboard {
  /** admin 首屏的三条行动队列 —— 工作台就是靠这三个数组撑起来的。 */
  overdue_follow_ups: FollowUpQueueRow[];
  upcoming_trials: TrialQueueRow[];
  low_credit: LowCreditRow[];
  today_lessons: number;
  pending_followups: number;
  overdue_followups: number;
  low_credit_students: number;
}

export interface TeacherLessonRow {
  id: number;
  class_id: number;
  class_name: string;
  subject_name: string | null;
  lesson_date: string;
  start_min: number;
  start_clock: string;
  status: 'scheduled' | 'cancelled' | 'completed';
  students: number;
  new_faces: number;
  on_leave: number;
  recorded: number;
}

export interface TeacherDashboard {
  today: TeacherLessonRow[];
  missing_roll_call: number;
}

export interface StudentPage extends PageMeta {
  items: StudentListItem[];
}

export interface CreditsPage {
  balance: number;
  items: LedgerEntry[];
  total: number;
}
