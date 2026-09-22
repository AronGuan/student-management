/**
 * 家长端的「课堂反馈」区。
 *
 * 这一页是家庭账号唯一能打开的页面，所以「孩子最近怎么样」也只能落在这里：
 * 它是课时账本之外的另一条线 —— 流水回答"课时花在哪了"，这一块回答"花得怎么样"。
 *
 * 数据来自 GET /students/:id 的 parent_updates —— 顾问在跟进里亲手写下的那句话
 * （服务端只下发给家长看过的那份，follow_ups.parent_note 非空）。家庭凭据的读权限由
 * 服务端控制到本人子女，前端不自己筛。
 *
 * 为什么不是老师点名页那些话（recent_feedback）：那是老师写给同事的课堂记录，口气是
 * 员工之间的（"他说不想来了，下周之前得给家里打个电话"），冲的就是内部看和 AI 判断；
 * 家长读到的是顾问消化过、愿意署上自己名字的那一句。两份数据之间没有派生关系 ——
 * 不自动脱敏、不自动摘要，因为漏掉一条就是机构少说了一句，而"忘了说"和"没什么可说"
 * 必须能被区分开（后者就是这份列表里没有这一条）。别把这一块改回读 recent_feedback。
 *
 * 标题为什么是「课堂反馈」而不是「老师评价」：「评价」在中文里带评判、打分的意味，
 * 是老师对学生下的判断；家长要读的不是判断，是**课后发生了什么、我们做了什么**。
 * 「反馈」是中性的、不评判的，也不承诺任何结论。同理，这一块的文案里刻意不出现
 * "记录"、"备注"这两个词 —— 那是内部流程的叫法，会把内部口径泄漏给家长。
 *
 * 为什么不把 GET /students/:id 提到页面层共享：/me 没有全局 store，兄弟区块
 * MyCreditsLeave 也是自取自显 + 自带"刷新"重试。跟着它的契约走，代价是切换孩子时
 * 这个端点会被请求两次 —— 一个 demo 尺度上可接受的代价。
 *
 * 刻意不写「这是 AI 续费卡的输入之一」：那是内部口径（抽屉里那句话是给顾问看的），
 * 家庭成员读到只会困惑。
 */
import { useCallback, useEffect, useState } from 'react';
import { MessageSquareQuote } from 'lucide-react';
import { api } from '../lib/api';
import { shortDate } from '../lib/format';
import { Panel, PanelHeader } from '../components/ui';
import { ListState } from '../components/StateViews';
import type { ParentUpdateRow, StudentDetail } from '../lib/types';

export default function MyCreditsFeedback({ studentId }: { studentId: number }) {
  const [rows, setRows] = useState<ParentUpdateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const detail = await api.get<StudentDetail>(`/students/${studentId}`);
      setRows(Array.isArray(detail?.parent_updates) ? detail.parent_updates : []);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [studentId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Panel>
      <PanelHeader title="课堂反馈" count={rows.length} icon={<MessageSquareQuote size={16} aria-hidden />} />
      <ListState
        loading={loading}
        error={error}
        isEmpty={rows.length === 0}
        emptyMessage="还没有收到课堂反馈。有新的内容时，顾问会同步给您。"
        emptyCta="刷新"
        onEmptyCta={() => void load()}
        onRetry={() => void load()}
        rows={3}
        cols={3}
      >
        <div className="flex flex-col gap-2 p-4">
          <p className="text-row text-muted">课后老师看到的情况，由课程顾问同步给您。</p>
          <div className="divide-y divide-border">
            {rows.map((entry) => (
              <div key={entry.id} className="flex flex-col gap-0.5 py-2">
                <span className="text-row text-muted">
                  <span className="num">{shortDate(entry.recorded_at)}</span> ·{' '}
                  {entry.speaker_name ? `由 ${entry.speaker_name} 同步` : '课程顾问同步'}
                </span>
                <span className="text-row text-fg-2">“{entry.note}”</span>
              </div>
            ))}
          </div>
        </div>
      </ListState>
    </Panel>
  );
}
