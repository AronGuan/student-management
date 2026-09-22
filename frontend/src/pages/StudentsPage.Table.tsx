/**
 * 学生表格（纯展示）。行点击 = 打开右侧档案抽屉，不跳页 —— 运营在列表和档案之间来回扫，
 * 跳页会丢掉筛选与滚动位置（UIUX §6.1：详情走右侧抽屉，不开新页）。
 *
 * 排序只做服务端真正支持的两种：name（姓名升序）与 balance_asc（课时少→多）
 * （service/student.go:94-99）。传别的值会被静默忽略，界面就会假装排过了。
 *
 * Owner 列读 owner_admin_name（服务端 COALESCE 后给出），不再含糊地统一写
 * 「Another consultant」；Classes 列读 active_class_count，也就是「待排班」视图的判据。
 */
import { ArrowUpDown, ChevronRight } from 'lucide-react';
import { Panel } from '../components/ui';
import { ListState } from '../components/StateViews';
import { shortDate } from '../lib/format';
import type { StudentListItem } from '../lib/types';
import { CreditNumber, StatusBadge } from './StudentsPage.Parts';

export type SortKey = '' | 'name' | 'balance_asc';

function SortHeader({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <th scope="col" aria-sort={active ? 'ascending' : 'none'} className="px-4">
      <button
        type="button"
        onClick={onClick}
        className={`col-header inline-flex items-center gap-1 transition-colors duration-150 ease-standard hover:text-fg ${
          active ? 'text-accent' : ''
        }`}
      >
        {label}
        <ArrowUpDown size={16} aria-hidden />
      </button>
    </th>
  );
}

export function StudentsTable({
  students,
  loading,
  error,
  onRetry,
  sort,
  onSort,
  myId,
  onOpen,
  emptyMessage,
  emptyCta,
  onEmptyCta,
}: {
  students: StudentListItem[];
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  sort: SortKey;
  onSort: (next: SortKey) => void;
  myId: number | undefined;
  onOpen: (id: number) => void;
  emptyMessage: string;
  emptyCta: string;
  onEmptyCta: () => void;
}) {
  return (
    <Panel>
      <ListState
        loading={loading}
        error={error}
        isEmpty={students.length === 0}
        emptyMessage={emptyMessage}
        emptyCta={emptyCta}
        onEmptyCta={onEmptyCta}
        onRetry={onRetry}
        rows={5}
        cols={5}
      >
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <caption className="sr-only">已存视图中的学生</caption>
            <thead>
              <tr className="h-9 border-b border-border bg-surface-sunken">
                <SortHeader label="学生" active={sort === 'name'} onClick={() => onSort(sort === 'name' ? '' : 'name')} />
                <th scope="col" className="col-header px-4">
                  状态
                </th>
                <th scope="col" className="col-header px-4">
                  班级
                </th>
                <SortHeader
                  label="课时"
                  active={sort === 'balance_asc'}
                  onClick={() => onSort(sort === 'balance_asc' ? '' : 'balance_asc')}
                />
                <th scope="col" className="col-header px-4">
                  顾问
                </th>
                <th scope="col" className="col-header px-4">
                  更新于
                </th>
                <th scope="col" className="px-4">
                  <span className="sr-only">打开学生档案</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {students.map((student) => (
                <tr
                  key={student.id}
                  onClick={() => onOpen(student.id)}
                  className="row-h cursor-pointer hover:bg-row-hover transition-colors duration-150 ease-standard"
                >
                  <td className="max-w-[240px] px-4">
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onOpen(student.id);
                      }}
                      className="max-w-full truncate text-row font-510 text-fg rounded-sm hover:text-accent transition-colors duration-150 ease-standard"
                      title={student.full_name}
                    >
                      {student.full_name}
                    </button>
                    <span className="text-meta text-muted">
                      {student.year_level ? ` · ${student.year_level}` : ''}
                    </span>
                  </td>
                  <td className="px-4">
                    <StatusBadge status={student.status} />
                  </td>
                  <td className="px-4">
                    {student.active_class_count === 0 ? (
                      <span className="text-meta font-510 text-warn">尚未报名</span>
                    ) : (
                      <span className="num text-row text-fg-2">{student.active_class_count}</span>
                    )}
                  </td>
                  <td className="px-4">
                    <CreditNumber balance={student.balance} />
                  </td>
                  <td className="max-w-[160px] truncate px-4 text-meta text-muted">
                    {student.owner_admin_id === myId ? '我' : student.owner_admin_name || '未分配'}
                  </td>
                  <td className="num px-4 text-meta text-muted">{shortDate(student.updated_at)}</td>
                  <td className="px-4 text-right text-muted">
                    <ChevronRight size={16} aria-hidden />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ListState>
    </Panel>
  );
}
