/**
 * 档案抽屉里的课时区：余额 + 课时条 + 课时包 + 只增不改的流水 + 两个写入动作。
 *
 * 课时包不再从流水里「还原」：GET /students/:id 现在直接返回 packages
 * （service/student_detail.go:28），所以包名、课时、价格、状态都是服务端原值，
 * 不必拿 note / delta / created_at 去猜一张收据。
 *
 * 流水读 GET /students/:id/credits 的 { balance, items, total } —— 其中 total 是**全量**条数
 * 而非本次返回的 50 条，页脚据此如实说明「只显示了最近 N 条」，不当成全量。
 *
 * 写入动作按 R7 只在归属 admin 面前启停；服务端同样会拦（40301），这里是提前告知，不是唯一防线。
 */
import { useRef } from 'react';
import { Coins, CreditCard, Repeat, TriangleAlert } from 'lucide-react';
import { Divider, KeyValue, Panel } from '../components/ui';
import { EmptyState, ErrorState, SkeletonRows } from '../components/StateViews';
import { CreditMeter } from '../components/CreditCell';
import { api } from '../lib/api';
import { dateTime, money, shortDate } from '../lib/format';
import type { CreditPackage, CreditsPage, LedgerEntry } from '../lib/types';
import { AdjustmentForm, OpenPackageForm } from './StudentsPage.CreditForms';
import { LEDGER_REASON, LedgerAmount } from './StudentsPage.Parts';
import { useAsync } from './TodayPage.Async';

const LEDGER_PAGE = 50;

function EntryRow({ entry }: { entry: LedgerEntry }) {
  const meta = [entry.lesson_label ? `课次 ${entry.lesson_label}` : null, entry.actor_name]
    .filter(Boolean)
    .join(' · ');
  return (
    <li className="flex items-start justify-between gap-3 py-2">
      <span className="min-w-0 flex flex-col gap-0.5">
        <span className="text-row text-fg">{LEDGER_REASON[entry.reason] ?? entry.reason}</span>
        <span className="num text-meta text-muted">
          {dateTime(entry.created_at)}
          {meta ? ` · ${meta}` : ''}
        </span>
        {entry.note && <span className="text-meta text-muted truncate">“{entry.note}”</span>}
      </span>
      <LedgerAmount delta={entry.delta} />
    </li>
  );
}

function PackageRow({ pkg }: { pkg: CreditPackage }) {
  return (
    <li className="flex items-center justify-between gap-3 py-2">
      <span className="min-w-0 flex flex-col gap-0.5">
        <span className="truncate text-row text-fg">{pkg.name}</span>
        <span className="num text-meta text-muted">
          {shortDate(pkg.purchased_at)}
          {pkg.status !== 'active' ? ` · ${pkg.status}` : ''}
        </span>
      </span>
      <span className="flex items-center gap-3 shrink-0">
        <span className="num text-row text-fg-2">{pkg.total_credits} 课时</span>
        <span className="num text-meta text-muted">{money(pkg.price_cents)}</span>
      </span>
    </li>
  );
}

export function StudentCredits({
  studentId,
  canWrite,
  packages,
  nonce,
  onChanged,
}: {
  studentId: number;
  canWrite: boolean;
  packages: CreditPackage[];
  nonce: number;
  onChanged: () => void;
}) {
  const state = useAsync(
    () => api.get<CreditsPage>(`/students/${studentId}/credits`, { limit: LEDGER_PAGE }),
    [studentId, nonce],
  );
  const formsRef = useRef<HTMLDivElement>(null);
  const goToForms = () => formsRef.current?.scrollIntoView();

  const entries = state.data?.items ?? [];
  const total = state.data?.total ?? 0;
  const balance = state.data?.balance ?? 0;
  const activeCredits = packages
    .filter((pkg) => pkg.status === 'active')
    .reduce((sum, pkg) => sum + pkg.total_credits, 0);
  const lifetimeCredits = packages.reduce((sum, pkg) => sum + pkg.total_credits, 0);
  // 课时条的分母：在有效的包总量。手工加课可能让余额超过包总量，此时以余额兜底，
  // 免得「剩余 / 总量」读成 22 / 20。
  const meterTotal = Math.max(activeCredits, balance, 1);
  // 首屏给骨架屏，重读时保留旧数字，避免每次写入后整块闪一下。
  const firstLoad = state.loading && state.data === null;

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-2">
        <h3 className="flex items-center gap-1.5 section-title text-fg">
          <Coins size={16} aria-hidden />
          课时
        </h3>
        {firstLoad ? (
          <SkeletonRows rows={1} cols={2} />
        ) : state.error ? (
          <ErrorState error={state.error} onRetry={state.reload} />
        ) : (
          <Panel className="p-3 flex flex-col gap-2">
            <div className="flex items-baseline gap-2">
              <span className="num text-page font-590 text-fg">{balance}</span>
              <span className="text-meta text-muted">剩余课时</span>
            </div>
            <CreditMeter balance={balance} total={meterTotal} />
            <div className="flex flex-col">
              <KeyValue k="有效课时包课时" v={<span className="num">{activeCredits}</span>} />
              <KeyValue k="累计购买" v={<span className="num">{lifetimeCredits}</span>} />
              <KeyValue k="流水条数" v={<span className="num">{total}</span>} />
            </div>
            {balance <= 5 && (
              <p className="flex items-center gap-1.5 text-meta font-510 text-danger">
                <TriangleAlert size={16} aria-hidden />
                {balance <= 0 ? '已透支。开通课时包前无法继续报名。' : '请在下节课前续费。'}
              </p>
            )}
          </Panel>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="flex items-center gap-1.5 section-title text-fg">
          <CreditCard size={16} aria-hidden />
          课时包
          <span className="num text-meta text-muted font-400">{packages.length}</span>
        </h3>
        {packages.length === 0 ? (
          <EmptyState
            message={
              canWrite
                ? '尚未开通课时包。开通后会把购买记录写入课时明细。'
                : '该学生尚未开通课时包。'
            }
            ctaLabel="前往课时包表单"
            onCta={canWrite ? goToForms : undefined}
          />
        ) : (
          <ul className="divide-y divide-border">
            {packages.map((pkg) => (
              <PackageRow key={pkg.id} pkg={pkg} />
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="flex items-center gap-1.5 section-title text-fg">
          <Repeat size={16} aria-hidden />
          课时明细
          <span className="num text-meta text-muted font-400">{total}</span>
        </h3>
        {firstLoad ? (
          <SkeletonRows rows={4} cols={3} />
        ) : state.error ? (
          <ErrorState error={state.error} onRetry={state.reload} />
        ) : entries.length === 0 ? (
          <EmptyState
            message={
              canWrite
                ? '还没有课时变动。开通课时包后会出现第一条记录。'
                : '该学生还没有课时变动。'
            }
            ctaLabel="前往课时包表单"
            onCta={canWrite ? goToForms : undefined}
          />
        ) : (
          <>
            <ul className="divide-y divide-border">
              {entries.map((entry) => (
                <EntryRow key={entry.id} entry={entry} />
              ))}
            </ul>
            <p className="text-meta text-muted">
              只增不改的明细。列表中任何记录都不能编辑或删除 —— 更正需要新增一条记录。
              {total > entries.length && `仅显示最近 ${entries.length} / ${total} 条。`}
            </p>
          </>
        )}
      </section>

      {canWrite && (
        <section ref={formsRef} className="flex flex-col gap-3 scroll-mt-4">
          <Divider />
          <h3 className="col-header">顾问操作</h3>
          <OpenPackageForm studentId={studentId} onSaved={onChanged} />
          <Divider />
          <AdjustmentForm studentId={studentId} onSaved={onChanged} />
        </section>
      )}
    </div>
  );
}
