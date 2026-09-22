/**
 * 试听列表 —— 每一行都能**就地**记录结果，不跳页（对标 Height/Plane 的行内推进）。
 * 记录结果是 R2 的触发器：服务端在同一个事务里生成 48h 跟进任务。
 */
import { useState } from 'react';
import { ChevronDown, ChevronRight, Sparkles } from 'lucide-react';
import { Button, Input } from '../components/ui';
import { ListState } from '../components/StateViews';
import { dateTime } from '../lib/format';
import { OutcomeBadge } from './LeadsPage.Shared';
import type { TrialListRow } from './LeadsPage.Shared';

const GRID = 'grid grid-cols-[104px_minmax(0,1.5fr)_minmax(0,1fr)_150px_minmax(0,1fr)_auto] gap-4 items-center';

export default function LeadsTrials({
  trials,
  loading,
  error,
  onRetry,
  selectedId,
  onSelect,
  onRecord,
}: {
  trials: TrialListRow[];
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  selectedId: number | null;
  onSelect: (trial: TrialListRow) => void;
  onRecord: (trialId: number, outcome: 'converted' | 'lost', note: string) => Promise<void>;
}) {
  const [openId, setOpenId] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'converted' | 'lost' | null>(null);

  async function submit(trialId: number, outcome: 'converted' | 'lost') {
    setBusy(outcome);
    try {
      await onRecord(trialId, outcome, note.trim());
      setOpenId(null);
      setNote('');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col">
      <div className={`${GRID} px-4 h-9 border-b border-border bg-surface-sunken`}>
        <span className="col-header">结果</span>
        <span className="col-header">学生</span>
        <span className="col-header">科目</span>
        <span className="col-header">试听时间</span>
        <span className="col-header">老师</span>
        <span className="col-header text-right">下一步</span>
      </div>

      <ListState
        loading={loading}
        error={error}
        isEmpty={trials.length === 0}
        emptyMessage="暂无符合该筛选条件的试听。"
        emptyCta="显示全部试听"
        onEmptyCta={onRetry}
        onRetry={onRetry}
        rows={5}
        cols={5}
      >
        <div className="divide-y divide-border">
          {trials.map((trial) => {
            const isOpen = openId === trial.id;
            const isSelected = selectedId === trial.id;
            return (
              <div key={trial.id} className={isSelected ? 'bg-accent-bg' : ''}>
                <div className={`${GRID} px-4 min-h-9 py-1.5 hover:bg-row-hover transition-colors duration-150 ease-standard`}>
                  <OutcomeBadge outcome={trial.outcome} />
                  <span className="text-row font-510 text-fg truncate" title={trial.student_name}>
                    {trial.student_name ?? `学生 #${trial.student_id}`}
                  </span>
                  <span className="text-row text-fg-2 truncate">{trial.subject_name ?? '—'}</span>
                  <span className="num text-meta text-muted">{dateTime(trial.scheduled_at)}</span>
                  <span className="text-meta text-muted truncate">{trial.teacher_name ?? '未分配'}</span>
                  <span className="flex justify-end gap-2">
                    {trial.outcome === 'pending' ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          setOpenId(isOpen ? null : trial.id);
                          setNote('');
                        }}
                        aria-expanded={isOpen}
                      >
                        {isOpen ? <ChevronDown size={16} aria-hidden /> : <ChevronRight size={16} aria-hidden />}
                        记录结果
                      </Button>
                    ) : trial.outcome === 'lost' ? (
                      // 只有「未转化」才给转化方案：已转化的家庭已经答应了，再推一份说服方案
                      // 是自相矛盾的；而未转化的正是要挽回的那一批。
                      <Button variant="secondary" size="sm" onClick={() => onSelect(trial)}>
                        <Sparkles size={16} aria-hidden />
                        转化方案
                      </Button>
                    ) : null}
                  </span>
                </div>

                {isOpen && (
                  <div className="px-4 pb-3 pt-1 bg-surface-sunken border-t border-border">
                    <p className="text-meta text-muted mb-2">
                      记录结果会立即生成一条 48 小时后到期的跟进任务，并马上出现在右侧队列中。
                    </p>
                    <div className="flex flex-wrap items-end gap-2">
                      <Input
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        placeholder="家庭怎么说的？（选填）"
                        aria-label="结果备注"
                        className="max-w-sm"
                      />
                      <Button
                        variant="primary"
                        size="sm"
                        loading={busy === 'converted'}
                        disabled={busy !== null}
                        onClick={() => void submit(trial.id, 'converted')}
                      >
                        已转化
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        loading={busy === 'lost'}
                        disabled={busy !== null}
                        onClick={() => void submit(trial.id, 'lost')}
                      >
                        未转化
                      </Button>
                      <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => setOpenId(null)}>
                        取消
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </ListState>
    </div>
  );
}
