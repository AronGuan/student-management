/**
 * 今日课堂 —— 老师的默认首屏，也是唯一会动钱的屏幕。
 *
 * 上：今日课表（GET /dashboard/teacher 提供每节课的人数 / 新生 / 请假 / 已记，
 *     再用 GET /lessons?date= 补齐服务端口径的"今天"）。选一节课即加载名单。
 * 下：点名表（TeachTodayPage.Roster.tsx），一次 POST 结算整节课。
 * 另：未点名的历史课以 nudge 形式常驻，老师第一眼就能看到欠了哪节课。
 *
 * "今天"取服务端返回的 lesson_date，不用浏览器本地日期 —— 墨尔本墙上时钟由
 * 服务端保证（ADR-007），前端不做时区推导。
 */
import { useCallback, useEffect, useState } from 'react';
import { CalendarX, ClipboardCheck, CircleDashed, CircleCheck, RotateCw, UserRoundPlus } from 'lucide-react';
import { api } from '../lib/api';
import { minutesToTime, shortDate } from '../lib/format';
import { Button, Panel, PanelHeader } from '../components/ui';
import { ErrorState, ListState, SkeletonRows } from '../components/StateViews';
import TeachRoster from './TeachTodayPage.Roster';
import type { Lesson, TeacherDashboard, TeacherLessonRow } from '../lib/types';

const GRID =
  'grid grid-cols-[92px_minmax(0,1.4fr)_minmax(0,1.5fr)_auto] gap-4 items-center';

function countsOf(row: TeacherLessonRow): { students: number; newFaces: number; onLeave: number } {
  return { students: row.students ?? 0, newFaces: row.new_faces ?? 0, onLeave: row.on_leave ?? 0 };
}

function lessonFromLesson(l: Lesson): TeacherLessonRow {
  return {
    id: l.id,
    class_id: l.class_id,
    class_name: l.class_name,
    subject_name: l.subject_name,
    lesson_date: l.lesson_date,
    start_min: l.start_min,
    start_clock: `${String(Math.floor(l.start_min / 60)).padStart(2, '0')}:${String(l.start_min % 60).padStart(2, '0')}`,
    status: l.status,
    students: 0,
    new_faces: 0,
    on_leave: 0,
    recorded: 0,
  };
}

export default function TeachTodayPage() {
  const [board, setBoard] = useState<TeacherDashboard | null>(null);
  const [lessons, setLessons] = useState<TeacherLessonRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const dash = await api.get<TeacherDashboard>('/dashboard/teacher');
      const today = dash?.today ?? [];
      setBoard({ today, missing_roll_call: dash?.missing_roll_call ?? 0 });

      // 用服务端自己的"今天"去补课表，避免拿浏览器时区猜日期
      const dateKey = today[0]?.lesson_date;
      const extra = dateKey ? await api.get<Lesson[]>('/lessons', { date: dateKey }) : [];
      const merged = [...today];
      for (const l of extra) {
        if (!merged.some((row) => row.id === l.id)) merged.push(lessonFromLesson(l));
      }
      setLessons(merged.sort((a, b) => a.lesson_date.localeCompare(b.lesson_date) || a.start_min - b.start_min));
    } catch (err) {
      setError(err);
      setBoard(null);
      setLessons([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const todayKey = board?.today[0]?.lesson_date ?? null;
  const selected = lessons.find((l) => l.id === selectedId) ?? null;

  return (
    <main className="p-4 flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title text-fg">今日课程</h1>
          <p className="text-meta text-muted">
            {todayKey ? (
              <>
                <span className="num font-510 text-fg-2">{shortDate(todayKey)}</span> · 墨尔本 ·{' '}
              </>
            ) : null}
            今日课表共 <span className="num font-510 text-fg-2">{lessons.length}</span> 节课
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => void load()}>
          <RotateCw size={16} aria-hidden />
          刷新
        </Button>
      </header>

      {board && board.missing_roll_call > 0 && (
        <aside className="flex items-start gap-2 rounded-lg border border-warn bg-warn-bg px-4 py-3">
          <CircleDashed size={16} aria-hidden className="mt-0.5 shrink-0 text-warn" />
          <p className="text-row text-warn">
            <span className="num font-590">{board.missing_roll_call}</span> 节已过去的课尚未记录出勤。这些课的课时还没有变动——从下方列表打开该节课即可结算。
          </p>
        </aside>
      )}

      <Panel>
        <PanelHeader
          title="今日课表"
          count={lessons.length}
          icon={<ClipboardCheck size={16} aria-hidden />}
        />
        {loading ? (
          <SkeletonRows rows={3} cols={4} />
        ) : error ? (
          <ErrorState error={error} onRetry={() => void load()} />
        ) : (
          <ListState
            loading={false}
            error={null}
            isEmpty={lessons.length === 0}
            emptyMessage="还没有排课。课表生成后，今日课程会显示在这里。"
            emptyCta="刷新课表"
            onEmptyCta={() => void load()}
            onRetry={() => void load()}
            rows={3}
            cols={4}
          >
            <div className={`${GRID} px-4 h-9 border-b border-border bg-surface-sunken`}>
              <span className="col-header">开始时间</span>
              <span className="col-header">班级</span>
              <span className="col-header">学生情况</span>
              <span className="col-header text-right">点名</span>
            </div>
            <div className="divide-y divide-border">
              {lessons.map((lesson) => {
                const c = countsOf(lesson);
                const isToday = todayKey === null || lesson.lesson_date === todayKey;
                const done = lesson.status === 'completed' || (c.students > 0 && lesson.recorded >= c.students);
                const partial = !done && lesson.recorded > 0;
                const isSelected = selectedId === lesson.id;
                return (
                  <div
                    key={lesson.id}
                    className={`${GRID} px-4 min-h-9 py-1.5 transition-colors duration-150 ease-standard hover:bg-row-hover ${
                      isSelected ? 'bg-accent-bg' : ''
                    }`}
                  >
                    <span className="flex flex-col">
                      <span className="num text-row font-510 text-fg">{lesson.start_clock || minutesToTime(lesson.start_min)}</span>
                      {!isToday && <span className="num text-meta text-muted">{shortDate(lesson.lesson_date)}</span>}
                    </span>

                    <span className="flex flex-col min-w-0">
                      <span className="text-row font-510 text-fg truncate">{lesson.class_name}</span>
                      <span className="text-meta text-muted truncate">{lesson.subject_name ?? '—'}</span>
                    </span>

                    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="num text-meta text-muted">{c.students} 人已报名</span>
                      {c.newFaces > 0 && (
                        <span className="inline-flex items-center gap-1 text-meta text-accent">
                          <UserRoundPlus size={16} aria-hidden />
                          <span className="num">{c.newFaces}</span> 名新学生
                        </span>
                      )}
                      {c.onLeave > 0 && (
                        <span className="inline-flex items-center gap-1 text-meta text-muted">
                          <CalendarX size={16} aria-hidden />
                          <span className="num">{c.onLeave}</span> 人请假
                        </span>
                      )}
                    </span>

                    <span className="flex items-center justify-end gap-2">
                      {done ? (
                        <span className="inline-flex items-center gap-1.5 text-meta font-510 text-success">
                          <CircleCheck size={16} aria-hidden />
                          已记录
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-meta font-510 text-warn">
                          <CircleDashed size={16} aria-hidden />
                          {partial ? `部分已记录 ${lesson.recorded}/${c.students}` : '未记录'}
                        </span>
                      )}
                      <Button variant="secondary" size="sm" onClick={() => setSelectedId(lesson.id)}>
                        {done ? '查看名单' : '开始点名'}
                      </Button>
                    </span>
                  </div>
                );
              })}
            </div>
          </ListState>
        )}
      </Panel>

      {selected && (
        <Panel>
          <PanelHeader
            title={`${selected.class_name} · ${selected.start_clock || minutesToTime(selected.start_min)}`}
            icon={<ClipboardCheck size={16} aria-hidden />}
            action={
              <span className="flex items-center gap-3">
                <span className="num text-meta text-muted">{shortDate(selected.lesson_date)}</span>
                <Button variant="ghost" size="sm" onClick={() => setSelectedId(null)}>
                  关闭名单
                </Button>
              </span>
            }
          />
          <TeachRoster
            lessonId={selected.id}
            isToday={todayKey === null || selected.lesson_date === todayKey}
            onRecorded={load}
          />
        </Panel>
      )}
    </main>
  );
}
