/**
 * 工作台第一区：试听结束待记录。
 *
 * 为什么排在最上面：这一批是全系统里唯一「顾问此刻就能操作」的行 —— 课已经上完了，
 * 结果没人记，48h 跟进时钟就还没起跑（R2）。而 /dashboard/admin 的 upcoming_trials
 * 只发未来的试听，这一批以前在界面上根本没有入口（只能靠顾问自己想起来去 /leads 翻）。
 *
 * ⚠️ 标题不叫「待跟进」：跟进在本系统里特指「记录结果之后生成的 48h 任务」，而这一区
 * 页面上的动作是**记录结果** —— 课刚上完、结果还没填。两个词混用正是工作台「跟进逾期」
 * 那一区被撤下的原因（见 TodayPage.tsx 文件头）。同一个东西只给一个名字。
 *
 * 行本身复用 TodayPage.Trials.tsx 的 RecordOutcomeRow：按钮、展开面板、摘行与
 * 「今日与明日试听」逐字同源，只有 meta 那一段的时间口径不同（这里报「已结束多久」）。
 */
import { useNavigate } from 'react-router';
import { CircleAlert, ClipboardList } from 'lucide-react';
import { Panel, PanelHeader } from '../components/ui';
import { ListState } from '../components/StateViews';
import { endedAgoLabel, hoursSinceEnd } from '../lib/format';
import type { TrialQueueRow } from '../lib/types';
import { RecordOutcomeRow, useRecordOutcome } from './TodayPage.Trials';

export function AwaitingOutcomeSection({
  items,
  total,
  loading,
  onChanged,
}: {
  items: TrialQueueRow[];
  /** 全量计数，不是 items.length —— 数组上限 20 */
  total: number;
  loading: boolean;
  onChanged: () => void;
}) {
  const navigate = useNavigate();
  const recording = useRecordOutcome(onChanged);

  const visible = items.filter((trial) => !recording.recorded.includes(trial.id));

  return (
    <Panel>
      <PanelHeader
        title="试听结束待记录"
        count={total}
        icon={<ClipboardList size={16} aria-hidden />}
      />
      <ListState
        loading={loading}
        error={null}
        isEmpty={visible.length === 0}
        emptyMessage="没有已上完但还没记结果的试听。"
        // CTA 文案不能写成「安排试听」：这一区空了并不代表团里没有试听，而是没有**该记结果的**，
        // 所以按钮带去的是试听总表（也就是记录结果会发生的地方），不是一个预约动作。
        emptyCta="打开线索与试听"
        onEmptyCta={() => navigate('/leads')}
        rows={3}
        cols={3}
      >
        <div className="divide-y divide-border">
          {visible.map((trial) => {
            const hours = hoursSinceEnd(trial.scheduled_at, trial.duration_min);
            // 服务端只把这批行发进来（服务端口径：结束时刻 <= now），所以 hours 为负只可能是
            // 浏览器时钟比服务端慢了几分钟。这种时候显示「刚刚结束」而不是不显示：不显示会让
            // meta 行只剩一个孤零零的图标，读起来像数据缺失。
            const endedAgo = endedAgoLabel(hours) ?? '刚刚结束';
            return (
              <RecordOutcomeRow
                key={trial.id}
                trial={trial}
                // 这一区的行**结构性**就是已结束的：能进这一队列的唯一判据是服务端算的
                // `scheduled_at + duration_min <= now`，所以按钮永远可记录，不需要（也不应该）
                // 拿浏览器时钟把 canRecordOutcome 再算一遍 —— 那只会多出一个失败模式：浏览器
                // 时钟比服务端慢几秒时，行上写着「刚刚结束」而按钮灰着说「试听结束后才能记录
                // 结果」，两句话互相打脸。置灰那条规则是给可能含未来行的「今日与明日试听」和
                // /leads 试听表准备的，那两处的行才可能是未来的。
                canRecord
                recording={recording}
                meta={
                  /*
                    ⚠️ 这里**绝不能**写 text-meta：index.css 的 --color-meta 与 --text-meta
                    撞了名，Tailwind 只产出了颜色那一份，而它按 token 名字母序产出 —— .text-meta
                    排在 .text-danger 之后，同优先级下红色会被静默盖成灰（只有 text-warn 侥幸生效）。
                    text-row 只给字号、没有同名的颜色 token，与两个颜色都能安全组合。
                    同一处坑在 LeadsPage.Trials.tsx 里有更长的记录。
                  */
                  <span
                    className={`flex items-center gap-1.5 text-row font-510 ${
                      hours !== null && hours >= 24 ? 'text-danger' : 'text-warn'
                    }`}
                  >
                    <CircleAlert size={16} aria-hidden />
                    {endedAgo}
                  </span>
                }
              />
            );
          })}
        </div>
      </ListState>
      <p className="flex items-center justify-between gap-3 px-4 py-2 border-t border-border text-meta text-muted">
        <span>记录结果会在同一事务中启动 48 小时跟进时钟。</span>
        {total > items.length && <span className="num shrink-0">还有 {total - items.length} 条未显示</span>}
      </p>
    </Panel>
  );
}
