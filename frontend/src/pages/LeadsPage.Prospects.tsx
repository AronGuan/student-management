/**
 * 线索表 —— 漏斗的第一栏，只渲染 `status='lead'` 的学生行。
 *
 * 与试听表（LeadsPage.Trials.tsx）是**两个模型**：试听行的单位是「一次试听」，线索行的
 * 单位是「一个还没约过试听的家庭」。所以这里是学生行，数据来自 GET /students?status=lead
 * （不是从试听行里反推 —— 反推的话，一个没有任何试听的线索根本不会出现）。
 *
 * 归属收口的写法与 /trials 一致：只列自己名下的（handler 侧 owner_admin_id=me），
 * 于是「我的线索」这件事在服务端就定了，前端不自己过滤。
 *
 * 行内唯一的动作是「安排试听」，且**只在 can_write 为真时渲染** —— R7：admin 能读全部
 * 学生，但只能写自己名下的。对别人的线索点一下只会拿到 40301，所以直接把按钮收掉，
 * 而不是让用户点了才知道。判断只认服务端算好的那个布尔，不在浏览器里比较 owner_admin_id。
 *
 * 末列不是「跟进」，是「录入 / 已晾 N 天」—— 理由见该列旁的注释：待跟进在这一档里
 * 结构性不存在（跟进任务只在记录试听结果时生成，而那一刻学生已不再是线索）。
 */
import { CalendarPlus } from 'lucide-react';
import { Button, Pager } from '../components/ui';
import { ListState } from '../components/StateViews';
import { daysSince, shortDate } from '../lib/format';
import type { StudentListItem } from '../lib/types';

/**
 * 列轨道。末列必须是**固定** 120px，理由与试听表逐字相同（见 LeadsPage.Trials.tsx 的
 * GRID 注释）：表头与每一行都是各自的 grid 容器，末列若写 `auto` 就会按行解析，
 * 「安排试听」按钮行与无按钮的只读行解出不同的模板，列位随之漂移。
 *
 * 两个 fr 轨道都带 `minmax(0,…)`：裸 `1fr` 的最小尺寸是 min-content，长姓名/长来源
 * 会把轨道撑开并挤走邻列 —— 那正是同一类漂移的另一种走法。
 */
const GRID = 'grid grid-cols-[minmax(0,1.6fr)_88px_minmax(0,1fr)_minmax(0,1fr)_104px_120px] gap-4 items-center';

export default function LeadsProspects({
  leads,
  loading,
  error,
  onRetry,
  myId,
  onBook,
  onCreate,
  total,
  page,
  hasMore,
  onPageChange,
}: {
  leads: StudentListItem[];
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  myId: number | undefined;
  onBook: (student: StudentListItem) => void;
  onCreate: () => void;
  total: number;
  page: number;
  hasMore: boolean;
  onPageChange: (next: number) => void;
}) {
  return (
    <div className="flex flex-col">
      <div className={`${GRID} px-4 h-9 border-b border-border bg-surface-sunken`}>
        <span className="col-header">学生</span>
        <span className="col-header">年级</span>
        <span className="col-header">来源</span>
        <span className="col-header">负责人</span>
        <span className="col-header">录入 / 已晾</span>
        <span className="col-header text-right">下一步</span>
      </div>

      <ListState
        loading={loading}
        error={error}
        isEmpty={leads.length === 0}
        emptyMessage="还没有未转化的线索。登记一条，他就会出现在这里，然后才能约试听。"
        emptyCta="登记线索"
        onEmptyCta={onCreate}
        onRetry={onRetry}
        rows={5}
        cols={6}
      >
        <div className="divide-y divide-border">
          {leads.map((student) => {
            // 晾了多久。created_at 缺失或不可解析时按 0 走：说「今天录入」比说「已晾 — 天」
            // 更少干扰 —— 这一列是提示，不是断言。
            const days = daysSince(student.created_at) ?? 0;
            // 一周没人动。阈值本身不重要，重要的是它可解释：顾问的回访节奏以周为单位。
            // 刻意不用 danger —— 流失是经营常态，整片红色会污染语义（同 LeadsPage.Shared.tsx
            // 的 OUTCOME 注释）。warn 只在这一格上，不传染整行。
            const stale = days >= 7;
            return (
              <div
                key={student.id}
                className={`${GRID} px-4 min-h-9 py-1.5 hover:bg-row-hover transition-colors duration-150 ease-standard`}
              >
                <span className="flex min-w-0 items-baseline gap-1.5">
                  <span className="truncate text-row font-510 text-fg" title={student.full_name}>
                    {student.full_name}
                  </span>
                  {student.preferred_name && (
                    <span className="truncate text-meta text-muted">{student.preferred_name}</span>
                  )}
                </span>
                {/* year_level 与 source 在 Go 侧都是裸 string（不是 *string），空值给 "" 而非 null，
                    所以下面两列必须用 || 兜底：用 ?? 会原样渲染空串，看起来像列没对齐。 */}
                <span className="truncate text-meta text-muted">{student.year_level || '—'}</span>
                <span className="truncate text-meta text-muted" title={student.source || undefined}>
                  {student.source || '—'}
                </span>
                <span className="truncate text-meta text-muted">
                  {student.owner_admin_id === myId ? '我' : student.owner_admin_name || '未分配'}
                </span>
                {/* 这一列此前是「跟进」，内容恒为「—」—— 结构性如此，不是数据没填：
                    跟进任务只在**记录试听结果**那一刻生成（service/trial.go 的 SetOutcome），
                    而那一刻学生已被推进到 trial、离开了这一档（同事务改 status）。于是
                    pending_followup 在线索档永远是 false。留一列恒空的「跟进」会被读成
                    「这些线索都有人跟进了」—— 与实际正相反。真正该问的是「晾了多久没人管」，
                    那是 created_at 到今天的距离。
                    主行给行动信号（已晾 N 天），副行给溯源（哪天进来的）。 */}
                <span className="flex flex-col leading-tight">
                  <span className={`text-meta font-510 ${stale ? 'text-warn' : 'text-muted'}`}>
                    {days === 0 ? '今天录入' : `已晾 ${days} 天`}
                  </span>
                  <span className="truncate text-meta text-muted num">
                    {shortDate(student.created_at)} 录入
                  </span>
                </span>
                <span className="flex justify-end gap-2">
                  {student.can_write && (
                    <Button variant="secondary" size="sm" onClick={() => onBook(student)}>
                      <CalendarPlus size={16} aria-hidden />
                      安排试听
                    </Button>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </ListState>

      {/* 分页器只属于「有数据」这一态：加载中 / 空 / 报错都由 ListState 承担，不该出现翻页。 */}
      {!loading && !error && (
        <Pager page={page} total={total} shown={leads.length} hasMore={hasMore} onPage={onPageChange} />
      )}
    </div>
  );
}
