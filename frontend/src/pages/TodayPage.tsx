/**
 * admin 工作台 /today —— 打开就能开始干活的一屏（UIUX §6.2、§7.1）。
 *
 * 三个分区按「今天必须处理的紧急度」排序，不是按数据表顺序：
 *   1 跟进超期（最贵，48h 没联系就掉转化）
 *   2 今日/明日试听（记录结果才会启动跟进时钟）
 *   3 低课时（钱快用完了，催续费要 1 步）
 *
 * 三条队列都来自**同一个** GET /dashboard/admin（handler/dashboard.go:54）：它就是为这一屏
 * 写的，而且三条都按 owner_admin_id 收敛到「你自己的学生」。此前第二区读 /trials，
 * 那条接口不带 owner 过滤，会把同事名下的试听也铺到你的工作台上，与另外两区的口径不一致。
 * 换成单一响应后还顺带省掉了「拿 trial_id 反查科目名」那张映射表 —— 队列行自带
 * student_name / subject_name / teacher_name。
 *
 * 因此这里只有一个异步区：它的 error 只在页面级渲染一次，不给三个面板各贴一条同样的报错。
 * 三个面板各自仍然有自己的 loading 与 empty（骨架行数与空态文案各不相同）。
 */
import { useMemo, useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { Panel } from '../components/ui';
import { ErrorState } from '../components/StateViews';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { AdminDashboard } from '../lib/types';
import { datePartOf, melbourneDay, melbourneLongDate, useAsync } from './TodayPage.Async';
import { FollowUpsSection } from './TodayPage.FollowUps';
import { LowCreditSection } from './TodayPage.LowCredit';
import { TrialsSection } from './TodayPage.Trials';

export default function TodayPage() {
  const { me } = useAuth();
  const [nonce, setNonce] = useState(0);
  const bump = () => setNonce((n) => n + 1);

  const dash = useAsync(() => api.get<AdminDashboard>('/dashboard/admin'), [nonce]);
  const data = dash.data;
  const firstLoad = dash.loading && data === null;

  const today = melbourneDay(0);
  const tomorrow = melbourneDay(1);

  // 队列给的是「从现在起的试听」（scheduled_at >= now，按时间升序，最多 10 条），
  // 所以最近两天一定在里面；这里再收敛到「今天或明天且还没记录结果」。
  const trials = useMemo(
    () =>
      (data?.upcoming_trials ?? [])
        .filter((trial) => trial.outcome === 'pending' && [today, tomorrow].includes(datePartOf(trial.scheduled_at)))
        .sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at)),
    [data, today, tomorrow],
  );

  return (
    <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-4 px-5 py-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="page-title text-fg">今日</h1>
          <p className="flex flex-wrap items-center gap-1.5 text-meta text-muted">
            <CalendarDays size={16} aria-hidden />
            <span>{melbourneLongDate()}</span>
            <span>· 墨尔本时间</span>
            {data !== null && (
              <span className="num">· 今天你的学生有 {data.today_lessons} 节课</span>
            )}
          </p>
        </div>
        <span className="text-meta text-muted">{me?.user.display_name}</span>
      </header>

      {dash.error ? (
        <Panel>
          <ErrorState error={dash.error} onRetry={dash.reload} />
        </Panel>
      ) : (
        <>
          <FollowUpsSection
            items={data?.overdue_follow_ups ?? []}
            total={data?.overdue_followups ?? 0}
            loading={firstLoad}
            onChanged={bump}
          />

          <TrialsSection items={trials} loading={firstLoad} onChanged={bump} />

          <LowCreditSection
            items={data?.low_credit ?? []}
            total={data?.low_credit_students ?? 0}
            loading={firstLoad}
            onChanged={bump}
          />
        </>
      )}
    </div>
  );
}
