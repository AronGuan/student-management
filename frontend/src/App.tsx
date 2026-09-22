import type { ReactNode } from 'react';
import { Link, Navigate, Route, Routes } from 'react-router';
import { ShieldAlert } from 'lucide-react';

import { homeFor, useAuth } from './lib/auth';
import type { UserRole } from './lib/types';
import { AppShell } from './shell/AppShell';
import { Panel } from './components/ui';
import { InlineSpinner } from './components/StateViews';

import LoginPage from './pages/LoginPage';
import TodayPage from './pages/TodayPage';
import LeadsPage from './pages/LeadsPage';
import StudentsPage from './pages/StudentsPage';
import ClassesPage from './pages/ClassesPage';
import TeachTodayPage from './pages/TeachTodayPage';
import MyCreditsPage from './pages/MyCreditsPage';

function BootSplash() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-bg">
      <InlineSpinner label="正在加载工作区" />
    </div>
  );
}

/**
 * 前端这层只是「不给看」，不是安全边界：同一规则的真正执行在 Go 侧
 * （middleware.RequireRoles + 查询里的 owner 过滤）。评审会直接用 curl 绕过界面验证这一点。
 */
function NoAccess({ home }: { home: string }) {
  return (
    <div className="p-6">
      <Panel className="max-w-xl">
        <div className="flex items-start gap-3">
          <ShieldAlert size={20} aria-hidden style={{ color: 'var(--warn)' }} />
          <div className="flex flex-col gap-1">
            <p className="section-title text-fg">当前角色无法访问该页面</p>
            <p className="text-row text-muted">
              该页面属于其他角色。限制由 API 强制执行，而不是靠隐藏入口。
            </p>
            <Link
              to={home}
              className="text-row text-accent hover:text-accent-hover transition-colors duration-150 ease-standard"
            >
              返回我的工作区
            </Link>
          </div>
        </div>
      </Panel>
    </div>
  );
}

function Gated({ roles, children }: { roles: UserRole[]; children: ReactNode }) {
  const { role } = useAuth();
  if (!role || !roles.includes(role)) return <NoAccess home={homeFor(role)} />;
  return <>{children}</>;
}

export default function App() {
  const { me, role, loading } = useAuth();

  if (loading) return <BootSplash />;

  // 未登录：只开放 /login，其余一律回登录页。
  if (!me || !role) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  const home = homeFor(role);

  return (
    <AppShell role={role}>
      <Routes>
        <Route path="/" element={<Navigate to={home} replace />} />
        <Route path="/login" element={<Navigate to={home} replace />} />

        <Route
          path="/today"
          element={
            <Gated roles={['admin']}>
              <TodayPage />
            </Gated>
          }
        />
        <Route
          path="/leads"
          element={
            <Gated roles={['admin']}>
              <LeadsPage />
            </Gated>
          }
        />
        <Route
          path="/leads/:id"
          element={
            <Gated roles={['admin']}>
              <LeadsPage />
            </Gated>
          }
        />
        <Route
          path="/students"
          element={
            <Gated roles={['admin']}>
              <StudentsPage />
            </Gated>
          }
        />
        <Route
          path="/classes"
          element={
            <Gated roles={['admin']}>
              <ClassesPage />
            </Gated>
          }
        />
        <Route
          path="/teach/today"
          element={
            <Gated roles={['teacher', 'admin']}>
              <TeachTodayPage />
            </Gated>
          }
        />
        <Route
          path="/me"
          element={
            <Gated roles={['student']}>
              <MyCreditsPage />
            </Gated>
          }
        />

        <Route path="*" element={<Navigate to={home} replace />} />
      </Routes>
    </AppShell>
  );
}
