/**
 * LeadsPage 的共享类型与状态徽记。
 *
 * 类型一律取自 lib/types.ts（它已按后端实际返回对齐）。这里只做两件必要的松绑：
 *   1. 列表端点在实体之外还带了一些派生列（`/trials` 附带 student_name/teacher_name，
 *      `/follow-ups` 附带逾期小时数），而 Go 的 `omitempty` 又会让可空字段整键消失；
 *   2. `AiConversionCard` 的 id/kind/created_at 由服务端补，ConversionCard 本身不返回，
 *      统一在 normaliseCard() 里补齐**常量元数据**（不伪造任何内容字段）。
 * /trials 与 /follow-ups 都返回 Page 信封（items/total/page/limit/has_more），读取处直接取字段。
 */
import { CircleCheck, CircleSlash, CircleDashed, CircleAlert, Clock } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { AiConversionCard, FollowUp, Trial } from '../lib/types';
import { overdueLabel, slaCountdown } from '../lib/format';

/** `/trials` 行：契约里的 Trial + 列表联表带出的派生列 */
export interface TrialListRow extends Omit<Trial, 'subject_name' | 'teacher_id' | 'outcome_note'> {
  subject_name?: string | null;
  teacher_id?: number | null;
  outcome_note?: string | null;
  student_name?: string;
  teacher_name?: string | null;
}

/** `/follow-ups` 行：契约里的 FollowUp + 服务端派生的逾期小时数（`?` ⇒ 键可能缺席，见 types.ts 的 FollowUp） */
export interface FollowUpListRow extends FollowUp {
  overdue_hours?: number;
}

/**
 * ConversionCard 的实际形状：id / kind / created_at 由服务端补，模型未配置时
 * model 整键消失，nil 切片会序列化成 null 而不是 []。三者都要在归一化时兜住。
 */
export type RawConversionCard = Omit<
  AiConversionCard,
  'id' | 'kind' | 'created_at' | 'model' | 'guardian_concerns' | 'evidence'
> & {
  id?: number;
  kind?: 'trial_conversion';
  created_at?: string;
  model?: string | null;
  guardian_concerns?: string[] | null;
  evidence?: string[] | null;
};

/** 补齐常量元数据并把 null 集合归一成 []，内容字段一个不动。 */
export function normaliseCard(raw: RawConversionCard, studentId: number): AiConversionCard {
  return {
    ...raw,
    id: raw.id ?? 0,
    kind: 'trial_conversion',
    student_id: raw.student_id ?? studentId,
    created_at: raw.created_at ?? '',
    model: raw.model ?? null,
    guardian_concerns: raw.guardian_concerns ?? [],
    evidence: raw.evidence ?? [],
  };
}

export function unwrapList<T>(res: T[] | { items?: T[] } | null | undefined): T[] {
  if (Array.isArray(res)) return res;
  const items = res?.items;
  return Array.isArray(items) ? items : [];
}

/* ── 试听结果（UIUX §4.4 维度 A）─────────────────────────────────────────────
   「结果」与「是否已跟进」是两个独立维度，绝不合并成一个颜色。
   未转化不用红色：流失是经营常态，红色会让整张表变红、污染语义。        */

const OUTCOME: Record<Trial['outcome'], { label: string; icon: LucideIcon; cls: string }> = {
  pending: {
    label: '待反馈',
    icon: CircleDashed,
    cls: 'border border-dashed border-border-strong text-muted',
  },
  converted: {
    label: '已转化',
    icon: CircleCheck,
    cls: 'border border-success bg-success-bg text-success',
  },
  lost: {
    label: '未转化',
    icon: CircleSlash,
    cls: 'border border-neutral-fg bg-neutral-bg text-neutral-fg',
  },
};

/** 枚举 → 中文标签。未登记的值原样返回 —— 界面留痕比显示空值更有助于排查服务端返回了什么。 */
export function outcomeLabel(outcome: Trial['outcome']): string {
  return OUTCOME[outcome]?.label ?? outcome;
}

export function OutcomeBadge({ outcome }: { outcome: Trial['outcome'] }) {
  const spec = OUTCOME[outcome] ?? OUTCOME.pending;
  const Icon = spec.icon;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-meta font-510 ${spec.cls}`}
    >
      <Icon size={16} aria-hidden />
      {spec.label}
    </span>
  );
}

/* ── 跟进状态（UIUX §4.3）───────────────────────────────────────────────────
   文案优先用 overdueLabel(overdue_hours)；slaCountdown 仍只负责进度条几何与色调，
   不参与「是否进这个队列」的判断（那是服务端的 status 过滤决定的）。     */

export function FollowUpStatus({ item }: { item: FollowUpListRow }) {
  const done = item.status === 'done';
  const sla = slaCountdown(item.due_at);

  if (done) {
    return (
      <span className="inline-flex items-center gap-1.5 text-meta font-510 text-success">
        <CircleCheck size={16} aria-hidden />
        已跟进
      </span>
    );
  }

  const overdue = sla.hoursLeft <= 0;
  const Icon = overdue ? CircleAlert : Clock;
  const tone = overdue ? 'text-danger' : sla.tone === 'warn' ? 'text-warn' : 'text-muted';

  return (
    <span className="flex flex-col gap-1">
      <span className={`inline-flex items-center gap-1.5 text-meta font-510 ${tone}`}>
        <Icon size={16} aria-hidden />
        {overdueLabel(item.overdue_hours) || sla.label}
      </span>
      <span className="sla-bar" aria-hidden>
        <span
          className={`absolute inset-y-0 left-0 ${
            overdue ? 'bg-danger' : sla.tone === 'warn' ? 'bg-warn' : 'bg-muted'
          }`}
          style={{ width: `${Math.round(sla.ratio * 100)}%` }}
        />
        <span className="sla-tick" style={{ left: '50%' }} />
      </span>
    </span>
  );
}
