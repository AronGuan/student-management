import { useState } from 'react';
import { Sparkles, ListChecks, ChevronDown, ChevronRight, CloudOff, RotateCw } from 'lucide-react';
import type { AiDecisionCard } from '../lib/types';
import { Button } from './ui';
import { dateTime } from '../lib/format';

/**
 * LLM 决策卡 —— 可用态与降级态**同一个组件、同一套 props**，由服务端 ai_status 切换。
 * UIUX.md §4.5：位置、高度、按钮完全不变，只变三处 —— 图标 / 标题 / 边框（实线 accent → 虚线）。
 *
 * 两条失败要区分：
 *   invalid  —— structured output 校验失败，服务端已静默重试 1 次 → **不给重试按钮**
 *   unavailable —— LLM 不可达/未配置（环境性问题）→ 给 Ghost「Regenerate」
 *
 * 卡片内容分两类（试听转化 / 续费风险），字段不同，因此在这里归一为同一个视图模型，
 * 而不是让每个页面各写一套渲染。
 */
export type DecisionMode = 'ai' | 'rule';

export function modeOf(card: Pick<AiDecisionCard, 'ai_status'>): DecisionMode {
  return card.ai_status === 'ok' ? 'ai' : 'rule';
}

/** 服务端返回的是枚举；界面必须给人话，不能把 'send_material' 直接印出来。 */
const SIGNAL: Record<string, string> = {
  strong: '强信号',
  weak: '弱信号',
  blocked: '受阻',
};
const RISK: Record<string, string> = {
  high: '高流失风险',
  medium: '中流失风险',
  low: '低流失风险',
};
const CONCERN: Record<string, string> = {
  price: '价格',
  outcome: '对效果没把握',
  schedule: '时间冲突',
  distance: '距离太远',
  teacher: '老师匹配度',
  other: '其他',
};
const BLOCKER: Record<string, string> = {
  none: '没有阻碍',
  price: '价格',
  schedule: '时间安排',
  outcome: '对效果存疑',
  undecided: '还在犹豫',
  competitor: '竞品机构',
};
const ACTION: Record<string, string> = {
  call: '致电家长',
  send_material: '发送资料',
  arrange_second_trial: '安排第二次试听',
  wait: '等待',
  close: '立即成交',
};
const FACTOR: Record<string, string> = {
  attendance_drop: '出勤率下降',
  feedback_negative: '近期反馈负面',
  low_usage: '课时消耗偏慢',
  long_gap: '距上次上课间隔较长',
};
const PACKAGE: Record<string, string> = {
  small: '小',
  standard: '标准',
  large: '大',
  none: '无',
};
const KIND_LABEL: Record<string, string> = {
  trial_conversion: '试听转化',
  renewal_risk: '续费风险',
};

interface DecisionView {
  chip: string;
  recommendation: string;
  reasons: string[];
  actions: string[];
}

function viewOf(card: AiDecisionCard): DecisionView {
  if (card.kind === 'trial_conversion') {
    const concerns = card.guardian_concerns
      .filter((c) => c !== 'other')
      .map((c) => CONCERN[c] ?? c);
    return {
      chip: SIGNAL[card.conversion_signal] ?? '',
      recommendation: card.advisor_note,
      reasons: [
        concerns.length > 0 ? `家长顾虑：${concerns.join('、')}` : '未提出具体顾虑',
        `主要阻碍：${BLOCKER[card.blocker] ?? card.blocker}`,
        `请在 ${card.follow_up_within_days} 天内跟进`,
        ...card.evidence,
      ],
      actions: [ACTION[card.next_action] ?? card.next_action],
    };
  }
  return {
    chip: RISK[card.churn_risk] ?? '',
    recommendation: card.advisor_note,
    reasons: [
      ...card.risk_factors.filter((f) => f !== 'none').map((f) => FACTOR[f] ?? f),
      `建议课时包：${PACKAGE[card.recommended_package] ?? card.recommended_package}`,
      `最佳联系时段：${card.contact_from}–${card.contact_to}`,
      ...card.evidence,
    ],
    actions: [],
  };
}

export function DecisionCard({
  card,
  loading = false,
  onRegenerate,
  onAction,
  actions,
  footerNote,
}: {
  card: AiDecisionCard | null | undefined;
  loading?: boolean;
  onRegenerate?: () => void;
  onAction?: (action: string) => void;
  /** 覆盖卡片自带的建议动作（页面已有一致按钮组时使用） */
  actions?: string[];
  footerNote?: string;
}) {
  const [reasonsOpen, setReasonsOpen] = useState(false);

  // 无卡片时先渲染规则态占位骨架，高度与真实态一致，不跳布局。
  const mode: DecisionMode = card ? modeOf(card) : 'rule';
  const degraded = mode === 'rule';
  const Icon = degraded ? ListChecks : Sparkles;
  const view = card ? viewOf(card) : null;

  const shell: React.CSSProperties = degraded
    ? {
        border: '1px dashed var(--border-strong)',
        backgroundColor: 'var(--surface)',
      }
    : {
        border: '1px solid var(--accent)',
        backgroundColor: 'var(--surface-warm)',
      };

  const kindLabel = card ? (KIND_LABEL[card.kind] ?? card.kind) : '正在评估信号';
  const title = degraded
    ? `规则判定 · ${kindLabel}`
    : `AI 建议 · ${kindLabel}`;

  const list = actions ?? view?.actions ?? [];

  return (
    <aside className="rounded-lg p-4 flex flex-col gap-3" style={shell} aria-live="polite">
      <header className="flex items-start justify-between gap-2">
        <h3 className="flex items-center gap-2 section-title text-fg">
          <Icon size={16} aria-hidden style={{ color: degraded ? 'var(--muted)' : 'var(--accent)' }} />
          <span>{title}</span>
        </h3>
        {!degraded && view && view.chip && (
          <span
            className="shrink-0 rounded-sm px-1.5 py-0.5 text-meta font-[510]"
            style={{ backgroundColor: 'var(--accent-bg)', color: 'var(--accent)' }}
          >
            {view.chip}
          </span>
        )}
      </header>

      {/* 建议动作 */}
      <div className="flex flex-col gap-1.5">
        <span className="col-header">建议动作</span>
        {view ? (
          <p className="text-row text-fg">{view.recommendation}</p>
        ) : (
          <p className="text-row text-muted">综合出勤、反馈与跟进时机。</p>
        )}
      </div>

      {/* 为什么这么判断 */}
      <div>
        <button
          type="button"
          onClick={() => setReasonsOpen((v) => !v)}
          aria-expanded={reasonsOpen}
          className="inline-flex items-center gap-1 col-header hover:text-fg transition-colors duration-150 ease-standard"
        >
          {reasonsOpen ? <ChevronDown size={16} aria-hidden /> : <ChevronRight size={16} aria-hidden />}
          判断依据
        </button>
        {reasonsOpen && (
          <ul className="mt-1.5 flex flex-col gap-1">
            {(view?.reasons ?? ['正在汇总出勤、反馈与跟进历史。']).map(
              (reason, i) => (
                <li key={i} className="text-meta text-fg-2 flex gap-1.5">
                  <span aria-hidden style={{ color: 'var(--meta)' }}>
                    ·
                  </span>
                  <span>{reason}</span>
                </li>
              ),
            )}
          </ul>
        )}
      </div>

      <div className="h-px" style={{ backgroundColor: 'var(--border)' }} />

      <footer className="flex flex-col gap-2">
        <p className="text-meta text-muted flex items-center gap-1.5 flex-wrap">
          {degraded ? (
            <>
              {card?.ai_status === 'unavailable' && <CloudOff size={16} aria-hidden />}
              <span>AI 建议不可用 —— 本次结论由规则引擎给出。</span>
              {card?.ai_status === 'unavailable' && onRegenerate && (
                <Button variant="ghost" size="sm" onClick={onRegenerate} loading={loading}>
                  <RotateCw size={14} aria-hidden />
                  重新生成
                </Button>
              )}
            </>
          ) : (
            <span>
              {footerNote ?? `基于 ${view?.reasons.length ?? 0} 条信号 · ${dateTime(card?.created_at)}`}
            </span>
          )}
        </p>
        {!degraded && <p className="text-meta text-muted">最终决策权在顾问。</p>}
      </footer>

      {list.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {list.map((action) => (
            <Button key={action} variant="secondary" size="sm" onClick={() => onAction?.(action)}>
              {action}
            </Button>
          ))}
        </div>
      )}
    </aside>
  );
}
