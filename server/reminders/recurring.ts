// Server-side entry point for rolling a recurring task forward, for
// server/tasks.ts (Tasks & Dashboard) to call when a recurring task is completed:
//
//   const next = nextDueDate(recurrence, task.dueDate, task.id, userId);
//   if (next === null) → the series has ended (until/count): complete the task normally
//   else               → insert the completed copy (occurrence_of) as today, set due_date = next
//
// "Today" is the completing user's today in their time zone (notification
// settings), so completing at 23:30 in Los Angeles doesn't count as tomorrow.
// The completed-occurrence count for `count` rules comes from the copies
// already recorded (occurrence_of = task id) plus this one.
import { db } from '../db.ts';
import { nextOccurrence, todayIn } from '../../shared/recurrence.ts';
import { getSettings } from './settings.ts';
import type { Recurrence } from '../../shared/types.ts';

export function nextDueDate(rule: Recurrence, dueDate: string | null, taskId: string, userId: string, now: number = Date.now()): string | null {
  const today = todayIn(getSettings(userId).timeZone, now);
  const done = (db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE occurrence_of = ?').get(taskId) as { n: number }).n;
  return nextOccurrence(rule, { dueDate, today, completedCount: done + 1 });
}
