import type { ReactNode } from 'react';
import { NavLink } from 'react-router';
import {
  CalendarDays,
  ClipboardCheck,
  GraduationCap,
  LayoutDashboard,
  LogOut,
  UserPlus,
  Users,
  Wallet,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { useAuth } from '../lib/auth';
import type { UserRole } from '../lib/types';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

/** 导航按角色裁剪，和 router 的 RequireRoles 一一对应（服务端才是真正的门）。 */
const NAV: Record<UserRole, NavItem[]> = {
  admin: [
    { to: '/today', label: '今日', icon: LayoutDashboard },
    { to: '/leads', label: '线索与试听', icon: UserPlus },
    { to: '/students', label: '学生', icon: Users },
    { to: '/classes', label: '班级', icon: CalendarDays },
  ],
  teacher: [{ to: '/teach/today', label: '今日课程', icon: ClipboardCheck }],
  student: [{ to: '/me', label: '我的课时', icon: Wallet }],
};

const ROLE_LABEL: Record<UserRole, string> = {
  admin: '顾问',
  teacher: '老师',
  student: '家庭',
};

export function AppShell({ role, children }: { role: UserRole; children: ReactNode }) {
  const { me, logout } = useAuth();
  const items = NAV[role];

  return (
    <div className="min-h-screen flex bg-bg">
      <aside className="w-[248px] shrink-0 border-r border-border bg-surface flex flex-col">
        <div className="flex items-center gap-2 px-4 h-14 border-b border-border">
          <GraduationCap size={20} aria-hidden style={{ color: 'var(--accent)' }} />
          <div className="min-w-0">
            <p className="section-title text-fg truncate">Austin Education</p>
            <p className="text-meta text-muted truncate">课时履约控制台</p>
          </div>
        </div>

        <nav className="flex-1 px-2 py-3 flex flex-col gap-0.5" aria-label="主导航">
          {items.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                [
                  'flex items-center gap-2 rounded-md px-3 h-9 text-row transition-colors duration-150 ease-standard',
                  isActive
                    ? 'bg-accent-bg text-accent font-[510]'
                    : 'text-fg-2 hover:bg-row-hover hover:text-fg',
                ].join(' ')
              }
            >
              <Icon size={16} aria-hidden />
              <span className="truncate">{label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-border px-4 py-3">
          <p className="text-row text-fg truncate">{me?.user.display_name}</p>
          <p className="text-meta text-muted mb-2">{ROLE_LABEL[role]}</p>
          <button
            type="button"
            onClick={() => void logout()}
            className="inline-flex items-center gap-1.5 text-meta text-muted hover:text-fg transition-colors duration-150 ease-standard"
          >
            <LogOut size={16} aria-hidden />
            退出登录
          </button>
        </div>
      </aside>

      <main className="flex-1 min-w-0 flex flex-col">{children}</main>
    </div>
  );
}

/** 各页面的统一顶栏，保证每屏标题位置一致（UIUX.md §2.2 可预测性）。 */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex items-start justify-between gap-4 px-6 py-4 border-b border-border bg-surface">
      <div className="min-w-0">
        <h1 className="page-title text-fg truncate">{title}</h1>
        {subtitle && <p className="text-meta text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="shrink-0 flex items-center gap-2">{actions}</div>}
    </header>
  );
}
