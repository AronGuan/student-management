/**
 * 请假表单 —— 本页最要紧的交互。
 *
 * 硬性要求：**提交前**就把 24h 阈值的后果说清楚（还剩几小时、扣不扣、余额变成多少），
 * 并且不用 tooltip 藏起来；提交后展示服务端返回的 resolution，而不是假设成功，
 * 也不发明一个服务端不存在的「待审批」中间态。
 */
import { useMemo, useState } from 'react';
import { CalendarClock, CalendarX, Send } from 'lucide-react';
import { api, humaniseError } from '../lib/api';
import { dateTime, hoursUntil, minutesToTime, shortDate } from '../lib/format';
import { useToast } from '../components/Toast';
import { Button, Field, Input, Select } from '../components/ui';
import { lessonStartIso, verdictFor, RESOLUTION_LABEL } from './MyCreditsPage.Shared';
import type { LessonOption } from './MyCreditsPage.Shared';
import type { LeaveRequest } from '../lib/types';

export interface LeaveResult extends Omit<LeaveRequest, 'reason'> {
  reason?: string | null;
  hours_before_start?: number;
}

export default function MyCreditsLeaveForm({
  studentId,
  balance,
  threshold,
  options,
  onSubmitted,
}: {
  studentId: number;
  balance: number;
  threshold: number;
  options: LessonOption[];
  onSubmitted: () => Promise<void> | void;
}) {
  const { push } = useToast();
  const [lessonId, setLessonId] = useState<string>(() =>
    options.length > 0 ? String(options[0].lesson_id) : '',
  );
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<LeaveResult | null>(null);

  const chosen = useMemo(
    () => options.find((o) => String(o.lesson_id) === lessonId) ?? null,
    [options, lessonId],
  );
  const hours = chosen ? hoursUntil(lessonStartIso(chosen.lesson_date, chosen.start_min)) : null;
  const verdict = hours === null ? null : verdictFor(hours, threshold);
  const started = hours !== null && hours <= 0;

  async function submit() {
    if (!chosen) return;
    setSubmitting(true);
    try {
      const res = await api.post<LeaveResult>('/leave-requests', {
        lesson_id: chosen.lesson_id,
        student_id: studentId,
        reason: reason.trim(),
      });
      setResult(res);
      setReason('');
      push(
        'success',
        res.resolution === 'approved_ge_24h'
          ? '请假已登记，不扣课时。'
          : '请假已登记，扣 1 课时。',
      );
      await onSubmitted();
    } catch (err) {
      push('error', `请假未登记。${humaniseError(err)}`);
    } finally {
      setSubmitting(false);
    }
  }

  if (options.length === 0) {
    return (
      <section className="flex flex-col gap-3 rounded-md border border-border p-3">
        <h3 className="section-title text-fg">请选择要请假的课次</h3>
        <p className="text-row text-muted">
          当前课表里还没有尚未开始的课次，暂时无法请假。等校区排出后续课次后，会显示在这里。
        </p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3 rounded-md border border-border p-3">
      <h3 className="section-title text-fg">请选择要请假的课次</h3>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="课次">
          <Select value={lessonId} onChange={(e) => setLessonId(e.target.value)}>
            {options.map((o) => (
              <option key={o.lesson_id} value={String(o.lesson_id)}>
                {shortDate(o.lesson_date)} {minutesToTime(o.start_min)} · {o.class_name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="原因" hint="选填。老师点名时会看到这段说明。">
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="家庭出行、就医预约…"
          />
        </Field>
      </div>

      {verdict && (
        <p
          className={`flex items-start gap-2 rounded-md px-3 py-2 text-row ${
            verdict.late
              ? 'border border-warn bg-warn-bg text-warn'
              : 'border border-border bg-surface-sunken text-fg-2'
          }`}
        >
          {verdict.late ? (
            <CalendarClock size={16} aria-hidden className="mt-0.5 shrink-0" />
          ) : (
            <CalendarX size={16} aria-hidden className="mt-0.5 shrink-0" />
          )}
          <span>
            <span className="font-510">{verdict.headline}。</span> {verdict.detail}{' '}
            {verdict.late ? (
              <>
                你的余额将从 <span className="num font-590">{balance}</span> 变为{' '}
                <span className="num font-590">{balance - 1}</span> 课时。
              </>
            ) : (
              <>
                你的余额保持 <span className="num font-590">{balance}</span> 课时不变。
              </>
            )}{' '}
            {verdict.borderline && (
              <span className="text-meta">
                你正好卡在通知时限的边缘；校区按小时判定，提交后这里会立刻显示确切结果。
              </span>
            )}
          </span>
        </p>
      )}

      <div>
        <Button
          variant="primary"
          size="touch"
          loading={submitting}
          disabled={!chosen || started || submitting}
          onClick={() => void submit()}
        >
          <Send size={20} aria-hidden />
          提交请假申请
        </Button>
        {started && (
          <p className="mt-2 text-meta text-muted">
            这节课已经开始，接下来的出勤由老师判定。
          </p>
        )}
      </div>

      {result && (
        <div className="flex flex-col gap-1 rounded-md border border-border bg-surface-sunken px-3 py-2">
          <span className="col-header">系统记录的结果</span>
          <span
            className={`inline-flex items-center gap-1.5 text-row font-510 ${
              result.resolution === 'approved_ge_24h' ? 'text-neutral-fg' : 'text-warn'
            }`}
          >
            {result.resolution === 'approved_ge_24h' ? (
              <CalendarX size={16} aria-hidden />
            ) : (
              <CalendarClock size={16} aria-hidden />
            )}
            {RESOLUTION_LABEL[result.resolution] ?? result.resolution}
          </span>
          <span className="num text-meta text-muted">
            提交于 {dateTime(result.requested_at)}
            {typeof result.hours_before_start === 'number' && ` · 距上课 ${result.hours_before_start} 小时`}
          </span>
        </div>
      )}
    </section>
  );
}
