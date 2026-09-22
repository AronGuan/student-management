/**
 * 建班抽屉（admin）。
 *
 * 科目与老师选项来自 GET /subjects 与 GET /teachers（router.go:87-88，仅 admin）。
 * 此前是从既有班级列表里去重反推，导致空库时**根本建不出第一个班** —— 没有班就没有
 * 科目/老师可反推，表单只能禁用提交。现在两个 picker 有真实来源。
 *
 * 冲突校验仍在服务端：40902 老师时段冲突会带着具体冲突对象回来，这里原样显示。
 */
import { useState } from 'react';
import { CalendarPlus, TriangleAlert } from 'lucide-react';
import { Drawer } from '../components/Drawer';
import { Button, Field, Input, Select } from '../components/ui';
import { ErrorState, SkeletonRows } from '../components/StateViews';
import { useToast } from '../components/Toast';
import { api, humaniseError } from '../lib/api';
import { weekdayLong } from '../lib/format';
import type { Subject, TeacherOption } from '../lib/types';
import { useAsync } from './TodayPage.Async';

function toMinutes(clock: string): number {
  const [hours, minutes] = clock.split(':').map(Number);
  return hours * 60 + minutes;
}

export function CreateClassDrawer({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { push } = useToast();
  const [name, setName] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [teacherId, setTeacherId] = useState('');
  const [weekday, setWeekday] = useState('4');
  const [start, setStart] = useState('16:00');
  const [end, setEnd] = useState('17:30');
  const [capacity, setCapacity] = useState('8');
  const [room, setRoom] = useState('');
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
    const startMin = toMinutes(start);
    const endMin = toMinutes(end);
    const seats = Number(capacity);
    if (!name.trim()) {
      setFailure({ label: '班级需要一个名称。', detail: '例如「AEIS Maths B」。' });
      return;
    }
    if (!subjectId || !teacherId) {
      setFailure({ label: '请选择科目和老师。', detail: '创建时段时两者必填。' });
      return;
    }
    if (!Number.isFinite(startMin) || !Number.isFinite(endMin) || endMin <= startMin) {
      setFailure({ label: '结束时间必须晚于开始时间。', detail: '时间均为墨尔本本地时间。' });
      return;
    }
    if (!Number.isInteger(seats) || seats < 1 || seats > 100) {
      setFailure({ label: '名额必须是 1 到 100 之间的整数。', detail: '服务端强制同一范围。' });
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      await api.post('/classes', {
        name: name.trim(),
        subject_id: Number(subjectId),
        teacher_id: Number(teacherId),
        weekday: Number(weekday),
        start_min: startMin,
        end_min: endMin,
        capacity: seats,
        room: room.trim() || undefined,
      });
      push('success', `${name.trim()} 已创建。可从其名单中添加学生。`);
      onCreated();
    } catch (err) {
      setFailure({ label: humaniseError(err), detail: err instanceof Error ? err.message : '' });
      push('error', humaniseError(err));
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
      title="新建班级"
      subtitle="班级是每周固定时段，而不是单节课。"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" size="sm" loading={busy} disabled={blockers} onClick={() => void submit()}>
            <CalendarPlus size={16} aria-hidden />
            新建班级
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
        {firstLoad ? (
          <SkeletonRows rows={3} cols={2} />
        ) : options.error ? (
          <ErrorState error={options.error} onRetry={options.reload} />
        ) : catalogueEmpty ? (
          <p className="flex items-start gap-2 rounded-md border border-border bg-surface-sunken px-2.5 py-2 text-meta text-muted">
            <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
            中心尚无{subjects.length === 0 ? '科目' : '老师'}记录，无法命名或配置时段。请先补一个。
          </p>
        ) : null}

        <Field label="班级名称">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="AEIS Maths B" disabled={busy} />
        </Field>

        <div className="flex gap-3">
          <div className="flex-1">
            <Field label="科目">
              <Select value={subjectId} onChange={(e) => setSubjectId(e.target.value)} disabled={busy || firstLoad} className="w-full">
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
              <Select value={teacherId} onChange={(e) => setTeacherId(e.target.value)} disabled={busy || firstLoad} className="w-full">
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

        <Field label="星期">
          <Select value={weekday} onChange={(e) => setWeekday(e.target.value)} disabled={busy} className="w-full">
            {[1, 2, 3, 4, 5, 6, 7].map((day) => (
              <option key={day} value={day}>
                {weekdayLong(day % 7)}
              </option>
            ))}
          </Select>
        </Field>

        <div className="flex gap-3">
          <div className="flex-1">
            <Field label="开始">
              <Input type="time" value={start} onChange={(e) => setStart(e.target.value)} className="num" disabled={busy} />
            </Field>
          </div>
          <div className="flex-1">
            <Field label="结束">
              <Input type="time" value={end} onChange={(e) => setEnd(e.target.value)} className="num" disabled={busy} />
            </Field>
          </div>
          <Field label="名额">
            <Input
              type="number"
              min={1}
              max={100}
              value={capacity}
              onChange={(e) => setCapacity(e.target.value)}
              className="num w-[84px]"
              disabled={busy}
            />
          </Field>
        </div>

        <Field label="教室" hint="选填。显示在班级行上。">
          <Input value={room} onChange={(e) => setRoom(e.target.value)} placeholder="教室 2" disabled={busy} />
        </Field>

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
