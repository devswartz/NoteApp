// Date math for the built-in month calendar (MiniCalendar). Dates are local calendar dates as
// YYYY-MM-DD strings, like the rest of the app (shared/dates.ts).
import { toISODate } from '../../shared/dates.ts';

/** Weeks shown per month: always six, so the calendar keeps its height when the month changes. */
export const GRID_WEEKS = 6;

type WeekInfoLocale = Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } };

/**
 * The locale's first day of the week, 0 = Sunday … 6 = Saturday (Intl.Locale week info; it numbers
 * Monday 1 … Sunday 7). Falls back to Sunday where the browser doesn't say.
 */
export function firstWeekday(locale?: string): number {
  try {
    const tag = locale ?? (typeof navigator !== 'undefined' ? navigator.language : undefined) ?? new Intl.DateTimeFormat().resolvedOptions().locale;
    const loc = new Intl.Locale(tag) as WeekInfoLocale;
    const day = (loc.getWeekInfo?.() ?? loc.weekInfo)?.firstDay;
    return typeof day === 'number' && day >= 1 && day <= 7 ? day % 7 : 0;
  } catch {
    return 0;
  }
}

/** The weekday numbers (0 = Sunday) in column order for a week starting on `first`. */
export function weekdayOrder(first: number): number[] {
  return Array.from({ length: 7 }, (_, i) => (first + i) % 7);
}

/**
 * The 42 days (six weeks) shown for a month (`month` 0–11), starting on the `first` weekday on
 * or before the 1st; the days before and after belong to the neighbouring months.
 */
export function monthGrid(year: number, month: number, first = 0): string[] {
  const start = new Date(year, month, 1);
  start.setDate(1 - ((start.getDay() - first + 7) % 7));
  return Array.from({ length: GRID_WEEKS * 7 }, (_, i) => toISODate(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)));
}

/** Year and month (0–11) of a YYYY-MM-DD date. */
export function monthOf(iso: string): { year: number; month: number } {
  return { year: Number(iso.slice(0, 4)), month: Number(iso.slice(5, 7)) - 1 };
}

/** The month `n` months after year/month (negative goes back). */
export function shiftMonth(view: { year: number; month: number }, n: number): { year: number; month: number } {
  const m = view.year * 12 + view.month + n;
  return { year: Math.floor(m / 12), month: ((m % 12) + 12) % 12 };
}

/** Number of days in a month (0–11). */
export function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}
