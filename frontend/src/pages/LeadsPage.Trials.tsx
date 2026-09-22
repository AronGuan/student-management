/**
 * 试听列表 —— 每一行都能**就地**记录结果，不跳页（对标 Height/Plane 的行内推进）。
 * 记录结果是 R2 的触发器：服务端在同一个事务里生成 48h 跟进任务。
 */
import { useState } from 'react';
import { ChevronDown, ChevronRight, Sparkles } from 'lucide-react';
import { Button, Input, Pager } from '../components/ui';
import { ListState } from '../components/StateViews';
import { dateTime, endedAgoLabel, hoursSinceEnd } from '../lib/format';
import { OutcomeBadge } from './LeadsPage.Shared';
import type { TrialListRow } from './LeadsPage.Shared';

// 末列必须是固定轨道：表头与每一行都是各自的 grid 容器，`auto` 会按行解析 ——
// 表头那格只有文字（窄）、已转化行是空（0）、未转化/待记录行是按钮（约 94px），
// 于是每行各自解出一套模板，学生/科目/老师三列的列位就会随行漂移。
// 固定 120px（按钮实测约 94px，留 26px 余量）后所有容器解出同一套轨道。
const GRID = 'grid grid-cols-[104px_minmax(0,1.5fr)_minmax(0,1fr)_150px_minmax(0,1fr)_120px] gap-4 items-center';

export default function LeadsTrials({
  trials,
  loading,
  error,
  onRetry,
  selectedId,
  onSelect,
  onRecord,
  total,
  page,
  hasMore,
  onPageChange,
}: {
  trials: TrialListRow[];
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  selectedId: number | null;
  onSelect: (trial: TrialListRow) => void;
  onRecord: (trialId: number, outcome: 'converted' | 'lost', note: string) => Promise<void>;
  total: number;
  page: number;
  hasMore: boolean;
  onPageChange: (next: number) => void;
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
            // 「已结束但结果还没记」是这一档里唯一需要动作的状态：服务端已经把这些行
            // 排到最前（handler/trial.go 的 pending 排序键），前端只负责让它们看得见。
            // 未开始 / 正在试听的行不渲染任何东西 —— 顾问对它们无事可做，一个「还没结束」
            // 的标记只是往表里加噪音。已转化 / 未转化的行也早已结束，但那些标签页是历史
            // 列表，给每一行都挂一个「已结束 30 天」同样没有信息量，所以按 outcome 收口，
            // 不按时间收口。
            const endedHours =
              trial.outcome === 'pending' ? hoursSinceEnd(trial.scheduled_at, trial.duration_min) : null;
            const endedAgo = endedAgoLabel(endedHours);
            return (
              <div key={trial.id} className={isSelected ? 'bg-accent-bg' : ''}>
                <div className={`${GRID} px-4 min-h-9 py-1.5 hover:bg-row-hover transition-colors duration-150 ease-standard`}>
                  <OutcomeBadge outcome={trial.outcome} />
                  <span className="text-row font-510 text-fg truncate" title={trial.student_name}>
                    {trial.student_name ?? `学生 #${trial.student_id}`}
                  </span>
                  <span className="text-row text-fg-2 truncate">{trial.subject_name ?? '—'}</span>
                  <span className="flex flex-col leading-tight">
                    <span className="num text-meta text-muted">{dateTime(trial.scheduled_at)}</span>
                    {endedAgo !== null && (
                      // 24 小时以内用 warn、超过用 danger：同一天下午刚下课和上周还没记
                      // 是两件事，用同一个颜色会让「积压」看不出来。形状不变，只用颜色分级。
                      //
                      // ⚠️ 这里**绝不能**写 text-meta。本项目 index.css 里 `--color-meta`
                      // 与 `--text-meta` 撞了名，Tailwind 只产出了后者中的颜色那一份
                      // （编译产物里 `var(--text-meta)` 一次都不出现），于是 text-meta 实际
                      // 是个**颜色**工具类；而 Tailwind 按 token 名字母序产出，`.text-meta`
                      // 排在 `.text-danger` 之后 —— 同优先级下红色被静默盖成灰色。
                      // 症状：只有 text-warn（字母序在 meta 之后）生效，红色全部失效。
                      // text-row 只给字号、没有同名的颜色 token，与两者组合都安全
                      // （LoginPage 的错误条就是 text-row + text-danger）。
                      <span
                        className={`text-row font-510 ${
                          endedHours !== null && endedHours >= 24 ? 'text-danger' : 'text-warn'
                        }`}
                      >
                        {endedAgo}
                      </span>
                    )}
                  </span>
                  <span className="text-meta text-muted truncate">{trial.teacher_name ?? '未分配'}</span>
                  <span className="flex justify-end gap-2">
                    {trial.outcome === 'pending' ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        // 试听结束以后才可以记录结果 —— 与工作台同一条规则、同一个判据
                        // （今天页的 canRecordOutcome 也是拿 hoursSinceEnd 现算）。
                        // 这里直接用上面那个 endedAgo：它只对 pending 行求解，为 null 当且
                        // 仅当「还没下课 / 时间戳解析不了」，正好是置灰条件，不必再算一遍。
                        // 服务端不拦这一步：提前记录会得到一条比实际结束时刻更早起算的 48h 时钟。
                        disabled={endedAgo === null}
                        // 置灰时 Chrome 不弹原生 title（disabled 元素不派发鼠标事件），仍要写：
                        // 它是这条规则给读屏与自动化测试的机器可读副本。
                        title={endedAgo === null ? '试听结束后才能记录结果' : undefined}
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
                      记录结果会立即生成一条 48 小时后到期的跟进任务（服务端同一事务）。到期前后都可以在学生抽屉的转化卡上「完成跟进」。
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

      {/* 分页器只属于「有数据」这一态：加载中 / 空 / 报错都由 ListState 承担，不该出现翻页。 */}
      {!loading && !error && (
        <Pager page={page} total={total} shown={trials.length} hasMore={hasMore} onPage={onPageChange} />
      )}
    </div>
  );
}
