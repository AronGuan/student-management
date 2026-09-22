/**
 * 点名表 —— 这节课唯一会动钱的地方。
 *
 * 设计要点：
 *   1. 请假两态由**服务端**按 24h 阈值判定，老师只读；覆盖入口存在但视觉上是次级的，
 *      并且覆盖后必须自己承担那一节课时 —— 服务端只接受 present/late/absent。
 *   2. 底部提交是**一次** POST /lessons/:id/attendance，点之前就把后果写清楚
 *      （几条 marks、动几节课时），点之后给出结算后的余额，并允许逐行 PATCH 纠错。
 *   3. 40906（已结算）不是错误页：转成"纠错模式"，把 PATCH 入口放开。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CircleCheck, RotateCw, TriangleAlert, UserRoundPlus } from 'lucide-react';
import { api, ApiError, humaniseError } from '../lib/api';
import { useToast } from '../components/Toast';
import { Button, Divider } from '../components/ui';
import { ListState } from '../components/StateViews';
import { AttendanceBadge, AttendancePicker } from '../components/AttendanceBadge';
import {
  CreditsLeft,
  chargesACredit,
  isLeave,
  isTeacherStatus,
  leaveExplanation,
  normaliseRoster,
} from './TeachTodayPage.Shared';
import type { RosterResponse, RosterRow } from './TeachTodayPage.Shared';
import type { AttendanceStatus } from '../lib/types';

const GRID = 'grid grid-cols-[40px_minmax(0,1.3fr)_130px_minmax(0,1.7fr)_110px_minmax(0,1fr)] gap-3 items-center';

type Draft = Record<number, AttendanceStatus>;

export default function TeachRoster({
  lessonId,
  onRecorded,
}: {
  lessonId: number;
  onRecorded: () => Promise<void> | void;
}) {
  const { push } = useToast();
  const [rows, setRows] = useState<RosterRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [overrideOpen, setOverrideOpen] = useState<number[]>([]);
  const [settling, setSettling] = useState(false);
  const [settled, setSettled] = useState<{ charged: number } | null>(null);
  const [correcting, setCorrecting] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<RosterResponse>(`/lessons/${lessonId}/roster`);
      const next = normaliseRoster(res);
      setRows(next);
      setDraft(Object.fromEntries(next.map((r) => [r.student_id, r.status])));
      setOverrideOpen([]);
      setCorrecting(null);
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
        .map((row) => ({ student_id: row.student_id, status: draft[row.student_id], note: '' })),
    [rows, draft],
  );

  const credits = useMemo(
    () => marks.filter((m) => chargesACredit(m.status)).length,
    [marks],
  );

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
        <span className="col-header">备注</span>
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
                  {leave || isSettledRow ? (
                    <>
                      <AttendanceBadge status={status} />
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
                  ) : correcting === row.student_id ? (
                    <span className="flex items-center gap-2">
                      <AttendancePicker value={status} onChange={(next) => void correct(row.student_id, next)} />
                      <button
                        type="button"
                        onClick={() => setCorrecting(null)}
                        className="text-meta text-muted hover:text-fg transition-colors duration-150 ease-standard"
                      >
                        取消
                      </button>
                    </span>
                  ) : (
                    <span className="flex items-center gap-2">
                      <AttendancePicker
                        value={status === 'unrecorded' ? null : status}
                        onChange={(next) => setDraft((prev) => ({ ...prev, [row.student_id]: next }))}
                      />
                      {isSettledRow && (
                        <Button
                          variant="ghost"
                          size="sm"
                          loading={busyId === row.student_id}
                          onClick={() => setCorrecting(row.student_id)}
                        >
                          <RotateCw size={14} aria-hidden />
                          纠错
                        </Button>
                      )}
                    </span>
                  )}
                </span>

                <span className="num text-meta text-muted">{row.settles}</span>

                <span className="text-meta text-muted">
                  {row.is_new_to_class ? '新学生，请向全班介绍' : '—'}
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
            <p className="flex items-center gap-1.5 text-meta text-muted">
              <TriangleAlert size={16} aria-hidden />
              出勤、迟到、缺席各扣 1 课时。系统已判定请假的同学会自动跳过——如果实际到课，可在上方覆盖。
            </p>
          </div>
          <Button
            variant="primary"
            size="touch"
            loading={settling}
            disabled={marks.length === 0 || settling}
            onClick={() => void settle()}
          >
            <CircleCheck size={20} aria-hidden />
            记录出勤
          </Button>
        </div>
      )}
    </div>
  );
}
