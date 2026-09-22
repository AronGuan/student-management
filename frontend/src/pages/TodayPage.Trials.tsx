/**
 * 工作台第二区：今日 / 明日试听。
 *
 * 「试听结果」是二维的（结果 × 是否已跟进），这里只负责结果维度：待反馈的试听必须当场
 * 记录结果，因为 R2 规定「记录结果」那一刻才启动 48h 跟进时钟 —— 不记录就没有跟进，
 * 也就没有这条业务链。记录成功后回调父级刷新，新建出来的跟进任务会立刻出现在第一区。
 *
 * 行由父级从 /dashboard/admin 的 upcoming_trials 收敛而来，该队列自带 student_name /
 * subject_name / teacher_name，所以不必再拿 trial_id 去翻科目名。
 *
 * 记完就本地摘掉这一行：SetOutcome 没有幂等闸（service/trial.go:58 每次调用都会新建一条
 * 跟进），若等重读回来再摘，中间那段窗口里按钮会重新可点，点下去就会多出一条重复跟进。
 */
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { CalendarClock, CircleCheck, CircleDashed, CircleSlash, Clock } from 'lucide-react';
import { Button, Input, Panel, PanelHeader } from '../components/ui';
import { ListState } from '../components/StateViews';
import { useToast } from '../components/Toast';
import { api, humaniseError } from '../lib/api';
import { dateTime, shortDate, timeOfDay } from '../lib/format';
import type { FollowUp, TrialQueueRow } from '../lib/types';
import { datePartOf, melbourneDay } from './TodayPage.Async';

function dayLabel(iso: string): string {
  const date = datePartOf(iso);
  if (date === melbourneDay(0)) return '今天';
  if (date === melbourneDay(1)) return '明天';
  return shortDate(iso);
}

export function TrialsSection({
  items,
  loading,
  onChanged,
}: {
  items: TrialQueueRow[];
  loading: boolean;
  onChanged: () => void;
}) {
  const { push } = useToast();
  const navigate = useNavigate();
  const [openId, setOpenId] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);
  const [recorded, setRecorded] = useState<number[]>([]);

  const visible = items.filter((trial) => !recorded.includes(trial.id));

  async function record(id: number, outcome: 'converted' | 'lost') {
    setBusyId(id);
    try {
      const followUp = await api.post<FollowUp>(`/trials/${id}/outcome`, { outcome, note });
      setRecorded((prev) => [...prev, id]);
      setOpenId(null);
      setNote('');
      push('success', `已记录结果，请在 ${dateTime(followUp.due_at)} 前跟进。`);
      onChanged();
    } catch (err) {
      push('error', humaniseError(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Panel>
      <PanelHeader
        title="今日与明日试听"
        count={visible.length}
        icon={<CalendarClock size={16} aria-hidden />}
      />
      <ListState
        loading={loading}
        error={null}
        isEmpty={visible.length === 0}
        emptyMessage="今天和明天都没有预约的试听。预约后会在试听当天出现在这里。"
        emptyCta="在线索页预约试听"
        onEmptyCta={() => navigate('/leads')}
        rows={3}
        cols={3}
      >
        <div className="divide-y divide-border">
          {visible.map((trial) => {
            const open = openId === trial.id;
            return (
              <div key={trial.id} className="flex flex-col gap-2 px-4 py-2.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex flex-col gap-0.5">
                    <span className="truncate text-row font-510 text-fg">{trial.student_name}</span>
                    <span className="num flex items-center gap-1.5 text-meta text-muted">
                      <Clock size={16} aria-hidden />
                      {dayLabel(trial.scheduled_at)} {timeOfDay(trial.scheduled_at)}
                      <span className="text-border-strong" aria-hidden>
                        ·
                      </span>
                      {trial.subject_name ?? '未设置科目'}
                      {trial.teacher_name ? ` · ${trial.teacher_name}` : ''}
                    </span>
                  </div>
                  {!open && (
                    <Button variant="secondary" size="sm" onClick={() => setOpenId(trial.id)}>
                      <CircleDashed size={16} aria-hidden />
                      记录结果
                    </Button>
                  )}
                </div>

                {open && (
                  <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-sunken px-2.5 py-2">
                    <Input
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="试听情况如何？"
                      aria-label="试听反馈备注"
                      className="min-w-[220px] flex-1"
                      disabled={busyId !== null}
                    />
                    <Button
                      variant="primary"
                      size="sm"
                      loading={busyId === trial.id}
                      disabled={busyId !== null}
                      onClick={() => void record(trial.id, 'converted')}
                    >
                      <CircleCheck size={16} aria-hidden />
                      已转化
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busyId !== null}
                      onClick={() => void record(trial.id, 'lost')}
                    >
                      <CircleSlash size={16} aria-hidden />
                      未转化
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busyId !== null}
                      onClick={() => {
                        setOpenId(null);
                        setNote('');
                      }}
                    >
                      取消
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </ListState>
      <p className="px-4 py-2 border-t border-border text-meta text-muted">
        记录结果会在同一事务中启动 48 小时跟进时钟。
      </p>
    </Panel>
  );
}
