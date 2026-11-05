import { addDays, parseISODate, today } from '../../shared/dates.ts';

const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
const SHORT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const SHORT_YEAR = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const LONG = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

/** "Today", "Tomorrow", "Friday", "Nov 14", "Mar 3, 2027" */
export function describeDue(date: string | null): string {
  if (!date) return 'No date';
  const t = today();
  if (date === t) return 'Today';
  if (date === addDays(t, 1)) return 'Tomorrow';
  if (date === addDays(t, -1)) return 'Yesterday';
  const d = parseISODate(date);
  if (date > t && date <= addDays(t, 6)) return WEEKDAY.format(d);
  return d.getFullYear() === new Date().getFullYear() ? SHORT.format(d) : SHORT_YEAR.format(d);
}

export function longDate(date: string): string {
  return LONG.format(parseISODate(date));
}

export function formatTime(t: string | null): string {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(2000, 0, 1, h, m));
}

export type DueTone = 'overdue' | 'today' | 'soon' | 'later' | 'none';
export function dueTone(date: string | null): DueTone {
  if (!date) return 'none';
  const t = today();
  if (date < t) return 'overdue';
  if (date === t) return 'today';
  if (date <= addDays(t, 6)) return 'soon';
  return 'later';
}

export function relativeTime(iso: string): string {
  const diff = (Date.now() - Date.parse(iso)) / 1000;
  if (diff < 45) return 'just now';
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  if (diff < 7 * 86400) return `${Math.round(diff / 86400)}d ago`;
  return SHORT.format(new Date(iso));
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
}

export const PRIORITY_LABEL: Record<number, string> = { 1: 'Priority 1', 2: 'Priority 2', 3: 'Priority 3', 4: 'No priority' };
