/**
 * 班级与排班 /classes。
 *
 * 这张表的每一列都在回答一个排班问题：谁教、教什么、什么时候、还剩几个位置。
 * 课程冲突不是在这里检测的 —— 冲突发生在「把学生放进班」的那一刻（R3/R6），
 * 所以入口是每行的 Roster 抽屉，而不是一个通用的「编辑」按钮。
 *
 * 建班入口只对 admin 显示（服务端 RequireRoles(admin) 同样会拦）。
 */
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { CalendarDays, CalendarPlus, ChevronRight, RotateCw } from 'lucide-react';
import { Button, Panel } from '../components/ui';
import { ListState } from '../components/StateViews';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { minutesToTime, weekdayShort } from '../lib/format';
import type { ClassItem } from '../lib/types';
import { CreateClassDrawer } from './ClassesPage.CreateDrawer';
import { RosterDrawer } from './ClassesPage.Roster';
import { SeatsCell } from './ClassesPage.Parts';
import { useAsync } from './TodayPage.Async';

export default function ClassesPage() {
  const { role } = useAuth();
  const navigate = useNavigate();
  const [nonce, setNonce] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const isAdmin = role === 'admin';
  const classes = useAsync(() => api.get<ClassItem[]>('/classes'), [nonce]);
  const rows = classes.data ?? [];
  const selected = rows.find((cls) => cls.id === selectedId) ?? null;
  const totalSeats = rows.reduce((sum, cls) => sum + cls.capacity, 0);
  const takenSeats = rows.reduce((sum, cls) => sum + (cls.enrolled ?? 0), 0);

  return (
    <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-4 px-5 py-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="page-title text-fg">班级</h1>
          <p className="text-meta text-muted">
            每周固定时段。排课冲突在学生报名时校验，而非建班时。
          </p>
        </div>
        <span className="flex items-center gap-2">
          <span className="num text-meta text-muted">
            {rows.length} 个班级 · {totalSeats} 个名额已占 {takenSeats}
          </span>
          <Button variant="ghost" size="sm" onClick={classes.reload}>
            <RotateCw size={16} aria-hidden />
            刷新
          </Button>
          {isAdmin && (
            <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
              <CalendarPlus size={16} aria-hidden />
              新建班级
            </Button>
          )}
        </span>
      </header>

      <Panel>
        <ListState
          loading={classes.loading && classes.data === null}
          error={classes.error}
          isEmpty={rows.length === 0}
          emptyMessage={
            isAdmin
              ? '暂无班级。班级是学生报名的每周固定时段。'
              : '暂无班级。只有顾问可以新建班级。'
          }
          emptyCta={isAdmin ? '新建第一个班级' : '打开今日看板'}
          onEmptyCta={() => (isAdmin ? setCreateOpen(true) : navigate('/today'))}
          onRetry={classes.reload}
          rows={5}
          cols={5}
        >
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <caption className="sr-only">每周班级及其名额占用</caption>
              <thead>
                <tr className="h-9 border-b border-border bg-surface-sunken">
                  <th scope="col" className="col-header px-4">
                    班级
                  </th>
                  <th scope="col" className="col-header px-4">
                    科目
                  </th>
                  <th scope="col" className="col-header px-4">
                    老师
                  </th>
                  <th scope="col" className="col-header px-4">
                    每周时段
                  </th>
                  <th scope="col" className="col-header px-4">
                    名额
                  </th>
                  <th scope="col" className="px-4">
                    <span className="sr-only">打开名单</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((cls) => (
                  <tr
                    key={cls.id}
                    onClick={() => setSelectedId(cls.id)}
                    className="row-h cursor-pointer hover:bg-row-hover transition-colors duration-150 ease-standard"
                  >
                    <td className="px-4">
                      <span className="text-row font-510 text-fg">{cls.name}</span>
                      {cls.room && <span className="text-meta text-muted"> · {cls.room}</span>}
                    </td>
                    <td className="px-4 text-meta text-fg-2">{cls.subject_name ?? '—'}</td>
                    <td className="px-4 text-meta text-fg-2">{cls.teacher_name ?? '—'}</td>
                    <td className="num px-4 text-meta text-fg-2">
                      {weekdayShort(cls.weekday % 7)} {minutesToTime(cls.start_min)}–{minutesToTime(cls.end_min)}
                    </td>
                    <td className="px-4">
                      <SeatsCell enrolled={cls.enrolled ?? 0} capacity={cls.capacity} />
                    </td>
                    <td className="px-4 text-right text-muted">
                      <ChevronRight size={16} aria-hidden />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ListState>
        <p className="flex items-center gap-1.5 px-4 py-2 border-t border-border text-meta text-muted">
          <CalendarDays size={16} aria-hidden />
          报名规则由服务端强制执行：每周时段重叠、老师重复排课、名额上限，以及课时余额大于零。
        </p>
      </Panel>

      {createOpen && (
        <CreateClassDrawer
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            setNonce((n) => n + 1);
          }}
        />
      )}

      {selected && (
        <RosterDrawer
          cls={selected}
          onClose={() => setSelectedId(null)}
          onChanged={() => setNonce((n) => n + 1)}
        />
      )}
    </div>
  );
}
