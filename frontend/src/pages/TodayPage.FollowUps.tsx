/**
 * 工作台第一区：跟进超期。这是最贵的一条队列 —— 试听记录完结果后 48h 内没联系家长，
 * 转化率就掉。所以它排在第一区，且行内就能闭环（不跳页、不开新标签）。
 *
 * 「超期多久」的语义由相对时间文案 + SLA 条承担（UIUX §4.3），不靠红色 badge。
 * 逾期判定在服务端（dashboard.go:67-71 用 due_at < now 取），并且服务端把**逾期小时数**
 * 下发在 overdue_hours 上（ADR-007：不在前端按时间戳重算）。overdueLabel 把它转成主文案；
 * 服务端没给（null）时才回落到前端按时间戳算的 slaCountdown.label。slaCountdown 另供
 * SLA 条的比例与配色（tone 决定图标与填充色，ratio 决定填充宽度）。
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
import type { FollowUpQueueRow } from '../lib/types';

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
}: {
  items: FollowUpQueueRow[];
  total: number;
  loading: boolean;
  onChanged: () => void;
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
      push('success', '跟进已关闭，已联系家长。');
      onChanged();
    } catch (err) {
      push('error', humaniseError(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Panel>
      <PanelHeader title="跟进逾期" count={total} icon={<BellRing size={16} aria-hidden />} />
      <ListState
        loading={loading}
        error={null}
        isEmpty={visible.length === 0}
        emptyMessage="没有超过 48 小时窗口的跟进。所有试听结果都已跟进。"
        emptyCta="打开线索队列"
        onEmptyCta={() => navigate('/leads')}
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
                <SlaCell dueAt={row.due_at} overdueHours={row.overdue_hours} />
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
            还有 {total - items.length} 条逾期跟进未显示
          </span>
          <Button variant="ghost" size="sm" onClick={() => navigate('/leads')}>
            打开完整队列
          </Button>
        </p>
      )}
    </Panel>
  );
}
