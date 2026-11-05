// Date helpers that operate on local calendar dates (YYYY-MM-DD strings)
// so a task due "today" means the same thing regardless of timezone offsets.
import type { Recurrence } from './types.ts';

export function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function parseISODate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(s: string, n: number): string {
  const d = parseISODate(s);
  d.setDate(d.getDate() + n);
  return toISODate(d);
}

export function addMonths(s: string, n: number): string {
  const d = parseISODate(s);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  // Clamp to the last day of the target month (Jan 31 + 1 month = Feb 28/29).
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return toISODate(d);
}

export function today(now = new Date()): string {
  return toISODate(now);
}

/**
 * Next occurrence for a recurring task. Advances from the current due date
 * (or from today if none), and always lands strictly after today so that
 * completing an overdue recurring task doesn't produce another overdue one.
 */
export function nextOccurrence(rule: Recurrence, from: string | null, now = new Date()): string {
  const t = today(now);
  let d = from ?? t;
  const step = (x: string): string => {
    switch (rule.freq) {
      case 'day':
        return addDays(x, rule.interval);
      case 'week':
        return addDays(x, 7 * rule.interval);
      case 'month':
        return addMonths(x, rule.interval);
      case 'year':
        return addMonths(x, 12 * rule.interval);
      case 'weekday': {
        let n = addDays(x, 1);
        while ([0, 6].includes(parseISODate(n).getDay())) n = addDays(n, 1);
        return n;
      }
    }
  };
  d = step(d);
  // Guard against runaway loops with a generous cap.
  for (let i = 0; d <= t && i < 5000; i++) d = step(d);
  return d;
}

export function describeRecurrence(rule: Recurrence | null): string {
  if (!rule) return '';
  if (rule.freq === 'weekday') return 'Every weekday';
  const unit = rule.freq;
  if (rule.interval === 1) {
    return { day: 'Every day', week: 'Every week', month: 'Every month', year: 'Every year' }[unit];
  }
  return `Every ${rule.interval} ${unit}s`;
}
