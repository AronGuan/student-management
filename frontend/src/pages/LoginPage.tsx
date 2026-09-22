/**
 * 登录页。刻意只做一件事：拿到用户名口令，交给 AuthProvider。
 *
 * 不做跳转 —— App.tsx 按 role 决定落地页（homeFor 在 lib/auth 里），页面自己 push 路由
 * 会与那条规则打架。不做营销 hero，不放 "Welcome to"，因为这是个每天用 8 小时的运营工具。
 * 底部保留一块演示账号说明：这是 take-home 交付物，评审必须能登进来。
 */
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Globe, GraduationCap, Info, LogIn, TriangleAlert } from 'lucide-react';
import { Button, Divider, Field, Input, Panel } from '../components/ui';
import { humaniseError } from '../lib/api';
import { useAuth } from '../lib/auth';

/** 种子数据里的演示账号，见 backend/internal/seed/seed.go */
const DEMO_PASSWORD = 'demo1234';
const DEMO_ACCOUNTS = [
  { username: 'mei.lin', role: '顾问', person: 'Mei Lin' },
  { username: 'zhou.ya', role: '老师', person: 'Zhou Ya' },
  { username: 'parent.zhao', role: '家庭', person: 'Zhao Min' },
];

export default function LoginPage() {
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const user = username.trim();
    if (!user || !password) {
      setError('请输入用户名和密码。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await login(user, password);
      // 成功后不跳转：AuthProvider 更新 me，App.tsx 的守卫按角色重定向。
    } catch (err) {
      setError(humaniseError(err));
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  function fillDemo(nextUsername: string) {
    setUsername(nextUsername);
    setPassword(DEMO_PASSWORD);
    setError(null);
  }

  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-4 px-4 py-10 bg-bg">
      <Panel className="w-full max-w-[380px]">
        <form onSubmit={onSubmit} className="flex flex-col gap-4 p-6">
          <header className="flex items-start gap-2.5">
            <GraduationCap size={24} strokeWidth={1.75} className="mt-0.5 shrink-0 text-accent" aria-hidden />
            <div className="min-w-0">
              <h1 className="page-title text-fg">Austin Education</h1>
              <p className="text-meta text-muted">学生管理系统</p>
            </div>
          </header>

          <Divider />

          <Field label="用户名">
            <Input
              name="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
              spellCheck={false}
              disabled={busy}
              aria-invalid={error !== null}
            />
          </Field>

          <Field label="密码">
            <Input
              name="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              disabled={busy}
              aria-invalid={error !== null}
            />
          </Field>

          {error && (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-md border border-danger bg-danger-bg px-2.5 py-2 text-row text-danger"
            >
              <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
              <span className="min-w-0">{error}</span>
            </p>
          )}

          <Button type="submit" variant="primary" size="touch" loading={busy} className="w-full">
            <LogIn size={20} aria-hidden />
            {busy ? '登录中' : '登录'}
          </Button>

          <Divider />

          <section className="flex flex-col gap-2">
            <h2 className="flex items-center gap-1.5 section-title text-fg-2">
              <Info size={16} aria-hidden />
              演示账号
            </h2>
            <p className="text-meta text-muted">
              三个种子账号覆盖三种角色，共用一个密码。
            </p>
            <ul className="flex flex-col gap-1">
              {DEMO_ACCOUNTS.map((account) => (
                <li key={account.username} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 flex items-baseline gap-2">
                    <span className="num text-row text-fg truncate">{account.username}</span>
                    <span className="text-meta text-muted shrink-0">{account.role}</span>
                  </span>
                  <Button variant="ghost" size="sm" onClick={() => fillDemo(account.username)}>
                    填入
                  </Button>
                </li>
              ))}
            </ul>
            <p className="text-meta text-muted">
              三个账号的密码：<span className="num text-fg-2">{DEMO_PASSWORD}</span>
            </p>
          </section>
        </form>
      </Panel>

      <p className="flex items-center gap-1.5 text-meta text-muted">
        <Globe size={16} aria-hidden />
        所有时间均为澳大利亚墨尔本本地时间。
      </p>
    </main>
  );
}
