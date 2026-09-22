/**
 * 工作台两区共用的「试听行 + 就地记录结果」。
 *
 * 「试听结果」是二维的（结果 × 是否已跟进），这里只负责结果维度：待记录结果的试听必须当场
 * 记录结果，因为 R2 规定「记录结果」那一刻才启动 48h 跟进时钟 —— 不记录就没有跟进，
 * 也就没有这条业务链。记录成功后回调父级刷新，新建出来的跟进任务会立刻出现在别处。
 *
 * 行由父级从 /dashboard/admin 收敛而来，两段队列（upcoming_trials / awaiting_outcome_trials）
 * 都自带 student_name / subject_name / teacher_name，所以不必再拿 trial_id 去翻科目名。
 * 两段的时间口径不同 —— 未来的说「今天/明天 15:00」，已上完的说「已结束 N 天」 —— 所以
 * 那一段由调用方以 meta 传进来；按钮、展开面板、摘行这些逐字共用，改一处两个区一起变。
 *
 * ⚠️ 展开态 / 备注 / 提交中都是**一次一份**的父级 state（见 useRecordOutcome），不是每行
 * 自带：同屏只允许一行展开，且一行提交时其余行的输入要一起锁住。改成每行自带会让两行
 * 同时展开 —— 那是行为变化，不是重构。
 *
 * ⚠️ 记完就本地摘掉这一行：SetOutcome 没有幂等闸（service/trial.go:58 每次调用都会新建一条
 * 跟进），若等重读回来再摘，中间那段窗口里按钮会重新可点，点下去就会多出一条重复跟进。
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { CalendarClock, CircleCheck, CircleDashed, CircleSlash, Clock } from 'lucide-react';
import { Button, Input, Panel, PanelHeader } from '../components/ui';
import { ListState } from '../components/StateViews';
import { useToast } from '../components/Toast';
import { api, humaniseError } from '../lib/api';
import { dateTime, hoursSinceEnd, shortDate, timeOfDay } from '../lib/format';
import type { FollowUp, TrialQueueRow } from '../lib/types';
import { datePartOf, melbourneDay } from './TodayPage.Async';

function dayLabel(iso: string): string {
  const date = datePartOf(iso);
  if (date === melbourneDay(0)) return '今天';
  if (date === melbourneDay(1)) return '明天';
  return shortDate(iso);
}

/**
 * 「记录结果」能不能按 —— 规则只有一条：试听结束了才能按，未结束（含时间戳无法解析）置灰。
 *
 * 服务端不拦这一步：提前记录会得到一条比实际结束时刻更早起算的 48h 时钟，所以闸门放在
 * 唯一能看见按钮的地方。判断只写在这里一处，「今日与明日试听」与「试听结束待记录」两区
 * 都调它 —— 那条队列里本来就有「明天 15:00」这种未来行，置灰是它的正常形态。
 */
export function canRecordOutcome(trial: TrialQueueRow): boolean {
  const hours = hoursSinceEnd(trial.scheduled_at, trial.duration_min);
  return hours !== null && hours >= 0;
}

export interface OutcomeRecording {
  openId: number | null;
  note: string;
  busyId: number | null;
  /** 本次会话里已经记过结果、要立刻从列表上摘掉的试听 id */
  recorded: number[];
  open: (id: number) => void;
  cancel: () => void;
  setNote: (value: string) => void;
  record: (id: number, outcome: 'converted' | 'lost') => Promise<void>;
}

/**
 * 记录结果的行交互状态机。两个区共用一份实现，首要理由是 **toast 文案必须逐字相同**：
 * 「已记录结果，请在 <时间> 前跟进。」说明的是 R2 的时钟从哪一刻起算，抄成两份后
 * 任何一边改了字，两个区对同一个动作的承诺就变得不一样了。
 */
export function useRecordOutcome(onChanged: () => void): OutcomeRecording {
  const { push } = useToast();
  const [openId, setOpenId] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);
  const [recorded, setRecorded] = useState<number[]>([]);

  function open(id: number) {
    setOpenId(id);
    setNote('');
  }

  function cancel() {
    setOpenId(null);
    setNote('');
  }

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

  return { openId, note, busyId, recorded, open, cancel, setNote, record };
}

/**
 * 一行试听 + 就地记录结果。行首是学生名与一行 meta（时间由调用方给，科目/老师在这里补，
 * 两段队列的字段口径一致），行尾是「记录结果」按钮，展开后是备注与结果二选一。
 */
export function RecordOutcomeRow({
  trial,
  meta,
  canRecord,
  recording,
}: {
  trial: TrialQueueRow;
  /** meta 行里**时间**那一段：各区的口径不同（未来的报钟点，已上完的报已结束多久） */
  meta: ReactNode;
  /** 未结束的行不给记录，见 canRecordOutcome */
  canRecord: boolean;
  recording: OutcomeRecording;
}) {
  const isOpen = recording.openId === trial.id;
  // 一行提交中时锁住所有输入，包括别的行：避免在同一个 48h 时钟上叠第二次提交。
  const locked = recording.busyId !== null;

  return (
    <div className="flex flex-col gap-2 px-4 py-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex flex-col gap-0.5">
          <span className="truncate text-row font-510 text-fg">{trial.student_name}</span>
          <span className="num flex items-center gap-1.5 text-meta text-muted">
            {meta}
            <span className="text-border-strong" aria-hidden>
              ·
            </span>
            {/* 用 || 不用 ??：dashboard 的试听 DTO 上 subject_name 是普通 string、没有
                omitempty，没科目时下发的是**空串**而不是缺键（见 openapi TrialRow）——
                ?? 只对 null/undefined 生效，兜不住空串，会渲染出一段空白。
                注意 GET /trials 那条路正好相反（那边带 omitempty、键会整个缺席），
                两条路不要互相照抄兜底代码。 */}
            {trial.subject_name || '未设置科目'}
            {trial.teacher_name ? ` · ${trial.teacher_name}` : ''}
          </span>
        </div>
        {!isOpen && (
          <Button
            variant="secondary"
            size="sm"
            disabled={!canRecord}
            // 置灰时 Chrome 不会弹出原生 title（disabled 元素不派发鼠标事件），但这仍然要写：
            // 它是这条规则给读屏与自动化测试的机器可读副本。
            title={canRecord ? undefined : '试听结束后才能记录结果'}
            onClick={() => recording.open(trial.id)}
          >
            <CircleDashed size={16} aria-hidden />
            记录结果
          </Button>
        )}
      </div>

      {isOpen && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-sunken px-2.5 py-2">
          <Input
            value={recording.note}
            onChange={(e) => recording.setNote(e.target.value)}
            placeholder="试听情况如何？"
            aria-label="试听反馈备注"
            className="min-w-[220px] flex-1"
            disabled={locked}
          />
          <Button
            variant="primary"
            size="sm"
            loading={recording.busyId === trial.id}
            disabled={locked}
            onClick={() => void recording.record(trial.id, 'converted')}
          >
            <CircleCheck size={16} aria-hidden />
            已转化
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={locked}
            onClick={() => void recording.record(trial.id, 'lost')}
          >
            <CircleSlash size={16} aria-hidden />
            未转化
          </Button>
          <Button variant="ghost" size="sm" disabled={locked} onClick={recording.cancel}>
            取消
          </Button>
        </div>
      )}
    </div>
  );
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
  const navigate = useNavigate();
  const recording = useRecordOutcome(onChanged);

  const visible = items.filter((trial) => !recording.recorded.includes(trial.id));

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
          {visible.map((trial) => (
            <RecordOutcomeRow
              key={trial.id}
              trial={trial}
              canRecord={canRecordOutcome(trial)}
              recording={recording}
              meta={
                <>
                  <Clock size={16} aria-hidden />
                  {dayLabel(trial.scheduled_at)} {timeOfDay(trial.scheduled_at)}
                </>
              }
            />
          ))}
        </div>
      </ListState>
      <p className="px-4 py-2 border-t border-border text-meta text-muted">
        记录结果会在同一事务中启动 48 小时跟进时钟。
      </p>
    </Panel>
  );
}
