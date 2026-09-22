/**
 * 点名表 —— 这节课唯一会动钱的地方。
 *
 * 设计要点：
 *   1. 请假两态由**服务端**按 24h 阈值判定，老师只读；覆盖入口存在但视觉上是次级的，
 *      并且覆盖后必须自己承担那一节课时 —— 服务端只接受 present/late/absent。
 *   2. 底部提交是**一次** POST /lessons/:id/attendance，点之前就把后果写清楚
 *      （几条 marks、动几节课时），点之后给出结算后的余额，并允许逐行 PATCH 纠错。
 *      全班都选完才允许点：漏选只会让那几个人不进 marks、不被点名，而老师看着一张
 *      点了一半的表会以为整节课已经点完了。系统已判定的请假不算漏选。
 *   3. 备注是这一屏唯一的自由文本，随 marks 一起提交（attendances.note）；
 *      提交后转只读 —— 纠错走 PATCH，而 PATCH 不接受备注，留个能改却不生效的框
 *      比不留更糟。这一列的表头与抽屉里那块**同名，都叫「课堂记录」**：它存的东西家长
 *      永远看不到（家庭端读的是另一份 parent_updates，顾问消化后才写），只给顾问和 AI
 *      续费判断用；叫「备注」语义太含糊，看的人会以为它可能对外。改的只是给人看的列名，
 *      数据库里这一列仍然叫 attendances.note。
 *      这一列下面挂着的「需要顾问跟进」也不是第二个输入框，而是**这次结算请求里的一个
 *      布尔位**（AttendanceRecordInput.needs_follow_up）：老师落地这段观察时顺手把
 *      「这件事需要有人接手」推出去，服务端在同一事务里为这一行开一条顾问待办。
 *      家长读到的那段话由顾问消化后另行写下，不是这里写的，两者互不派生。
 *   4. 40906（已结算）不是错误页：转成"纠错模式"，底部换成结算摘要，**每行给一个
 *      「纠错」入口**（PATCH）。leave_approved 除外 —— 那一态服务端没有 attendances
 *      行，PATCH 必然 404，见 hasAttendanceRow()。
 *   5. 「全部设为出勤」不是省事按钮，是把上面那道"全班选完"的门禁一次清掉，所以它
 *      (a) 要二次确认、(b) 只动老师有权落子的行（系统判定的请假不动，说明 12）、
 *      (c) 只在当天的课上可用 —— 补录历史课时"谁到课了"已不可靠，一键填完等于把
 *      一节课的账目集体造出来。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CircleAlert, CircleCheck, ListChecks, RotateCw, TriangleAlert, UserRoundPlus } from 'lucide-react';
import { api, ApiError, humaniseError } from '../lib/api';
import { useToast } from '../components/Toast';
import { Button, chipStateClass, Divider } from '../components/ui';
import { ListState } from '../components/StateViews';
import { AttendanceBadge, AttendancePicker } from '../components/AttendanceBadge';
import {
  CreditsLeft,
  chargesACredit,
  hasAttendanceRow,
  isLeave,
  isTeacherStatus,
  leaveExplanation,
  needsTeacherChoice,
  normaliseRoster,
} from './TeachTodayPage.Shared';
import type { RosterResponse, RosterRow } from './TeachTodayPage.Shared';
import type { AttendanceStatus } from '../lib/types';

const GRID = 'grid grid-cols-[40px_minmax(0,1.3fr)_130px_minmax(0,1.7fr)_110px_minmax(0,1fr)] gap-3 items-center';

/**
 * 课堂记录是这一屏唯一的自由文本：贴着单元格走，不抢出勤那一列的注意力。
 *
 * 为什么是 text-row 而不是 text-meta —— index.css 的 --color-meta 与 --text-meta 撞了名，
 * Tailwind 只产出了颜色那一份（编译产物里 `var(--text-meta)` 零命中），所以 text-meta 是个
 * **纯颜色类**、根本不含字号；它和 text-fg 拼在一起就是两个颜色类打架，按 token 名字母序
 * `.text-fg` 在先、`.text-meta` 在后 ⇒ 同优先级下后到的胜出，输入框里的字被静默染成弱化的灰，
 * 这正是"这框不像能编辑的"的一半。text-row 只给字号、没有同名的颜色 token，与颜色类组合安全。
 * 同一坑的完整记录见 LeadsPage.Trials.tsx:110-115 与 TodayPage.Awaiting.tsx:80-85。
 *
 * focus:border-accent 与同一串里的 hover:border-border-strong 是同一个写法，不是新造一套；
 * 键盘 focus 那圈更明显的环由 index.css:92 的全局 :focus-visible 提供，这里不重复声明。
 */
const NOTE_CELL = [
  'h-7 w-full min-w-0 rounded-md border border-border bg-surface px-1.5',
  'text-row text-fg',
  'transition-colors duration-150 ease-standard hover:border-border-strong',
  'focus:border-accent',
].join(' ');

type Draft = Record<number, AttendanceStatus>;

export default function TeachRoster({
  lessonId,
  isToday,
  onRecorded,
}: {
  lessonId: number;
  /**
   * 这节课是不是服务端口径的"今天"。判定由上层做（它才有服务端 board 的
   * lesson_date，ADR-007：时区不由前端推导），这里只消费结论 —— 唯一用途是
   * 决定「全部设为出勤」能不能按。
   */
  isToday: boolean;
  onRecorded: () => Promise<void> | void;
}) {
  const { push } = useToast();
  const [rows, setRows] = useState<RosterRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [noteDraft, setNoteDraft] = useState<Record<number, string>>({});
  /**
   * 「需要顾问跟进」的草稿。它和 noteDraft 同生同灭：两者都只是**这次提交之前的输入**，
   * 一起在 load() 里按名单重建 —— 旗标不是一个独立动作，而是这次结算请求里的一个布尔位
   * （AttendanceRecordInput.needs_follow_up），提交后由服务端开出一条顾问待办。
   * 留在这里不清的话，换一节课（同一个组件实例、lessonId 变了）会把上节课的勾带过去，
   * 而老师看到的是另一班学生。
   */
  const [flagDraft, setFlagDraft] = useState<Record<number, boolean>>({});
  const [overrideOpen, setOverrideOpen] = useState<number[]>([]);
  const [settling, setSettling] = useState(false);
  const [settled, setSettled] = useState<{ charged: number } | null>(null);
  const [correcting, setCorrecting] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [bulkConfirm, setBulkConfirm] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<RosterResponse>(`/lessons/${lessonId}/roster`);
      const next = normaliseRoster(res);
      setRows(next);
      setDraft(Object.fromEntries(next.map((r) => [r.student_id, r.status])));
      setNoteDraft(Object.fromEntries(next.map((r) => [r.student_id, r.note])));
      setFlagDraft({});
      setOverrideOpen([]);
      setCorrecting(null);
      setBulkConfirm(false);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [lessonId]);

  useEffect(() => {
    setSettled(null);
    void load();
  }, [load]);

  const marks = useMemo(
    () =>
      rows
        .filter((row) => isTeacherStatus(draft[row.student_id] ?? 'unrecorded'))
        .map((row) => ({
          student_id: row.student_id,
          status: draft[row.student_id],
          note: (noteDraft[row.student_id] ?? '').trim(),
          // 布尔位恒显式下发（不靠「键在不在」表达）：契约里 default 是 false，缺键与 false
          // 同义，显式写出来读的人不必回头查默认值，服务端也不必替前端补一个默认。
          needs_follow_up: flagDraft[row.student_id] === true,
        })),
    [rows, draft, noteDraft, flagDraft],
  );

  const credits = useMemo(
    () => marks.filter((m) => chargesACredit(m.status)).length,
    [marks],
  );

  /**
   * 还没做选择的人数。>0 时不允许提交：一次 POST 只带上老师选过的行，没选的人
   * 既不会被点名也不会被扣课时，而老师看着点了一半的表会以为这节课已经点完了。
   * 系统判定的请假不算待选（老师无权改，也不该被要求去选）。
   */
  const pending = useMemo(
    () =>
      rows.filter((row) =>
        needsTeacherChoice(draft[row.student_id] ?? row.status, overrideOpen.includes(row.student_id)),
      ).length,
    [rows, draft, overrideOpen],
  );

  /**
   * 「全部设为出勤」要动的行，以及其中已有老师选择、会被覆盖掉的条数。
   *
   * 只包含**老师有权落子**的行：系统判定的请假（没点开覆盖）不在内 —— UIUX.md 说明 12
   * 说那两态老师不可改，一键按钮无权替老师做这个决定，也正好和 needsTeacherChoice 的
   * 口径一致（那边是"还欠选择"，这里是"能改"）。
   */
  const bulk = useMemo(() => {
    const targets = rows.filter((row) => {
      const st = draft[row.student_id] ?? row.status;
      return !isLeave(st) || overrideOpen.includes(row.student_id);
    });
    const overwriting = targets.filter((row) =>
      isTeacherStatus(draft[row.student_id] ?? row.status),
    ).length;
    return { targets, overwriting };
  }, [rows, draft, overrideOpen]);

  function applyAllPresent() {
    setDraft((prev) => {
      const next = { ...prev };
      for (const row of bulk.targets) next[row.student_id] = 'present';
      return next;
    });
    setBulkConfirm(false);
  }

  async function settle() {
    setSettling(true);
    try {
      // 单次请求结算整节课；服务端幂等，同一学生同一课次只产生一条 consume 流水。
      const res = await api.post<{ charged?: number; deducted?: number }>(`/lessons/${lessonId}/attendance`, {
        marks,
      });
      const charged = res?.charged ?? res?.deducted ?? credits;
      setSettled({ charged });
      push('success', `出勤已记录，扣 ${charged} 课时。`);
      await load();
      await onRecorded();
    } catch (err) {
      if (err instanceof ApiError && err.code === 40906) {
        setSettled({ charged: 0 });
        push('info', '这节课已结算——可在下方纠错。');
        await load();
        await onRecorded();
      } else {
        push('error', `出勤未记录。${humaniseError(err)}`);
      }
    } finally {
      setSettling(false);
    }
  }

  async function correct(studentId: number, status: AttendanceStatus) {
    setBusyId(studentId);
    try {
      await api.patch(`/lessons/${lessonId}/attendance/${studentId}`, { status });
      push('success', '纠错已保存，课时明细已相应调整。');
      setCorrecting(null);
      await load();
      await onRecorded();
    } catch (err) {
      push('error', `纠错未保存。${humaniseError(err)}`);
    } finally {
      setBusyId(null);
    }
  }

  const chargedRows = rows.filter((row) => settled && chargesACredit(draft[row.student_id] ?? 'unrecorded'));

  return (
    <div className="flex flex-col">
      <div className={`${GRID} px-4 h-9 border-b border-border bg-surface-sunken`}>
        <span className="col-header" aria-label="新加入本班" />
        <span className="col-header">学生</span>
        <span className="col-header">课时</span>
        <span className="col-header">出勤</span>
        <span className="col-header">结算</span>
        <span className="col-header">课堂记录</span>
      </div>

      <ListState
        loading={loading}
        error={error}
        isEmpty={rows.length === 0}
        emptyMessage="这个班还没有学生报名，没有可记录的内容。"
        emptyCta="刷新名单"
        onEmptyCta={() => void load()}
        onRetry={() => void load()}
        rows={4}
        cols={5}
      >
        <div className="divide-y divide-border">
          {rows.map((row) => {
            const status = draft[row.student_id] ?? row.status;
            const leave = isLeave(status) && !overrideOpen.includes(row.student_id);
            const isSettledRow = settled !== null;
            const flagged = flagDraft[row.student_id] === true;
            /**
             * 旗标只出现在**这一行的备注真的会被提交**的那些行上，三个条件与上面组 marks 的
             * 过滤同源：
             *   - isSettledRow：已结算的行落到下面的只读分支，提交按钮已经换成结算摘要，
             *     这时候摆一个能点的勾是在承诺一件不会发生的事；
             *   - 备注非空：勾的含义是「我写的这段课堂记录需要顾问接手」。没有内容就没有要
             *     接手的东西 —— 服务端照样会开出一条待办，而顾问打开只看到一条没有上下文
             *     的空任务；
             *   - isTeacherStatus(draft[row.student_id] ?? 'unrecorded')：与上面组 marks 的
             *     过滤条件**逐字同一句**。这两处等价本来是靠「load() 给每一行都种了 draft」
             *     这个住在别处的保证撑着的，写成同一句之后，「旗标出现在哪些行」与「哪些行
             *     真的会被提交」在源码上就是同一行代码 —— 将来谁改了那边的过滤而忘了这边，
             *     读的人一眼能对上，不用重新推导一遍等价性。
             *     这条也说明为什么系统判定的请假不会有旗标：marks 只收老师有权落子的行
             *     （present/late/absent），请假两态根本不进 marks，而在一个不会提交的行上放
             *     一个能点的控件，正是本文件开头批评过的「留个能改却不生效的框比不留更糟」。
             */
            const canFlag =
              !isSettledRow &&
              (noteDraft[row.student_id] ?? '').trim() !== '' &&
              isTeacherStatus(draft[row.student_id] ?? 'unrecorded');
            return (
              <div key={row.student_id} className={`${GRID} px-4 py-2 min-h-9 hover:bg-row-hover transition-colors duration-150 ease-standard`}>
                <span className="flex items-center">
                  {row.is_new_to_class && (
                    <UserRoundPlus size={16} className="text-accent" aria-label="新加入本班" />
                  )}
                </span>

                <span className="text-row font-510 text-fg truncate" title={row.student_name}>
                  {row.student_name}
                </span>

                <CreditsLeft balance={row.balance} />

                <span className="flex flex-col gap-1">
                  {correcting === row.student_id ? (
                    <span className="flex items-center gap-2">
                      <AttendancePicker
                        value={isTeacherStatus(status) ? status : null}
                        onChange={(next) => void correct(row.student_id, next)}
                      />
                      <button
                        type="button"
                        onClick={() => setCorrecting(null)}
                        className="text-meta text-muted hover:text-fg transition-colors duration-150 ease-standard"
                      >
                        取消
                      </button>
                    </span>
                  ) : leave || isSettledRow ? (
                    <>
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <AttendanceBadge status={status} />
                        {/* 纠错入口挂在这里，不挂在上面的 else 分支 —— 那个分支的前提就是
                            !isSettledRow，挂在里面等于永远不渲染（此前正是如此）。
                            且只在真有 attendances 行时才给：leave_approved 没有行，PATCH 会 404。 */}
                        {isSettledRow && hasAttendanceRow(status) && (
                          <button
                            type="button"
                            disabled={busyId !== null}
                            onClick={() => setCorrecting(row.student_id)}
                            className="inline-flex items-center gap-1 text-meta text-accent hover:underline disabled:opacity-45 disabled:cursor-not-allowed transition-colors duration-150 ease-standard"
                          >
                            <RotateCw size={16} aria-hidden />
                            纠错
                          </button>
                        )}
                      </span>
                      {leave && (
                        <span className="text-meta text-muted">{leaveExplanation(status)}</span>
                      )}
                      {leave && !isSettledRow && (
                        <button
                          type="button"
                          onClick={() => setOverrideOpen((prev) => [...prev, row.student_id])}
                          className="self-start text-meta text-accent hover:underline transition-colors duration-150 ease-standard"
                        >
                          覆盖系统判定
                        </button>
                      )}
                    </>
                  ) : (
                    <AttendancePicker
                      value={status === 'unrecorded' ? null : status}
                      onChange={(next) => setDraft((prev) => ({ ...prev, [row.student_id]: next }))}
                    />
                  )}
                </span>

                <span className="num text-meta text-muted">{row.settles}</span>

                {/* 课堂记录是老师这一屏唯一能自己写的东西：提交前可编辑，提交后只读
                    （纠错走 PATCH，它不接受备注，所以这里不能留一个改了不生效的框）。
                    placeholder 必须是"能写什么"的引导短句：这里原先写 '—'，而 '—' 恰好是
                    同一屏里"没有值"的写法（见下面只读分支的 row.note || '—'），于是
                    "可以输入的框"和"没有值的空格子"长得一模一样，功能被读成不存在。
                    只读分支的空值保持破折号不动，两者才一眼可辨。文案压在 8 个汉字内：
                    GRID 最后一列只有 1fr，长 placeholder 会被截断。 */}
                <span className="flex min-w-0 flex-col gap-1">
                  {isSettledRow ? (
                    <span
                      className="block h-7 truncate text-meta leading-7 text-fg-2"
                      title={row.note || undefined}
                    >
                      {row.note || '—'}
                    </span>
                  ) : (
                    <>
                      <input
                        type="text"
                        value={noteDraft[row.student_id] ?? ''}
                        onChange={(e) => {
                          const next = e.target.value;
                          setNoteDraft((prev) => ({ ...prev, [row.student_id]: next }));
                          // 清空备注时旗标一起落回 false：没有内容就没有「需要跟进」的理由，
                          // 而一个勾着的空旗标会让老师以为自己标记过了。判据用 trim 而不是
                          // 字面的空串，与上面 canFlag 的第二个条件同一个谓词 —— 否则填一串
                          // 空格时 chip 已经藏起来、旗标却仍是 true，老师再补一个字它就以
                          // 「已标记」的样子冒出来，而他这一轮从没勾过。
                          if (next.trim() === '') {
                            setFlagDraft((prev) => ({ ...prev, [row.student_id]: false }));
                          }
                        }}
                        maxLength={255}
                        placeholder={row.is_new_to_class ? '新学生，请向全班介绍' : '记录课堂表现…'}
                        aria-label={`${row.student_name} 的课堂记录`}
                        className={NOTE_CELL}
                      />
                      {/* chip 挤在输入框下面、左对齐：GRID 最后一列只有 1fr，跟输入框并排会
                          把它压到读不出内容。开启态的文案必须换（不能只换颜色）—— 颜色是
                          唯一编码通道时，色觉差异和灰度打印的读者看不到状态，这里只有
                          aria-pressed 与这句话能说明它已经按下了。 */}
                      {canFlag && (
                        <button
                          type="button"
                          aria-pressed={flagged}
                          onClick={() =>
                            setFlagDraft((prev) => ({ ...prev, [row.student_id]: !flagged }))
                          }
                          className={`inline-flex items-center gap-1 self-start h-6 rounded-sm px-2 text-meta font-510 transition-colors duration-150 ease-standard ${chipStateClass(
                            flagged,
                          )}`}
                        >
                          <CircleAlert size={14} aria-hidden />
                          {flagged ? '已标记：顾问跟进' : '需要顾问跟进'}
                        </button>
                      )}
                    </>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </ListState>

      <Divider />

      {error ? null : settled ? (
        <div className="flex flex-col gap-2 px-4 py-3 bg-surface-sunken">
          <p className="flex items-center gap-2 text-row text-success">
            <CircleCheck size={16} aria-hidden />
            {settled.charged > 0
              ? `已记录：本班扣 ${settled.charged} 课时。`
              : '已记录：这节课没有产生课时变动。'}
          </p>
          {chargedRows.length > 0 && (
            <p className="flex flex-wrap items-center gap-x-4 gap-y-1">
              {chargedRows.map((row) => (
                <span key={row.student_id} className="text-meta text-muted">
                  {row.student_name}
                  <span className="num ml-1 font-510 text-fg-2">{row.balance}</span>
                </span>
              ))}
              <span className="text-meta text-muted">结算后余额</span>
            </p>
          )}
          <p className="text-meta text-muted">
            已写入新的出勤记录。需要改动某一行时点「纠错」——服务端会追加一条冲正流水，而不是改写历史。
          </p>
        </div>
      ) : (
        <div className="flex flex-wrap items-end justify-between gap-3 px-4 py-3 bg-surface-sunken">
          <div className="flex flex-col gap-1">
            <p className="text-row text-fg">
              将提交 <span className="num font-590">{marks.length}</span> 条记录 · 扣{' '}
              <span className="num font-590 text-danger">{credits}</span> 课时
            </p>
            {/* 补录的课为什么不能一键点名 —— 灰按钮不解释等于没说 */}
            {!isToday && (
              <p className="flex items-center gap-1.5 text-meta text-muted">
                <TriangleAlert size={16} aria-hidden />
                这是补录的历史课，不能一键点名——当天谁到课了已不可靠，请逐行填写。
              </p>
            )}
            {pending > 0 ? (
              <p className="flex items-center gap-1.5 text-meta text-warn">
                <TriangleAlert size={16} aria-hidden />
                还有 <span className="num font-510">{pending}</span> 位学生没有选择出勤，全班选完才能记录。
              </p>
            ) : (
              <p className="flex items-center gap-1.5 text-meta text-muted">
                <TriangleAlert size={16} aria-hidden />
                出勤、迟到、缺席各扣 1 课时。系统已判定请假的同学会自动跳过——如果实际到课，可在上方覆盖。
              </p>
            )}
          </div>
          <span className="flex flex-wrap items-center gap-2">
            {bulkConfirm ? (
              <>
                <span className="text-meta text-muted">
                  把 <span className="num font-510">{bulk.targets.length}</span> 位学生记为出勤？
                  {bulk.overwriting > 0 && (
                    <> 其中 <span className="num font-510">{bulk.overwriting}</span> 位已有选择会被覆盖。</>
                  )}
                </span>
                <Button variant="primary" size="touch" onClick={applyAllPresent}>
                  确认
                </Button>
                <Button variant="ghost" size="touch" onClick={() => setBulkConfirm(false)}>
                  取消
                </Button>
              </>
            ) : (
              <Button
                variant="secondary"
                size="touch"
                disabled={!isToday || pending === 0 || settling}
                onClick={() => setBulkConfirm(true)}
              >
                <ListChecks size={20} aria-hidden />
                全部设为出勤
              </Button>
            )}
            <Button
              variant="primary"
              size="touch"
              loading={settling}
              disabled={rows.length === 0 || pending > 0 || settling}
              onClick={() => void settle()}
            >
              <CircleCheck size={20} aria-hidden />
              记录出勤
            </Button>
          </span>
        </div>
      )}
    </div>
  );
}
