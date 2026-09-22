import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { api, setToken } from './api';
import type { AuthMe, UserRole } from './types';

export interface AuthValue {
  me: AuthMe | null;
  role: UserRole | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<AuthMe>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

interface LoginResult {
  token: string;
  user: AuthMe['user'];
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<AuthMe | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setMe(await api.get<AuthMe>('/auth/me'));
    } catch {
      // A 401 here is the ordinary signed-out path, not a failure worth
      // surfacing: clear the mirrored token and fall through to /login.
      setMe(null);
      setToken(null);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void refresh().finally(() => {
      if (alive) setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [refresh]);

  const login = useCallback(async (username: string, password: string) => {
    const res = await api.post<LoginResult>('/auth/login', { username, password });
    // The httpOnly cookie is the primary channel; mirroring the token keeps
    // the Bearer channel working when cookies are blocked in dev.
    if (res.token) setToken(res.token);
    const who = await api.get<AuthMe>('/auth/me');
    setMe(who);
    return who;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } catch {
      // Signing out locally must succeed even if the round trip fails.
    }
    setToken(null);
    setMe(null);
  }, []);

  const value = useMemo<AuthValue>(
    () => ({ me, role: me?.user.role ?? null, loading, login, logout, refresh }),
    [me, loading, login, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 必须在 <AuthProvider> 内使用。');
  return ctx;
}

/** The landing route for a role. Mirrors docs/UIUX.md 6.2. */
export function homeFor(role: UserRole | null): string {
  switch (role) {
    case 'teacher':
      return '/teach/today';
    case 'student':
      return '/me';
    default:
      return '/today';
  }
}
