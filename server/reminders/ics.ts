// Private iCalendar feed per user: GET /api/calendar/<token>.ics, for
// subscribing from Apple / Google Calendar. Lists your open tasks with a due
// date (assigned to you, or unassigned ones you created), across workspaces
// you belong to. The token is random; only its hash is stored, so the URL is
// shown once when created and can be reset (which kills the old URL).
import crypto from 'node:crypto';
import { db, now } from '../db.ts';
import { TASK_ON_LOCKED_PAGE, TASK_VISIBLE } from '../access.ts';
import { LOCKED_TASK_TITLE } from '../../shared/config.ts';
import { addDays } from '../../shared/recurrence.ts';
import { APP_NAME } from '../../shared/config.ts';
import { getSettings } from './settings.ts';
import type { Recurrence } from '../../shared/types.ts';

const hash = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

/** Creates (or replaces) the user's feed token. Returns the path, relative to the API base. */
export function resetCalendarFeed(userId: string): string {
  const token = crypto.randomBytes(24).toString('base64url');
  db.prepare(
    `INSERT INTO calendar_feeds (user_id, token_hash, created_at) VALUES (?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at`,
  ).run(userId, hash(token), now());
  return `/calendar/${token}.ics`;
}

export function calendarFeedEnabled(userId: string): boolean {
  return !!db.prepare('SELECT 1 FROM calendar_feeds WHERE user_id = ?').get(userId);
}

export function disableCalendarFeed(userId: string) {
  db.prepare('DELETE FROM calendar_feeds WHERE user_id = ?').run(userId);
}

export function feedUser(token: string): string | null {
  if (!/^[\w-]{20,100}$/.test(token)) return null;
  const r = db.prepare('SELECT user_id FROM calendar_feeds WHERE token_hash = ?').get(hash(token)) as { user_id: string } | undefined;
  return r?.user_id ?? null;
}

interface FeedTask {
  id: string;
  title: string;
  description: string;
  due_date: string;
  due_time: string | null;
  recurrence: string | null;
  workspace_id: string;
  page_id: string | null;
  workspace_name: string;
  updated_at: string;
  done_count: number;
}

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const compactDate = (d: string) => d.replace(/-/g, '');
const stamp = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** Fold content lines at 75 octets (RFC 5545 §3.1). */
function fold(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + (start === 0 ? 75 : 74), bytes.length);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--; // don't split a UTF-8 sequence
    parts.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
  }
  return parts.join('\r\n ');
}

const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** RRULE for a rule, counting from the current due date; null when it can't be expressed (completion-based). */
export function toRRule(rule: Recurrence, doneCount = 0): string | null {
  if (rule.basis === 'completion') return null;
  const parts: string[] = [];
  if (rule.freq === 'weekday') parts.push('FREQ=WEEKLY', 'BYDAY=MO,TU,WE,TH,FR');
  else {
    parts.push(`FREQ=${{ day: 'DAILY', week: 'WEEKLY', month: 'MONTHLY', year: 'YEARLY' }[rule.freq]}`);
    if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
    if (rule.freq === 'week' && rule.byWeekday?.length) parts.push(`BYDAY=${[...new Set(rule.byWeekday)].map((d) => BYDAY[d]).join(',')}`);
    if (rule.freq === 'month' && rule.byNthWeekday) parts.push(`BYDAY=${rule.byNthWeekday.n}${BYDAY[rule.byNthWeekday.weekday]}`);
    else if (rule.freq === 'month' && rule.byMonthDay) parts.push(rule.byMonthDay === -1 ? 'BYMONTHDAY=-1' : `BYMONTHDAY=${rule.byMonthDay}`);
  }
  if (rule.until) parts.push(`UNTIL=${compactDate(rule.until)}`);
  else if (rule.count) parts.push(`COUNT=${Math.max(1, rule.count - doneCount)}`);
  return parts.join(';');
}

export function buildCalendar(userId: string, publicUrl = (process.env.PUBLIC_URL ?? '').replace(/\/$/, '')): string {
  const tz = getSettings(userId).timeZone;
  const tasks = db
    .prepare(
      // A task on a locked page goes into the calendar as "Locked task", without its text (server/locks.ts).
      `SELECT t.id, CASE WHEN ${TASK_ON_LOCKED_PAGE} THEN '${LOCKED_TASK_TITLE}' ELSE t.title END AS title,
         CASE WHEN ${TASK_ON_LOCKED_PAGE} THEN '' ELSE t.description END AS description, t.due_date, t.due_time, t.recurrence, t.workspace_id, t.page_id, t.updated_at,
         w.name AS workspace_name, (SELECT COUNT(*) FROM tasks o WHERE o.occurrence_of = t.id) AS done_count
       FROM tasks t JOIN workspaces w ON w.id = t.workspace_id
       WHERE t.status = 'open' AND t.due_date IS NOT NULL
         AND (t.assignee_id = @userId OR (t.assignee_id IS NULL AND t.created_by = @userId))
         AND ${TASK_VISIBLE}
       ORDER BY t.due_date LIMIT 2000`,
    )
    .all({ userId }) as FeedTask[];
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//${APP_NAME}//Tasks//EN`, 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${esc(`${APP_NAME} tasks`)}`, `X-WR-TIMEZONE:${tz}`, 'REFRESH-INTERVAL;VALUE=DURATION:PT30M', 'X-PUBLISHED-TTL:PT30M'];
  for (const t of tasks) {
    const path = t.page_id ? `/w/${t.workspace_id}/p/${t.page_id}?task=${t.id}` : `/w/${t.workspace_id}/tasks/today?task=${t.id}`;
    lines.push('BEGIN:VEVENT', `UID:${t.id}@noteapp`, `DTSTAMP:${stamp(t.updated_at)}`, `SUMMARY:${esc(t.title || 'Untitled task')}`);
    if (t.due_time) {
      const [h, m] = t.due_time.split(':');
      // IANA TZID: Apple and Google resolve it, and recurring times stay put across DST.
      lines.push(`DTSTART;TZID=${tz}:${compactDate(t.due_date)}T${h}${m}00`, 'DURATION:PT30M');
    } else {
      lines.push(`DTSTART;VALUE=DATE:${compactDate(t.due_date)}`, `DTEND;VALUE=DATE:${compactDate(addDays(t.due_date, 1))}`, 'TRANSP:TRANSPARENT');
    }
    if (t.recurrence) {
      try {
        const rr = toRRule(JSON.parse(t.recurrence) as Recurrence, t.done_count);
        if (rr) lines.push(`RRULE:${rr}`);
      } catch {
        /* malformed rule: no RRULE */
      }
    }
    const desc = [t.description, `Workspace: ${t.workspace_name}`, publicUrl ? `${publicUrl}${path}` : ''].filter(Boolean).join('\n');
    lines.push(`DESCRIPTION:${esc(desc)}`);
    if (publicUrl) lines.push(`URL:${publicUrl}${path}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
