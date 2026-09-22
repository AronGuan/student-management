/**
 * StudentsPage 的状态徽记与两个数值原子。
 *
 * 响应类型一律取自 ../lib/types —— 那份文件已与服务端的 Go 结构逐字段对齐，是唯一真源，
 * 页面里不再另立重复的 DTO（ADR-011）。这里只留真正属于界面的一层：状态徽记、流水符号、
 * 列表里的课时单元格。
 */
import { CircleCheck, CircleDot, CircleSlash, Clock, Minus, Plus, TriangleAlert } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { creditTier } from '../lib/format';
import type { LedgerReason, StudentStatus } from '../lib/types';

/* ── 学生状态：颜色 + 形状/图标 + 文本 三通道（UIUX §4.0）───────────────────
   churned 用中性色而不是红色：流失是经营常态，红色会让整张表变成「全是红的」。 */

export const STUDENT_STATUS: Record<StudentStatus, { label: string; icon: LucideIcon; cls: string }> = {
  lead: {
    label: '线索',
    icon: CircleDot,
    cls: 'border border-border-strong bg-neutral-bg text-neutral-fg',
  },
  trial: { label: '已约试听', icon: Clock, cls: 'border border-warn bg-warn-bg text-warn' },
  active: { label: '在读', icon: CircleCheck, cls: 'border border-success bg-success-bg text-success' },
  churned: {
    label: '已流失',
    icon: CircleSlash,
    cls: 'border border-border-strong bg-neutral-bg text-neutral-fg',
  },
};

export function StatusBadge({ status }: { status: StudentStatus }) {
  const spec = STUDENT_STATUS[status] ?? STUDENT_STATUS.lead;
  const Icon = spec.icon;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-meta font-510 ${spec.cls}`}>
      <Icon size={16} aria-hidden />
      {spec.label}
    </span>
  );
}

/* ── 课时流水：正负必须一眼可分（图标 + 符号 + 颜色）──────────────────────── */

export const LEDGER_REASON: Record<LedgerReason, string> = {
  purchase: '购买课时包',
  consume: '上课扣减',
  leave_adjust: '请假调整',
  manual_adjust: '手工调整',
  refund: '退款',
  transfer_out: '转出',
};

export function LedgerAmount({ delta }: { delta: number }) {
  const positive = delta > 0;
  const Icon = positive ? Plus : Minus;
  return (
    <span
      className={`num inline-flex items-center gap-1 text-row font-590 ${positive ? 'text-success' : 'text-fg-2'}`}
    >
      <Icon size={16} aria-hidden />
      {positive ? `+${delta}` : `−${Math.abs(delta)}`}
    </span>
  );
}

/**
 * 列表里的课时单元格。**故意不显示「剩余 / 总量」**：/students 的一行只带 balance，
 * 没有 total_credits（那个字段只有 /dashboard/admin 与档案详情才有）。这里就只报绝对数
 * + 阈值图标，「剩余 / 总量」留给档案抽屉里那张 CreditMeter —— 宁可不显示，也不拿
 * balance 冒充分母、渲染成一根永远满格的条。
 */
export function CreditNumber({ balance, status }: { balance: number; status: StudentStatus }) {
  // 还没成交的学生根本没有课时包，余额读 0 是「还没有账」，不是「用完了」，更不是
  // 「透支」。在漏斗最前端挂一个红色感叹号，是提醒顾问一件他们此刻不该被提醒的事。
  //
  // 现在这条分支是**防御性**的：service/student.go 的 List 在调用方不传 status 时
  // 已经把结果收口到 active + churned，所以这一页正常渲染不到 lead / trial。留着它是因为
  // 「余额 0 对未成交的人不等于透支」这个判断本身仍然成立，不是因为预期会走到这里。
  if (status === 'lead' || status === 'trial') {
    return (
      <span
        className="num inline-flex items-center gap-2 text-row"
        title="尚未购课。课时余额从成交开账后开始记。"
      >
        <span className="text-muted">—</span>
        <span className="text-muted">未购课</span>
      </span>
    );
  }
  const tier = creditTier(balance, 0);
  return (
    <span
      className="num inline-flex items-center gap-2 text-row"
      title="仅余额。课时包总量在学生档案中。"
    >
      {tier.alert && (
        <TriangleAlert
          size={16}
          className={balance <= 5 ? 'text-danger' : 'text-warn'}
          aria-label={balance < 0 ? '已透支' : '课时不足'}
        />
      )}
      <span className="font-590" style={{ color: tier.fill }}>
        {balance}
      </span>
      <span className="text-muted">课时</span>
      {balance < 0 && <span className="text-meta font-510 text-danger">已透支 {Math.abs(balance)}</span>}
    </span>
  );
}
