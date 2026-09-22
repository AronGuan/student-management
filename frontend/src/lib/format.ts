/**
 * 墨尔本墙上时钟的展示工具。服务端保证所有时间串都带墨尔本偏移，前端**只截取、不换算**。
 *
 * 唯一的例外是文件末尾的 melbourneInstant() —— 安排试听时要拼一个绝对时刻送上服务端，
 * 那里必须自己算对偏移。除此之外这个文件里的函数都不做时区推理。
 */

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

/**
 * 墨尔本在**某个日期**上的 UTC 偏移，形如 "+11:00"。
 *
 * 为什么不写死 "+10:00"：那是 AEST 的偏移，而墨尔本 10 月到 4 月是 AEDT 的 "+11:00"。
 * 写死会在夏令时期间整整差一小时，而且错得很安静 —— 服务端照收不误，只是约错了时间。
 * `timeZoneName: 'longOffset'` 是运行时给出的真值，比手写一张 DST 表可靠。
 *
 * 取样点用 **UTC 正午**：它落在墨尔本当天 22:00/23:00，永远与目标日期同一天，
 * 也永远落在当天凌晨那次夏令时切换的同一侧（业务时段内不会有第二次切换）。
 * 若改成拿墨尔本本地午夜去问偏移，在切换日反而会取到前一天的偏移。
 */
export function melbourneOffset(date: string): string {
  const raw = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Australia/Melbourne',
    timeZoneName: 'longOffset',
  })
    .formatToParts(new Date(`${date}T12:00:00Z`))
    .find((part) => part.type === 'timeZoneName')?.value;
  // 形如 "GMT+11:00"；只给时区名不带日期时某些实现会省略偏移。墨尔本恒定有偏移，
  // 兜底分支只是为了让返回值类型确定，不代表这里预期会走到。
  return /GMT([+-]\d{2}:\d{2})/.exec(raw ?? '')?.[1] ?? '+10:00';
}

/**
 * 把「墨尔本墙上时钟的日期 + 时刻」拼成一个**绝对时刻**（RFC3339）。
 *
 * 这是全 app 唯一一处前端要拼出一个绝对时刻送给服务端的地方，其余各处都只做「截取」：
 * 展示用 shortDate / timeOfDay，请假与倒计时用 wallClock 解析服务端已带偏移的串，
 * 建班送的是 weekday + start_min（相对时刻，绕开了时区）。所以唯独这里必须自己把偏移
 * 算对 —— 见 melbourneOffset 里为什么不能沿用 MyCreditsPage.Shared.tsx 的 "+10:00"。
 */
export function melbourneInstant(date: string, time: string): string {
  return `${date}T${time}:00${melbourneOffset(date)}`;
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

/**
 * 从某个时间串到现在经过的**整天数**（向下取整）。无法解析时返回 null。
 *
 * 走 wallClock 解析成绝对时刻再相减，与 slaCountdown / hoursUntil 同一口径：服务端下发的
 * 串自带墨尔本偏移，parse 出来就是绝对时刻，所以这里不需要知道「墨尔本现在几点」——
 * 这正是本文件开头那条「只截取、不换算」规则允许的用法。
 *
 * 反过来做——把日期串截成 "2026-09-10" 再和今天的日期串比较——会在跨时区时整整差一天，
 * 正是本仓禁止的那类换算。
 *
 * floor 而非 round：晾了 23 小时是「今天录入」，不是「已晾 1 天」。
 * max(0, …) 兜住服务端时钟略快于浏览器（或 created_at 是将来时刻）造成的负数。
 */
export function daysSince(iso: string | null | undefined, now = Date.now()): number | null {
  const t = wallClock(iso);
  if (t === null) return null;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}

/**
 * 一节课（开始时刻 + 时长）**结束**到现在经过的小时数。还没下课就是负数，无法解析返回 null。
 *
 * 与 daysSince / hoursUntil 同一口径：先把服务端下发的带偏移串经 wallClock 解析成绝对
 * 时刻，再相减。前端自己拼 scheduled_at + duration_min 是允许的，因为两者都是绝对量；
 * 不被允许的是把日期串截成 "2026-09-22" 再和「今天」比 —— 那是换算。
 *
 * 不取整：调用方要区分「刚刚结束」（<1h）和「已结束 N 小时」，取整会把前者抹成 0。
 */
export function hoursSinceEnd(
  startIso: string | null | undefined,
  durationMin: number,
  now = Date.now(),
): number | null {
  const t = wallClock(startIso);
  if (t === null) return null;
  return (now - (t + durationMin * 60_000)) / 3_600_000;
}

/**
 * 「试听已经结束多久」的文案 —— 只给「待记录结果」档里**已经下课、结果还没记**的行用。
 *
 * 刻意不借用 overdueLabel 的「逾期」二字：逾期是 48h 跟进任务的词（slaCountdown 与
 * overdueLabel 都服务于那条钟），试听本身没有 SLA。两个钟共用一个词，读的人会把
 * 「还没试听」和「试听完没记」混成同一件事 —— 这恰恰是这一档今天最容易被读反的地方。
 *
 * 负数（还没下课）返回 null，让调用方决定什么都不渲染 —— 未开始和正在试听的行不需要
 * 任何标记，给它们贴一个「还没结束」只是往表里加噪音。
 */
export function endedAgoLabel(hours: number | null | undefined): string | null {
  if (hours === null || hours === undefined || hours < 0) return null;
  if (hours < 1) return '刚刚结束';
  if (hours < 24) return `已结束 ${Math.max(1, Math.round(hours))} 小时`;
  return `已结束 ${Math.floor(hours / 24)} 天`;
}
