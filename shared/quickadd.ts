// Natural-language quick add, e.g.
//   "Send invoice tomorrow p1 @sam every month"
// → { title: 'Send invoice', dueDate: <tomorrow>, priority: 1, assignee: 'sam', recurrence: monthly }
import { addDays, addMonths, parseISODate, toISODate, today } from './dates.ts';
import type { Priority, Recurrence } from './types.ts';
import { firstOccurrence, parseRecurrence } from './recurrence.ts';

export interface QuickAddResult {
  title: string;
  dueDate: string | null;
  dueTime: string | null;
  priority: Priority | null;
  recurrence: Recurrence | null;
  /** Raw mention text after "@" — resolved to a user by the caller. */
  assignee: string | null;
  /** Spans of the input that were recognised, for highlighting. */
  tokens: { start: number; end: number; kind: 'date' | 'time' | 'priority' | 'recurrence' | 'assignee' }[];
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEKDAY_RE = '(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|rsday|urday)?';
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_RE = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*';

function weekdayIndex(word: string): number {
  return WEEKDAYS.findIndex((w) => w.startsWith(word.toLowerCase().slice(0, 3)));
}

function nextWeekday(from: string, idx: number, strictlyAfter = true): string {
  const d = parseISODate(from);
  let diff = (idx - d.getDay() + 7) % 7;
  if (diff === 0 && strictlyAfter) diff = 7;
  return addDays(from, diff);
}

function monthDay(month: number, day: number, base: string): string | null {
  if (month < 0 || day < 1 || day > 31) return null;
  const b = parseISODate(base);
  let d = new Date(b.getFullYear(), month, day);
  if (d.getMonth() !== month) return null;
  if (toISODate(d) < base) d = new Date(b.getFullYear() + 1, month, day);
  return toISODate(d);
}

type Rule = {
  re: RegExp;
  kind: QuickAddResult['tokens'][number]['kind'];
  apply: (m: RegExpExecArray, r: QuickAddResult, base: string) => boolean;
};

const UNIT: Record<string, 'day' | 'week' | 'month' | 'year'> = {
  day: 'day', days: 'day', week: 'week', weeks: 'week', month: 'month', months: 'month', year: 'year', years: 'year',
};

const rules: Rule[] = [
  {
    re: /(?:^|\s)!?p([1-4])\b/i,
    kind: 'priority',
    apply: (m, r) => {
      r.priority = Number(m[1]) as Priority;
      return true;
    },
  },
  {
    re: /(?:^|\s)@([\p{L}\p{N}._-]+)/u,
    kind: 'assignee',
    apply: (m, r) => {
      r.assignee = m[1];
      return true;
    },
  },
  {
    re: /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\bat\s+(\d{1,2}):(\d{2})\b/i,
    kind: 'time',
    apply: (m, r, base) => {
      let h: number, min: number;
      if (m[3]) {
        h = Number(m[1]) % 12 + (m[3].toLowerCase() === 'pm' ? 12 : 0);
        min = Number(m[2] ?? 0);
      } else {
        h = Number(m[4]);
        min = Number(m[5]);
      }
      if (h > 23 || min > 59) return false;
      r.dueTime = `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
      r.dueDate = r.dueDate ?? base;
      return true;
    },
  },
  {
    re: /\b(?:at\s+)?(noon|midday|midnight)\b/i,
    kind: 'time',
    apply: (m, r, base) => {
      r.dueTime = m[1].toLowerCase() === 'midnight' ? '00:00' : '12:00';
      r.dueDate = r.dueDate ?? base;
      return true;
    },
  },
  {
    re: /\b(today|tod|tonight)\b/i,
    kind: 'date',
    apply: (_m, r, base) => ((r.dueDate = base), true),
  },
  {
    re: /\b(tomorrow|tmr|tmrw)\b/i,
    kind: 'date',
    apply: (_m, r, base) => ((r.dueDate = addDays(base, 1)), true),
  },
  {
    re: /\bnext\s+week\b/i,
    kind: 'date',
    apply: (_m, r, base) => ((r.dueDate = nextWeekday(base, 1)), true),
  },
  {
    re: /\bnext\s+month\b/i,
    kind: 'date',
    apply: (_m, r, base) => {
      const d = parseISODate(addMonths(base, 1));
      d.setDate(1);
      r.dueDate = toISODate(d);
      return true;
    },
  },
  {
    re: /\bin\s+(\d+)\s+(day|days|week|weeks|month|months)\b/i,
    kind: 'date',
    apply: (m, r, base) => {
      const n = Number(m[1]);
      const u = UNIT[m[2].toLowerCase()];
      r.dueDate = u === 'day' ? addDays(base, n) : u === 'week' ? addDays(base, 7 * n) : addMonths(base, n);
      return true;
    },
  },
  {
    re: /\b(\d{4})-(\d{2})-(\d{2})\b/,
    kind: 'date',
    apply: (m, r) => {
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      if (d.getMonth() !== Number(m[2]) - 1) return false;
      r.dueDate = toISODate(d);
      return true;
    },
  },
  {
    re: new RegExp(`\\b(?:on\\s+)?${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i'),
    kind: 'date',
    apply: (m, r, base) => {
      const d = monthDay(MONTHS.indexOf(m[1].toLowerCase().slice(0, 3)), Number(m[2]), base);
      if (!d) return false;
      r.dueDate = d;
      return true;
    },
  },
  {
    re: new RegExp(`\\b(?:on\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_RE}\\b`, 'i'),
    kind: 'date',
    apply: (m, r, base) => {
      const d = monthDay(MONTHS.indexOf(m[2].toLowerCase().slice(0, 3)), Number(m[1]), base);
      if (!d) return false;
      r.dueDate = d;
      return true;
    },
  },
  {
    re: new RegExp(`\\b(?:on\\s+|next\\s+)?${WEEKDAY_RE}\\b`, 'i'),
    kind: 'date',
    apply: (m, r, base) => {
      const idx = weekdayIndex(m[1]);
      if (idx < 0) return false;
      r.dueDate = nextWeekday(base, idx);
      return true;
    },
  },
];

export function parseQuickAdd(input: string, now = new Date()): QuickAddResult {
  const base = today(now);
  const r: QuickAddResult = {
    title: input,
    dueDate: null,
    dueTime: null,
    priority: null,
    recurrence: null,
    assignee: null,
    tokens: [],
  };
  // Track consumed character ranges so rules don't overlap.
  const consumed: boolean[] = new Array(input.length).fill(false);
  const seen = new Set<string>();
  // Recurrence first (shared/recurrence.ts), so "every monday" or "every month
  // on the 15th" isn't eaten by the date rules.
  const rec = parseRecurrence(input);
  if (rec) {
    r.recurrence = rec.rule;
    for (let i = rec.start; i < rec.end; i++) consumed[i] = true;
    r.tokens.push({ start: rec.start, end: rec.end, kind: 'recurrence' });
    seen.add('recurrence');
  }
  for (const rule of rules) {
    // Only one match per token kind (first rule to match wins).
    if (seen.has(rule.kind)) continue;
    const re = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : rule.re.flags + 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(input))) {
      let start = m.index;
      const end = m.index + m[0].length;
      while (start < end && /\s/.test(input[start])) start++;
      if (consumed.slice(start, end).some(Boolean)) continue;
      const snapshot = { ...r };
      if (rule.apply(m, r, base)) {
        // Swallow a dangling connector before a date/time: "Ship by Friday", "due tomorrow".
        if (rule.kind === 'date' || rule.kind === 'time') {
          const lead = /(?:^|\s)((?:by|due|on|at)\s+)$/i.exec(input.slice(0, start));
          if (lead && !consumed.slice(start - lead[1].length, start).some(Boolean)) start -= lead[1].length;
        }
        for (let i = start; i < end; i++) consumed[i] = true;
        r.tokens.push({ start, end, kind: rule.kind });
        seen.add(rule.kind);
        // A recurrence also implies a date, so later date rules shouldn't override it
        // unless an explicit date is present; dates still win if they appear.
        break;
      }
      Object.assign(r, snapshot);
    }
  }
  if (r.recurrence) {
    // No explicit date: start on the first day the rule matches ("every monday" → next Monday).
    r.dueDate ??= firstOccurrence(r.recurrence, base);
    // Pin monthly/yearly rules to the due date's day so month ends don't drift (Jan 31 → Feb 28 → Mar 31).
    const rule = r.recurrence;
    if ((rule.freq === 'month' || rule.freq === 'year') && rule.byMonthDay === undefined && !rule.byNthWeekday)
      r.recurrence = { ...rule, byMonthDay: Number(r.dueDate.slice(8, 10)) };
  }
  r.title = input
    .split('')
    .map((c, i) => (consumed[i] ? ' ' : c))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  r.tokens.sort((a, b) => a.start - b.start);
  return r;
}
