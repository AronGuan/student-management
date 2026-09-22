/**
 * 家长端的「选课 / 请假」区。
 *
 * 只负责取数与呈现：在读书班级 → 具体课次 → 已登记的请假；表单本身在
 * MyCreditsPage.LeaveForm.tsx（提交前的 24h 告知 + 提交后展示服务端判定）。
 *
 * 两次请求就够：GET /students/:id 拿「这个孩子」的在读班级（含班名/科目/老师/周几），
 * GET /lessons 拿具体课次。两者都由服务端做数据范围控制，前端不自己筛权限。
 *
 * 为什么周课表不用 GET /classes：它对家庭账号是按「整个家庭」预过滤的
 * （scheduling.go 的 EXISTS 子查询只比对 user_id），多子女家庭会拿到全部孩子的班，
 * 切换孩子时周课表不会变。GET /students/:id 才是按单个学生的。
 *
 * 为什么不给 /lessons 传 from/to：服务端没有暴露「今天」这个日期串，前端一旦用浏览器
 * 时钟去拼 from，就等于擅自做了时区换算（ADR-007 禁止）。所以只过滤绝对时刻 ——
 * hoursUntil 比较的是 Date.parse(课次+10:00) 与真实 now，与时区无关。
 */
import { useCallback, useEffect, useState } from 'react';
import { CalendarClock, CalendarDays, CalendarX } from 'lucide-react';
import { api } from '../lib/api';
import { dateTime, hoursUntil, minutesToTime, weekdayShort } from '../lib/format';
import { Panel, PanelHeader } from '../components/ui';
import { ErrorState, ListState, SkeletonRows } from '../components/StateViews';
import MyCreditsLeaveForm from './MyCreditsPage.LeaveForm';
import { lessonStartIso, toLessonOption, RESOLUTION_LABEL } from './MyCreditsPage.Shared';
import type { LessonOption, ScheduleSlot } from './MyCreditsPage.Shared';
import type { LeaveRequest, Lesson, StudentDetail } from '../lib/types';

interface LeaveRequestRow extends Omit<LeaveRequest, 'reason'> {
  reason?: string | null;
  hours_before_start?: number;
}

export default function MyCreditsLeave({
  studentId,
  balance,
  threshold,
  onChanged,
}: {
  studentId: number;
  balance: number;
  threshold: number;
  onChanged: () => Promise<void> | void;
}) {
  const [slots, setSlots] = useState<ScheduleSlot[]>([]);
  const [options, setOptions] = useState<LessonOption[]>([]);
  const [requests, setRequests] = useState<LeaveRequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const loadRequests = useCallback(async () => {
    const reqs = await api.get<LeaveRequestRow[]>('/leave-requests', { student_id: studentId });
    setRequests(Array.isArray(reqs) ? reqs : []);
  }, [studentId]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // 1) 该学生的在读班级。GET /students/:id 是「学生抽屉」的一次性取数，报名行自带
      //    班名 / 科目 / 老师 / 周几 / 起止分钟。这里刻意不用 GET /classes：服务端对家庭
      //    账号是按「家庭」预过滤的（scheduling.go 的 EXISTS 子查询只比对 user_id），
      //    多子女家庭会拿到所有孩子的班，切换孩子时周课表就不会变 —— 串班。
      const detail = await api.get<StudentDetail>(`/students/${studentId}`);
      // enrollments 是**完整入班历史、含 withdrawn**（服务端刻意不加 status 过滤，
      // 抽屉要展示历史）。所以这里的 filter 不是兜底而是语义的一部分：周课表只列在读的班。
      const active = (detail?.enrollments ?? []).filter((e) => e.status === 'active');
      setSlots(
        active
          .map((e) => ({
            class_id: e.class_id,
            class_name: e.class_name,
            // 与 toLessonOption 同一口径：Enrollment 的这两个字段是裸 string（服务端
            // 不带 omitempty），落空即 "" 而不是 null。若原样透传，下游的 `?? '—'`
            // 不会生效，界面会显示空白。这里用 || 把 "" 和 null 一起归一成 null。
            subject_name: e.subject_name || null,
            teacher_name: e.teacher_name || null,
            weekday: e.weekday,
            start_min: e.start_min,
            end_min: e.end_min,
          }))
          .sort((a, b) => a.weekday - b.weekday || a.start_min - b.start_min),
      );

      // 2) 具体课次（请假必须点名 lesson_id）。服务端已把范围限制到本人子女的班级，
      //    返回体自带 class_name / subject_name，不再需要逐班轮询。
      const byClass = new Map(active.map((e) => [e.class_id, e]));
      const lessons = await api.get<Lesson[]>('/lessons');
      setOptions(
        (Array.isArray(lessons) ? lessons : [])
          .filter((l) => l.status === 'scheduled')
          .map((l) => toLessonOption(l, byClass))
          // 无日期过滤时会带回历史课次，只保留尚未开始的，最早的排最前
          .filter((o) => hoursUntil(lessonStartIso(o.lesson_date, o.start_min)) > 0)
          .sort((a, b) => a.lesson_date.localeCompare(b.lesson_date) || a.start_min - b.start_min),
      );

      // 3) 已登记的请假（结果由服务端即时判定，没有审批队列）
      await loadRequests();
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [studentId, loadRequests]);

  useEffect(() => {
    void load();
  }, [load]);

  async function afterSubmit() {
    await loadRequests();
    await onChanged();
  }

  return (
    <Panel>
      <PanelHeader title="申请请假" icon={<CalendarDays size={16} aria-hidden />} />

      {loading ? (
        <SkeletonRows rows={3} cols={3} />
      ) : error ? (
        <ErrorState error={error} onRetry={() => void load()} />
      ) : (
        <div className="flex flex-col gap-4 p-4">
          <section className="flex flex-col gap-2">
            <h3 className="section-title text-fg">每周课表</h3>
            <ListState
              loading={false}
              error={null}
              isEmpty={slots.length === 0}
              emptyMessage="这个账号还没有报名任何班级。请先联系校区为孩子报名。"
              emptyCta="刷新课表"
              onEmptyCta={() => void load()}
              rows={3}
              cols={3}
            >
              <div className="divide-y divide-border rounded-md border border-border">
                {slots.map((slot) => (
                  <div key={slot.class_id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2">
                    <span className="num w-20 text-row font-510 text-fg">{weekdayShort(slot.weekday)}</span>
                    <span className="num text-row text-fg-2">
                      {minutesToTime(slot.start_min)}–{minutesToTime(slot.end_min)}
                    </span>
                    <span className="text-row text-fg">{slot.class_name}</span>
                    <span className="text-meta text-muted">{slot.subject_name ?? '—'}</span>
                    <span className="text-meta text-muted">{slot.teacher_name ?? '老师待定'}</span>
                  </div>
                ))}
              </div>
            </ListState>
          </section>

          <MyCreditsLeaveForm
            studentId={studentId}
            balance={balance}
            threshold={threshold}
            options={options}
            onSubmitted={afterSubmit}
          />

          <section className="flex flex-col gap-2">
            <h3 className="section-title text-fg">已登记的请假</h3>
            <ListState
              loading={false}
              error={null}
              isEmpty={requests.length === 0}
              emptyMessage="这个账号还没有登记过请假。"
              emptyCta="刷新"
              onEmptyCta={() => void loadRequests()}
              rows={2}
              cols={3}
            >
              <div className="divide-y divide-border rounded-md border border-border">
                {requests.map((req) => {
                  const approved = req.resolution === 'approved_ge_24h';
                  return (
                    <div key={req.id} className="flex flex-wrap items-start gap-x-4 gap-y-1 px-3 py-2">
                      <span
                        className={`inline-flex items-center gap-1.5 text-meta font-510 ${
                          approved ? 'text-neutral-fg' : 'text-warn'
                        }`}
                      >
                        {approved ? <CalendarX size={16} aria-hidden /> : <CalendarClock size={16} aria-hidden />}
                        {RESOLUTION_LABEL[req.resolution] ?? req.resolution}
                      </span>
                      <span className="num text-meta text-muted">课次 #{req.lesson_id}</span>
                      {req.reason && <span className="text-meta text-fg-2">{req.reason}</span>}
                      <span className="num ml-auto text-meta text-muted">
                        {typeof req.hours_before_start === 'number' && `提前 ${req.hours_before_start} 小时 · `}
                        {dateTime(req.requested_at)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </ListState>
          </section>
        </div>
      )}
    </Panel>
  );
}
