/**
 * 工作台第三区：低课时预警。
 *
 * 课时是家长已经付过的钱、也是机构的履约库存（DESIGN.md）。所以这里的表达不是「数字变红」，
 * 而是「行尾出现一个具体动作」—— UIUX §4.1 的原话：≤5 节时的正确表现是一个按钮出现。
 * 开账表单就地展开，因为催续费必须 1 步完成（UIUX §6.2）。
 *
 * 行来自 /dashboard/admin 的 low_credit：它是唯一同时带 balance 与 total_credits 的队列，
 * 而 CreditCell 必须显示「剩余 / 总量」，不能只显示百分比。行数上限 20 由服务端 SQL 决定，
 * total 是同口径全量计数，页脚据此如实说明还有多少条没显示。
 */
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { TriangleAlert, Wallet } from 'lucide-react';
import { Button, Input, Panel, PanelHeader } from '../components/ui';
import { CreditCell } from '../components/CreditCell';
import { ListState } from '../components/StateViews';
import { useToast } from '../components/Toast';
import { api, humaniseError } from '../lib/api';
import type { LowCreditRow } from '../lib/types';

export function LowCreditSection({
  items,
  total,
  loading,
  onChanged,
}: {
  items: LowCreditRow[];
  total: number;
  loading: boolean;
  onChanged: () => void;
}) {
  const { push } = useToast();
  const navigate = useNavigate();
  const [openId, setOpenId] = useState<number | null>(null);
  const [label, setLabel] = useState('');
  const [credits, setCredits] = useState('20');
  const [price, setPrice] = useState('1700');
  const [busyId, setBusyId] = useState<number | null>(null);

  function open(studentId: number) {
    setOpenId(studentId);
    setLabel('');
    setCredits('20');
    setPrice('1700');
  }

  async function openPackage(studentId: number) {
    const creditCount = Number(credits);
    const dollars = Number(price);
    if (!Number.isInteger(creditCount) || creditCount < 1) {
      push('error', '请输入整数课时，且不少于 1。');
      return;
    }
    if (!Number.isFinite(dollars) || dollars < 0) {
      push('error', '请输入澳元价格，0 表示赠送课时包。');
      return;
    }
    setBusyId(studentId);
    try {
      const res = await api.post<{ balance: number }>(`/students/${studentId}/credit-packages`, {
        name: label.trim() || undefined,
        total_credits: creditCount,
        price_cents: Math.round(dollars * 100),
      });
      push('success', `已添加 ${creditCount} 课时，当前余额 ${res.balance}。`);
      setOpenId(null);
      onChanged();
    } catch (err) {
      push('error', humaniseError(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Panel>
      <PanelHeader title="课时不足" count={total} icon={<TriangleAlert size={16} aria-hidden />} />
      <ListState
        loading={loading}
        error={null}
        isEmpty={items.length === 0}
        emptyMessage="你名下没有达到续费阈值的在读学生。"
        emptyCta="查看全部学生"
        onEmptyCta={() => navigate('/students')}
        rows={3}
        cols={3}
      >
        <div className="divide-y divide-border">
          {items.map((row) => (
            <div key={row.student_id} className="flex flex-col gap-2 px-4 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={() => navigate(`/students?view=low-credit&student=${row.student_id}`)}
                  className="min-w-0 text-left text-row font-510 text-fg truncate rounded-sm hover:text-accent transition-colors duration-150 ease-standard"
                  title="打开学生档案"
                >
                  {row.full_name}
                </button>
                <span className="flex items-center gap-3 shrink-0">
                  <CreditCell balance={row.balance} total={row.total_credits} />
                  {openId !== row.student_id && (
                    <Button variant="secondary" size="sm" onClick={() => open(row.student_id)}>
                      <Wallet size={16} aria-hidden />
                      开课时包
                    </Button>
                  )}
                </span>
              </div>

              {openId === row.student_id && (
                <div className="flex flex-wrap items-end gap-2 rounded-md border border-border bg-surface-sunken px-2.5 py-2">
                  <label className="flex flex-col gap-1">
                    <span className="col-header">标签</span>
                    <Input
                      value={label}
                      onChange={(e) => setLabel(e.target.value)}
                      placeholder="选填，例如第四学期加课包"
                      className="w-[200px]"
                      disabled={busyId !== null}
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="col-header">课时</span>
                    <Input
                      type="number"
                      min={1}
                      max={999}
                      value={credits}
                      onChange={(e) => setCredits(e.target.value)}
                      className="num w-[84px]"
                      disabled={busyId !== null}
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="col-header">价格（澳元）</span>
                    <Input
                      type="number"
                      min={0}
                      step="0.01"
                      value={price}
                      onChange={(e) => setPrice(e.target.value)}
                      className="num w-[110px]"
                      disabled={busyId !== null}
                    />
                  </label>
                  <Button
                    variant="primary"
                    size="sm"
                    loading={busyId === row.student_id}
                    disabled={busyId !== null}
                    onClick={() => void openPackage(row.student_id)}
                  >
                    <Wallet size={16} aria-hidden />
                    确认购买
                  </Button>
                  <Button variant="ghost" size="sm" disabled={busyId !== null} onClick={() => setOpenId(null)}>
                    取消
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      </ListState>
      <p className="flex items-center justify-between gap-3 px-4 py-2 border-t border-border text-meta text-muted">
        <span>开课时包会把购买记录写入课时明细，这里不会修改任何历史。</span>
        {total > items.length && <span className="num shrink-0">还有 {total - items.length} 条未显示</span>}
      </p>
    </Panel>
  );
}
