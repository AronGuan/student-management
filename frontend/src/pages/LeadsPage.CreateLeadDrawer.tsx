/**
 * 登记线索抽屉 —— 漏斗的第一跳。
 *
 * 在此之前这一页只能记录**已经发生**的试听结果，没有任何入口能产生一条新线索：
 * 全前端的写操作调用点里没有 POST /students，只能 curl。补上它，漏斗才闭合。
 *
 * 两个字段前端**故意不传**，因为它们由服务端决定：
 *   - owner_admin_id：缺省时 handler/student.go:90-93 把它填成调用者自己；
 *   - status：service/student.go:232 硬写 `model.StudentLead`。
 * 客户端传了也无效，所以这里不提供、也不假装提供这两个「选项」。这正是「规则在服务端
 * 强制」的样子 —— 前端只收集它真正能决定的东西。
 *
 * 监护人姓名与电话是选填，写进 guardians[0]；服务端对 name 为空的监护人本来就跳过
 * （service/student.go:241），所以这里不传空对象只是让请求体干净，判断谁是合法监护人
 * 的规则仍然只在服务端。
 */
import { useState } from 'react';
import { TriangleAlert, UserPlus } from 'lucide-react';
import { Drawer } from '../components/Drawer';
import { Button, Field, Input, Select } from '../components/ui';
import { useToast } from '../components/Toast';
import { api, humaniseError } from '../lib/api';

/** seed.go:31 实际写进库里的 5 个来源。用同一套词表，新线索的 source 才和既有数据可比。 */
const SOURCES = ['WeChat referral', 'Walk-in', 'Google search', 'Parent referral', 'School flyer'];

export function CreateLeadDrawer({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { push } = useToast();
  const [fullName, setFullName] = useState('');
  const [preferredName, setPreferredName] = useState('');
  const [yearLevel, setYearLevel] = useState('');
  const [source, setSource] = useState(SOURCES[0]);
  const [guardianName, setGuardianName] = useState('');
  const [guardianPhone, setGuardianPhone] = useState('');
  const [failure, setFailure] = useState<{ label: string; detail: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    const name = fullName.trim();
    if (!name) {
      setFailure({ label: '线索至少需要一个姓名。', detail: '监护人联系方式可以之后再补。' });
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      await api.post('/students', {
        full_name: name,
        preferred_name: preferredName.trim(),
        year_level: yearLevel.trim(),
        source,
        guardians: guardianName.trim()
          ? [
              {
                name: guardianName.trim(),
                phone: guardianPhone.trim(),
                relationship: 'parent',
                is_primary: true,
              },
            ]
          : [],
      });
      push('success', `${name} 已登记为线索。`);
      onCreated();
    } catch (err) {
      setFailure({ label: humaniseError(err), detail: err instanceof Error ? err.message : '' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      open
      onClose={onClose}
      width={480}
      title="登记线索"
      subtitle="新记录一律是「线索」，负责人默认为你自己。"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" size="sm" loading={busy} onClick={() => void submit()}>
            <UserPlus size={16} aria-hidden />
            登记线索
          </Button>
        </div>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field label="学生姓名">
          <Input
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="例如 陈小雨"
            disabled={busy}
            autoFocus
          />
        </Field>

        <Field label="英文名" hint="选填。家长与老师平时怎么称呼他。">
          <Input
            value={preferredName}
            onChange={(e) => setPreferredName(e.target.value)}
            placeholder="Yuki"
            disabled={busy}
          />
        </Field>

        <div className="flex gap-3">
          <div className="flex-1">
            <Field label="年级" hint="自由文本：Prep / Year 9。">
              <Input
                value={yearLevel}
                onChange={(e) => setYearLevel(e.target.value)}
                placeholder="Year 9"
                disabled={busy}
              />
            </Field>
          </div>
          <div className="flex-1">
            <Field label="来源">
              <Select value={source} onChange={(e) => setSource(e.target.value)} disabled={busy} className="w-full">
                {SOURCES.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </div>

        <div className="flex gap-3">
          <div className="flex-1">
            <Field label="监护人姓名" hint="选填。">
              <Input
                value={guardianName}
                onChange={(e) => setGuardianName(e.target.value)}
                placeholder="陈先生"
                disabled={busy}
              />
            </Field>
          </div>
          <div className="flex-1">
            <Field label="监护人电话" hint="选填。">
              <Input
                value={guardianPhone}
                onChange={(e) => setGuardianPhone(e.target.value)}
                placeholder="04xx xxx xxx"
                className="num"
                disabled={busy}
              />
            </Field>
          </div>
        </div>

        {failure && (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-md border border-danger bg-danger-bg px-2.5 py-2 text-row text-danger"
          >
            <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
            <span className="min-w-0">
              {failure.label}
              {failure.detail && failure.detail !== failure.label && (
                <span className="block text-meta text-muted">{failure.detail}</span>
              )}
            </span>
          </p>
        )}
      </form>
    </Drawer>
  );
}
