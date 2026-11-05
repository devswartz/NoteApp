// Recurrence math, time-zone helpers and natural-language recurrence parsing.
// Owner: Recurrence & Reminders. Used by the server (rolling tasks forward,
// reminder times) and the client (pickers, quick add).
//
// Dates are local calendar dates ("YYYY-MM-DD") in the user's IANA time zone.
// Calendar arithmetic on them is time-zone independent (done on UTC Date
// objects, so DST never shifts a day); the time zone matters only for "what
// is today" and for turning a local date + time into an instant
// (zonedTimeToUtc), which is where DST is handled.
//
// Completing a recurring task ROLLS THE SAME TASK FORWARD: server/tasks.ts
// inserts a completed copy (occurrence_of = the task) so history shows in
// Completed, then moves the original's due date to nextOccurrence(...). When
// nextOccurrence returns null (until/count reached) the task is completed for
// good instead.
import type { Recurrence, Weekday } from './types.ts';

// ── Calendar dates ──────────────────────────────────────────────────────────

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const isISODate = (s: unknown): s is string => typeof s === 'string' && DATE_RE.test(s) && fmt(parse(s)) === s;
export const isHHmm = (s: unknown): s is string => typeof s === 'string' && TIME_RE.test(s);

function parse(s: string): Date {
  const m = DATE_RE.exec(s);
  if (!m) throw new Error(`Invalid date: ${s}`);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}
function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}
const ymd = (s: string) => {
  const d = parse(s);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate() };
};
const make = (y: number, m: number, d: number) => fmt(new Date(Date.UTC(y, m, d)));

export const daysInMonth = (y: number, m0: number) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
export const weekdayOf = (s: string) => parse(s).getUTCDay() as Weekday;

export function addDays(s: string, n: number): string {
  const d = parse(s);
  d.setUTCDate(d.getUTCDate() + n);
  return fmt(d);
}

/** Day `day` (1–31, or -1 = last) of the month `n` months after s's month, clamped to the month's length. */
function monthDay(s: string, n: number, day: number): string {
  const { y, m } = ymd(s);
  const first = new Date(Date.UTC(y, m + n, 1));
  const Y = first.getUTCFullYear();
  const M = first.getUTCMonth();
  const last = daysInMonth(Y, M);
  return make(Y, M, day === -1 ? last : Math.min(day, last));
}

/** The nth weekday of the month n months after s's month, or null if it doesn't exist (5th Monday). */
function nthWeekday(s: string, n: number, nth: number, weekday: Weekday): string | null {
  const { y, m } = ymd(s);
  const first = new Date(Date.UTC(y, m + n, 1));
  const Y = first.getUTCFullYear();
  const M = first.getUTCMonth();
  const len = daysInMonth(Y, M);
  if (nth === -1) {
    const lastDow = new Date(Date.UTC(Y, M, len)).getUTCDay();
    return make(Y, M, len - ((lastDow - weekday + 7) % 7));
  }
  const day = 1 + ((weekday - first.getUTCDay() + 7) % 7) + 7 * (nth - 1);
  return day <= len ? make(Y, M, day) : null;
}

// ── Time zones ──────────────────────────────────────────────────────────────

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function dtf(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    dtf(tz);
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of instant t in tz. */
export function zonedParts(t: Date | number, tz: string) {
  const parts: Record<string, number> = {};
  for (const p of dtf(tz).formatToParts(new Date(t))) if (p.type !== 'literal') parts[p.type] = Number(p.value);
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour % 24, minute: parts.minute, second: parts.second };
}

/** Offset of tz from UTC at instant t, in ms (positive east of Greenwich). */
function offsetAt(t: number, tz: string): number {
  const p = zonedParts(t, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(t / 1000) * 1000;
}

/** Today's date (YYYY-MM-DD) in tz. */
export function todayIn(tz: string, now: Date | number = Date.now()): string {
  const p = zonedParts(now, tz);
  return make(p.year, p.month - 1, p.day);
}

/** Local time HH:mm of instant t in tz. */
export function timeIn(tz: string, t: Date | number): string {
  const p = zonedParts(t, tz);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/**
 * The instant at which the wall clock in tz shows `date` `time`.
 * DST: a time skipped by a spring-forward (02:30 when clocks jump 02:00→03:00)
 * moves forward by the gap (03:30); an ambiguous fall-back time picks the
 * earlier (first) occurrence.
 */
export function zonedTimeToUtc(date: string, time: string, tz: string): Date {
  const { y, m, d } = ymd(date);
  const [hh, mm] = time.split(':').map(Number);
  const wall = Date.UTC(y, m, d, hh, mm);
  const candidates = new Set<number>();
  for (const probe of [wall - 864e5 / 2, wall, wall + 864e5 / 2]) candidates.add(wall - offsetAt(probe, tz));
  const exact = [...candidates].filter((t) => wall - offsetAt(t, tz) === t).sort((a, b) => a - b);
  if (exact.length) return new Date(exact[0]);
  // In a gap: use the offset in force before the transition, which lands after it.
  return new Date(wall - offsetAt(wall - 864e5 / 2, tz));
}

// ── Rules ───────────────────────────────────────────────────────────────────

/** Validation for rules arriving over the API. Returns an error message or null. */
export function recurrenceError(r: unknown): string | null {
  if (!r || typeof r !== 'object') return 'Invalid recurrence';
  const x = r as Record<string, unknown>;
  if (x.freq !== 'weekday') {
    if (!['day', 'week', 'month', 'year'].includes(x.freq as string)) return 'Invalid recurrence frequency';
    if (!Number.isInteger(x.interval) || (x.interval as number) < 1 || (x.interval as number) > 365) return 'Invalid recurrence interval';
  }
  const isDow = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 6;
  if (x.byWeekday !== undefined && (!Array.isArray(x.byWeekday) || !x.byWeekday.length || !x.byWeekday.every(isDow)))
    return 'Invalid weekdays';
  if (x.byMonthDay !== undefined && !(x.byMonthDay === -1 || (Number.isInteger(x.byMonthDay) && (x.byMonthDay as number) >= 1 && (x.byMonthDay as number) <= 31)))
    return 'Invalid day of month';
  if (x.byNthWeekday !== undefined) {
    const n = x.byNthWeekday as { n?: unknown; weekday?: unknown };
    if (!n || typeof n !== 'object' || ![1, 2, 3, 4, 5, -1].includes(n.n as number) || !isDow(n.weekday)) return 'Invalid nth weekday';
  }
  if (x.until !== undefined && x.until !== null && !isISODate(x.until)) return 'Invalid end date';
  if (x.count !== undefined && x.count !== null && !(Number.isInteger(x.count) && (x.count as number) >= 1 && (x.count as number) <= 10000))
    return 'Invalid occurrence count';
  if (x.basis !== undefined && x.basis !== 'due' && x.basis !== 'completion') return 'Invalid recurrence basis';
  return null;
}

const interval = (r: Recurrence) => (r.freq === 'weekday' ? 1 : Math.max(1, r.interval));
// Weeks start on Monday for "every 2 weeks on Mon, Thu".
const mondayOf = (s: string) => addDays(s, -((weekdayOf(s) + 6) % 7));

/** The first occurrence strictly after date d, keeping d's interval phase. */
export function stepAfter(rule: Recurrence, d: string): string {
  const n = interval(rule);
  switch (rule.freq) {
    case 'day':
      return addDays(d, n);
    case 'weekday': {
      let x = addDays(d, 1);
      while (weekdayOf(x) === 0 || weekdayOf(x) === 6) x = addDays(x, 1);
      return x;
    }
    case 'week': {
      const days = rule.byWeekday?.length ? [...new Set(rule.byWeekday)] : null;
      if (!days) return addDays(d, 7 * n);
      const order = (w: number) => (w + 6) % 7; // Mon = 0 … Sun = 6
      const sorted = days.sort((a, b) => order(a) - order(b));
      const cur = order(weekdayOf(d));
      const later = sorted.find((w) => order(w) > cur);
      if (later !== undefined) return addDays(d, order(later) - cur);
      return addDays(mondayOf(d), 7 * n + order(sorted[0]));
    }
    case 'month': {
      if (rule.byNthWeekday) {
        const { n: nth, weekday } = rule.byNthWeekday;
        const same = nthWeekday(d, 0, nth, weekday);
        if (same && same > d) return same;
        for (let k = n; k <= n * 120; k += n) {
          const x = nthWeekday(d, k, nth, weekday);
          if (x) return x;
        }
        return monthDay(d, n, ymd(d).d); // unreachable for valid rules
      }
      const day = rule.byMonthDay ?? ymd(d).d;
      const same = monthDay(d, 0, day);
      return same > d ? same : monthDay(d, n, day);
    }
    case 'year': {
      const day = rule.byMonthDay ?? ymd(d).d;
      return monthDay(d, 12 * n, day);
    }
  }
}

/**
 * First occurrence on or after `from`, for a rule set on a task with no due
 * date (or by quick add): "every Monday" typed on a Thursday starts next Monday.
 */
export function firstOccurrence(rule: Recurrence, from: string): string {
  const patterned =
    rule.freq === 'weekday' ||
    (rule.freq === 'week' && !!rule.byWeekday?.length) ||
    (rule.freq === 'month' && (rule.byMonthDay !== undefined || !!rule.byNthWeekday));
  if (!patterned) return from;
  return stepAfter(rule.freq === 'weekday' ? rule : { ...rule, interval: 1 }, addDays(from, -1));
}

export interface NextOccurrenceInput {
  /** The task's current due date (YYYY-MM-DD), or null. */
  dueDate: string | null;
  /** Today in the user's time zone (the completion day). */
  today: string;
  /** Occurrences completed so far INCLUDING the one being completed now (for `count`). */
  completedCount?: number;
}

/**
 * The next due date after completing an occurrence, or null when the series
 * has ended (until / count). Always lands strictly after today, so completing
 * an overdue task never produces another overdue one.
 *
 * basis 'due' (default): steps from the due date along the rule's pattern
 * (keeps "every Monday" on Mondays). basis 'completion': steps from today
 * ("water plants 3 days after I last did").
 */
export function nextOccurrence(rule: Recurrence, input: NextOccurrenceInput): string | null {
  const { today } = input;
  if (rule.count && (input.completedCount ?? 1) >= rule.count) return null;
  let d: string;
  if (rule.basis === 'completion' || !input.dueDate) {
    d = stepAfter(rule, today);
  } else {
    d = stepAfter(rule, input.dueDate);
    for (let i = 0; d <= today && i < 20000; i++) d = stepAfter(rule, d);
  }
  if (rule.until && d > rule.until) return null;
  return d;
}

/** The next `limit` occurrences starting from `start` (inclusive if it matches). For previews in the picker. */
export function previewOccurrences(rule: Recurrence, start: string, limit = 5): string[] {
  const out: string[] = [];
  let d = start;
  for (let i = 0; out.length < limit && i < 1000; i++) {
    if (rule.until && d > rule.until) break;
    if (rule.count && out.length >= rule.count) break;
    out.push(d);
    d = stepAfter(rule, d);
  }
  return out;
}

// ── Text ────────────────────────────────────────────────────────────────────

export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ord = (n: number) => {
  if (n === -1) return 'last';
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${s}`;
};

/** "Every 2 weeks on Mon, Thu", "Every month on the 2nd Tuesday", … */
export function describeRecurrence(rule: Recurrence | null, dueDate?: string | null): string {
  if (!rule) return '';
  let s: string;
  if (rule.freq === 'weekday') s = 'Every weekday';
  else {
    const n = interval(rule);
    s = n === 1 ? { day: 'Every day', week: 'Every week', month: 'Every month', year: 'Every year' }[rule.freq] : `Every ${n} ${rule.freq}s`;
    if (rule.freq === 'week' && rule.byWeekday?.length) {
      const order = (w: number) => (w + 6) % 7;
      const days = [...new Set(rule.byWeekday)].sort((a, b) => order(a) - order(b));
      s += ` on ${days.map((d) => WEEKDAY_SHORT[d]).join(', ')}`;
    }
    if (rule.freq === 'month') {
      if (rule.byNthWeekday) s += ` on the ${ord(rule.byNthWeekday.n)} ${WEEKDAY_LONG[rule.byNthWeekday.weekday]}`;
      else if (rule.byMonthDay) s += rule.byMonthDay === -1 ? ' on the last day' : ` on the ${ord(rule.byMonthDay)}`;
    }
    if (rule.freq === 'year' && dueDate && isISODate(dueDate)) {
      const { m, d } = ymd(dueDate);
      s += ` on ${MONTHS[m]} ${rule.byMonthDay ?? d}`;
    }
  }
  if (rule.basis === 'completion') s += ' after completion';
  if (rule.until) s += ` until ${rule.until}`;
  if (rule.count) s += `, ${rule.count} times`;
  return s;
}

// ── Natural language ────────────────────────────────────────────────────────

const DOW: Record<string, Weekday> = {
  su: 0, sun: 0, sunday: 0, mo: 1, mon: 1, monday: 1, tu: 2, tue: 2, tues: 2, tuesday: 2,
  we: 3, wed: 3, wednesday: 3, th: 4, thu: 4, thur: 4, thurs: 4, thursday: 4,
  fr: 5, fri: 5, friday: 5, sa: 6, sat: 6, saturday: 6,
};
const DAY_WORD = '(?:sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)';
const DAY_LIST = `${DAY_WORD}(?:\\s*(?:,|and|&|\\+|/)?\\s*${DAY_WORD})*`;
const NTH: Record<string, number> = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4, fifth: 5, '5th': 5, last: -1 };
const UNIT: Record<string, 'day' | 'week' | 'month' | 'year'> = { day: 'day', week: 'week', month: 'month', year: 'year' };
const NUM_WORD: Record<string, number> = { other: 2, two: 2, three: 3, four: 4, five: 5, six: 6 };

const parseDays = (s: string): Weekday[] =>
  [...new Set((s.toLowerCase().match(new RegExp(DAY_WORD, 'gi')) ?? []).map((w) => DOW[w.toLowerCase()]))];

export interface ParsedRecurrence {
  rule: Recurrence;
  /** Where the phrase was found, so quick add can strip it from the title. */
  start: number;
  end: number;
}

/**
 * Finds a recurrence phrase in free text. Understands, among others:
 *   daily, weekly, monthly, yearly, every day, every weekday, every 3 days,
 *   every other week, every monday, every mon, thu, every 2 weeks on mon,thu,
 *   every month on the 15th, every month on the last day, every 2nd tuesday,
 *   every last friday, every year, every 15th, … and suffixes
 *   "until 2026-12-31", "for 10 times" / "x10", "after completion" / "from completion".
 * For the Tasks agent: call this from shared/quickadd.ts and strip
 * text.slice(start, end) from the title.
 */
export function parseRecurrence(text: string): ParsedRecurrence | null {
  const patterns: [RegExp, (m: RegExpExecArray) => Recurrence | null][] = [
    // every 2 weeks on mon, thu   /   every week on monday
    [
      new RegExp(`\\b(?:every|each)\\s+(?:(\\d+|other|two|three|four)\\s+)?weeks?\\s+on\\s+(${DAY_LIST})\\b`, 'i'),
      (m) => ({ freq: 'week', interval: num(m[1]), byWeekday: parseDays(m[2]) }),
    ],
    // every month on the 15th / the last day
    [
      /\b(?:every|each)\s+(?:(\d+|other|two|three|four|six)\s+)?months?\s+on\s+the\s+(\d{1,2})(?:st|nd|rd|th)?\b/i,
      (m) => (+m[2] >= 1 && +m[2] <= 31 ? { freq: 'month', interval: num(m[1]), byMonthDay: +m[2] } : null),
    ],
    [/\b(?:every|each)\s+(?:(\d+|other|two|three|four|six)\s+)?months?\s+on\s+the\s+last\s+day\b/i, (m) => ({ freq: 'month', interval: num(m[1]), byMonthDay: -1 })],
    // every month on the 2nd tuesday  /  every 2nd tuesday  /  every last friday (of the month)
    [
      new RegExp(`\\b(?:every|each)\\s+(?:(\\d+|other|two|three|four|six)\\s+)?months?\\s+on\\s+the\\s+(first|second|third|fourth|fifth|last|1st|2nd|3rd|4th|5th)\\s+(${DAY_WORD})\\b`, 'i'),
      (m) => ({ freq: 'month', interval: num(m[1]), byNthWeekday: { n: NTH[m[2].toLowerCase()] as 1, weekday: DOW[m[3].toLowerCase()] } }),
    ],
    [
      new RegExp(`\\b(?:every|each|the)\\s+(first|second|third|fourth|fifth|last|1st|2nd|3rd|4th|5th)\\s+(${DAY_WORD})(?:\\s+of\\s+(?:the|each|every)\\s+month)?\\b`, 'i'),
      (m) => ({ freq: 'month', interval: 1, byNthWeekday: { n: NTH[m[1].toLowerCase()] as 1, weekday: DOW[m[2].toLowerCase()] } }),
    ],
    // every 15th (of the month)
    [
      /\b(?:every|each)\s+(\d{1,2})(?:st|nd|rd|th)(?:\s+of\s+(?:the|each|every)\s+month)?\b/i,
      (m) => (+m[1] >= 1 && +m[1] <= 31 ? { freq: 'month', interval: 1, byMonthDay: +m[1] } : null),
    ],
    // every weekday / workday
    [/\b(?:every|each)\s+(?:weekday|workday|work\s+day|business\s+day)s?\b|\bweekdays\b/i, () => ({ freq: 'weekday' })],
    // every monday, every mon and thu
    [new RegExp(`\\b(?:every|each)\\s+(${DAY_LIST})\\b`, 'i'), (m) => ({ freq: 'week', interval: 1, byWeekday: parseDays(m[1]) })],
    // every 3 days, every other week, every month
    [
      /\b(?:every|each)\s+(?:(\d+|other|two|three|four|five|six)\s+)?(day|week|month|year)s?\b/i,
      (m) => ({ freq: UNIT[m[2].toLowerCase()], interval: num(m[1]) }),
    ],
    [/\b(daily|weekly|fortnightly|biweekly|monthly|quarterly|yearly|annually)\b/i, (m) => adverb(m[1].toLowerCase())],
  ];
  for (const [re, build] of patterns) {
    const m = re.exec(text);
    if (!m) continue;
    const rule = build(m);
    if (!rule) continue;
    let end = m.index + m[0].length;
    // Optional suffixes, in any order.
    for (;;) {
      const rest = text.slice(end);
      let s: RegExpExecArray | null;
      if ((s = /^\s+until\s+(\d{4}-\d{2}-\d{2})\b/i.exec(rest)) && isISODate(s[1])) rule.until = s[1];
      else if ((s = /^\s+(?:for\s+(\d{1,4})\s+times|x\s?(\d{1,4}))\b/i.exec(rest))) rule.count = +(s[1] ?? s[2]);
      else if ((s = /^\s+(?:after|from)\s+(?:completion|completed|done)\b/i.exec(rest))) rule.basis = 'completion';
      else break;
      end += s[0].length;
    }
    return { rule, start: m.index, end };
  }
  return null;
}

function num(s: string | undefined): number {
  if (!s) return 1;
  const n = NUM_WORD[s.toLowerCase()] ?? Number(s);
  return Number.isInteger(n) && n >= 1 && n <= 365 ? n : 1;
}

function adverb(w: string): Recurrence {
  switch (w) {
    case 'daily':
      return { freq: 'day', interval: 1 };
    case 'weekly':
      return { freq: 'week', interval: 1 };
    case 'fortnightly':
    case 'biweekly':
      return { freq: 'week', interval: 2 };
    case 'quarterly':
      return { freq: 'month', interval: 3 };
    case 'monthly':
      return { freq: 'month', interval: 1 };
    default:
      return { freq: 'year', interval: 1 };
  }
}
