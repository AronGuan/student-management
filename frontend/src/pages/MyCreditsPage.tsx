/**
 * 我的课时 —— 学生 / 家长的唯一页面。
 *
 * 它回答的是整个系统最贵的一句话：「我的课时怎么又少了」。
 * 所以顺序是固定的：余额（大字 + 进度条）→ 购买记录 → 全量流水（每一行都写清为什么变）
 * → 课堂反馈 → 选课与请假。流水不折叠、不省略，家长能自己核对每一笔。
 *
 * 课堂反馈排在流水之后、选课与请假之前：它不属于课时账本（这个页面回答的"课时怎么又少了"
 * 在流水那一块就答完了），但它必须在这里——这是家庭账号唯一能打开的页面。流水说"课时花在
 * 哪了"，课堂反馈说"花得怎么样"，两句挨着读最顺；而选课与请假是一组动作，仍然收在页尾。
 *
 * 课堂反馈读的是 `parent_updates`（顾问写给这个家庭的那句话），**不是**老师说给同事听的课堂
 * 记录 —— 那是两份数据，不互相派生。理由见 `MyCreditsPage.Feedback.tsx` 的文件头。
 *
 * 余额条的分母用的是 ledger 里 purchase 的累计，并在界面上标明口径 —— 后端没有
 * 「列出某学生课时包」的接口，所以不假装它是套餐总量。
 */
import { useCallback, useEffect, useState } from 'react';
import { Coins, Repeat } from 'lucide-react';
import { api } from '../lib/api';
import { dateTime, shortDate } from '../lib/format';
import { useAuth } from '../lib/auth';
import { Panel, PanelHeader, Select } from '../components/ui';
import { CreditMeter } from '../components/CreditCell';
import { EmptyState, ErrorState, ListState, SkeletonRows } from '../components/StateViews';
import MyCreditsFeedback from './MyCreditsPage.Feedback';
import MyCreditsLeave from './MyCreditsPage.Leave';
import { REASON_LABEL, normaliseCredits, purchasedTotal, purchases } from './MyCreditsPage.Shared';
import type { CreditsResponse, LedgerRow } from './MyCreditsPage.Shared';

const LEDGER_GRID = 'grid grid-cols-[104px_84px_minmax(0,1fr)_minmax(0,1.2fr)] gap-3 items-baseline';

export default function MyCreditsPage() {
  const { me, loading: authLoading, refresh } = useAuth();
  const studentIds = me?.student_ids ?? [];
  const [studentId, setStudentId] = useState<number | null>(null);
  const [balance, setBalance] = useState(0);
  const [entries, setEntries] = useState<LedgerRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [threshold, setThreshold] = useState(24);

  useEffect(() => {
    if (studentId === null && studentIds.length > 0) setStudentId(studentIds[0]);
  }, [studentId, studentIds]);

  const load = useCallback(async () => {
    if (studentId === null) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<CreditsResponse>(`/students/${studentId}/credits`, { limit: 100 });
      const normalised = normaliseCredits(res);
      setBalance(normalised.balance);
      setEntries(normalised.entries);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [studentId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 请假阈值不从常量里抄第二份：/config 是它的单一真源 */
  useEffect(() => {
    let cancelled = false;
    api
      .get<{ leave_notice_hours?: number }>('/config')
      .then((cfg) => {
        if (!cancelled && typeof cfg?.leave_notice_hours === 'number') setThreshold(cfg.leave_notice_hours);
      })
      .catch(() => {
        /* 读不到就沿用服务端默认值 24，不阻塞页面 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (authLoading) {
    return (
      <main className="p-4 max-w-3xl">
        <Panel>
          <PanelHeader title="我的课时" icon={<Coins size={16} aria-hidden />} />
          <SkeletonRows rows={3} cols={3} />
        </Panel>
      </main>
    );
  }

  if (studentIds.length === 0) {
    return (
      <main className="p-4 max-w-3xl">
        <Panel>
          <PanelHeader title="我的课时" icon={<Coins size={16} aria-hidden />} />
          <EmptyState
            message="这个登录账号还没有绑定学生，因此没有可显示的课时余额。家庭账号由校区绑定。"
            ctaLabel="刷新"
            onCta={() => void refresh()}
          />
        </Panel>
      </main>
    );
  }

  const purchased = purchasedTotal(entries);
  const bought = purchases(entries);
  const showMeter = purchased > 0;

  return (
    <main className="p-4 flex flex-col gap-4 max-w-3xl">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title text-fg">我的课时</h1>
          <p className="text-meta text-muted">{me?.user.display_name ?? '家庭账号'}</p>
        </div>
        {studentIds.length > 1 && (
          <label className="flex items-center gap-2">
            <span className="col-header">孩子</span>
            <Select
              value={String(studentId ?? '')}
              onChange={(e) => setStudentId(Number(e.target.value))}
              aria-label="选择要查看的孩子"
            >
              {studentIds.map((id) => (
                <option key={id} value={String(id)}>
                  学生 #{id}
                </option>
              ))}
            </Select>
          </label>
        )}
      </header>

      <Panel>
        <PanelHeader title="余额" icon={<Coins size={16} aria-hidden />} />
        {loading ? (
          <SkeletonRows rows={2} cols={2} />
        ) : error ? (
          <ErrorState error={error} onRetry={() => void load()} />
        ) : (
          <div className="flex flex-col gap-3 p-4">
            <div className="flex items-end gap-3">
              <span className="page-title num text-fg">{balance}</span>
              <span className="text-body text-muted">
                剩余课时{showMeter ? `（已购 ${purchased}）` : ''}
              </span>
            </div>
            {showMeter ? (
              <>
                <CreditMeter balance={balance} total={Math.max(purchased, balance)} />
                <p className="num text-meta text-muted">
                  {balance} / {Math.max(purchased, balance)} · 随每次上课逐节扣减
                </p>
              </>
            ) : (
              <p className="text-meta text-muted">
                这个账号还没有课时包购买记录，因此没有可画的比例条——上面的数字就是全部。
              </p>
            )}
          </div>
        )}
      </Panel>

      <Panel>
        <PanelHeader title="购买记录" count={bought.length} icon={<Repeat size={16} aria-hidden />} />
        <ListState
          loading={loading}
          error={error}
          isEmpty={bought.length === 0}
          emptyMessage="这个账号还没有课时包购买记录。"
          emptyCta="刷新明细"
          onEmptyCta={() => void load()}
          onRetry={() => void load()}
          rows={2}
          cols={3}
        >
          <div className="divide-y divide-border">
            {bought.map((entry) => (
              <div key={entry.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2">
                <span className="inline-flex items-center gap-1.5 text-row font-510 text-success">
                  <Repeat size={16} aria-hidden />
                  <span className="num">+{entry.delta}</span>
                </span>
                <span className="num text-meta text-muted">{dateTime(entry.created_at)}</span>
                <span className="text-meta text-fg-2">{entry.note || '课时包'}</span>
                {entry.actor_name && <span className="text-meta text-muted">由 {entry.actor_name} 录入</span>}
              </div>
            ))}
          </div>
        </ListState>
      </Panel>

      <Panel>
        <PanelHeader title="课时明细" count={entries.length} icon={<Coins size={16} aria-hidden />} />
        {!loading && !error && entries.length > 0 && (
          <div className={`${LEDGER_GRID} px-4 h-9 border-b border-border bg-surface-sunken`}>
            <span className="col-header">日期</span>
            <span className="col-header">变动</span>
            <span className="col-header">原因</span>
            <span className="col-header">详情</span>
          </div>
        )}
        <ListState
          loading={loading}
          error={error}
          isEmpty={entries.length === 0}
          emptyMessage="这个账号还没有任何课时变动。"
          emptyCta="刷新明细"
          onEmptyCta={() => void load()}
          onRetry={() => void load()}
          rows={5}
          cols={4}
        >
          <div className="divide-y divide-border">
            {entries.map((entry) => {
              const up = entry.delta > 0;
              return (
                <div key={entry.id} className={`${LEDGER_GRID} px-4 py-2 hover:bg-row-hover transition-colors duration-150 ease-standard`}>
                  <span className="num text-meta text-muted">{dateTime(entry.created_at)}</span>
                  <span className={`inline-flex items-center gap-1.5 text-row font-590 ${up ? 'text-success' : 'text-danger'}`}>
                    {up ? <Repeat size={16} aria-hidden /> : <Coins size={16} aria-hidden />}
                    <span className="num">{up ? `+${entry.delta}` : entry.delta}</span>
                  </span>
                  <span className="text-row text-fg-2">{REASON_LABEL[entry.reason] ?? entry.reason}</span>
                  <span className="text-meta text-muted">
                    {entry.lesson_label ? `课次 ${shortDate(entry.lesson_label)} · ` : ''}
                    {entry.note || '—'}
                    {entry.actor_name ? ` · ${entry.actor_name}` : ''}
                  </span>
                </div>
              );
            })}
          </div>
        </ListState>
      </Panel>

      {studentId !== null && <MyCreditsFeedback studentId={studentId} />}

      {studentId !== null && (
        <MyCreditsLeave
          studentId={studentId}
          balance={balance}
          threshold={threshold}
          onChanged={load}
        />
      )}

      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-muted">
        <span>
          购买行记录的是实付金额；其余每一行都是某次上课的扣减。这里的内容不会被原地修改——更正以追加的方式记录，所以明细永远对得上。
        </span>
        <span className="num">
          明细合计 {entries.reduce((sum, e) => sum + e.delta, 0)} 课时，与上方余额一致。
        </span>
      </p>
    </main>
  );
}
