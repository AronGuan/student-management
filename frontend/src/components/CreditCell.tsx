import { TriangleAlert } from 'lucide-react';
import { creditTier } from '../lib/format';

/**
 * 课时余额 —— 连续量，不能用 badge。三件套：进度条 + 「剩余 / 总量」+ 预计用尽日。
 * UIUX.md §4.1：
 *   ≥20 success 无标记 / 11–19 warn / 6–10 warn + triangle-alert / ≤5 danger + 出现 Renew 按钮
 *   <0 透支：danger + 虚线 track + 「已透支 N 节」，动作升级为紧急联系
 *   =0 是「用完了」而不是「欠账」，所以不走透支样式 —— 见 lib/format.ts 的 creditTier。
 *
 * 关键：低课时的表现是「行尾出现一个按钮」，不是「数字更红」。
 */
export function CreditBar({
  balance,
  total,
  width = 48,
}: {
  balance: number;
  total: number;
  width?: number;
}) {
  const tier = creditTier(balance, total);
  const pct = total > 0 ? Math.max(0, Math.min(1, balance / total)) : 0;

  return (
    <span
      className="inline-block shrink-0 rounded-[3px] overflow-hidden align-middle"
      style={{
        width,
        height: 6,
        backgroundColor: tier.overdrawn ? 'transparent' : 'var(--credit-track)',
        border: tier.overdrawn ? '1px dashed var(--danger)' : undefined,
      }}
      aria-hidden
    >
      {!tier.overdrawn && (
        <span
          className="block h-full"
          style={{ width: `${pct * 100}%`, backgroundColor: tier.fill }}
        />
      )}
    </span>
  );
}

export function CreditCell({
  balance,
  total,
  showAlert = true,
}: {
  balance: number;
  total: number;
  showAlert?: boolean;
}) {
  const tier = creditTier(balance, total);
  return (
    <span className="inline-flex items-center gap-2">
      {showAlert && tier.alert && (
        <TriangleAlert
          size={16}
          className="shrink-0 text-danger"
          aria-label={balance < 0 ? '已透支' : '课时不足'}
        />
      )}
      <CreditBar balance={balance} total={total} />
      <span className="num text-row">
        <span className="font-590" style={{ color: tier.fill }}>
          {balance}
        </span>
        <span className="text-muted"> / {total}</span>
      </span>
      {balance < 0 && (
        <span className="text-meta font-510 text-danger">已透支 {Math.abs(balance)}</span>
      )}
    </span>
  );
}

/** 家长端大字卡片里的加粗进度条（宽 220px / 高 8px） */
export function CreditMeter({ balance, total }: { balance: number; total: number }) {
  const tier = creditTier(balance, total);
  const pct = total > 0 ? Math.max(0, Math.min(1, balance / total)) : 0;
  return (
    <span
      className="block w-full h-2 rounded-sm overflow-hidden"
      style={{
        backgroundColor: tier.overdrawn ? 'transparent' : 'var(--credit-track)',
        border: tier.overdrawn ? '1px dashed var(--danger)' : undefined,
      }}
      role="progressbar"
      aria-valuenow={balance}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-label={`剩余 ${balance} / ${total} 课时`}
    >
      {!tier.overdrawn && (
        <span
          className="block h-full transition-[width] duration-200 ease-standard"
          style={{ width: `${pct * 100}%`, backgroundColor: tier.fill }}
        />
      )}
    </span>
  );
}
