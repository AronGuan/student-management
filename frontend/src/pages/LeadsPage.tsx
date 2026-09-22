/**
 * 线索与试听 —— admin 的转化工作面。
 *
 * 左栏：试听列表，行内就地记录结果（converted / lost）。记录结果是 R2 的触发器，
 *      服务端在**同一个事务**里生成 due_at = now + 48h 的跟进任务，所以成功回调里
 *      立刻重拉两份数据 —— 新跟进不需要手动刷新就会出现，并高亮几秒。
 * 右栏：48h 跟进队列（是否逾期由服务端过滤，见 LeadsPage.Queue.tsx）。
 * 抽屉：本作业唯一的 LLM 特性 —— 转化 playbook，降级路径显式可见。
 *
 * 两条队列都是**服务端分页**：页码、总数、has_more 全部来自响应信封，前端不自己切片、
 * 也不按时间戳重算（ADR-007）。切换筛选一律回到第 1 页。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { BellRing, ClipboardList } from 'lucide-react';
import { api, humaniseError } from '../lib/api';
import type { PageMeta } from '../lib/api';
import { useToast } from '../components/Toast';
import { chipStateClass, Panel, PanelHeader } from '../components/ui';
import LeadsTrials from './LeadsPage.Trials';
import LeadsQueue from './LeadsPage.Queue';
import LeadsPlaybook from './LeadsPage.Playbook';
import type { FollowUpListRow, TrialListRow } from './LeadsPage.Shared';
import type { QueueFilter } from './LeadsPage.Queue';

type OutcomeFilter = 'all' | 'pending' | 'converted' | 'lost';

const OUTCOME_TABS: { key: OutcomeFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'pending', label: '待记录结果' },
  { key: 'converted', label: '已转化' },
  { key: 'lost', label: '未转化' },
];

/** 两条队列共用一个页长，免得「左 20 右 10」这种说不清来源的不一致。 */
const PAGE_SIZE = 20;

/** GET /trials 的分页信封（handler.Page）。裸数组已随契约校正废弃。 */
interface TrialPageShape extends PageMeta {
  items: TrialListRow[];
}

/** GET /follow-ups 的分页信封（handler.Page） */
interface FollowUpPageShape extends PageMeta {
  items: FollowUpListRow[];
}

export default function LeadsPage() {
  const { push } = useToast();
  const { id: routeId } = useParams();
  const deepId = routeId && /^\d+$/.test(routeId) ? Number(routeId) : null;

  const [trials, setTrials] = useState<TrialListRow[]>([]);
  const [trialsLoading, setTrialsLoading] = useState(true);
  const [trialsError, setTrialsError] = useState<unknown>(null);
  const [outcomeFilter, setOutcomeFilter] = useState<OutcomeFilter>('all');
  const [studentFilter, setStudentFilter] = useState<number | null>(null);
  const [trialsPage, setTrialsPage] = useState(1);
  const [trialsTotal, setTrialsTotal] = useState(0);
  const [trialsHasMore, setTrialsHasMore] = useState(false);

  const [queue, setQueue] = useState<FollowUpListRow[]>([]);
  const [queueLoading, setQueueLoading] = useState(true);
  const [queueError, setQueueError] = useState<unknown>(null);
  const [queueFilter, setQueueFilter] = useState<QueueFilter>('pending');
  const [queuePage, setQueuePage] = useState(1);
  const [queueTotal, setQueueTotal] = useState(0);
  const [queueHasMore, setQueueHasMore] = useState(false);
  const [counts, setCounts] = useState({ open: 0, overdue: 0 });

  const [selected, setSelected] = useState<TrialListRow | null>(null);
  const [selectedFollowUp, setSelectedFollowUp] = useState<FollowUpListRow | null>(null);
  const [followUpNonce, setFollowUpNonce] = useState(0);
  const [newFollowUpId, setNewFollowUpId] = useState<number | null>(null);
  const deepLinkDone = useRef(false);

  /** 返回本次加载到的条数（失败返回 null）—— recordOutcome 靠它判断是否停在了空页上。 */
  const loadTrials = useCallback(async (): Promise<number | null> => {
    setTrialsLoading(true);
    setTrialsError(null);
    try {
      const res = await api.get<TrialPageShape>('/trials', {
        outcome: outcomeFilter === 'all' ? undefined : outcomeFilter,
        student_id: studentFilter ?? undefined,
        page: trialsPage,
        limit: PAGE_SIZE,
      });
      setTrials(res.items);
      setTrialsTotal(res.total);
      setTrialsHasMore(res.has_more);
      return res.items.length;
    } catch (err) {
      setTrialsError(err);
      return null;
    } finally {
      setTrialsLoading(false);
    }
  }, [outcomeFilter, studentFilter, trialsPage]);

  const loadQueue = useCallback(async () => {
    setQueueLoading(true);
    setQueueError(null);
    try {
      const res = await api.get<FollowUpPageShape>('/follow-ups', {
        status: queueFilter,
        page: queuePage,
        limit: PAGE_SIZE,
      });
      setQueue(res.items);
      setQueueTotal(res.total);
      setQueueHasMore(res.has_more);
    } catch (err) {
      setQueueError(err);
    } finally {
      setQueueLoading(false);
    }
  }, [queueFilter, queuePage]);

  /** 头部计数只用 Page 包装里的 total，不为了两个数字拉整页数据 */
  const loadCounts = useCallback(async () => {
    try {
      const [open, overdue] = await Promise.all([
        api.get<FollowUpPageShape>('/follow-ups', { status: 'pending', limit: 1 }),
        api.get<FollowUpPageShape>('/follow-ups', { status: 'overdue', limit: 1 }),
      ]);
      setCounts({ open: open?.total ?? 0, overdue: overdue?.total ?? 0 });
    } catch {
      // 计数是辅助信息，失败不打扰主流程
    }
  }, []);

  const refreshQueue = useCallback(async () => {
    await Promise.all([loadQueue(), loadCounts()]);
  }, [loadQueue, loadCounts]);

  /**
   * 切换筛选必须回到第 1 页。三个 change* 把这条不变量收在一处 —— 散在每个 onClick 里
   * 迟早会漏一个，而漏掉的表现是「全部第 3 页 → 切到已转化」停在一个永远为空的页上。
   */
  const changeOutcomeFilter = useCallback((next: OutcomeFilter) => {
    setOutcomeFilter(next);
    setTrialsPage(1);
  }, []);

  const changeStudentFilter = useCallback((next: number | null) => {
    setStudentFilter(next);
    setTrialsPage(1);
  }, []);

  const changeQueueFilter = useCallback((next: QueueFilter) => {
    setQueueFilter(next);
    setQueuePage(1);
  }, []);

  useEffect(() => {
    void loadTrials();
  }, [loadTrials]);

  useEffect(() => {
    void refreshQueue();
  }, [refreshQueue]);

  /** `/leads/:id` 深链：先当试听 id 认；认不出就当作学生过滤条件。 */
  useEffect(() => {
    if (deepId === null || trialsLoading || deepLinkDone.current) return;
    deepLinkDone.current = true;
    const match = trials.find((t) => t.id === deepId);
    if (match) setSelected(match);
    else changeStudentFilter(deepId);
  }, [deepId, trials, trialsLoading, changeStudentFilter]);

  const selectedStudentId = selected?.student_id ?? null;

  /**
   * 抽屉里的「完成跟进」不能只在**当前页**里找那条跟进：分页之后它大概率落在别的页。
   * 所以按学生定点查一次。
   *
   * **刻意不传 status**：pending 与 overdue 在服务端是两个互斥的筛选值，传 pending 会把
   * 逾期那条漏掉，而逾期恰恰是最该被完成的那条。取回后在前端挑 status !== 'done'。
   *
   * followUpNonce 用来在「记录结果 / 完成跟进」之后强制重查 —— 那两件事都会改变这个
   * 学生的未关闭跟进集合。
   */
  useEffect(() => {
    if (selectedStudentId === null) {
      setSelectedFollowUp(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.get<FollowUpPageShape>('/follow-ups', {
          student_id: selectedStudentId,
          limit: PAGE_SIZE,
        });
        if (!cancelled) setSelectedFollowUp(res.items.find((row) => row.status !== 'done') ?? null);
      } catch {
        // 抽屉里的辅助信息：查不到就不给「完成跟进」按钮，不打扰主流程。
        if (!cancelled) setSelectedFollowUp(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedStudentId, followUpNonce]);

  async function recordOutcome(trialId: number, outcome: 'converted' | 'lost', note: string) {
    try {
      // 服务端 handler/trial.go 直接 OK(c, fu)，data 就是新建的 FollowUp，
      // 没有 { trial, follow_up } 包装层（openapi.yaml 已按运行时校正）。
      const created = await api.post<FollowUpListRow>(`/trials/${trialId}/outcome`, { outcome, note });
      push('success', '结果已记录。跟进任务将在 48 小时后到期。');
      const [loadedCount] = await Promise.all([loadTrials(), refreshQueue()]);
      // 刚记完结果的那一行可能正是本页最后一行，重拉后本页会空掉。服务端不会自动往前挪，
      // 所以这里主动回退一页，否则用户停在一个永远为空的页面上。
      if (loadedCount === 0 && trialsPage > 1) setTrialsPage((page) => page - 1);
      setFollowUpNonce((n) => n + 1);
      if (created.id) {
        setNewFollowUpId(created.id);
        window.setTimeout(() => setNewFollowUpId(null), 8000);
      }
    } catch (err) {
      push('error', `结果未记录。${humaniseError(err)}`);
      throw err;
    }
  }

  async function completeFollowUp(id: number) {
    try {
      await api.post(`/follow-ups/${id}/complete`);
      push('success', '跟进已关闭。');
      await refreshQueue();
      // 抽屉里那条刚被关掉，重查一次让「完成跟进」按钮消失。
      setFollowUpNonce((n) => n + 1);
    } catch (err) {
      push('error', `跟进未关闭。${humaniseError(err)}`);
      throw err;
    }
  }

  return (
    <main className="p-4 flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title text-fg">线索与试听</h1>
          <p className="text-meta text-muted">
            <span className="num font-510 text-fg-2">{counts.open}</span> 条待处理跟进 ·{' '}
            <span className="num font-510 text-fg-2">{counts.overdue}</span> 条逾期
            {studentFilter !== null && ` · 已筛选学生 #${studentFilter}`}
          </p>
        </div>
        {studentFilter !== null && (
          <button
            type="button"
            onClick={() => changeStudentFilter(null)}
            className="text-meta text-accent hover:underline transition-colors duration-150 ease-standard"
          >
            清除学生筛选
          </button>
        )}
      </header>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_400px] gap-4 items-start">
        <Panel>
          <PanelHeader
            title="试听"
            count={trialsTotal}
            icon={<ClipboardList size={16} aria-hidden />}
            action={
              <div className="flex items-center gap-1">
                {OUTCOME_TABS.map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => changeOutcomeFilter(tab.key)}
                    aria-pressed={outcomeFilter === tab.key}
                    className={`h-6 rounded-sm px-2 text-meta font-510 transition-colors duration-150 ease-standard ${chipStateClass(
                      outcomeFilter === tab.key,
                    )}`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            }
          />
          <LeadsTrials
            trials={trials}
            loading={trialsLoading}
            error={trialsError}
            onRetry={() => void loadTrials()}
            selectedId={selected?.id ?? null}
            onSelect={setSelected}
            onRecord={recordOutcome}
            total={trialsTotal}
            page={trialsPage}
            hasMore={trialsHasMore}
            onPageChange={setTrialsPage}
          />
        </Panel>

        <Panel>
          <PanelHeader
            title="跟进队列"
            count={queueTotal}
            icon={<BellRing size={16} aria-hidden />}
          />
          <LeadsQueue
            items={queue}
            loading={queueLoading}
            error={queueError}
            onRetry={() => void loadQueue()}
            onComplete={completeFollowUp}
            filter={queueFilter}
            onFilter={changeQueueFilter}
            highlightId={newFollowUpId}
            total={queueTotal}
            page={queuePage}
            hasMore={queueHasMore}
            onPageChange={setQueuePage}
          />
        </Panel>
      </div>

      <LeadsPlaybook
        trial={selected}
        followUp={selectedFollowUp}
        onClose={() => setSelected(null)}
        onCompleteFollowUp={completeFollowUp}
      />
    </main>
  );
}
