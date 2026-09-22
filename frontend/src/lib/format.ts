/** 墨尔本墙上时钟的展示工具。服务端保证所有时间串已是 +10:00 本地时间，前端不做时区换算。 */

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const WEEKDAYS_LONG = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

export function weekdayShort(weekday: number): string {
  return WEEKDAYS[weekday] ?? '—';
}

export function weekdayLong(weekday: number): string {
  return WEEKDAYS_LONG[weekday] ?? '—';
}

/** 自 00:00 起的分钟数 → "16:00" */
export function minutesToTime(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** 8/19 —— 只取日期部分，不做时区解析（时间串本身已是墨尔本本地时间） */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return '—';
  return `${Number(match[2])}/${Number(match[3])}`;
}

export function longDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return '—';
  return `${Number(match[2])}/${Number(match[3])}/${match[1]}`;
}

export function timeOfDay(iso: string | null | undefined): string {
  if (!iso) return '—';
  const match = /T(\d{2}):(\d{2})/.exec(iso);
  return match ? `${match[1]}:${match[2]}` : '—';
}

export function dateTime(iso: string | null | undefined): string {
  return `${shortDate(iso)} ${timeOfDay(iso)}`;
}

/** 把 "2026-09-21T09:00:00+10:00" 解析为可比较的时间戳（保留原墙上时钟语义） */
export function wallClock(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * 48h SLA 倒计时文案。语义由文案承担，不靠颜色。
 * 返回 { label, tone, hoursLeft, ratio } —— ratio 用于 SLA 条填充。
 */
export function slaCountdown(dueIso: string | null | undefined, now = Date.now()): {
  label: string;
  tone: 'neutral' | 'warn' | 'danger';
  hoursLeft: number;
  ratio: number;
} {
  const due = wallClock(dueIso);
  if (due === null) return { label: '无截止时间', tone: 'neutral', hoursLeft: 48, ratio: 0 };

  const diffMs = due - now;
  const hoursLeft = diffMs / 3_600_000;
  const ratio = Math.min(1, Math.max(0, (48 - hoursLeft) / 48));

  if (hoursLeft <= 0) {
    const overdueHours = Math.abs(hoursLeft);
    if (overdueHours >= 48) {
      const days = Math.floor(overdueHours / 24);
      return { label: `逾期 ${days} 天`, tone: 'danger', hoursLeft, ratio: 1 };
    }
    if (overdueHours >= 24) {
      const days = Math.floor(overdueHours / 24);
      return { label: `逾期 ${days} 天`, tone: 'danger', hoursLeft, ratio: 1 };
    }
    const hours = Math.max(1, Math.round(overdueHours));
    return { label: `逾期 ${hours} 小时`, tone: 'warn', hoursLeft, ratio };
  }

  if (hoursLeft <= 24) {
    const hours = Math.max(1, Math.round(hoursLeft));
    return { label: `剩余 ${hours} 小时`, tone: 'warn', hoursLeft, ratio };
  }

  const hours = Math.round(hoursLeft);
  return { label: `剩余 ${hours} 小时`, tone: 'neutral', hoursLeft, ratio };
}

/**
 * 逾期时长文案。服务端只下发小时数（overdue_hours），文案归前端 —— 与 slaCountdown
 * 的逾期分支同一口径：≥24h 说「天」，不足 24h 说「小时」（至少 1 小时，不出现「逾期 0 小时」）。
 * 未逾期（null / undefined / ≤0）返回 null，由调用方决定是否回落到 sla.label。
 */
export function overdueLabel(hours: number | null | undefined): string | null {
  if (hours === null || hours === undefined || hours <= 0) return null;
  if (hours >= 24) return `逾期 ${Math.floor(hours / 24)} 天`;
  return `逾期 ${Math.max(1, Math.round(hours))} 小时`;
}

export function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export interface CreditTier {
  /** 进度条填充色 token */
  fill: string;
  /** 是否显示 triangle-alert */
  alert: boolean;
  /** ≤5 节：行尾出现 Renew 按钮 */
  action: 'renew' | 'prepare' | 'urgent' | null;
  /** 透支：虚线轨道 */
  overdrawn: boolean;
}

export function creditTier(balance: number, _total: number): CreditTier {
  // 透支必须真的是负数。余额正好 0 是「用完了」，不是「欠账」——把 0 归到透支档，
  // 一条从没开过账的学生记录就会被画成红色虚线轨道 + 「已透支 0」，读起来像会计事故。
  if (balance < 0) return { fill: 'var(--danger)', alert: true, action: 'urgent', overdrawn: true };
  if (balance <= 5) return { fill: 'var(--danger)', alert: true, action: 'renew', overdrawn: false };
  if (balance <= 10) return { fill: 'var(--warn)', alert: true, action: null, overdrawn: false };
  if (balance <= 19) return { fill: 'var(--warn)', alert: false, action: null, overdrawn: false };
  return { fill: 'var(--success)', alert: false, action: null, overdrawn: false };
}

/** 预计用尽日。按每周消耗节数线性外推。 */
export function projectedRunOut(balance: number, perWeek: number, from = new Date()): Date | null {
  if (balance <= 0 || perWeek <= 0) return null;
  const weeks = balance / perWeek;
  return new Date(from.getTime() + weeks * 7 * 86_400_000);
}

export function relativeWeeksLabel(target: Date, from = new Date()): string {
  const weeks = Math.max(0, Math.round((target.getTime() - from.getTime()) / (7 * 86_400_000)));
  if (weeks <= 0) return '本周用尽';
  if (weeks === 1) return '约剩 1 周';
  return `约剩 ${weeks} 周`;
}

export function hoursUntil(iso: string, now = Date.now()): number {
  const t = wallClock(iso);
  if (t === null) return 0;
  return Math.round((t - now) / 3_600_000);
}
