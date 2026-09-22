/**
 * ⚠️ 「跟进逾期」这一区**仍然没有展示**（2026-09-22 用户裁定），但组件本身已经在用了 ——
 * 工作台的「课堂记录标记」区复用它渲染（同一份行渲染，两个来源按 `source` 恰好切分）。
 * 于是恢复这一区要做的事少了一件：TodayPage.tsx 的 import 已经加回来了，只要把那段注释放开。
 * 理由完整写在 TodayPage.tsx 的文件头注释里：判定本身是对的，但界面上容易被读成
 * 「这些人的试听结果拖了 48 小时没填」，而实际能进这一区的**都是已经填过结果的**
 * （跟进任务是 SetOutcome 的产物）。能力本身没有消失：`POST /follow-ups/:id/complete`
 * 仍在，界面上那个按钮在学生抽屉的转化卡上（`LeadsPage.Playbook.tsx:125`）。
 * ⚠️ 但 `/leads` 右栏的跟进队列也在 2026-09-22 一并撤下了，所以恢复这一区之前，先想清楚
 * 「浏览全部逾期跟进」这个面放在哪 —— 现在是两处都没有，只有服务端 API 拿得到全量。
 *
 * 工作台第一区：跟进超期。这是最贵的一条队列 —— 试听记录完结果后 48h 内没联系家长，
 * 转化率就掉。所以它排在第一区，且行内就能闭环（不跳页、不开新标签）。
 *
 * 「超期多久」的语义由相对时间文案 + SLA 条承担（UIUX §4.3），不靠红色 badge。
 * 逾期判定在服务端（dashboard.go:93-97 用 due_at < now 取），并且服务端把**逾期小时数**
 * 下发在 overdue_hours 上（ADR-007：不在前端按时间戳重算）。overdueLabel 把它转成主文案；
 * 服务端没给（null）时才回落到前端按时间戳算的 slaCountdown.label。slaCountdown 另供
 * SLA 条的比例与配色（tone 决定图标与填充色，ratio 决定填充宽度）。
 * 课堂标记区的行**按契约没有 overdue_hours**（见 types.ts 的 FlaggedFollowUpRow），
 * 所以那一区永远走这条回落 —— 那正是契约要的：它们的窗口还没过，「逾期 0 小时」是句谎话。
 *
 * 行数上限 20 由服务端 SQL 决定，total 是同一口径的全量计数，所以「还有 N 条没显示」
 * 是真实差额，不是猜的。
 */
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { BellRing, CircleAlert, CircleCheck, Clock } from 'lucide-react';
import { Button, Panel, PanelHeader } from '../components/ui';
import { ListState } from '../components/StateViews';
import { useToast } from '../components/Toast';
import { api, humaniseError } from '../lib/api';
import { dateTime, overdueLabel, slaCountdown } from '../lib/format';

/**
 * 这一区要渲染的行 —— 抽出两个来源都有的那四个字段，而不是写死 `FollowUpQueueRow`：
 * `FollowUpQueueRow[]`（逾期）与 `FlaggedFollowUpRow[]`（课堂标记）都天然可赋给它
 * （前者是它的超集），于是两区**共用同一份行渲染**，不会各自长出一份然后慢慢漂移。
 * 两个契约类型只差 `overdue_hours` 一个键，而那个键的缺席是有含义的，所以它不在这里，
 * 读取处按 `in` 探测（见下面 overdueHoursOf）。
 */
type QueueRow = { id: number; student_id: number; student_name: string; due_at: string };

/**
 * 只有逾期区（`FollowUpQueueRow`）带服务端算好的 overdue_hours；课堂标记区的行按契约
 * **刻意不带这个键** —— 用 `in` 探而不是 `?? null`，是因为后者要求这个键先出现在上面那个
 * 共用类型里，而一旦它出现，「课堂标记行也带着一个 overdue_hours」就成了合法代码。
 * 契约去掉那个键，为的就是不让这一区被渲染成「已逾期 0 小时」。
 */
function overdueHoursOf(row: QueueRow): number | null {
  if ('overdue_hours' in row && typeof row.overdue_hours === 'number') return row.overdue_hours;
  return null;
}

function SlaCell({ dueAt, overdueHours }: { dueAt: string; overdueHours: number | null }) {
  const sla = slaCountdown(dueAt);
  const label = overdueLabel(overdueHours) ?? sla.label;
  const Icon = sla.tone === 'danger' ? CircleAlert : Clock;
  const tone = sla.tone === 'danger' ? 'text-danger' : sla.tone === 'warn' ? 'text-warn' : 'text-muted';
  const fill = sla.tone === 'danger' ? 'bg-danger' : sla.tone === 'warn' ? 'bg-warn' : 'bg-muted';
  return (
    <span className="flex flex-col gap-1">
      <span className={`num inline-flex items-center gap-1.5 text-meta font-510 ${tone}`}>
        <Icon size={16} aria-hidden />
        {label}
      </span>
      <span className="sla-bar" aria-hidden>
        <span className={`absolute inset-y-0 left-0 ${fill}`} style={{ width: `${Math.round(sla.ratio * 100)}%` }} />
        <span className="sla-tick" style={{ left: '50%' }} />
      </span>
    </span>
  );
}

export function FollowUpsSection({
  items,
  total,
  loading,
  onChanged,
  title = '跟进逾期',
  emptyMessage = '没有超过 48 小时窗口的跟进。所有试听结果都已跟进。',
  footnote,
  overflowNoun = '逾期跟进',
  doneToast = '跟进已关闭，已联系家长。',
  emptyCta,
  onOpenFullQueue,
}: {
  items: QueueRow[];
  /** 全量计数，不是 items.length —— 数组上限 20 */
  total: number;
  loading: boolean;
  onChanged: () => void;
  /**
   * 标题 / 空态文案 / 底部说明行。默认值就是逾期区原来那三句（这个组件最初只为它写），
   * 课堂标记区按同一份渲染传自己的话；不传 footnote 就整行不渲染，逾期区的样子与从前一致。
   */
  title?: string;
  emptyMessage?: string;
  footnote?: string;
  /**
   * 「还有 N 条…未显示」里的那个名词。默认「逾期跟进」；课堂标记区传「标记」——
   * 那一区的行**按定义还没到期**，照抄「逾期跟进」会把「几条还没轮到你处理」说成
   * 「几条已经超时」，正是那一区最不该出现的一句谎话。
   */
  overflowNoun?: string;
  /**
   * 关闭成功后那句 toast。默认是逾期区原来那句。
   *
   * 课堂标记区传「跟进已关闭。」：本轮**没有任何地方记录「顾问跟家长说了什么」** ——
   * `parent_note` 那几列目前没有写入路径（`CompleteFollowUp` 只 `UPDATE ... note=?`），
   * 顾问写给家长那段话的输入框是下一轮才做的。所以对课堂标记行弹「已联系家长」，是系统
   * 替顾问作证一件它并不知道的事；这一区能担保的只有「这条待办关掉了」。
   * 试听那条队列同样没被记录，但它在界面上是隐藏的，不在本轮范围 —— 等 `parent_note`
   * 的写路径做出来，这两句话才会重新变成同一句真话。
   */
  doneToast?: string;
  /**
   * 空态 CTA 与「还有 N 条未显示」那个按钮的**同一个去处**；两个都不传时两处按钮都不渲染。
   *
   * 默认不渲染，是因为它们原本都指向 `/leads`，而那条跟进队列在界面上根本不存在（`/leads`
   * 右栏已按用户裁定撤下，`LeadsPage.Queue.tsx` 整份未被引用）：空态时它说「打开线索队列」、
   * 超过 20 条时说「打开完整队列」，两处都是点了落不到目标上的承诺。等哪天完整队列有了落点，
   * 把这两个 prop 传进来即可（逾期区若要恢复，也记得显式传 —— 默认已经不发这两个按钮了）。
   */
  emptyCta?: string;
  onOpenFullQueue?: () => void;
}) {
  const { push } = useToast();
  const navigate = useNavigate();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [closed, setClosed] = useState<number[]>([]);

  // 完成后先本地隐藏，再让父级重读队列：重读是整屏一次请求，
  // 若不等它回来就渲染，被关掉的那行会闪一下再消失。
  const visible = items.filter((row) => !closed.includes(row.id));

  async function complete(id: number) {
    setBusyId(id);
    try {
      await api.post(`/follow-ups/${id}/complete`, {});
      setClosed((prev) => [...prev, id]);
      push('success', doneToast);
      onChanged();
    } catch (err) {
      push('error', humaniseError(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Panel>
      <PanelHeader title={title} count={total} icon={<BellRing size={16} aria-hidden />} />
      <ListState
        loading={loading}
        error={null}
        isEmpty={visible.length === 0}
        emptyMessage={emptyMessage}
        emptyCta={emptyCta}
        onEmptyCta={onOpenFullQueue}
        rows={3}
        cols={4}
      >
        <div className="divide-y divide-border">
          {visible.map((row) => (
            <div
              key={row.id}
              className="flex items-center justify-between gap-3 px-4 py-2 hover:bg-row-hover transition-colors duration-150 ease-standard"
            >
              <div className="min-w-0 flex flex-col gap-0.5">
                {/* 队列行不带科目（dashboard.go 的 followUpRow 没有 trial_id），
                    所以把学生名做成通往档案的入口，背景信息在档案里一眼可见。 */}
                <button
                  type="button"
                  onClick={() => navigate(`/students?view=mine&student=${row.student_id}`)}
                  className="max-w-full truncate text-left text-row font-510 text-fg rounded-sm hover:text-accent transition-colors duration-150 ease-standard"
                  title="打开学生档案"
                >
                  {row.student_name}
                </button>
                <span className="num text-meta text-muted">截止 {dateTime(row.due_at)}</span>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <SlaCell dueAt={row.due_at} overdueHours={overdueHoursOf(row)} />
                <Button
                  variant="secondary"
                  size="sm"
                  loading={busyId === row.id}
                  disabled={busyId !== null}
                  onClick={() => void complete(row.id)}
                >
                  <CircleCheck size={16} aria-hidden />
                  标记为已跟进
                </Button>
              </div>
            </div>
          ))}
        </div>
      </ListState>
      {total > items.length && (
        <p className="flex items-center justify-between gap-3 px-4 py-2 border-t border-border">
          <span className="num text-meta text-muted">
            还有 {total - items.length} 条{overflowNoun}未显示
          </span>
          {/* 差额照实说，但按钮只在真有落点时才给：没有去处就不摆一个按下去会后悔的按钮。 */}
          {onOpenFullQueue && (
            <Button variant="ghost" size="sm" onClick={onOpenFullQueue}>
              打开完整队列
            </Button>
          )}
        </p>
      )}
      {/* 说明行与「还有 N 条未显示」分开两行：后者是服务端 20 条上限造成的差额（可能没有），
          前者是这个队列自己的规则（一定有）。挤进同一行会让「48 小时的窗口」看起来
          像是只在有隐藏行时才成立。 */}
      {footnote && (
        <p className="px-4 py-2 border-t border-border text-meta text-muted">{footnote}</p>
      )}
    </Panel>
  );
}
