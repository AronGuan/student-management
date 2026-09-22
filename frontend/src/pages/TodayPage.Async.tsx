/**
 * 三个页面共用的异步读取钩子 + 墨尔本墙上时钟日期工具。
 *
 * 为什么放在一个子文件里：`docs/UIUX.md` §8 要求每个列表都实现 loading / empty / error 三态，
 * 于是这几个页面都需要同一套「读取 → loading / error / reload」状态机，抽一次比抄六遍好。
 *
 * 为什么不用 react-query（它在 package.json 里、main.tsx 也套了 QueryClientProvider）：
 * 整个 pages 目录（含 LeadsPage 那三个文件）都是本地 state 读取，没有一处 useQuery，这里跟着同样的
 * 写法；而且这一层要的语义很简单 —— 「deps 里的 nonce +1 就重读」。40 行的自持实现比配置
 * queryKey 更短也更好读。要改成 useQuery 是行为等价的替换，随时可做。
 *
 * 文件名的前缀是 TodayPage. —— 子文件命名规则要求带上某个页面的前缀，而这个钩子被
 * TodayPage / StudentsPage / ClassesPage 三个页面共用（LoginPage 不需要读数据）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncState<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

/**
 * 读一次 + 可重试。`deps` 变化会重新读取（例如 URL 变化或上游刷新计数器 +1）。
 * `load` 每次渲染都会新建闭包，因此用 ref 持有，避免把它放进依赖数组造成死循环。
 */
export function useAsync<T>(load: () => Promise<T>, deps: readonly unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    loadRef.current().then(
      (next) => {
        if (!alive) return;
        setData(next);
        setLoading(false);
      },
      (err: unknown) => {
        if (!alive) return;
        setError(err);
        setLoading(false);
      },
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { data, error, loading, reload };
}

/** 服务端所有时间串都已是墨尔本墙上时钟；这里只做「截取日期」与「跨日推算」，不涉及时区换算。 */
export function datePartOf(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : '';
}

/**
 * 墨尔本的今天是哪一天，以及今天 ± N 天。用 en-CA 拿到 YYYY-MM-DD，再用 UTC 做整数日加减，
 * 这样跨夏令时切换也不会算错一天。
 */
export function melbourneDay(offsetDays = 0): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Melbourne',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const [y, m, d] = parts.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d) + offsetDays * 86_400_000);
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(shifted.getUTCDate()).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${mm}-${dd}`;
}

/** 工作台标题行用的日期，例如 "9月22日星期二"。 */
export function melbourneLongDate(): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Australia/Melbourne',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date());
}
