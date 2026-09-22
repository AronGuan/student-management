/**
 * 学生档案抽屉（右侧滑出，不跳页）。
 *
 * 一次请求：GET /students/:id 返回 StudentDetail —— 档案行 + guardians + enrollments +
 * packages + follow_ups + latest_ai_card（service/student_detail.go:62）。此前为了在班列表
 * 得打 1 次 /classes 再对每个班打一次名册，是 N+1；现在这些都在同一个响应里。
 *
 * 抽屉渲染三块：档案要点 + 监护人、课时（在 StudentsPage.Credits 里自取）、在班列表。
 * can_write 是服务端算好的 R7 结论（handler/student.go:98-100），写入动作的启停只看它一个布尔，
 * 前端不自己比较 owner_admin_id。
 */
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { CalendarDays, CircleSlash, LockKeyhole, UserRound, Users } from 'lucide-react';
import { Drawer } from '../components/Drawer';
import { KeyValue, Panel } from '../components/ui';
import { EmptyState, ErrorState, SkeletonRows } from '../components/StateViews';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { minutesToTime, shortDate, weekdayShort } from '../lib/format';
import type { StudentDetail } from '../lib/types';
import { StudentCredits } from './StudentsPage.Credits';
import { STUDENT_STATUS } from './StudentsPage.Parts';
import { useAsync } from './TodayPage.Async';

const ENROLMENT_STATUS = { active: '已报名', withdrawn: '已退班' } as const;

export function StudentDrawer({
  studentId,
  myId,
  onClose,
}: {
  studentId: number;
  myId: number | undefined;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const { role } = useAuth();
  const [nonce, setNonce] = useState(0);
  const bump = () => setNonce((n) => n + 1);

  const student = useAsync(() => api.get<StudentDetail>(`/students/${studentId}`), [studentId, nonce]);

  const row = student.data;
  const canWrite = row?.can_write === true;
  const guardians = row?.guardians ?? [];
  const enrolments = row?.enrollments ?? [];
  const subtitle = [row?.preferred_name, row?.year_level, row ? STUDENT_STATUS[row.status]?.label : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <Drawer
      open
      onClose={onClose}
      width={620}
      title={row?.full_name ?? `学生 #${studentId}`}
      subtitle={subtitle || undefined}
      footer={
        <p className="text-meta text-muted">
          所有员工都可以查看学生档案，只有归属顾问可以写入 —— 由服务端规则 R7 强制执行。
        </p>
      }
    >
      {student.loading && row === null ? (
        <SkeletonRows rows={5} cols={3} />
      ) : student.error ? (
        <ErrorState error={student.error} onRetry={student.reload} />
      ) : row === null ? null : (
        <div className="flex flex-col gap-5">
          <section className="flex flex-col gap-2">
            <h3 className="flex items-center gap-1.5 section-title text-fg">
              <UserRound size={16} aria-hidden />
              档案
            </h3>
            <Panel className="px-3 py-2">
              <KeyValue
                k="顾问"
                v={myId !== undefined && row.owner_admin_id === myId ? '我' : '其他顾问'}
              />
              <KeyValue k="来源" v={row.source || '未记录'} />
              <KeyValue k="创建于" v={<span className="num">{shortDate(row.created_at)}</span>} />
              <KeyValue k="最近更新" v={<span className="num">{shortDate(row.updated_at)}</span>} />
            </Panel>
            {!canWrite && (
              <p className="flex items-start gap-2 rounded-md border border-border bg-surface-sunken px-2.5 py-2 text-meta text-muted">
                <LockKeyhole size={16} className="mt-0.5 shrink-0" aria-hidden />
                {role === 'admin'
                  ? '仅可查看。该学生属于其他顾问，因此课时包与调整表单保持关闭。服务端同样返回 40301。'
                  : '仅可查看。开课时包与调整课时是顾问操作。'}
              </p>
            )}
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="flex items-center gap-1.5 section-title text-fg">
              <Users size={16} aria-hidden />
              家长
              <span className="num text-meta text-muted font-400">{guardians.length}</span>
            </h3>
            {guardians.length === 0 ? (
              <p className="text-meta text-muted">
                暂无家长信息。联系方式在学生登记时录入。
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {guardians.map((guardian) => (
                  <li key={guardian.id} className="flex items-start justify-between gap-3 py-2">
                    <span className="min-w-0 flex flex-col gap-0.5">
                      <span className="truncate text-row font-510 text-fg">{guardian.name}</span>
                      <span className="text-meta text-muted">
                        {guardian.relationship || '未记录关系'}
                        {guardian.is_primary ? ' · 主要联系人' : ''}
                      </span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-0.5 text-meta">
                      <span className="num text-fg-2">{guardian.phone || '无电话'}</span>
                      <span className="text-muted">{guardian.email || '无邮箱'}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <StudentCredits
            studentId={studentId}
            canWrite={canWrite}
            packages={row.packages}
            nonce={nonce}
            onChanged={bump}
          />

          <section className="flex flex-col gap-2">
            <h3 className="flex items-center gap-1.5 section-title text-fg">
              <CalendarDays size={16} aria-hidden />
              班级
              <span className="num text-meta text-muted font-400">{enrolments.length}</span>
            </h3>
            {enrolments.length === 0 ? (
              <EmptyState
                message="尚未报名任何班级。报名时会校验时间安排规则。"
                ctaLabel="打开班级"
                onCta={() => navigate('/classes')}
              />
            ) : (
              <ul className="divide-y divide-border">
                {enrolments.map((enrolment) => (
                  <li key={enrolment.id} className="flex items-center justify-between gap-3 py-2">
                    <span className="min-w-0 flex flex-col gap-0.5">
                      <span className="flex items-center gap-1.5 truncate text-row font-510 text-fg">
                        {enrolment.status === 'withdrawn' && (
                          <CircleSlash size={16} className="shrink-0 text-muted" aria-hidden />
                        )}
                        {enrolment.class_name}
                      </span>
                      <span className="num text-meta text-muted">
                        {weekdayShort(enrolment.weekday % 7)} {minutesToTime(enrolment.start_min)}–
                        {minutesToTime(enrolment.end_min)}
                        {enrolment.subject_name ? ` · ${enrolment.subject_name}` : ''}
                        {enrolment.teacher_name ? ` · ${enrolment.teacher_name}` : ''}
                      </span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-0.5 text-meta">
                      <span className={enrolment.status === 'active' ? 'text-fg-2' : 'text-muted'}>
                        {ENROLMENT_STATUS[enrolment.status]}
                      </span>
                      <span className="num text-muted">
                        {enrolment.status === 'withdrawn'
                          ? `退班于 ${shortDate(enrolment.withdrawn_on)}`
                          : `自 ${shortDate(enrolment.enrolled_on)}`}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-meta text-muted">
              报名变更在班级名册中操作，那里会校验周时间槽、老师与名额。
            </p>
          </section>
        </div>
      )}
    </Drawer>
  );
}
