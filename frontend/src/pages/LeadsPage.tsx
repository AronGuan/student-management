/**
 * 线索与试听 —— admin 的转化工作面，也是**漏斗全流程**的唯一入口。
 *
 * 左栏：五档看板。前四档是试听行（GET /trials），「线索」档是学生行
 *      （GET /students?status=lead）—— 漏斗的头两跳就长在这一栏上：
 *      「添加线索」登记一条 lead，线索行里的「安排试听」把 lead 推进到 trial
 *      （服务端在同一个事务里改状态，见 service/trial.go:57），第五跳
 *      「记录结果」再把 trial 推到 active。三跳都在这一屏里完成，不跳页。
 *      记录结果同时是 R2 的触发器：服务端在同一事务里生成 due_at = now + 48h 的跟进，
 *      所以成功回调会立刻把页头的跟进计数刷新到位。
 * 右栏：48h 跟进队列 —— **已隐藏**（2026-09-22 用户裁定）。详见下面那段。
 * 抽屉：转化 playbook（本作业唯一的 LLM 特性）、登记线索、安排试听。
 *
 * 试听表与线索表都是**服务端分页**：页码、总数、has_more 全部来自响应信封，
 * 前端不自己切片、也不按时间戳重算（ADR-007）。切换档位一律回到第 1 页。
 *
 * ── 右栏「跟进队列」为什么隐藏、能力去了哪、怎么恢复 ────────────────────────────
 *
 * 隐藏它**不丢任何写入能力**：
 *   - 完成跟进 → 学生抽屉的转化卡上就有「完成跟进」（LeadsPage.Playbook.tsx:125），
 *                走的是同一个 POST /follow-ups/:id/complete
 *   - 后端一行未改 → GET /follow-ups 契约不变，页头那两个计数仍在用它
 *   - 同目录的 LeadsPage.Queue.tsx **整份保留**，没有被删
 *
 * 恢复方式（三处，都在本文件）：
 *   1. 渲染处把 <Panel title="跟进队列"> 那段注释放开；
 *   2. 容器类换回 `grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_400px] gap-4 items-start`；
 *   3. 按 git 历史还原被删掉的 queue* 状态、QUEUE_PAGE_SIZE、LeadsQueue 与 QueueFilter
 *      的 import、loadQueue / refreshQueue / changeQueueFilter。
 *      （这一段是 `noUnusedLocals` 逼出来的：右栏一停用，它们立刻变成编译错误，
 *        所以只能跟着删，而不能像 TodayPage 那样只注释渲染块。）
 *
 * ⚠️ 已知缺口（隐藏右栏带来的，不是原有问题）：抽屉只能从「未转化」行的「转化方案」
 * 按钮打开（LeadsPage.Trials.tsx:143），行本身不可点，已转化行也没有按钮。于是
 * **已转化学生**的跟进在界面上没有入口了 —— 右栏在的时候正是它兜住了这一批。
 * 要补的话是给试听行加一个统一的「打开抽屉」入口；没补之前，那批跟进只走服务端 API。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { ClipboardList, UserPlus, Users } from 'lucide-react';
import { api, humaniseError } from '../lib/api';
import type { PageMeta } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { Button, chipStateClass, Panel, PanelHeader } from '../components/ui';
import LeadsTrials from './LeadsPage.Trials';
import LeadsProspects from './LeadsPage.Prospects';
import { CreateLeadDrawer } from './LeadsPage.CreateLeadDrawer';
import { BookTrialDrawer } from './LeadsPage.BookTrialDrawer';
import LeadsPlaybook from './LeadsPage.Playbook';
import type { FollowUpListRow, TrialListRow } from './LeadsPage.Shared';
import type { StudentListItem, StudentPage } from '../lib/types';

/**
 * 左栏的五个档位。前四档看的是**试听行**（GET /trials），只有「线索」档换行模型、
 * 看学生行（GET /students?status=lead）。所以这个类型不再只装 outcome —— 名字与
 * 「试听结果」解耦，免得下一次读代码的人以为 leads 也是一个 outcome 值。
 */
type BoardFilter = 'all' | 'leads' | 'pending' | 'converted' | 'lost';

/** outcome 参数映射：只有这四档会真的送给 GET /trials。 */
const BOARD_TABS: { key: BoardFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'leads', label: '线索' },
  { key: 'pending', label: '待记录结果' },
  { key: 'converted', label: '已转化' },
  { key: 'lost', label: '未转化' },
];

/** 试听表、线索表与抽屉定点查询共用这个页长（左栏一次 20 条，滚动列表的常规长度）。 */
const PAGE_SIZE = 20;

/** GET /trials 的分页信封（handler.Page）。裸数组已随契约校正废弃。 */
interface TrialPageShape extends PageMeta {
  items: TrialListRow[];
}

/** GET /follow-ups 的分页信封（handler.Page）。页头计数与抽屉定点查询都用它。 */
interface FollowUpPageShape extends PageMeta {
  items: FollowUpListRow[];
}

export default function LeadsPage() {
  const { push } = useToast();
  const { me } = useAuth();
  const myId = me?.user.id;
  const { id: routeId } = useParams();
  const deepId = routeId && /^\d+$/.test(routeId) ? Number(routeId) : null;

  const [trials, setTrials] = useState<TrialListRow[]>([]);
  const [trialsLoading, setTrialsLoading] = useState(true);
  const [trialsError, setTrialsError] = useState<unknown>(null);
  const [boardFilter, setBoardFilter] = useState<BoardFilter>('all');
  const [studentFilter, setStudentFilter] = useState<number | null>(null);
  const [trialsPage, setTrialsPage] = useState(1);
  const [trialsTotal, setTrialsTotal] = useState(0);
  const [trialsHasMore, setTrialsHasMore] = useState(false);

  // 线索档是另一个模型（学生行），所以另起一套状态。loading 初值为 true 与试听那一路一致：
  // 页面默认不在这一档，但一旦切过来，第一帧就该是骨架屏而不是「暂无线索」。
  const [leads, setLeads] = useState<StudentListItem[]>([]);
  const [leadsLoading, setLeadsLoading] = useState(true);
  const [leadsError, setLeadsError] = useState<unknown>(null);
  const [leadsPage, setLeadsPage] = useState(1);
  const [leadsTotal, setLeadsTotal] = useState(0);
  const [leadsHasMore, setLeadsHasMore] = useState(false);
  /** 登记线索后用 +1 强制重拉：若用户本来就停在线索档第 1 页，没有任何依赖会变。 */
  const [leadsNonce, setLeadsNonce] = useState(0);

  /**
   * 页头的两个跟进计数。右栏隐藏后它们只剩这一个消费点，但**刻意保留**：
   * 右栏没了以后，这是本页唯一提到「队列里还有东西」的地方，作为环境信号仍然有用，
   * 而且数据来源（GET /follow-ups 的 total）跟右栏本来就是两条独立的路径。
   */
  const [counts, setCounts] = useState({ open: 0, overdue: 0 });

  const [selected, setSelected] = useState<TrialListRow | null>(null);
  const [selectedFollowUp, setSelectedFollowUp] = useState<FollowUpListRow | null>(null);
  const [followUpNonce, setFollowUpNonce] = useState(0);
  const [creatingLead, setCreatingLead] = useState(false);
  const [bookingFor, setBookingFor] = useState<StudentListItem | null>(null);
  const deepLinkDone = useRef(false);

  /** 返回本次加载到的条数（失败返回 null）—— recordOutcome 靠它判断是否停在了空页上。 */
  const loadTrials = useCallback(async (): Promise<number | null> => {
    // 线索档看的是另一个模型，没有必要同时拉试听：那会让面板标题与计数短暂地指向
    // 一份不会显示的数据。离开这一档时 loadTrials 的身份会变，effect 自然重拉。
    if (boardFilter === 'leads') return null;
    setTrialsLoading(true);
    setTrialsError(null);
    try {
      const res = await api.get<TrialPageShape>('/trials', {
        outcome: boardFilter === 'all' ? undefined : boardFilter,
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
  }, [boardFilter, studentFilter, trialsPage]);

  /**
   * 线索档的读取路径。行是**学生**，不是试听。
   *
   * owner_admin_id=me 与 GET /trials 的归属收口一致（handler/trial.go:69 也是只给
   * 自己名下的）：这一栏回答的是「我手上还有哪些线索没约」，不是学生总目录。
   * status=lead 让「已约上试听」的家庭自动离开这一栏 —— 推进状态的是服务端，不是这里。
   */
  const loadLeads = useCallback(async (): Promise<number | null> => {
    if (boardFilter !== 'leads') return null;
    setLeadsLoading(true);
    setLeadsError(null);
    try {
      const res = await api.get<StudentPage>('/students', {
        status: 'lead',
        owner_admin_id: 'me',
        page: leadsPage,
        limit: PAGE_SIZE,
      });
      setLeads(res.items);
      setLeadsTotal(res.total);
      setLeadsHasMore(res.has_more);
      return res.items.length;
    } catch (err) {
      setLeadsError(err);
      return null;
    } finally {
      setLeadsLoading(false);
    }
  }, [boardFilter, leadsPage, leadsNonce]);

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

  /**
   * 切换档位必须回到第 1 页。两个 change* 把这条不变量收在一处 —— 散在每个 onClick 里
   * 迟早会漏一个，而漏掉的表现是「全部第 3 页 → 切到已转化」停在一个永远为空的页上。
   *
   * 两个页长一起归位：两档共用同一块面板，切档时另一边不显示但页号留着，下次回来就
   * 落在一个凭空的页码上。
   */
  const changeBoardFilter = useCallback((next: BoardFilter) => {
    setBoardFilter(next);
    setTrialsPage(1);
    setLeadsPage(1);
    // 学生筛选只作用于试听表（GET /trials 的 student_id 参数）。带着它进线索档，页头会
    // 写着「已筛选学生 #12」而下面列的是全部线索 —— 页头与表格互相矛盾，所以清掉。
    if (next === 'leads') setStudentFilter(null);
  }, []);

  const changeStudentFilter = useCallback((next: number | null) => {
    setStudentFilter(next);
    setTrialsPage(1);
  }, []);

  useEffect(() => {
    void loadTrials();
  }, [loadTrials]);

  useEffect(() => {
    void loadLeads();
  }, [loadLeads]);

  /**
   * 页头计数只在挂载时拉一次。写操作造成的变化各自定点刷新（见 recordOutcome /
   * completeFollowUp / handleTrialBooked），不靠这个 effect 兜底。
   */
  useEffect(() => {
    void loadCounts();
  }, [loadCounts]);

  /**
   * 登记线索成功。刚登完就要能看见他：切到线索档、回第 1 页（/students 默认按
   * updated_at DESC，于是新记录在第一行），再用 nonce 强制重拉。
   * nonce 不是多余的：如果用户本来就停在线索档第 1 页，上面几个 setState 里没有一个
   * 会真的改变值，没有它就不会重拉，刚登的线索要手动刷新才出现。
   *
   * 不刷头部计数：新线索不会产生跟进任务，那两个数字不会变。
   */
  const handleLeadCreated = useCallback(() => {
    setCreatingLead(false);
    changeBoardFilter('leads');
    setLeadsNonce((n) => n + 1);
  }, [changeBoardFilter]);

  /**
   * 安排试听成功。这一跳同时改了两边的模型：试听表多一行、线索栏少一行（服务端把学生的
   * status 从 lead 推到了 trial），所以两栏都要重算，并切到「待记录结果」档
   * —— 用户的说法是「这样这个学生就进入到试听栏中」。
   *
   * 试听表的重拉由 effect 完成：boardFilter 从 leads 变成 pending，loadTrials 的身份随之
   * 改变。这里不直接调 loadTrials() —— 那样会拿旧闭包再发一次请求，与 effect 那一次竞争。
   * changeBoardFilter 顺带把两个页号都归位，所以原来那一页可能空掉的问题也一并消掉了。
   * 头部两个计数顺带刷一次（只打 limit=1 的两个轻请求）。
   */
  const handleTrialBooked = useCallback(() => {
    setBookingFor(null);
    changeBoardFilter('pending');
    void loadCounts();
  }, [changeBoardFilter, loadCounts]);

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
   * 所以按学生定点查一次。右栏隐藏后这是**唯一**能查到「这个学生还有没有未关闭的跟进」
   * 的地方，所以它比右栏在的时候更要紧了。
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
        // 这里刻意保持 PAGE_SIZE，**不要**为了「只看有没有」而砍到 1：下面只取第一条
        // status !== 'done'，砍得太狠会让跟进很多的学生的「完成跟进」按钮凭空消失，
        // 而这不是用户要求的事。
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
      await api.post<FollowUpListRow>(`/trials/${trialId}/outcome`, { outcome, note });
      push('success', '结果已记录。跟进任务将在 48 小时后到期。');
      // 记录结果会新建一条跟进，所以页头计数要跟着动；试听表本身也要重拉
      //（本行的 outcome 变了，当前档位下它可能已经不该出现在这里）。
      const loadedCount = await loadTrials();
      void loadCounts();
      // 刚记完结果的那一行可能正是本页最后一行，重拉后本页会空掉。服务端不会自动往前挪，
      // 所以这里主动回退一页，否则用户停在一个永远为空的页面上。
      if (loadedCount === 0 && trialsPage > 1) setTrialsPage((page) => page - 1);
      // 抽屉里那条刚变出来的跟进：重查一次让「完成跟进」按钮出现。
      setFollowUpNonce((n) => n + 1);
    } catch (err) {
      push('error', `结果未记录。${humaniseError(err)}`);
      throw err;
    }
  }

  /**
   * 关闭一条跟进。**右栏隐藏后这里只剩两个消费点**：学生抽屉的转化卡
   *（LeadsPage.Playbook.tsx:125）—— 所以不再需要重拉队列、也不再需要页码回退
   *（那是右栏分页才有的问题）。只剩两件事：刷页头计数，以及让抽屉重查一次，
   * 好让刚被关掉的那条对应的「完成跟进」按钮消失。
   */
  async function completeFollowUp(id: number) {
    try {
      await api.post(`/follow-ups/${id}/complete`);
      push('success', '跟进已关闭。');
      void loadCounts();
      setFollowUpNonce((n) => n + 1);
    } catch (err) {
      push('error', `跟进未关闭。${humaniseError(err)}`);
      throw err;
    }
  }

  /** 左栏当前挂的是哪张表：只有「线索」档换成学生行。 */
  const onLeadsTab = boardFilter === 'leads';

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

      {/* 右栏隐藏后这里只剩一列。容器**保留**（而不是把 <Panel> 提到 main 下面），
          是为了恢复时只改这一行的类名 + 放回下面那段注释里的 <Panel>。
          恢复：把类换回 `grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_400px] gap-4 items-start`。 */}
      <div className="grid grid-cols-1 gap-4 items-start">
        <Panel>
          <PanelHeader
            // 标题与计数必须跟着档走：「线索」档挂在「试听」下面会自相矛盾 —— 一栏写着
            // 「试听」，列出来的却是还没约过试听的学生。
            title={onLeadsTab ? '线索' : '试听'}
            count={onLeadsTab ? leadsTotal : trialsTotal}
            icon={onLeadsTab ? <Users size={16} aria-hidden /> : <ClipboardList size={16} aria-hidden />}
            action={
              <div className="flex items-center gap-1">
                {BOARD_TABS.map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => changeBoardFilter(tab.key)}
                    aria-pressed={boardFilter === tab.key}
                    className={`h-6 rounded-sm px-2 text-meta font-510 transition-colors duration-150 ease-standard ${chipStateClass(
                      boardFilter === tab.key,
                    )}`}
                  >
                    {tab.label}
                  </button>
                ))}
                {/* 漏斗的第一跳，所以不藏在「线索」档里：哪一档都该能登记新线索。
                    用 secondary 而非 primary —— 紧邻的选中档位已经是实心 accent，
                    再放一个同色实心按钮会让两个「当前」互抢。 */}
                <Button variant="secondary" size="sm" className="ml-1" onClick={() => setCreatingLead(true)}>
                  <UserPlus size={16} aria-hidden />
                  添加线索
                </Button>
              </div>
            }
          />
          {onLeadsTab ? (
            <LeadsProspects
              leads={leads}
              loading={leadsLoading}
              error={leadsError}
              onRetry={() => void loadLeads()}
              myId={myId}
              onBook={(student) => setBookingFor(student)}
              onCreate={() => setCreatingLead(true)}
              total={leadsTotal}
              page={leadsPage}
              hasMore={leadsHasMore}
              onPageChange={setLeadsPage}
            />
          ) : (
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
          )}
        </Panel>

        {/* 右栏「48h 跟进队列」已隐藏（2026-09-22 用户裁定）。
            理由、能力去哪了、以及完整的恢复清单见文件头注释。
            下面这段原样保留，注释放开即恢复（别忘了同时还原上面容器那一行的 grid 类、
            以及本文件里被删掉的 queue* 状态与 loadQueue/refreshQueue/changeQueueFilter）。
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
        */}
      </div>

      <LeadsPlaybook
        trial={selected}
        followUp={selectedFollowUp}
        onClose={() => setSelected(null)}
        onCompleteFollowUp={completeFollowUp}
      />

      {/* 两个写入抽屉。都按条件挂载而不是传 open：抽屉内部是「一到场就打开」的语义，
          条件挂载让「关掉」与「卸载」是同一个动作，不会留下上一次的半填状态。 */}
      {creatingLead && <CreateLeadDrawer onClose={() => setCreatingLead(false)} onCreated={handleLeadCreated} />}
      {bookingFor && (
        <BookTrialDrawer
          student={bookingFor}
          onClose={() => setBookingFor(null)}
          onBooked={handleTrialBooked}
        />
      )}
    </main>
  );
}
