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
   * （service/student_detail.go:51），LEFT JOIN 落空时是 `""` 而**不是** null。
   * 消费侧必须用 `||` 兜底，用 `??` 会静默失效。
   */
  subject_name: string;
  /** 约定 B，同 subject_name（service/student_detail.go:52）。 */
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

/**
 * `GET /students/:id` 里的 `recent_feedback[]` —— **老师手写的评价原文**。
 *
 * 与 `follow_ups.note`（顾问的跟进备注）不是一回事：那个是顾问给自己/同事留的待办说明，
 * 这个出自点名页备注列，写的人是在课堂上的老师，说的是孩子最近怎么样。学生抽屉把两者
 * 分开渲染，AI 续费卡读的也是这一份（service/ai.go:282-298 —— 含 Go 侧那道
 * teacherFeedback 过滤，它才是真正拦下系统样板文字的一层）。
 *
 * 只有一个读者：顾问的学生抽屉（StudentsPage.Drawer.tsx）。家庭端的 /me **不读这一份** ——
 * 老师写给同事的课堂口气不该给家长看，家长读的是另一份 `parent_updates`（见下）。
 *
 * 服务端已经剥掉了 `late leave:` / `corrected from` 这类系统样板文字，所以 note 里剩下的
 * 就是老师原话。上限 10 条、按 recorded_at 倒序 —— 取的是"最近怎么样"，不是全量历史。
 */
export interface FeedbackRow {
  id: number;
  lesson_date: string; // "2026-09-16"
  class_name: string;
  subject_name: string;
  teacher_name: string;
  status: string; // present | late | absent | leave_approved | leave_late
  note: string; // 老师原话，系统生成的文本服务端已剥除
  recorded_at: string; // RFC3339
}

/**
 * `GET /students/:id` 里的 `parent_updates[]` —— **顾问写给这个家庭的、家长真的会读到的那句话**。
 *
 * 它和 `recent_feedback` 是两份不同的数据，不是一份数据的两个视图：
 * `recent_feedback` 出自点名页备注列，是老师写给同事的课堂记录（口气糙、可以很直接），
 * 只给 AI 和顾问看；这一份来自顾问处理完一次跟进之后亲手写下的话，家长在自己的页面上读它。
 * 两者之间**没有任何派生关系** —— 不做"自动脱敏"、不做"自动摘要"，理由是：漏一条等于机构
 * 少说了一句，而"忘了说"和"没什么可说"必须能被区分开（后者就是这一条不存在）。
 *
 * 服务端只下发给家长看过的那份（`follow_ups.parent_note` 非空），上限 10 条、
 * 按 `parent_note_at` 倒序 —— 取的是"最近一次同步是什么时候"。
 */
export interface ParentUpdateRow {
  id: number;
  note: string; // 顾问写给这个家庭的那句话，服务端保证非空
  speaker_name: string; // 谁同步的（顾问），可能为空串
  recorded_at: string; // RFC3339
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
  /** 老师手写的评价原文（上限 10 条、按 recorded_at 倒序），见 FeedbackRow。 */
  recent_feedback: FeedbackRow[];
  /** 顾问写给家长、家长在 /me 上真能读到的话，见 ParentUpdateRow。 */
  parent_updates: ParentUpdateRow[];
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
  /** 老师填的自由备注；未点名时为 null */
  note: string | null;
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
 * `overdue_hours` 来自 dashboard 的 `followUpRow`（dashboard.go:38）：`int64` 非指针、**无** `omitempty`，
 * 且 SQL 已按 `WHERE fu.due_at < now` 预过滤 —— **键恒在、值恒为正**（正 = 已逾期小时数）。
 * 别和 `/follow-ups` 的 `model.FollowUp.overdue_hours` 混：那个是 `*int64 + omitempty`，
 * 且**只有「仍是 pending 且已过 due_at」的行才有键**（未到期的 pending 行同样整个键缺席），
 * 值也恒不为负 —— 两个端点同名同义，都是「键在即已逾期」。
 */
export interface FollowUpQueueRow {
  id: number;
  student_id: number;
  student_name: string;
  due_at: string;
  overdue_hours: number;
}

/**
 * 工作台队列行 —— 「课堂记录标记」（`AdminDashboard.flagged_follow_ups`，来源
 * `source='teacher_note'`）：老师在点名页勾了「需要顾问跟进」而顾问还没处理完的项。
 *
 * 与 `FollowUpQueueRow` 只差一个字段，却是**必须分开的两个类型**，不是重复定义：
 * 上面的注释把 `0` 定死成「已逾期但不足 1 小时」（`FollowUp.overdue_hours` 的第 2 条也这么
 * 写：「`0` 表示已逾期但不足 1 小时，不是未到期」），而这一队列的行按定义**还没到期**
 * （`due_at = 标记时刻 + 48h`）。复用同一个类型，服务端只能给出一个 `0` ——
 * 于是「还没到期」会被渲染成「已逾期 0 小时」；改给负数又把这个字段的值域从 `[0, +∞)`
 * 偷偷放宽到 `(-∞, +∞)`，一个端点上的谎话会顺着共用渲染漂到另一个端点。
 * 所以这里干脆不带这个字段：要显示「还剩多久」就按 `due_at` 本地倒计时 —— 与服务端在
 * `GET /follow-ups` 上对未逾期行（同样不下发这个键）的做法完全一致。
 */
export interface FlaggedFollowUpRow {
  id: number;
  student_id: number;
  student_name: string;
  due_at: string;
}

export interface TrialQueueRow {
  id: number;
  student_id: number;
  student_name: string;
  subject_name: string | null;
  teacher_name: string | null;
  scheduled_at: string;
  /**
   * 试听时长（分钟）。服务端下发的是**原始分钟数**，不是派生出来的结束时刻或「已结束」
   * 布尔 ——「结束没有」是渲染那一刻的问题（同一行今天看是「未结束」、明天看是「已结束」），
   * 多下发一个派生字段只会让两处口径各自漂移。前端用 hoursSinceEnd(scheduled_at, duration_min) 算。
   */
  duration_min: number;
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
  /** admin 首屏的行动队列 —— 工作台就是靠这五个数组撑起来的。 */
  overdue_follow_ups: FollowUpQueueRow[];
  /**
   * 「课堂记录标记」：老师在点名页勾了「需要顾问跟进」、顾问还没处理完的项，按 due_at 升序，
   * 上限 20。与 overdue_follow_ups **不重叠**：两条队列按 `source`（trial / teacher_note）
   * 恰好切分「未完成的跟进」，不重不漏 —— 这不是靠数据现状成立的说法，课堂标记一旦逾期
   * 就会同时满足逾期区的其他条件，只有按 source 切开才不会两头都出现或两头都不出现。
   *
   * 与逾期区还有两处刻意的不同：**不按是否逾期过滤**（逾期的行留在这里，甩进逾期区等于让
   * 这条任务凭空消失 —— 那边按 source 只收试听转化，而且它当前在界面上是隐藏的）；
   * 行里没有 `overdue_hours`（为什么，见 FlaggedFollowUpRow）。
   * 展示的措辞由前端从 `due_at` 本地倒计时，服务端不替它算差值。
   */
  flagged_follow_ups: FlaggedFollowUpRow[];
  /** **未来**的试听（scheduled_at >= now），按开始时刻升序。 */
  upcoming_trials: TrialQueueRow[];
  /**
   * **已上完但结果还没记**的试听：outcome='pending' 且 结束时刻 <= now，按结束时刻升序
   * （结束最久的排最前）。它与 upcoming_trials 是同一条时间轴上的两段，互不重叠，
   * 判据的边界都落在 `scheduled_at + COALESCE(duration_min, 60) <= now` 这一刻。
   * 数组上限 20，全量计数另见 awaiting_outcome_trials_count。
   */
  awaiting_outcome_trials: TrialQueueRow[];
  low_credit: LowCreditRow[];
  today_lessons: number;
  pending_followups: number;
  overdue_followups: number;
  /**
   * flagged_follow_ups 同口径的**全量**计数（`source='teacher_note' AND status='pending'`，
   * 含已逾期），与数组长度不一定相等（数组上限 20）。标题上的数字用这个，且必须与数组同一个
   * 谓词：否则标题说 5 条、列表只画 3 条，而看的人只会以为列表漏了。
   */
  flagged_followups: number;
  low_credit_students: number;
  /**
   * awaiting_outcome_trials 同口径的**全量**计数，与数组长度不一定相等（数组有上限 20）。
   * 标题上的数字用这个：积压时拿数组长度当计数会低报，而积压恰恰是这一区要暴露的事。
   */
  awaiting_outcome_trials_count: number;
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
