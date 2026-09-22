/**
 * admin 工作台 /today —— 打开就能开始干活的一屏（UIUX §6.2、§7.1）。
 *
 * 四个分区按「今天必须处理的紧急度」排序，不是按数据表顺序：
 *   1 试听结束待记录（课已经上完、结果没人记，跟进时钟就还没起跑 —— 全系统里唯一
 *                       顾问此刻就能操作的行）
 *   2 课堂记录标记（老师在点名页点名要你去处理 —— 同属「现在就该动」，但它和 1 的区别是
 *                       窗口还没过，所以排在 1 后面、浏览性的队列之前）
 *   3 今日/明日试听（记录结果才会启动跟进时钟）
 *   4 低课时（钱快用完了，催续费要 1 步）
 *
 * ⚠️ 「跟进逾期」那一区**暂时不展示**（2026-09-22 用户裁定）。
 * 它的判定本身是对的（dashboard.go:96：status='pending' + due_at < now + 归你），
 * 但界面上读起来像是在说「这些人的试听结果拖了 48 小时还没填」—— 实际正相反：
 * 能进这一区的都是**已经填过结果**的，因为跟进任务是 SetOutcome 的产物
 * （service/trial.go:115，due_at = 记录结果的时刻 + 48h）。产品负责人自己第一遍就读反了，
 * 而这一屏的全部价值就在「一眼看懂该干什么」，一个会被读反的区块在这里是负分。
 *
 * 隐藏它**不丢写入能力**，但要注意：`/leads` 右栏那个可浏览的跟进队列也在同一天撤下了
 * （同一个理由，见 LeadsPage.tsx 的文件头注释），所以「看逾期跟进」现在只剩非界面的一条路：
 *   - 看逾期跟进 → GET /follow-ups?status=overdue（不是这个端点）。界面上只剩
 *                  /leads 页头的「N 条逾期」计数这一个数字痕迹
 *   - 标记已跟进 → 学生抽屉转化卡上的「完成跟进」（LeadsPage.Playbook.tsx:125）。
 *                  ⚠️ 抽屉目前只能从「未转化」行的「转化方案」按钮打开
 *                  （LeadsPage.Trials.tsx:143），已转化行没有入口 —— 右栏撤下前它兜住了
 *                  这一批，撤下后这批跟进在界面上没有路径，只剩服务端 API
 *   - 挽回未转化 → /leads 的「未转化」档，行内就有「转化方案」（LeadsPage.Trials.tsx:143）
 *   - 提醒去开账 → 本页的「低课时」区兜底：转化后没开账的学生余额为 0，必定落进来
 *                  （openAccountForConversion 只在 seed 里，生产路径不会自动开账）
 * 后端**一行未改** —— dashboard 仍照常下发 overdue_follow_ups，契约不变；同目录的
 * TodayPage.FollowUps.tsx 也保留着，把下面那段注释放开就能恢复这一区（import 已经在上面了 ——
 * 同页的「课堂记录标记」区正是用同一个组件渲染的）。
 *
 * 四个面板各自仍然有自己的 loading 与 empty（骨架行数与空态文案各不相同），而异步区只有
 * 一个：它的 error 只在页面级渲染一次，不给四个面板各贴一条同样的报错。
 */
import { useMemo, useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { Panel } from '../components/ui';
import { ErrorState } from '../components/StateViews';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { AdminDashboard } from '../lib/types';
import { datePartOf, melbourneDay, melbourneLongDate, useAsync } from './TodayPage.Async';
import { LowCreditSection } from './TodayPage.LowCredit';
import { AwaitingOutcomeSection } from './TodayPage.Awaiting';
import { FollowUpsSection } from './TodayPage.FollowUps';
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
          {/* 「跟进逾期」这一区暂时不展示 —— 理由与四条替代出路见文件头注释。
              恢复方式：把下面这段注释放开；FollowUpsSection 的 import 已经在上面了
              （「课堂记录标记」那一区在用它，同一个组件、同一份行渲染）。
              ⚠️ 放开时若还想保留原来那个「打开线索队列」CTA 与「打开完整队列」按钮，
              要把 emptyCta / onOpenFullQueue 显式传进来（两个都指向 /leads，而那条队列在
              界面上不存在，所以组件现在默认不发这两个按钮，不传就是没有）。
          <FollowUpsSection
            items={data?.overdue_follow_ups ?? []}
            total={data?.overdue_followups ?? 0}
            loading={firstLoad}
            onChanged={bump}
          />
          */}

          <AwaitingOutcomeSection
            items={data?.awaiting_outcome_trials ?? []}
            total={data?.awaiting_outcome_trials_count ?? 0}
            loading={firstLoad}
            onChanged={bump}
          />

          {/* 课堂记录标记排在「待记录结果」之后、「今日与明日试听」之前：前两区都是
              「有人点名要你现在处理」，属于现在就该动的动作，而试听与低课时是按时序或按
              余额扫过去的队列。另外这一区**不按是否逾期过滤**（逾期的行也留在这里）：
              逾期区按 source 只收试听转化，而且它当前在界面上是隐藏的（见文件头注释），
              甩过去等于让这条任务凭空消失。
              不传 emptyCta / onOpenFullQueue：这一区没有可去的「完整队列」，两处按钮都
              省掉（见 TodayPage.FollowUps.tsx 的 props 注释）；doneToast 也不能照抄
              「已联系家长」—— 本轮没有任何地方记录顾问跟家长说了什么。 */}
          <FollowUpsSection
            title="课堂记录标记"
            emptyMessage="老师标记需要顾问跟进的内容会出现在这里。"
            footnote="老师在点名页勾「需要顾问跟进」时会开出这一条，窗口 48 小时。"
            overflowNoun="标记"
            doneToast="跟进已关闭。"
            items={data?.flagged_follow_ups ?? []}
            total={data?.flagged_followups ?? 0}
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
