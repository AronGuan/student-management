/**
 * 班级名册抽屉：排班（enrol）与退班（withdraw）。
 *
 * 这个抽屉的重点不是 CRUD，而是**把服务端的四条拒绝理由原样说出来**：
 *   40901 周时段重叠 / 40902 老师已被占用 / 40903 班级已满 / 40904 余额为 0（+ 40301 非本人学生）
 * 所以失败时同时给：人话标签（humaniseError）+ 服务端原句（err.message，里面带具体的冲突对象）。
 * 选择器里也顺带显示每个学生的余额，让「余额为 0」这件事在点下去之前就能看出来。
 *
 * 排班成功还要刷新外层班级表（人数变了），所以 onChanged 由父级传入。
 */
import { useRef, useState } from 'react';
import { LockKeyhole, TriangleAlert, UserMinus, UserRoundPlus } from 'lucide-react';
import { Drawer } from '../components/Drawer';
import { Button, Field, Select } from '../components/ui';
import { EmptyState, ErrorState, SkeletonRows } from '../components/StateViews';
import { useToast } from '../components/Toast';
import { api, humaniseError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { minutesToTime, weekdayShort } from '../lib/format';
import type { ClassItem, ClassMember, StudentPage } from '../lib/types';
import { SeatsCell } from './ClassesPage.Parts';
import { useAsync } from './TodayPage.Async';

export function RosterDrawer({
  cls,
  onClose,
  onChanged,
}: {
  cls: ClassItem;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { push } = useToast();
  const { role } = useAuth();
  const isAdmin = role === 'admin';
  const [nonce, setNonce] = useState(0);
  const [failure, setFailure] = useState<{ label: string; detail: string } | null>(null);
  const [pick, setPick] = useState('');
  const [enrolling, setEnrolling] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const pickerRef = useRef<HTMLSelectElement>(null);

  const roster = useAsync(() => api.get<ClassMember[]>(`/classes/${cls.id}/enrollments`), [cls.id, nonce]);
  // 只有 admin 会用到选择器；老师进来时不必为一个用不到的下拉框发请求。
  // 候选只列「自己名下的学生」：R7 叠在 R3 上，enrol 别人家的学生会直接被 40301 拒掉
  // （handler/scheduling.go:183），所以不必让它们在列表里出现。
  // 用 'me' 而不是本地 user id：这是服务端专门为此提供的过滤值，把「我是谁」留给
  // 发凭据的那一边。若某天调用者身份缺失，服务端会明确 401，而不是把过滤条件静默丢掉
  // 返回全表（handler/student.go:51-53 的注释就是这条）。
  const owned = useAsync<StudentPage>(
    () =>
      isAdmin
        ? api.get<StudentPage>('/students', { owner_admin_id: 'me', limit: 100 })
        : Promise.resolve({ items: [], total: 0, page: 1, limit: 0, has_more: false }),
    [nonce, isAdmin],
  );

  const rows = roster.data ?? [];
  const enrolledIds = new Set(rows.map((row) => row.student_id));
  const candidates = (owned.data?.items ?? []).filter((student) => !enrolledIds.has(student.id));

  function fail(err: unknown) {
    const label = humaniseError(err);
    setFailure({ label, detail: err instanceof Error ? err.message : '' });
    push('error', label);
  }

  async function enrol() {
    if (!pick) {
      setFailure({ label: '请先选择学生。', detail: '只能报名你自己名下的学生。' });
      return;
    }
    const student = candidates.find((c) => c.id === Number(pick));
    setEnrolling(true);
    setFailure(null);
    try {
      await api.post(`/classes/${cls.id}/enrollments`, { student_id: Number(pick) });
      push('success', `${student?.full_name ?? '学生'} 已报名 ${cls.name}。`);
      setPick('');
      setNonce((n) => n + 1);
      onChanged();
    } catch (err) {
      fail(err);
    } finally {
      setEnrolling(false);
    }
  }

  async function withdraw(studentId: number) {
    setBusyId(studentId);
    setFailure(null);
    try {
      await api.del(`/classes/${cls.id}/enrollments/${studentId}`);
      push('success', '学生已退班，名额已释放。');
      setConfirmId(null);
      setNonce((n) => n + 1);
      onChanged();
    } catch (err) {
      fail(err);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Drawer
      open
      onClose={onClose}
      width={560}
      title={cls.name}
      subtitle={[
        cls.subject_name ?? '未设置科目',
        cls.teacher_name ?? '未设置老师',
        `${weekdayShort(cls.weekday % 7)} ${minutesToTime(cls.start_min)}–${minutesToTime(cls.end_min)}`,
        cls.room,
      ]
        .filter(Boolean)
        .join(' · ')}
      footer={
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-meta text-muted">已报名 / 名额</span>
            <SeatsCell
              enrolled={roster.data ? rows.length : (cls.enrolled ?? 0)}
              capacity={cls.capacity}
            />
          </div>
          <p className="text-meta text-muted">
            以下情况会拒绝报名：每周时段重叠、老师已被占用、班级已满、余额为 0，或该学生属于其他顾问。服务端的原始原因会显示在上方。
          </p>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {failure && (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-md border border-danger bg-danger-bg px-2.5 py-2 text-row text-danger"
          >
            <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
            <span className="min-w-0">
              {failure.label}
              {failure.detail && failure.detail !== failure.label && (
                <span className="num block text-meta text-muted">{failure.detail}</span>
              )}
            </span>
          </p>
        )}

        <section className="flex flex-col gap-2">
          <h3 className="col-header">报名学生</h3>
          {!isAdmin ? (
            <p className="flex items-start gap-2 rounded-md border border-border bg-surface-sunken px-2.5 py-2 text-meta text-muted">
              <LockKeyhole size={16} className="mt-0.5 shrink-0" aria-hidden />
              只有顾问可以报名或退班。下方名单对你只读。
            </p>
          ) : owned.loading && owned.data === null ? (
            <SkeletonRows rows={1} cols={2} />
          ) : owned.error ? (
            <ErrorState error={owned.error} onRetry={owned.reload} />
          ) : (
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Field label="学生" hint="只列出你自己名下的学生，其他学生会被 40301 拒绝。">
                  <Select
                    ref={pickerRef}
                    value={pick}
                    onChange={(event) => setPick(event.target.value)}
                    className="w-full"
                    disabled={enrolling}
                  >
                    <option value="">请选择学生</option>
                    {candidates.map((student) => (
                      <option key={student.id} value={student.id}>
                        {student.full_name} · {student.balance} 课时
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Button variant="primary" size="sm" loading={enrolling} onClick={() => void enrol()}>
                <UserRoundPlus size={16} aria-hidden />
                报名
              </Button>
            </div>
          )}
          {isAdmin && candidates.length === 0 && !owned.loading && (
            <p className="text-meta text-muted">你名下的学生都已报名该班级。</p>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="col-header">名单</h3>
          {roster.loading && roster.data === null ? (
            <SkeletonRows rows={4} cols={3} />
          ) : roster.error ? (
            <ErrorState error={roster.error} onRetry={roster.reload} />
          ) : rows.length === 0 ? (
            <EmptyState
              message="暂无报名学生。没有名单的班级不会生成出勤。"
              ctaLabel="在上方选择学生"
              onCta={() => pickerRef.current?.focus()}
            />
          ) : (
            <ul className="divide-y divide-border">
              {rows.map((row) => (
                <li key={row.student_id} className="flex items-center justify-between gap-3 py-2">
                  <span className="min-w-0 flex flex-col gap-0.5">
                    <span className="text-row font-510 text-fg truncate">{row.full_name}</span>
                    <span className="num text-meta text-muted">{row.balance} 课时</span>
                  </span>
                  {isAdmin &&
                    (confirmId === row.student_id ? (
                      <span className="flex items-center gap-2 shrink-0">
                        <Button
                          variant="danger"
                          size="sm"
                          loading={busyId === row.student_id}
                          onClick={() => void withdraw(row.student_id)}
                        >
                          确认
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setConfirmId(null)}>
                          保留
                        </Button>
                      </span>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busyId !== null}
                        onClick={() => setConfirmId(row.student_id)}
                      >
                        <UserMinus size={16} aria-hidden />
                        退班
                      </Button>
                    ))}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Drawer>
  );
}
