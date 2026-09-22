/**
 * 安排试听抽屉 —— 漏斗的第二跳（线索 → 试听）。
 *
 * 提交成功时服务端在一个事务里顺手把学生状态从 `lead` 推到 `trial`
 * （service/trial.go:57），所以这一跳不只是插了一行试听：这条线索真的离开了线索栏。
 * 页面的成功回调因此要把档位切到「待记录结果」，让用户看到学生落在了哪里。
 *
 * 三件事值得单独说明：
 *   1. 科目与老师来自 GET /subjects、GET /teachers（router.go:88-89，仅 admin），
 *      与建班抽屉同一来源，不从既有试听行里反推。
 *   2. scheduled_at 是全 app 唯一一个前端拼出来的**绝对时刻**，偏移必须按目标日期算
 *      （见 lib/format.ts 的 melbourneInstant）。
 *   3. R1（同一学生同一科目只能有一次试听，uq_trial_once）由服务端强制。这里**不做**
 *      本地预检 —— 那需要在前端维护一份「这个学生试过哪些科目」的镜像，而镜像会过期。
 */
import { useState } from 'react';
import { CalendarPlus, TriangleAlert } from 'lucide-react';
import { Drawer } from '../components/Drawer';
import { Button, Field, Input, Select } from '../components/ui';
import { ErrorState, SkeletonRows } from '../components/StateViews';
import { useToast } from '../components/Toast';
import { ApiError, api, humaniseError } from '../lib/api';
import { melbourneInstant } from '../lib/format';
import type { StudentListItem, Subject, TeacherOption } from '../lib/types';
import { melbourneDay, useAsync } from './TodayPage.Async';

export function BookTrialDrawer({
  student,
  onClose,
  onBooked,
}: {
  student: StudentListItem;
  onClose: () => void;
  onBooked: () => void;
}) {
  const { push } = useToast();
  const [subjectId, setSubjectId] = useState('');
  const [teacherId, setTeacherId] = useState('');
  // 默认明天、min 今天：两者都取自墨尔本墙上时钟（melbourneDay），不是浏览器本地日期 ——
  // 浏览器时区不一定在墨尔本，用 new Date() 会给出差一天的默认值。
  const [date, setDate] = useState(melbourneDay(1));
  const [time, setTime] = useState('16:00');
  const [failure, setFailure] = useState<{ label: string; detail: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const options = useAsync(async () => {
    const [subjects, teachers] = await Promise.all([
      api.get<Subject[]>('/subjects'),
      api.get<TeacherOption[]>('/teachers'),
    ]);
    return { subjects, teachers };
  });

  const subjects = options.data?.subjects ?? [];
  const teachers = options.data?.teachers ?? [];
  const catalogueEmpty = options.data !== null && (subjects.length === 0 || teachers.length === 0);
  const firstLoad = options.loading && options.data === null;

  async function submit() {
    if (!subjectId || !teacherId) {
      setFailure({ label: '请选择科目和老师。', detail: '服务端要求两者必填。' });
      return;
    }
    if (!date || !time) {
      setFailure({ label: '请选择试听的日期和时间。', detail: '' });
      return;
    }
    // 拼出来的时刻必须晚于现在。服务端**不校验**这一条，所以这是客户端补的一道闸：
    // 否则可以把它约到上周三，而那样的一行会立刻以「逾期」的形态出现在试听表里。
    const scheduledAt = melbourneInstant(date, time);
    const when = Date.parse(scheduledAt);
    if (Number.isNaN(when) || when <= Date.now()) {
      setFailure({ label: '试听时间必须晚于现在。', detail: `当前填的是 ${date} ${time}。` });
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      // 只送模型里那四个字段：duration_min 缺省 60、outcome 缺省 pending 都由服务端补
      // （service/trial.go:42-47），前端不重复声明这两个默认值。
      await api.post('/trials', {
        student_id: student.id,
        subject_id: Number(subjectId),
        teacher_id: Number(teacherId),
        scheduled_at: scheduledAt,
      });
      push('success', `已为 ${student.full_name} 安排试听。`);
      onBooked();
    } catch (err) {
      setFailure({
        label: humaniseError(err),
        detail:
          err instanceof ApiError && err.code === 40905
            ? '同一学生同一科目只能有一次试听。换一个科目，或先去试听表里记录这次的结果。'
            : err instanceof Error
              ? err.message
              : '',
      });
    } finally {
      setBusy(false);
    }
  }

  const blockers = firstLoad || options.error !== null || catalogueEmpty;

  return (
    <Drawer
      open
      onClose={onClose}
      width={480}
      title="安排试听"
      subtitle="约上之后，这条线索就进入试听栏。"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" size="sm" loading={busy} disabled={blockers} onClick={() => void submit()}>
            <CalendarPlus size={16} aria-hidden />
            安排试听
          </Button>
        </div>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {/* 学生是只读的：这次试听登记在谁名下由打开抽屉的那一行决定，抽屉里没有可改的入口。 */}
        <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface-sunken px-2.5 py-2">
          <span className="text-meta text-muted">本次试听登记在</span>
          <span className="truncate text-row font-510 text-fg">
            {student.full_name}
            {student.year_level && <span className="text-meta text-muted"> · {student.year_level}</span>}
          </span>
        </div>

        {firstLoad ? (
          <SkeletonRows rows={3} cols={2} />
        ) : options.error ? (
          <ErrorState error={options.error} onRetry={options.reload} />
        ) : catalogueEmpty ? (
          <p className="flex items-start gap-2 rounded-md border border-border bg-surface-sunken px-2.5 py-2 text-meta text-muted">
            <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
            中心尚无{subjects.length === 0 ? '科目' : '老师'}记录，无法安排试听。请先补一个。
          </p>
        ) : null}

        <div className="flex gap-3">
          <div className="flex-1">
            <Field label="科目">
              <Select
                value={subjectId}
                onChange={(e) => setSubjectId(e.target.value)}
                disabled={busy || firstLoad}
                className="w-full"
              >
                <option value="">请选择科目</option>
                {subjects.map((subject) => (
                  <option key={subject.id} value={subject.id}>
                    {subject.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="flex-1">
            <Field label="老师">
              <Select
                value={teacherId}
                onChange={(e) => setTeacherId(e.target.value)}
                disabled={busy || firstLoad}
                className="w-full"
              >
                <option value="">请选择老师</option>
                {teachers.map((teacher) => (
                  <option key={teacher.id} value={teacher.id}>
                    {teacher.display_name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </div>

        <div className="flex gap-3">
          <div className="flex-1">
            <Field label="日期" hint="墨尔本时间。">
              <Input
                type="date"
                value={date}
                min={melbourneDay(0)}
                onChange={(e) => setDate(e.target.value)}
                className="num"
                disabled={busy}
              />
            </Field>
          </div>
          <div className="flex-1">
            <Field label="时间">
              <Input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className="num"
                disabled={busy}
              />
            </Field>
          </div>
        </div>

        {failure && (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-md border border-danger bg-danger-bg px-2.5 py-2 text-row text-danger"
          >
            <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
            <span className="min-w-0">
              {failure.label}
              {failure.detail && failure.detail !== failure.label && (
                <span className="block text-meta text-muted">{failure.detail}</span>
              )}
            </span>
          </p>
        )}
      </form>
    </Drawer>
  );
}
