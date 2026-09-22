/**
 * 线索与试听 —— admin 的转化工作面。
 *
 * 左栏：试听列表，行内就地记录结果（converted / lost）。记录结果是 R2 的触发器，
 *      服务端在**同一个事务**里生成 due_at = now + 48h 的跟进任务，所以成功回调里
 *      立刻重拉两份数据 —— 新跟进不需要手动刷新就会出现，并高亮几秒。
 * 右栏：48h 跟进队列（是否逾期由服务端过滤，见 LeadsPage.Queue.tsx）。
 * 抽屉：本作业唯一的 LLM 特性 —— 转化 playbook，降级路径显式可见。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { BellRing, ClipboardList } from 'lucide-react';
import { api, humaniseError } from '../lib/api';
import { useToast } from '../components/Toast';
import { chipStateClass, Panel, PanelHeader } from '../components/ui';
import LeadsTrials from './LeadsPage.Trials';
import LeadsQueue from './LeadsPage.Queue';
import LeadsPlaybook from './LeadsPage.Playbook';
import { unwrapList } from './LeadsPage.Shared';
import type { FollowUpListRow, TrialListRow } from './LeadsPage.Shared';
import type { QueueFilter } from './LeadsPage.Queue';

type OutcomeFilter = 'all' | 'pending' | 'converted' | 'lost';

const OUTCOME_TABS: { key: OutcomeFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'pending', label: '待记录结果' },
  { key: 'converted', label: '已转化' },
  { key: 'lost', label: '未转化' },
];

/** GET /follow-ups 走标准 Page 包装 */
interface FollowUpPageShape {
  items?: FollowUpListRow[];
  total?: number;
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

  const [queue, setQueue] = useState<FollowUpListRow[]>([]);
  const [queueLoading, setQueueLoading] = useState(true);
  const [queueError, setQueueError] = useState<unknown>(null);
  const [queueFilter, setQueueFilter] = useState<QueueFilter>('pending');
  const [counts, setCounts] = useState({ open: 0, overdue: 0 });

  const [selected, setSelected] = useState<TrialListRow | null>(null);
  const [newFollowUpId, setNewFollowUpId] = useState<number | null>(null);
  const deepLinkDone = useRef(false);

  const loadTrials = useCallback(async () => {
    setTrialsLoading(true);
    setTrialsError(null);
    try {
      const res = await api.get<TrialListRow[]>('/trials', {
        outcome: outcomeFilter === 'all' ? undefined : outcomeFilter,
        student_id: studentFilter ?? undefined,
      });
      setTrials(unwrapList<TrialListRow>(res));
    } catch (err) {
      setTrialsError(err);
    } finally {
      setTrialsLoading(false);
    }
  }, [outcomeFilter, studentFilter]);

  const loadQueue = useCallback(async () => {
    setQueueLoading(true);
    setQueueError(null);
    try {
      const res = await api.get<FollowUpPageShape | FollowUpListRow[]>('/follow-ups', {
        status: queueFilter,
      });
      setQueue(unwrapList<FollowUpListRow>(res));
    } catch (err) {
      setQueueError(err);
    } finally {
      setQueueLoading(false);
    }
  }, [queueFilter]);

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
    else setStudentFilter(deepId);
  }, [deepId, trials, trialsLoading]);

  async function recordOutcome(trialId: number, outcome: 'converted' | 'lost', note: string) {
    try {
      // Go 直接返回新建的 FollowUp（openapi 草案写的是 { trial, follow_up }，两种都吃）
      const res = await api.post<FollowUpListRow | { follow_up: FollowUpListRow }>(
        `/trials/${trialId}/outcome`,
        { outcome, note },
      );
      const created: FollowUpListRow = 'follow_up' in res ? res.follow_up : res;
      push('success', '结果已记录。跟进任务将在 48 小时后到期。');
      await Promise.all([loadTrials(), refreshQueue()]);
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
    } catch (err) {
      push('error', `跟进未关闭。${humaniseError(err)}`);
      throw err;
    }
  }

  const activeFollowUp = selected
    ? (queue.find((q) => q.student_id === selected.student_id && q.status !== 'done') ?? null)
    : null;

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
            onClick={() => setStudentFilter(null)}
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
            count={trials.length}
            icon={<ClipboardList size={16} aria-hidden />}
            action={
              <div className="flex items-center gap-1">
                {OUTCOME_TABS.map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => setOutcomeFilter(tab.key)}
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
          />
        </Panel>

        <Panel>
          <PanelHeader
            title="跟进队列"
            count={counts.open + counts.overdue}
            icon={<BellRing size={16} aria-hidden />}
          />
          <LeadsQueue
            items={queue}
            loading={queueLoading}
            error={queueError}
            onRetry={() => void loadQueue()}
            onComplete={completeFollowUp}
            filter={queueFilter}
            onFilter={setQueueFilter}
            highlightId={newFollowUpId}
          />
        </Panel>
      </div>

      <LeadsPlaybook
        trial={selected}
        followUp={activeFollowUp}
        onClose={() => setSelected(null)}
        onCompleteFollowUp={completeFollowUp}
      />
    </main>
  );
}
