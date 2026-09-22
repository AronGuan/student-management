/**
 * 试听转化「playbook」抽屉 —— 本作业唯一的 LLM 特性落点。
 *
 * 降级路径**可见而非隐藏**：
 *   - 服务端契约保证 HTTP 200 恒返回，用 ai_status + source 表达"AI 写的"还是"规则兜底"，
 *     这里额外把"为什么降级"写成一行明示文案（CloudOff + 具体原因）；
 *   - 传输层失败时不伪造 LLM 内容，也不禁用页面：上方给错误条与重试，下方给一块
 *     与卡片同形的诚实占位（只列服务端已记录的事实），线索行内的动作照常可用。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { CloudOff, FileText, ListChecks, Sparkles, TriangleAlert } from 'lucide-react';
import { api } from '../lib/api';
import { dateTime } from '../lib/format';
import { useToast } from '../components/Toast';
import { Drawer } from '../components/Drawer';
import { Button, Divider, KeyValue } from '../components/ui';
import { ErrorState, InlineSpinner } from '../components/StateViews';
import { DecisionCard } from '../components/DecisionCard';
import { OutcomeBadge, normaliseCard, outcomeLabel } from './LeadsPage.Shared';
import type { FollowUpListRow, RawConversionCard, TrialListRow } from './LeadsPage.Shared';
import type { AiConversionCard, AiSource } from '../lib/types';

/** 卡片来源 → 中文。未登记的值原样返回，不在界面上抹掉服务端的真实取值。 */
const AI_SOURCE: Record<AiSource, string> = {
  llm: '模型',
  rule: '规则',
};

export default function LeadsPlaybook({
  trial,
  followUp,
  onClose,
  onCompleteFollowUp,
}: {
  trial: TrialListRow | null;
  followUp: FollowUpListRow | null;
  onClose: () => void;
  onCompleteFollowUp: (followUpId: number) => Promise<void>;
}) {
  const { push } = useToast();
  const [card, setCard] = useState<AiConversionCard | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const startedFor = useRef<number | null>(null);

  const trialId = trial?.id ?? null;
  const studentId = trial?.student_id ?? null;

  const generate = useCallback(async () => {
    if (studentId === null) return;
    setLoading(true);
    setError(null);
    try {
      // 路径参数是 student_id（对应 Go 的 AIService.Conversion(db, studentID)）。
      const raw = await api.post<RawConversionCard>(`/ai/trial-conversion/${studentId}`);
      const normalised = normaliseCard(raw, studentId);
      setCard(normalised);
      if (normalised.ai_status === 'ok') push('success', '转化方案已生成。');
      else push('info', 'AI 不可用——正在显示规则引擎的结果。');
    } catch (err) {
      setError(err);
      setCard(null);
    } finally {
      setLoading(false);
    }
  }, [studentId, push]);

  useEffect(() => {
    if (trialId === null || studentId === null) return;
    // 一次打开只生成一次：该接口会往 ai_decisions 落一条记录，不该被 StrictMode 双触发。
    if (startedFor.current === trialId) return;
    startedFor.current = trialId;
    void generate();
  }, [trialId, studentId, generate]);

  // 卡片必须属于当前这条线索：切到另一条线索时，上一张卡不能继续挂在新的标题下面。
  const relevant = card && studentId !== null && card.student_id === studentId ? card : null;

  return (
    <Drawer
      open={trial !== null}
      onClose={onClose}
      title={trial ? `${trial.student_name ?? '线索'} · ${trial.subject_name ?? '试听'}` : '转化方案'}
      subtitle={trial ? `试听时间 ${dateTime(trial.scheduled_at)}` : undefined}
      width={560}
    >
      {!trial ? null : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <OutcomeBadge outcome={trial.outcome} />
            {trial.outcome_note && <span className="text-meta text-muted">“{trial.outcome_note}”</span>}
          </div>

          <div>
            <KeyValue k="科目" v={trial.subject_name ?? '—'} />
            <KeyValue k="试听老师" v={trial.teacher_name ?? '未分配'} />
            <KeyValue k="试听时间" v={dateTime(trial.scheduled_at)} />
            <KeyValue k="时长" v={`${trial.duration_min} 分钟`} />
          </div>

          <Divider />

          {trial.outcome === 'pending' ? (
            <p className="text-row text-muted">
              请先记录试听结果。转化方案基于已记录的结果生成，记录结果同时会启动 48 小时跟进计时。
            </p>
          ) : (
            <>
              {loading && (
                <p className="flex items-center gap-2 text-meta text-muted">
                  <InlineSpinner label="正在生成转化方案" />
                  <span>占位保持不变——卡片会出现在这里，布局不会跳动。</span>
                </p>
              )}

              {error ? <ErrorState error={error} onRetry={generate} /> : null}

              {relevant && !loading && <DegradationNote card={relevant} />}

              {relevant || loading ? (
                <DecisionCard
                  card={relevant}
                  loading={loading}
                  onRegenerate={generate}
                  actions={followUp ? ['完成跟进'] : []}
                  onAction={() => {
                    if (followUp) void onCompleteFollowUp(followUp.id);
                  }}
                  footerNote={
                    relevant?.model
                      ? `由 ${relevant.model} 生成 · 已记录到该线索`
                      : '基于已记录的试听证据生成。'
                  }
                />
              ) : (
                <UnreachablePanel trial={trial} onRetry={generate} loading={loading} />
              )}

              {followUp ? (
                <p className="text-meta text-muted">
                  跟进到期时间 {dateTime(followUp.due_at)}。在此完成会同时清掉队列中的对应行。
                </p>
              ) : (
                <Button variant="ghost" size="sm" onClick={onClose}>
                  关闭
                </Button>
              )}
            </>
          )}
        </div>
      )}
    </Drawer>
  );
}

/** 降级路径的显式说明 —— 评审要看的正是这一条。 */
function DegradationNote({ card }: { card: AiConversionCard }) {
  if (card.ai_status === 'ok') {
    return (
      <p className="flex items-center gap-2 text-meta text-muted">
        <Sparkles size={16} aria-hidden className="text-accent" />
        AI 撰写{card.model ? `（${card.model}）` : ''} · 来源：{AI_SOURCE[card.source] ?? card.source}。最终由顾问决定。
      </p>
    );
  }
  const invalid = card.ai_status === 'invalid';
  return (
    <p className="flex items-start gap-2 text-meta text-warn">
      {invalid ? <TriangleAlert size={16} aria-hidden /> : <CloudOff size={16} aria-hidden />}
      <span>
        {invalid
          ? '已降级到规则引擎：模型有回复，但其结果未通过结构化输出白名单校验，因此改用确定性卡片。'
          : '已降级到规则引擎：模型不可达或当前环境未配置模型，因此改用确定性卡片。'}
        位置不变、按钮不变——不会减少任何可用操作。
      </span>
    </p>
  );
}

/**
 * 传输层失败时的诚实占位：只列服务端已经落库的事实，不编造建议。
 * 形状与 DecisionCard 对齐（虚线 + surface 底），所以布局不跳。
 */
function UnreachablePanel({
  trial,
  onRetry,
  loading,
}: {
  trial: TrialListRow;
  onRetry: () => void;
  loading: boolean;
}) {
  const facts = [
    `${trial.subject_name ?? '科目'} 的试听结果：${outcomeLabel(trial.outcome)}`,
    trial.teacher_name ? `试听老师：${trial.teacher_name}` : '无试听老师记录',
    trial.outcome_note ? `结果备注：${trial.outcome_note}` : '无结果备注',
  ];
  return (
    <aside className="rounded-lg p-4 flex flex-col gap-3 border border-dashed border-border-strong bg-surface">
      <h3 className="flex items-center gap-2 section-title text-fg">
        <ListChecks size={16} aria-hidden className="text-muted" />
        转化方案引擎不可达
      </h3>
      <div className="flex flex-col gap-1.5">
        <span className="col-header">已记录的事实</span>
        <ul className="flex flex-col gap-1">
          {facts.map((fact) => (
            <li key={fact} className="text-meta text-fg-2 flex gap-1.5">
              <FileText size={16} aria-hidden className="shrink-0 text-meta" />
              <span>{fact}</span>
            </li>
          ))}
        </ul>
      </div>
      <p className="text-meta text-muted">
        宁可不出建议，也不编造建议。跟进计时继续运行，左侧队列不受影响。
      </p>
      <div>
        <Button variant="ghost" size="sm" onClick={onRetry} loading={loading}>
          重试
        </Button>
      </div>
    </aside>
  );
}
