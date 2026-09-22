/**
 * 档案抽屉里的两个写入动作（仅归属 admin 可用，服务端 R7 也会再拦一次）。
 *
 * 两者都只 append 一条流水，绝不改历史（ADR-008 / R5）：所以「调整」不是编辑数字，
 * 而是再记一笔，note 就成了唯一的解释来源 —— 因此 note 在这里必填，不是可选项。
 */
import { useState } from 'react';
import { Plus, Save, Undo2 } from 'lucide-react';
import { Button, Field, Input } from '../components/ui';
import { useToast } from '../components/Toast';
import { api, humaniseError } from '../lib/api';

interface BalanceEcho {
  balance: number;
  applied?: number;
}

export function OpenPackageForm({ studentId, onSaved }: { studentId: number; onSaved: () => void }) {
  const { push } = useToast();
  const [label, setLabel] = useState('');
  const [credits, setCredits] = useState('20');
  const [price, setPrice] = useState('1700');
  const [busy, setBusy] = useState(false);

  async function submit() {
    const total = Number(credits);
    const dollars = Number(price);
    if (!Number.isInteger(total) || total < 1 || total > 999) {
      push('error', '课时必须是 1 到 999 之间的整数。');
      return;
    }
    if (!Number.isFinite(dollars) || dollars < 0) {
      push('error', '请输入澳元价格，0 表示赠送课时包。');
      return;
    }
    setBusy(true);
    try {
      const res = await api.post<BalanceEcho>(`/students/${studentId}/credit-packages`, {
        name: label.trim() || undefined,
        total_credits: total,
        price_cents: Math.round(dollars * 100),
      });
      push('success', `已添加 ${total} 课时，当前余额 ${res.balance}。`);
      setLabel('');
      onSaved();
    } catch (err) {
      push('error', humaniseError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Field label="课时包标签" hint="留空则使用默认的 N 课时包名称。">
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="第四学期加课包"
          disabled={busy}
        />
      </Field>
      <div className="flex gap-3">
        <Field label="课时">
          <Input
            type="number"
            min={1}
            max={999}
            value={credits}
            onChange={(e) => setCredits(e.target.value)}
            className="num"
            disabled={busy}
          />
        </Field>
        <Field label="价格（澳元）">
          <Input
            type="number"
            min={0}
            step="0.01"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            className="num"
            disabled={busy}
          />
        </Field>
      </div>
      <Button type="submit" variant="primary" size="sm" loading={busy} className="self-start">
        <Plus size={16} aria-hidden />
        开课时包
      </Button>
    </form>
  );
}

export function AdjustmentForm({ studentId, onSaved }: { studentId: number; onSaved: () => void }) {
  const { push } = useToast();
  const [delta, setDelta] = useState('-1');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    const value = Number(delta);
    if (!Number.isInteger(value) || value === 0) {
      push('error', '请输入非零整数，例如 -1 表示退回一节已扣课时。');
      return;
    }
    if (!note.trim()) {
      push('error', '请填写备注。明细只增不改，备注是唯一的解释来源。');
      return;
    }
    setBusy(true);
    try {
      const res = await api.post<BalanceEcho>(`/students/${studentId}/credit-adjustments`, {
        delta: value,
        note: note.trim(),
      });
      push('success', `已记录 ${value} 的调整，当前余额 ${res.balance}。`);
      setNote('');
      onSaved();
    } catch (err) {
      push('error', humaniseError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="flex gap-3">
        <Field label="课时" hint="负数表示退回一课时。">
          <Input
            type="number"
            value={delta}
            onChange={(e) => setDelta(e.target.value)}
            className="num w-[92px]"
            disabled={busy}
          />
        </Field>
        <div className="flex-1">
          <Field label="原因">
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="中心于 8/19 取消课次"
              disabled={busy}
            />
          </Field>
        </div>
      </div>
      <Button type="submit" variant="secondary" size="sm" loading={busy} className="self-start">
        <Save size={16} aria-hidden />
        记录调整
      </Button>
      <p className="flex items-start gap-1.5 text-meta text-muted">
        <Undo2 size={16} className="mt-0.5 shrink-0" aria-hidden />
        历史永不被修改。更正以新增一条对冲记录的方式完成。
      </p>
    </form>
  );
}
